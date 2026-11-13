import type { Duplex } from 'node:stream';

import { openSessionHolderWorkspaceClient, type SessionHolderChild } from '@/subprocess/supervision/sessionHolder';
import { createHolderWorkspaceSource } from '@/workspaces/source/holderWorkspaceSource';
import type { WorkspaceSource, WorkspaceSourcePlacement } from '@/workspaces/source/workspaceSource';

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

/** `resolveWorkspaceTarget` for the daemon's filesystem admission. */
export function resolveSessionTargetWorkspace(placement: WorkspaceSourcePlacement): WorkspaceSource | null {
    const entry = placement.sessionId ? entries.get(placement.sessionId) : undefined;
    if (!entry) return null;
    // A client that never reached the holder (Agent not started yet) or lost it is replaced on the next request.
    if (!entry.client || entry.client.holderConnectionFailed) {
        entry.client?.detach();
        entry.client = openSessionHolderWorkspaceClient(entry.primarySocketPath, entry.target);
        entry.source = createHolderWorkspaceSource({ id: `${entry.target.id}:${placement.sessionId}`, rootPath: entry.workspace.hostRoot,
            guestRootPath: entry.workspace.targetRoot, holder: entry.client, helperPath: entry.target.helperPath });
    }
    return entry.source!;
}
