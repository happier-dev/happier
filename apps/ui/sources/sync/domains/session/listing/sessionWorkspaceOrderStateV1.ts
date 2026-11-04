import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

import type { SessionListViewItem } from './sessionListViewData';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { createSessionProjectKeyResolverV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { workspaceRefResolutionContextV1 } from '@/sync/domains/workspaces/workspaceRefs';
import { projectGroupIdentityKey } from '@/sync/domains/workspaces/projectGroupDisplay';
import { buildSessionWorkspaceFallbackOrderKey, readSessionWorkspaceFallbackIdentity, serializeSessionWorkspaceOrderKey } from './sessionWorkspaceOrderKeys';

const UNKNOWN_SERVER_KEY = '__unknown_server__';

export type SessionWorkspaceOrderV1 = Readonly<Record<string, ReadonlyArray<string> | undefined>>;

type WorkspaceOrderIdentity = Readonly<{
    scopeKey: string;
    itemKey: string;
}>;

type WorkspaceBlock = WorkspaceOrderIdentity & Readonly<{
    start: number;
    end: number;
}>;

function normalizeServerIdForWorkspaceOrder(serverIdRaw: unknown): string {
    const serverId = typeof serverIdRaw === 'string' ? serverIdRaw.trim() : '';
    return serverId || UNKNOWN_SERVER_KEY;
}

function normalizeWorkspaceKey(workspaceKeyRaw: unknown): string {
    return typeof workspaceKeyRaw === 'string' ? workspaceKeyRaw.trim() : '';
}

function dedupePreserveOrder(keys: ReadonlyArray<string>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const key of keys) {
        const normalized = typeof key === 'string' ? key.trim() : '';
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        out.push(normalized);
    }
    return out;
}

export function buildSessionWorkspaceOrderScopeKey(serverIdRaw: unknown): string {
    const serverId = normalizeServerIdForWorkspaceOrder(serverIdRaw);
    return JSON.stringify(['workspace-order', serverId === UNKNOWN_SERVER_KEY ? null : serverId]);
}

/**
 * Inverse of {@link buildSessionWorkspaceOrderScopeKey}. A workspace order scope names the
 * exact Home that owns it, so a write can be routed to that Home instead of the focused one.
 * Returns `null` for the unknown-server scope and for any key this owner did not mint.
 */
export function readSessionWorkspaceOrderScopeServerId(scopeKeyRaw: unknown): string | null {
    const scopeKey = typeof scopeKeyRaw === 'string' ? scopeKeyRaw.trim() : '';
    if (!scopeKey.startsWith('[')) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(scopeKey);
    } catch {
        return null;
    }
    if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== 'workspace-order') return null;
    const serverId = typeof parsed[1] === 'string' ? parsed[1].trim() : '';
    return serverId || null;
}

export function buildSessionWorkspaceOrderItemKey(workspaceKeyRaw: unknown): string | null {
    const workspaceKey = normalizeWorkspaceKey(workspaceKeyRaw);
    return workspaceKey || null;
}

function resolveWorkspaceOrderIdentity(
    item: Extract<SessionListIndexItem | SessionListViewItem, { type: 'header' }>,
): WorkspaceOrderIdentity | null {
    if (item.headerKind !== 'project') return null;
    const itemKey = buildSessionWorkspaceOrderItemKey(item.workspaceKey);
    if (!itemKey) return null;
    return {
        scopeKey: buildSessionWorkspaceOrderScopeKey(item.serverId),
        itemKey,
    };
}

function isProjectBlockBoundary(item: SessionListIndexItem): boolean {
    return item.type === 'header' && item.headerKind !== 'folder';
}

function findWorkspaceBlockEnd(items: ReadonlyArray<SessionListIndexItem>, startIndex: number): number {
    let cursor = startIndex + 1;
    while (cursor < items.length && !isProjectBlockBoundary(items[cursor]!)) {
        cursor += 1;
    }
    return cursor;
}

function reorderBlocksByKeys(blocks: ReadonlyArray<WorkspaceBlock>, keys: ReadonlyArray<string>): WorkspaceBlock[] {
    const byKey = new Map(blocks.map((block) => [block.itemKey, block]));
    const used = new Set<WorkspaceBlock>();
    const out: WorkspaceBlock[] = [];
    for (const key of keys) {
        const normalized = typeof key === 'string' ? key.trim() : '';
        if (!normalized) continue;
        const found = byKey.get(normalized);
        if (found && !used.has(found)) {
            out.push(found);
            used.add(found);
        }
    }
    const unordered = blocks.filter((block) => !used.has(block));
    return [...out, ...unordered];
}

