import { isAbsolute } from 'node:path';
import type { createProcessOwnershipRuntime } from '@/daemon/processes/ownership/processOwnershipRuntime';
import type { StoragePathUse } from '@/storage/categories/types';

type ProcessOwnershipRead = Awaited<ReturnType<ReturnType<typeof createProcessOwnershipRuntime>['readOwners']>>;

/**
 * Projects the ownership runtime's census into Storage "in use" facts (plan 40 §4.6, §7(h)).
 * The census exposes cwd only for the same principal; Windows exposes none. Other programs
 * hold their cwd, ancestors and ordinary descendants. A registered workspace is
 * also a cwd fact, allowing the worktree owner to exempt an unused exact child
 * worktree. Explicit executables and absolute arguments remain dependency paths.
 */
export function projectStorageProcessUse(owners: ProcessOwnershipRead): StoragePathUse {
    if (owners.status !== 'ok') return { reliable: false, paths: [], cwdPaths: [], sessions: [] };
    const paths: string[] = [];
    const cwdPaths: string[] = [];
    const sessions: { path: string; sessionId: string; tree?: boolean }[] = [];
    const byPid = new Map(owners.snapshot.rows.map(row => [row.pid, row]));
    const liveSessions = new Set(owners.roots.flatMap(root => root.live && root.owner.kind === 'session' ? [root.owner.sessionId] : []));
    for (const owner of owners.rows) {
        const row = byPid.get(owner.pid);
        if (row?.cwd) cwdPaths.push(row.cwd);
        if (owner.level === 'not_happier') {
            continue;
        }
        if (owner.workspacePath) cwdPaths.push(owner.workspacePath);
        const heldPaths = [row?.executablePath,
            ...(row?.argv ?? []).filter(arg => isAbsolute(arg))].filter((path): path is string => !!path);
        paths.push(...heldPaths);
        // Ownership already selected the canonical live root; storage only projects its session binding.
        const ownerSessionId = owner.owner?.kind === 'session' && !owner.ownerEnded ? owner.owner.sessionId : undefined;
        if (ownerSessionId && liveSessions.has(ownerSessionId)) {
            for (const path of heldPaths) sessions.push({ path, sessionId: ownerSessionId });
            if (owner.workspacePath) sessions.push({ path: owner.workspacePath, sessionId: ownerSessionId, tree: false });
            if (row?.cwd) sessions.push({ path: row.cwd, sessionId: ownerSessionId, tree: false });
        }
    }
    return { reliable: !owners.snapshot.partial?.length && !owners.rows.some(owner => owner.level === 'unknown'), paths, cwdPaths, sessions };
}
