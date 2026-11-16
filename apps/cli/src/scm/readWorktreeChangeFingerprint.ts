import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { currentWorkspaceSource } from '@/workspaces/source/workspaceSource';

import { runScmCommand } from './runtime';
import { hashWorkspaceFile } from './workspace/workspaceExportPackaging/hashWorkspaceFile';

/**
 * An unavailable fingerprint always means "changed" to callers: review again,
 * never skip or refuse work because SCM could not supply a fingerprint.
 */
export type WorktreeChangeFingerprintResult =
    | Readonly<{ kind: 'available'; fingerprint: string }>
    | Readonly<{ kind: 'unavailable' }>;

export async function readWorktreeChangeFingerprint(cwd: string): Promise<WorktreeChangeFingerprintResult> {
    try {
        const root = await runScmCommand({ bin: 'git', cwd, args: ['rev-parse', '--show-toplevel'] });
        if (!root.success) return { kind: 'unavailable' };
        // Remove Git's line terminator only: spaces/newlines can belong to the directory name.
        const repoRoot = root.stdout.replace(/\n$/, '');
        if (!repoRoot) return { kind: 'unavailable' };

        const [status, modified, untracked] = await Promise.all([
            runScmCommand({
                bin: 'git', cwd: repoRoot,
                args: ['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--branch',
                    '--untracked-files=all', '--no-renames', '--ignore-submodules=none'],
            }),
            runScmCommand({
                bin: 'git', cwd: repoRoot,
                args: ['--no-optional-locks', 'diff', '--name-only', '-z', '--no-ext-diff',
                    '--no-textconv', '--ignore-submodules=none'],
            }),
            runScmCommand({
                bin: 'git', cwd: repoRoot,
                args: ['ls-files', '-z', '--others', '--exclude-standard'],
            }),
        ]);
        if (!status.success || !modified.success || !untracked.success) return { kind: 'unavailable' };

        // The SCM snapshot's porcelain-v2 basis includes staged blob identities and modes.
        // Status alone misses successive pending edits. Git supplies the pending/untracked
        // names separately so we need neither another status parser nor a full workspace scan.
        // Unlike ls-files --modified, diff also exposes dirty submodule contents.
        const hash = createHash('sha256').update(JSON.stringify(status.stdout));
        const paths = [...new Set([...modified.stdout.split('\0'), ...untracked.stdout.split('\0')]
            .filter(Boolean))].sort();
        for (const relativePath of paths) {
            const filePath = join(repoRoot, relativePath);
            // Git ran where the workspace lives (the admitted source); its entries are read there too.
            const info = await currentWorkspaceSource().lstat(filePath).catch((error: unknown) => {
                if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
                throw error;
            });
            if (info === null) {
                hash.update(JSON.stringify([relativePath, 'absent']));
            } else if (info.isSymbolicLink()) {
                hash.update(JSON.stringify([relativePath, 'symlink', await currentWorkspaceSource().readlink(filePath)]));
            } else if (info.isFile()) {
                hash.update(JSON.stringify([relativePath, 'file', info.mode & 0o111,
                    await hashWorkspaceFile({ filePath })]));
            } else {
                // Git can list a nested repository/submodule as a directory. Its status
                // does not describe every nested edit, so never claim an unchanged tree.
                return { kind: 'unavailable' };
            }
        }
        return { kind: 'available', fingerprint: `sha256:${hash.digest('hex')}` };
    } catch {
        // Missing/unreadable content or SCM failure must not suppress a fresh review.
        return { kind: 'unavailable' };
    }
}