function applyWorkspaceOrderForRun(
    source: ReadonlyArray<SessionListIndexItem>,
    blocks: ReadonlyArray<WorkspaceBlock>,
    order: SessionWorkspaceOrderV1,
): SessionListIndexItem[] {
    if (blocks.length < 2) return source as SessionListIndexItem[];
    const scopeKey = blocks[0]?.scopeKey ?? '';
    if (!scopeKey || !blocks.every((block) => block.scopeKey === scopeKey)) return source as SessionListIndexItem[];
    const keys = order[scopeKey];
    if (!keys || keys.length === 0) return source as SessionListIndexItem[];

    const reordered = reorderBlocksByKeys(blocks, keys);
    if (reordered.every((block, index) => block === blocks[index])) {
        return source as SessionListIndexItem[];
    }

    const first = blocks[0]!;
    const last = blocks[blocks.length - 1]!;
    return [
        ...source.slice(0, first.start),
        ...reordered.flatMap((block) => source.slice(block.start, block.end)),
        ...source.slice(last.end),
    ];
}

export function applySessionWorkspaceOrderV1ToIndex(
    source: ReadonlyArray<SessionListIndexItem>,
    order: SessionWorkspaceOrderV1,
): SessionListIndexItem[] {
    let out = source as SessionListIndexItem[];
    let run: WorkspaceBlock[] = [];
    for (let index = 0; index < out.length; index += 1) {
        const item = out[index]!;
        const identity = item.type === 'header' ? resolveWorkspaceOrderIdentity(item) : null;
        if (!identity) {
            if (run.length > 0) {
                out = applyWorkspaceOrderForRun(out, run, order);
                index = run[run.length - 1]!.end - 1;
                run = [];
            }
            continue;
        }

        const end = findWorkspaceBlockEnd(out, index);
        const previous = run[run.length - 1] ?? null;
        if (previous && (previous.end !== index || previous.scopeKey !== identity.scopeKey)) {
            out = applyWorkspaceOrderForRun(out, run, order);
            index = run[run.length - 1]!.end - 1;
            run = [];
            continue;
        }
        run.push({ ...identity, start: index, end });
        index = end - 1;
    }

    if (run.length > 0) {
        out = applyWorkspaceOrderForRun(out, run, order);
    }

    return out;
}

export function normalizeSessionWorkspaceOrderV1ForSource(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem | SessionListViewItem>;
    sessionWorkspaceOrderV1: SessionWorkspaceOrderV1;
    workspaceRefs?: readonly WorkspaceRefV1[];
    workspaceRefsServerId?: string;
}>): Record<string, string[]> {
    const context = workspaceRefResolutionContextV1();
    const resolveProject = createSessionProjectKeyResolverV1(params.workspaceRefs, context);
    const censusHome = params.workspaceRefsServerId ? context.normalizeServerId(params.workspaceRefsServerId) : null;
    const acceptedTuples = new Map<string, string | null>();
    const predecessorKeys = new Map<string, Readonly<{ tuple: string; project: string }> | null>();
    for (const item of params.source) {
        if (item.type !== 'session' || !item.projectKey || item.workspace?.t !== 'workspaceScope' || !item.serverId || !item.workspace.serverId) continue;
        const home = context.normalizeServerId(item.serverId);
        if (!home || context.normalizeServerId(item.workspace.serverId) !== home
            || context.normalizeServerId(item.projectKey.serverId) !== home) continue;
        // The base producer already canonicalized this execution tuple. No private census or
        // replacement-inventory guess is needed to read its admitted public Project relation.
        const identity = [home, item.workspace.machineId, item.workspace.rootPath] as const;
        const tuple = JSON.stringify(identity);
        const project = projectGroupIdentityKey(item.projectKey);
        const previousTuple = acceptedTuples.get(tuple);
        acceptedTuples.set(tuple, previousTuple === undefined || previousTuple === project ? project : null);
        const predecessor = JSON.stringify([home, buildSessionWorkspaceFallbackOrderKey(identity)]);
        const previous = predecessorKeys.get(predecessor);
        // Actual 0.2 hashes can collide: even two tuples for one Project cannot elect a winner.
        predecessorKeys.set(predecessor, previous === undefined
            || previous?.tuple === tuple && previous.project === project ? { tuple, project } : null);
    }
    const out: Record<string, string[]> = {};
    for (const [scopeKeyRaw, keysRaw] of Object.entries(params.sessionWorkspaceOrderV1 ?? {})) {
        const scopeKey = typeof scopeKeyRaw === 'string' ? scopeKeyRaw.trim() : '';
        if (!scopeKey) continue;
        const serverId = readSessionWorkspaceOrderScopeServerId(scopeKey);
        const normalizedKeys = Array.isArray(keysRaw) ? keysRaw : [];
        const filtered = dedupePreserveOrder(normalizedKeys.map(key => {
            if (!serverId) return key;
            const home = context.normalizeServerId(serverId);
            const predecessor = predecessorKeys.get(JSON.stringify([home, key]));
            if (predecessor) return predecessor.project;
            const identity = readSessionWorkspaceFallbackIdentity(key);
            if (identity?.[0]) {
                const tuple = JSON.stringify([context.normalizeServerId(identity[0]), identity[1], identity[2]]);
                if (context.normalizeServerId(identity[0]) === home && acceptedTuples.has(tuple)) {
                    return acceptedTuples.get(tuple) ?? serializeSessionWorkspaceOrderKey(key, serverId) ?? key;
                }
            }
            if (params.workspaceRefs && censusHome && context.normalizeServerId(serverId) === censusHome
                && identity?.[0] && context.normalizeServerId(identity[0]) === censusHome) {
                const resolved = resolveProject({ machineId: identity[1], path: identity[2] }, serverId);
                if (resolved.kind === 'resolved') return projectGroupIdentityKey(resolved.projectKey);
            }
            return serializeSessionWorkspaceOrderKey(key, serverId) ?? key;
        }));
        if (filtered.length > 0) {
            out[scopeKey] = filtered;
        }
    }

    return out;
}

