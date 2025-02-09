import { Config, File, Octokit, FrontMatter } from './types';
import type { Repository } from '@octokit/webhooks-types';
import fm from 'front-matter';
import yaml from 'js-yaml';
import { PullRequest } from '@octokit/webhooks-types';

async function generateEIPNumber(octokit: Octokit, repository: Repository, frontmatter: FrontMatter, file: File, isMerging: boolean = false): Promise<string> {
    // Generate mnemonic name for draft EIPs or EIPs not yet about to be merged
    //if (frontmatter.status == 'Draft' || (frontmatter.status == 'Review' && !isMerging)) { // What I want to do
    if (!isMerging && frontmatter.status == 'Draft' && file.status == 'added') { // What I have to do
        let eip = frontmatter.title.split(/[^\w\d]+/)?.join('_').toLowerCase() as string;
        // If there are trailing underscores, remove them
        while (eip.endsWith('_')) {
            eip = eip.slice(0, -1);
        }
        // If there are leading underscores, remove them
        while (eip.startsWith('_')) {
            eip = eip.slice(1);
        }
        // If the name is too long, truncate it
        if (eip.length > 30) {
            eip = eip.slice(0, 30);
        }
        return `draft_${eip}`;
    }

    // If filename already has an EIP number, use that
    if (file.filename.startsWith('EIPS/eip-')) {
        let eip = file.filename.split('-')[1].split('.')[0];
        if (eip.match(/^\d+$/)) {
            return eip;
        }
    }

    // Get all EIPs
    const eips = (await octokit.rest.repos.getContent({
        owner: repository.owner.login,
        repo: repository.name,
        path: 'EIPS'
    })).data as any[];

    // Get all EIP numbers
    const eipNumbers = eips
        .filter(eip => eip.name.startsWith('eip-'))
        .map(eip => {
            try {
                return Number(eip.name.split('-')[1]);
            } catch {
                return 0;
            }
        });

    // Find the biggest EIP number
    const eipNumber = Math.max(...eipNumbers);

    // Add a random number from 1-5 to the EIP number
    // This is to prevent conflicts when multiple PRs are merged at the same time, and to prevent number gaming
    return (eipNumber + Math.floor(Math.random() * 3) + 1).toString();
}

