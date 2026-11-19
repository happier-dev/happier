import type { Duplex } from 'node:stream';
import { realpathSync } from 'node:fs';
import type { WorkspaceManifest } from '@happier-dev/protocol';
import { workspaceTargetUnavailable, type WorkspaceSourcePlacement, type WorkspaceSource } from '@/workspaces/source/workspaceSource';

import { openSessionHolderWorkspaceChannel, openSessionHolderWorkspaceClient, type SessionHolderChild } from '@/subprocess/supervision/sessionHolder';
import { createHolderWorkspaceSource } from '@/workspaces/source/holderWorkspaceSource';
import { expandHomeDirPath, isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import type { ProjectOpenRuntime } from '@/workspaces/activation/openProject';

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

type SessionEntry = {
    readonly kind: 'session';
    readonly sessionId: string;
    readonly target: SessionTargetWorkspaceTarget;
    readonly primarySocketPath: string;
    readonly workspace: Readonly<{ hostRoot: string; targetRoot: string }>;
    readonly baseline?: WorkspaceManifest;
    client?: SessionHolderChild;
    source?: WorkspaceSource;
};

type ManagedWorkspace = NonNullable<WorkspaceSourcePlacement['workspace']>;
type ManagedEntry = Readonly<{
    kind: 'managed'; source: WorkspaceSource; hold(): () => void; openHolder(): SessionHolderChild;
}>;
type WorkspaceEntry = SessionEntry | ManagedEntry;
const entries = new Map<string, WorkspaceEntry>();
const sessionWorkspaces = new Map<string, string>();

function managedWorkspaceKey(workspace: ManagedWorkspace, requesterAccountId: string): string {
    return JSON.stringify(['managed', requesterAccountId, workspace.serverId, workspace.controller.machineId,
        workspace.controller.installationId, workspace.managedId, workspace.workspaceId, workspace.rootPath]);
}

/** The target lifetime comes from managed custody. Only provider channels follow panel demand. */
export function registerManagedWorkspaceTarget(input: Readonly<{
    workspace: ManagedWorkspace;
    requesterAccountId: string;
    target: Readonly<{ lifetime: AbortSignal; holderPath: string; helperPath: string;
        openChannel(argv: readonly string[], signal: AbortSignal): Duplex }>;
}>): boolean {
    const { target, workspace } = input;
    const key = managedWorkspaceKey(workspace, input.requesterAccountId);
    if (target.lifetime.aborted || entries.has(key)) return false;
    let demands = 0;
    let active: { channel: Duplex; holder: SessionHolderChild } | undefined;
    const close = () => {
        const previous = active;
        active = undefined;
        previous?.channel.end();
    };
    const hold = () => {
        demands += 1;
        return () => { if (--demands === 0) close(); };
    };
    const openHolder = () => {
        if (target.lifetime.aborted || demands === 0) throw workspaceTargetUnavailable();
        if (!active || active.channel.destroyed || active.holder.holderConnectionFailed) {
            close();
            const channel = target.openChannel([target.holderPath, 'workspace', '--root', workspace.rootPath], target.lifetime);
            active = { channel, holder: openSessionHolderWorkspaceChannel(channel) };
        }
        return active.holder;
    };
    const entry: ManagedEntry = { kind: 'managed', hold, openHolder, source: createHolderWorkspaceSource({
        id: key, rootPath: workspace.rootPath, helperPath: target.helperPath, hold, holder: openHolder,
    }) };
    entries.set(key, entry);
    target.lifetime.addEventListener('abort', () => {
        if (entries.get(key) === entry) entries.delete(key);
        close();
    }, { once: true });
    return true;
}

/** Restore an already admitted Project target. Its lifetime transfers to the registry. */
export async function ensureAcceptedManagedWorkspaceTarget(input: Readonly<{
    workspace: ManagedWorkspace;
    requesterAccountId: string;
    openTarget: NonNullable<ProjectOpenRuntime['openManagedProjectWorkspace']>;
    signal?: AbortSignal;
}>): Promise<WorkspaceSource | null> {
    const { workspace, requesterAccountId, openTarget, signal } = input;
    signal?.throwIfAborted();
    const placement = { workspace, requesterAccountId };
    const existing = managedWorkspaceEntry(placement);
    if (existing) return existing.source;
    const lifetime = new AbortController();
    const cancel = () => lifetime.abort(signal?.reason);
    signal?.addEventListener('abort', cancel, { once: true });
    let retained = false;
    try {
        const target = await openTarget({ workspace, requesterAccountId, lifetime: lifetime.signal });
        lifetime.signal.throwIfAborted();
        retained = registerManagedWorkspaceTarget({ ...placement, target });
        return managedWorkspaceEntry(placement)?.source ?? null;
    } finally {
        signal?.removeEventListener('abort', cancel);
        if (!retained) lifetime.abort();
    }
}

function sessionWorkspaceEntry(sessionId: string): SessionEntry | undefined {
    const key = sessionWorkspaces.get(sessionId);
    if (!key) return undefined;
    const entry = entries.get(key);
    return entry?.kind === 'session' ? entry : undefined;
}

export function registerSessionTargetWorkspace(input: Readonly<{
    sessionId: string;
    lifetime: AbortSignal;
    primarySocketPath: string;
    target: SessionTargetWorkspaceTarget;
    workspace: Readonly<{ hostRoot: string; targetRoot: string }>;
    baseline?: WorkspaceManifest;
}>): void {
    if (input.lifetime.aborted) return;
    const key = JSON.stringify(['session', input.target.id, input.primarySocketPath, input.workspace.targetRoot]);
    const entry: SessionEntry = { kind: 'session', sessionId: input.sessionId, target: input.target,
        primarySocketPath: input.primarySocketPath, workspace: input.workspace,
        ...(input.baseline ? { baseline: input.baseline } : {}) };
    const previousKey = sessionWorkspaces.get(input.sessionId);
    if (previousKey && previousKey !== key && entries.get(previousKey)?.kind === 'session') entries.delete(previousKey);
    entries.set(key, entry);
    sessionWorkspaces.set(input.sessionId, key);
    input.lifetime.addEventListener('abort', () => {
        if (entries.get(key) === entry) {
            entries.delete(key);
            if (sessionWorkspaces.get(input.sessionId) === key) sessionWorkspaces.delete(input.sessionId);
        }
        entry.client?.detach();
    }, { once: true });
}

function workspaceClient(entry: SessionEntry): SessionHolderChild {
    // A client that never reached the holder (Agent not started yet) or lost it is replaced on the next request.
    if (!entry.client || entry.client.holderConnectionFailed) {
        entry.client?.detach();
        entry.client = openSessionHolderWorkspaceClient(entry.primarySocketPath, entry.target);
        entry.source = undefined;
    }
    return entry.client;
}

function managedWorkspaceEntry(placement: WorkspaceSourcePlacement): ManagedEntry | undefined {
    if (!placement.workspace || !placement.requesterAccountId) return undefined;
    const key = managedWorkspaceKey(placement.workspace, placement.requesterAccountId);
    if (placement.sessionId && sessionWorkspaces.get(placement.sessionId) !== key) return undefined;
    const entry = entries.get(key);
    return entry?.kind === 'managed' ? entry : undefined;
}

/** Terminal demand uses the same admitted workspace registration as Files and Git. */
export function resolveWorkspacePtyTarget(placement: WorkspaceSourcePlacement): Readonly<{
    rootPath: string; openHolder(): SessionHolderChild; hold?: () => () => void;
}> | null {
    if (placement.workspace) {
        const entry = managedWorkspaceEntry(placement);
        return entry ? { rootPath: placement.workspace.rootPath, openHolder: entry.openHolder, hold: entry.hold } : null;
    }
    const entry = placement.sessionId ? sessionWorkspaceEntry(placement.sessionId) : undefined;
    return entry ? { rootPath: entry.workspace.hostRoot, openHolder: () => workspaceClient(entry) } : null;
}

function physicalPath(path: string): string | null {
    try { return realpathSync(expandHomeDirPath(path)); } catch { return null; }
}

function findWorkspaceAt(path: string, readRoot: (entry: SessionEntry) => string | null): SessionEntry | undefined {
    let revoked: SessionEntry | undefined;
    for (const [key, entry] of entries) {
        if (entry.kind !== 'session' || sessionWorkspaces.get(entry.sessionId) !== key) continue;
        const root = readRoot(entry);
        if (!root || !isCanonicalAbsolutePathInsideRoot(root, path)) continue;
        if (!entry.target.lifetime.aborted) return entry;
        revoked ??= entry;
    }
    return revoked;
}

function findWorkspaceByDirectory(path: string): SessionEntry | undefined {
    const lexical = findWorkspaceAt(path, entry => entry.workspace.hostRoot);
    if (lexical && !lexical.target.lifetime.aborted) return lexical;
    const requestedPath = physicalPath(path);
    const physical = requestedPath ? findWorkspaceAt(requestedPath, entry => physicalPath(entry.workspace.hostRoot)) : undefined;
    if (physical && !physical.target.lifetime.aborted) return physical;
    // A revoked-only root must keep its target refusal, including when it no longer exists.
    return lexical ?? physical;
}

/** `resolveWorkspaceTarget` for filesystem admission, including directory-only Git panel requests. */
export function resolveSessionTargetWorkspace(placement: WorkspaceSourcePlacement): WorkspaceSource | null {
    // An exact managed address can only resolve by its workspace identity.
    if (placement.workspace) return managedWorkspaceEntry(placement)?.source ?? null;
    // Explicit Session scope selects its own placement, including a revoked target.
    const entry = placement.sessionId ? sessionWorkspaceEntry(placement.sessionId)
        : placement.rootPath ? findWorkspaceByDirectory(placement.rootPath) : undefined;
    if (!entry) return null;
    const client = workspaceClient(entry);
    entry.source ??= createHolderWorkspaceSource({ id: `${entry.target.id}:${entry.sessionId}`, rootPath: entry.workspace.hostRoot,
        guestRootPath: entry.workspace.targetRoot, holder: client, helperPath: entry.target.helperPath });
    return entry.source!;
}

/** Finite transfers use guest-absolute tool paths, beside the existing request-path view. */
export function resolveSessionTargetWorkspaceTransfer(sessionId: string): Readonly<{
    source: WorkspaceSource;
    workspace: Readonly<{ hostRoot: string; targetRoot: string }>;
    baseline: WorkspaceManifest | null;
}> | null {
    const entry = sessionWorkspaceEntry(sessionId);
    if (!entry) return null;
    return {
        workspace: entry.workspace,
        baseline: entry.baseline ?? null,
        source: createHolderWorkspaceSource({ id: `${entry.target.id}:${sessionId}`, rootPath: entry.workspace.targetRoot,
            holder: workspaceClient(entry), helperPath: entry.target.helperPath }),
    };
}