/** Previous presentation orders existing groups; newly admitted groups append without a write. */
export function retainSessionProjectGroupOrder(
    source: ReadonlyArray<SessionListIndexItem>,
    previous: ReadonlyArray<SessionListIndexItem> | null | undefined,
): SessionListIndexItem[] {
    if (!previous) return source as SessionListIndexItem[];
    const order: Record<string, string[]> = {};
    for (const item of previous) {
        const identity = item.type === 'header' ? resolveWorkspaceOrderIdentity(item) : null;
        if (identity) (order[identity.scopeKey] ??= []).push(identity.itemKey);
    }
    return applySessionWorkspaceOrderV1ToIndex(source, order);
}

/** Complete the canonical Session creation seed after Runs have supplied their groups. */
export function completeSessionProjectGroupOrder(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    creationSeed: ReadonlyArray<SessionListIndexItem>;
    previousPresentedIndex?: ReadonlyArray<SessionListIndexItem> | null;
    savedOrder: SessionWorkspaceOrderV1;
}>): SessionListIndexItem[] {
    const seed: Record<string, string[]> = {};
    const known = new Map<string, Set<string>>();
    for (const item of params.creationSeed) {
        const identity = item.type === 'header' ? resolveWorkspaceOrderIdentity(item) : null;
        if (!identity) continue;
        const keys = known.get(identity.scopeKey) ?? new Set<string>();
        if (!keys.has(identity.itemKey)) (seed[identity.scopeKey] ??= []).push(identity.itemKey);
        keys.add(identity.itemKey);
        known.set(identity.scopeKey, keys);
    }
    const unknown = new Map<string, Map<string, string>>();
    for (const item of params.source) {
        const identity = item.type === 'header' ? resolveWorkspaceOrderIdentity(item) : null;
        if (!identity || known.get(identity.scopeKey)?.has(identity.itemKey)) continue;
        const groups = unknown.get(identity.scopeKey) ?? new Map<string, string>();
        groups.set(identity.itemKey, item.type === 'header' ? item.groupKey ?? identity.itemKey : identity.itemKey);
        unknown.set(identity.scopeKey, groups);
    }
    for (const [scopeKey, groups] of unknown) {
        // Run-only groups have no admitted Session-created seed. Their qualified identity
        // breaks ties after known groups; Run/ref timestamps never become a second clock.
        (seed[scopeKey] ??= []).push(...[...groups].sort((left, right) => left[1].localeCompare(right[1])).map(([key]) => key));
    }
    const seeded = applySessionWorkspaceOrderV1ToIndex(params.source, seed);
    const retained = retainSessionProjectGroupOrder(seeded, params.previousPresentedIndex);
    return applySessionWorkspaceOrderV1ToIndex(retained, params.savedOrder);
}

export function areSessionWorkspaceOrderMapsEqual(
    a: SessionWorkspaceOrderV1,
    b: SessionWorkspaceOrderV1,
): boolean {
    const aKeys = Object.keys(a ?? {}).sort();
    const bKeys = Object.keys(b ?? {}).sort();
    if (aKeys.length !== bKeys.length) return false;
    for (let i = 0; i < aKeys.length; i += 1) {
        if (aKeys[i] !== bKeys[i]) return false;
        const key = aKeys[i]!;
        const av = a[key] ?? [];
        const bv = b[key] ?? [];
        if (av.length !== bv.length) return false;
        for (let j = 0; j < av.length; j += 1) {
            if (av[j] !== bv[j]) return false;
        }
    }
    return true;
}