async function updateFiles(octokit: Octokit, pull_request: PullRequest, oldFiles: File[], newFiles: File[]) {
    let owner = pull_request.head.repo?.owner?.login as string;
    let repo = pull_request.head.repo?.name as string;
    let parentOwner = pull_request.base.repo?.owner?.login as string;
    let parentRepo = pull_request.base.repo?.name as string;
    let ref = `heads/${pull_request.head.ref as string}`;
    const { data: refData } = await octokit.rest.git.getRef({
        owner,
        repo,
        ref,
    });
    const commitSha = refData.object.sha;
    const { data: commitData } = await octokit.rest.git.getCommit({
        owner,
        repo,
        commit_sha: commitSha,
    });
    const currentCommit = {
        commitSha,
        treeSha: commitData.tree.sha,
    };
    let blobs = [];
    for (let i = 0; i < newFiles.length; i++) {
        const content = newFiles[i].contents as string;
        const blobDataPromise = octokit.rest.git.createBlob({
            owner: parentOwner,
            repo: parentRepo,
            content,
            encoding: 'utf-8',
        });
        blobs.push(blobDataPromise);
    }
    blobs = await Promise.all(blobs);
    blobs = blobs.map(blob => blob.data);
    const paths = newFiles.map(file => file.filename);
    const tree = blobs.map(({ sha }, index) => ({
        path: paths[index],
        mode: `100644`,
        type: `blob`,
        sha,
    })) as any[];
    const { data: oldTree } = await octokit.rest.git.getTree({
        owner,
        repo,
        tree_sha: currentCommit.treeSha,
        recursive: "true", // Why does this have to be a *string*?
    });
    const newPaths = newFiles.map(file => file.filename);
    const oldPaths = oldFiles.map(file => file.filename);
    await Promise.all(oldTree.tree.map(async (oldTreeFile) => { // So that these can be done in parallel
        if (oldTreeFile.type == "tree") return; // Skip directories
        if (newPaths.includes(oldTreeFile.path as string) || oldPaths.includes(oldTreeFile.path as string)) return; // Skip files that are already in the new tree
        let blobOwner = oldTreeFile.url?.match(/(?<=repos\/)[\w\d-]+(?=\/[\w\d-]+\/)/)?.[0] as string;
        let blobRepo = oldTreeFile.url?.match(/(?<=repos\/[\w\d-]+\/)[\w\d-]+(?=\/)/)?.[0] as string;
        if (blobOwner == parentOwner && blobRepo == parentRepo) {
            tree.push({
                path: oldTreeFile.path as string,
                mode: oldTreeFile.mode as string,
                type: oldTreeFile.type as string,
                sha: oldTreeFile.sha as string,
            }); // Already in the right repo
            return;
        }
        // If the file isn't changed in the PR, we can safely assume that it's already in the parent repo
        if (!oldFiles.map(file => file.filename).includes(oldTreeFile.path as string)) {
            tree.push({
                path: oldTreeFile.path as string,
                mode: oldTreeFile.mode as string,
                type: oldTreeFile.type as string,
                sha: oldTreeFile.sha as string,
            });
            return;
        }
        // Copy the blob from the old repo to the new repo
        const { data: blobData } = await octokit.rest.git.getBlob({
            owner: blobOwner,
            repo: blobRepo,
            file_sha: oldTreeFile.sha as string,
        });
        const { data: newBlobData } = await octokit.rest.git.createBlob({
            owner: parentOwner,
            repo: parentRepo,
            content: blobData.content as string,
            encoding: blobData.encoding as string,
        });
        tree.push({
            path: oldTreeFile.path as string,
            mode: oldTreeFile.mode as string,
            type: oldTreeFile.type as string,
            sha: newBlobData.sha,
        });
    }));
    // If the last commit was a merge commit, then we're good and can use its parent
    let { data: { default_branch: defaultBranch }} = await octokit.rest.repos.get({
        owner: parentOwner,
        repo: parentRepo,
    });
    let parents: string[];
    if (commitData.parents.length > 1) {
        parents = [commitData.parents[0].sha];
    } else {
        // We need to create a new commit
        await octokit.rest.pulls.update({
            owner: parentOwner,
            repo: parentRepo,
            pull_number: pull_request.number,
            base: defaultBranch,
        });
        await octokit.rest.pulls.updateBranch({
            owner: parentOwner,
            repo: parentRepo,
            pull_number: pull_request.number,
        });
        // Now use the current commit as the parent
        parents = [commitSha];
    }
    // We are creating the commit in the parent repo, so we need to create the tree in the parent repo
    const { data: newTree } = await octokit.rest.git.createTree({
        owner: parentOwner,
        repo: parentRepo,
        tree,
        base_tree: undefined, // Since we are deleting files, we can't set a base tree
    });
    const message = `Commit from EIP-Bot`;
    const { data: newCommit } = await octokit.rest.git.createCommit({
        owner: parentOwner,
        repo: parentRepo,
        message,
        tree: newTree.sha,
        parents,
    });

    // Workaround. What we want to do is:
    //await octokit.rest.git.updateRef({
    //    owner,
    //    repo,
    //    ref,
    //    sha: newCommit.sha,
    //});
    // However, GitHub's API is broken and doesn't allow us to update the ref. So we have to modify the PR another way.
    // We do this by making a new branch on the ethereum/EIPs repo, then we set the PR to merge into that branch.
    // Then, we merge changes from the ethereum/EIPs repo into the PR branch.
    // We then set the PR to merge into the default branch, and delete the temporary branch.
    // This is a bit hacky, but it works.
    let tempBranchName = `eipbot/${pull_request.number}`;
    try {
        await octokit.rest.git.getRef({ // Will give 404 if doesn't exist
            owner: parentOwner,
            repo: parentRepo,
            ref: `heads/${tempBranchName}`,
        });
        await octokit.rest.git.deleteRef({ // Delete ref if it does
            owner: parentOwner,
            repo: parentRepo,
            ref: `heads/${tempBranchName}`,
        });
    } catch (e: any) {
        if (e.status != 404) throw e;
    }
    await octokit.rest.git.createRef({
        owner: parentOwner,
        repo: parentRepo,
        ref: `refs/heads/${tempBranchName}`,
        sha: newCommit.sha,
    });
    try {
        await octokit.rest.pulls.update({
            owner: parentOwner,
            repo: parentRepo,
            pull_number: pull_request.number,
            base: tempBranchName,
        });
        await octokit.rest.pulls.updateBranch({
            owner: parentOwner,
            repo: parentRepo,
            pull_number: pull_request.number
        });
    } finally {
        await octokit.rest.pulls.update({
            owner: parentOwner,
            repo: parentRepo,
            pull_number: pull_request.number,
            base: defaultBranch,
        });
        await octokit.rest.git.deleteRef({
            owner: parentOwner,
            repo: parentRepo,
            ref: `heads/${tempBranchName}`,
        });
    }
}

