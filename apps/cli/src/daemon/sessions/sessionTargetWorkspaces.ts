import type { Duplex } from 'node:stream';
import { realpathSync } from 'node:fs';

import { openSessionHolderWorkspaceClient, type SessionHolderChild } from '@/subprocess/supervision/sessionHolder';
import { createHolderWorkspaceSource } from '@/workspaces/source/holderWorkspaceSource';
import type { WorkspaceSource, WorkspaceSourcePlacement } from '@/workspaces/source/workspaceSource';
import { expandHomeDirPath, isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';

/**
 * The daemon's Files/Git view of Sessions placed on a target (no daemon inside):
 * a request for such a Session resolves to its target workspace, reached through
 * a workspace client of the Session's primary Agent holder (`<socket>.ops`, which
 * cannot touch the Agent) over this daemon's own provider operations for that
 * target. Requests address the Session's own path; the helper uses the
 * workspace's path in the guest (`guestRootPath`). One entry per live Session,
 * removed when the Session ends; this Machine's disk is never a fallback.
 */
export type SessionTargetWorkspaceTarget = Readonly<{
    id: string;
    holderPath: string;
    helperPath: string;
    socketDirectory: string;
    exec(command: string): Promise<Readonly<{ status: number; stdout: string; stderr: string }>>;
    openChannel(argv: readonly string[]): Duplex;
}>;

type Entry = {
    readonly target: SessionTargetWorkspaceTarget;
    readonly primarySocketPath: string;
    readonly workspace: Readonly<{ hostRoot: string; targetRoot: string }>;
    client?: SessionHolderChild;
    source?: WorkspaceSource;
};

const entries = new Map<string, Entry>();

export function registerSessionTargetWorkspace(input: Readonly<{
    sessionId: string;
    lifetime: AbortSignal;
    primarySocketPath: string;
    target: SessionTargetWorkspaceTarget;
    workspace: Readonly<{ hostRoot: string; targetRoot: string }>;
}>): void {
    if (input.lifetime.aborted) return;
    const entry: Entry = { target: input.target, primarySocketPath: input.primarySocketPath, workspace: input.workspace };
    entries.set(input.sessionId, entry);
    input.lifetime.addEventListener('abort', () => {
        if (entries.get(input.sessionId) === entry) entries.delete(input.sessionId);
        entry.client?.detach();
    }, { once: true });
}

function workspaceClient(entry: Entry): SessionHolderChild {
    // A client that never reached the holder (Agent not started yet) or lost it is replaced on the next request.
    if (!entry.client || entry.client.holderConnectionFailed) {
        entry.client?.detach();
        entry.client = openSessionHolderWorkspaceClient(entry.primarySocketPath, entry.target);
        entry.source = undefined;
    }
    return entry.client;
}

/** Terminals consume the same live Session placement as Files/Git; the Session owns this shared client. */
export function resolveSessionTargetPtyTarget(sessionId: string): Readonly<{ rootPath: string; openHolder(): SessionHolderChild }> | null {
    const entry = entries.get(sessionId);
    return entry ? { rootPath: entry.workspace.hostRoot, openHolder: () => workspaceClient(entry) } : null;
}

function physicalPath(path: string): string | null {
    try { return realpathSync(expandHomeDirPath(path)); } catch { return null; }
}

/** `resolveWorkspaceTarget` for filesystem admission, including directory-only Git panel requests. */
export function resolveSessionTargetWorkspace(placement: WorkspaceSourcePlacement): WorkspaceSource | null {
    let sessionId = placement.sessionId;
    let entry = sessionId ? entries.get(sessionId) : undefined;
    // A Session-scoped request uses only its own Session's placement: another Session's root
    // stays this Machine's path, so the host identity check decides it (SEC1116G item 1).
    if (!sessionId && placement.rootPath) {
        for (const [id, candidate] of entries) {
            if (isCanonicalAbsolutePathInsideRoot(candidate.workspace.hostRoot, placement.rootPath)) {
                sessionId = id;
                entry = candidate;
                break;
            }
        }
        // Aliases of a shared root carry the same placement. Keep lexical matching
        // above even for unavailable/nonexistent paths: failure must not select host IO.
        if (!entry) {
            const requestedPath = physicalPath(placement.rootPath);
            if (requestedPath) for (const [id, candidate] of entries) {
                const root = physicalPath(candidate.workspace.hostRoot);
                if (root && isCanonicalAbsolutePathInsideRoot(root, requestedPath)) {
                    sessionId = id;
                    entry = candidate;
                    break;
                }
            }
        }
    }
    if (!entry) return null;
    const client = workspaceClient(entry);
    entry.source ??= createHolderWorkspaceSource({ id: `${entry.target.id}:${sessionId}`, rootPath: entry.workspace.hostRoot,
        guestRootPath: entry.workspace.targetRoot, holder: client, helperPath: entry.target.helperPath });
    return entry.source!;
}
