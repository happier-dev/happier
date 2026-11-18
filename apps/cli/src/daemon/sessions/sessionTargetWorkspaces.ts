import type { Duplex } from 'node:stream';
import { realpathSync } from 'node:fs';
import type { WorkspaceManifest } from '@happier-dev/protocol';

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
    lifetime: AbortSignal;
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
    readonly baseline?: WorkspaceManifest;
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
    baseline?: WorkspaceManifest;
}>): void {
    if (input.lifetime.aborted) return;
    const entry: Entry = { target: input.target, primarySocketPath: input.primarySocketPath, workspace: input.workspace,
        ...(input.baseline ? { baseline: input.baseline } : {}) };
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

function findWorkspaceAt(path: string, readRoot: (entry: Entry) => string | null): [string, Entry] | undefined {
    let revoked: [string, Entry] | undefined;
    for (const registration of entries) {
        const entry = registration[1];
        const root = readRoot(entry);
        if (!root || !isCanonicalAbsolutePathInsideRoot(root, path)) continue;
        if (!entry.target.lifetime.aborted) return registration;
        revoked ??= registration;
    }
    return revoked;
}

function findWorkspaceByDirectory(path: string): [string, Entry] | undefined {
    const lexical = findWorkspaceAt(path, entry => entry.workspace.hostRoot);
    if (lexical && !lexical[1].target.lifetime.aborted) return lexical;
    const requestedPath = physicalPath(path);
    const physical = requestedPath ? findWorkspaceAt(requestedPath, entry => physicalPath(entry.workspace.hostRoot)) : undefined;
    if (physical && !physical[1].target.lifetime.aborted) return physical;
    // A revoked-only root must keep its target refusal, including when it no longer exists.
    return lexical ?? physical;
}

/** `resolveWorkspaceTarget` for filesystem admission, including directory-only Git panel requests. */
export function resolveSessionTargetWorkspace(placement: WorkspaceSourcePlacement): WorkspaceSource | null {
    // Explicit Session scope selects its own placement, including a revoked target.
    const [sessionId, entry] = placement.sessionId
        ? [placement.sessionId, entries.get(placement.sessionId)] as const
        : (placement.rootPath ? findWorkspaceByDirectory(placement.rootPath) : undefined) ?? [];
    if (!entry) return null;
    const client = workspaceClient(entry);
    entry.source ??= createHolderWorkspaceSource({ id: `${entry.target.id}:${sessionId}`, rootPath: entry.workspace.hostRoot,
        guestRootPath: entry.workspace.targetRoot, holder: client, helperPath: entry.target.helperPath });
    return entry.source!;
}

/** Finite transfers use guest-absolute tool paths, beside the existing request-path view. */
export function resolveSessionTargetWorkspaceTransfer(sessionId: string): Readonly<{
    source: WorkspaceSource;
    workspace: Readonly<{ hostRoot: string; targetRoot: string }>;
    baseline: WorkspaceManifest | null;
}> | null {
    const entry = entries.get(sessionId);
    if (!entry) return null;
    return {
        workspace: entry.workspace,
        baseline: entry.baseline ?? null,
        source: createHolderWorkspaceSource({ id: `${entry.target.id}:${sessionId}`, rootPath: entry.workspace.targetRoot,
            holder: workspaceClient(entry), helperPath: entry.target.helperPath }),
    };
}