export async function preMergeChanges(octokit: Octokit, _: Config, repository: Repository, pull_number: number, files: File[], isMerging: boolean = false) {
    // Fetch PR data
    let pull_request = (await octokit.rest.pulls.get({
        owner: repository.owner.login,
        repo: repository.name,
        pull_number: pull_number
    })).data;

    // Modify EIP data when needed
    let anyFilesChanged = false;
    let newFiles = [];
    let oldEipToNewEip: { [key: string]: string } = {};
    for (let file of files) {
        file = { ...file };
        if (file.filename.endsWith('.md')) {
            // Parse file
            const fileContent = file.contents as string;
            const fileData = fm(fileContent);
            const frontmatter = fileData.attributes as FrontMatter;

            // Check if EIP number needs setting
            let eip = await generateEIPNumber(octokit, repository, frontmatter, file, isMerging);

            let oldEip = frontmatter.eip;
            frontmatter.eip = `${eip}`;
            let oldFilename = file.filename;
            file.filename = `EIPS/eip-${eip}.md`;
            
            if (oldFilename != file.filename || oldEip != eip) {
                anyFilesChanged = true;
                oldEipToNewEip[oldFilename.split("-")?.[1]] = file.filename;

                // Retroactively update asset files
                for (let i = 0; i < newFiles.length; i++) {
                    if (newFiles[i].filename.startsWith(`assets/eip-${oldFilename.split("-")?.[1]}`)) {
                        newFiles[i].filename = newFiles[i].filename.replace(`eip-${oldFilename.split("-")?.[1]}`, `eip-${eip}`);
                    }
                }
            }

            // Check if status needs setting
            if (!frontmatter.status) {
                frontmatter.status = "Draft";
                
                anyFilesChanged = true;
            }

            // Check if last call deadline needs setting
            if (frontmatter.status == "Last Call" && !frontmatter["last-call-deadline"]) {
                let fourteenDays = new Date(Date.now() + 12096e5);
                frontmatter["last-call-deadline"] = new Date(`${fourteenDays.getUTCFullYear()}-${fourteenDays.getUTCMonth()}-${fourteenDays.getUTCDate()}`);
                
                anyFilesChanged = true;
            }

            // Now, regenerate markdown from front matter
            let newYaml = yaml.dump(frontmatter, {
                // Ensure preamble is in the right order
                sortKeys: function (a, b) {
                    let preambleOrder = [
                        "eip",
                        "title",
                        "description",
                        "author",
                        "discussions-to",
                        "status",
                        "last-call-deadline",
                        "type",
                        "category",
                        "created",
                        "requires",
                        "withdrawal-reason"
                    ];
                    return preambleOrder.indexOf(a) - preambleOrder.indexOf(b);
                },
                // Ensure that dates and integers are not turned into strings
                replacer: function (key, value) {
                    if (key == 'eip' && Number.isInteger(value)) {
                        return parseInt(value); // Ensure that it's an integer
                    }
                    if (key == 'requires' && typeof value == 'string' && !value.includes(",")) {
                        return parseInt(value); // Ensure that non-list requires aren't transformed into strings
                    }
                    if (key == 'created' || key == 'last-call-deadline') {
                        return new Date(value); // Ensure that it's a date object
                    }
                    return value;
                },
                // Generic options
                lineWidth: -1, // No max line width for preamble
                noRefs: true, // Disable YAML references
            });
            newYaml = newYaml.trim(); // Get rid of excess whitespace
            newYaml = newYaml.replaceAll('T00:00:00.000Z', ''); // Mandated date formatting by EIP-1
            
            // Regenerate file contents
            file.contents = `---\n${newYaml}\n---\n\n${fileData.body}`;
            
            // Push
            newFiles.push(file);
        } else if (file.filename.startsWith('assets/eip-')) {
            let oldFilename = file.filename;
            let eip = oldFilename.split("-")?.[1];
            if (eip in oldEipToNewEip) {
                // Rename file
                file.filename = file.filename.replace(`eip-${eip}`, `eip-${oldEipToNewEip[eip].split("-")?.[1]}`);

                if (oldFilename != file.filename) {
                    anyFilesChanged = true;
                }
            }

            // Push
            newFiles.push(file);
        } else {
            newFiles.push(file);
        }
    }

    // Push changes
    if (anyFilesChanged) {
        await updateFiles(octokit, pull_request as PullRequest, files, newFiles);
    }
}

