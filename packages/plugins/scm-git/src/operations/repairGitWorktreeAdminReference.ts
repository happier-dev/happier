import { join } from 'node:path';

import type { GitCheckoutIdentity } from '../checkoutIdentity.js';
import { isGitLinkedWorktreeIdentity } from '../checkoutIdentity.js';
import { readRepositoryFileSystem } from '../repositoryFileSystem.js';

export async function repairGitWorktreeAdminReference(input: Readonly<{
    identity: GitCheckoutIdentity;
    targetPath: string;
}>): Promise<void> {
    if (!isGitLinkedWorktreeIdentity(input.identity)) {
        return;
    }

    const files = readRepositoryFileSystem();
    const targetPath = files.commandPaths?.toCommandPath(input.targetPath) ?? input.targetPath;
    if (input.identity.registeredWorktreePath === targetPath) {
        return;
    }

    const gitDir = files.commandPaths?.fromCommandPath(input.identity.gitDirPath) ?? input.identity.gitDirPath;
    await files.writeFile(join(input.targetPath, '.git'), Buffer.from(`gitdir: ${input.identity.gitDirPath}\n`));
    await files.writeFile(join(gitDir, 'gitdir'), Buffer.from(`${join(targetPath, '.git')}\n`));
}
