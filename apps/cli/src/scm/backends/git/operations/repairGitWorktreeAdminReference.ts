import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { GitCheckoutIdentity } from '../checkoutIdentity';
import { isGitLinkedWorktreeIdentity } from '../checkoutIdentity';

export async function repairGitWorktreeAdminReference(input: Readonly<{
    identity: GitCheckoutIdentity;
    targetPath: string;
}>): Promise<void> {
    if (!isGitLinkedWorktreeIdentity(input.identity)) {
        return;
    }

    if (input.identity.registeredWorktreePath === input.targetPath) {
        return;
    }

    await writeFile(join(input.targetPath, '.git'), `gitdir: ${input.identity.gitDirPath}\n`, 'utf8');
    await writeFile(join(input.identity.gitDirPath, 'gitdir'), `${join(input.targetPath, '.git')}\n`, 'utf8');
}