export async function performMergeAction(octokit: Octokit, _: Config, repository: Repository, pull_number: number, files: File[]) {
    // Fetch PR data
    let pull_request = (await octokit.rest.pulls.get({
        owner: repository.owner.login,
        repo: repository.name,
        pull_number: pull_number
    })).data;
    const title = pull_request.title;
    
    // Make pre-merge changes
    await preMergeChanges(octokit, _, repository, pull_number, files, true);

    // Enable auto merge
    // Need to use GraphQL API to enable auto merge
    // https://docs.github.com/en/graphql/reference/mutations#enablepullrequestautomerge
    const response = await octokit.graphql(
        // There's a bug with Prettier that breaks the syntax highlighting for the rest of the file if I don't do indentation like this
        `query GetPullRequestId($owner: String!, $repo: String!, $pullRequestNumber: Int!) {
            repository(owner: $owner, name: $repo) {
                pullRequest(number: $pullRequestNumber) {
                    id
                }
            }
        }`, {
            owner: repository.owner.login,
            repo: repository.name,
            pullRequestNumber: pull_number
        }
    ) as any;
    await octokit.graphql(
        `mutation EnableAutoMerge(
            $pullRequestId: ID!,
            $commitHeadline: String,
            $commitBody: String,
            $mergeMethod: PullRequestMergeMethod!,
        ) {
            enablePullRequestAutoMerge(input: {
                pullRequestId: $pullRequestId,
                commitHeadline: $commitHeadline,
                commitBody: $commitBody,
                mergeMethod: $mergeMethod,
            }) {
                pullRequest {
                    autoMergeRequest {
                        enabledAt
                        enabledBy {
                            login
                        }
                    }
                }
            }
        }`, {
            pullRequestId: response.repository.pullRequest.id,
            commitHeadline: title,
            commitBody: `Merged by EIP-Bot.`,
            mergeMethod: "SQUASH"
        }
    );

    // Approve PR
    await octokit.rest.pulls.createReview({
        owner: repository.owner.login,
        repo: repository.name,
        pull_number: pull_number,
        event: "APPROVE",
        body: "All Reviewers Have Approved; Performing Automatic Merge..."
    });
}
