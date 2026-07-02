import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

import type { SessionListViewItem } from './sessionListViewData';

export const SESSION_WORKSPACE_ORDER_MAX_KEYS_PER_SCOPE = 100;

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

function capKeys(keys: ReadonlyArray<string>, max: number): string[] {
    if (keys.length <= max) return [...keys];
    return keys.slice(0, max);
}

export function buildSessionWorkspaceOrderScopeKey(serverIdRaw: unknown): string {
    return `server:${normalizeServerIdForWorkspaceOrder(serverIdRaw)}:workspaces`;
}

export function buildSessionWorkspaceOrderItemKey(workspaceKeyRaw: unknown): string | null {
    const workspaceKey = normalizeWorkspaceKey(workspaceKeyRaw);
    return workspaceKey ? `workspace:${workspaceKey}` : null;
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
    return [...unordered, ...out];
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
}>): Record<string, string[]> {
    const allowedKeysByScope = new Map<string, Set<string>>();
    for (const item of params.source) {
        if (item.type !== 'header') continue;
        const identity = resolveWorkspaceOrderIdentity(item);
        if (!identity) continue;
        const bucket = allowedKeysByScope.get(identity.scopeKey) ?? new Set<string>();
        bucket.add(identity.itemKey);
        allowedKeysByScope.set(identity.scopeKey, bucket);
    }

    const out: Record<string, string[]> = {};
    for (const [scopeKeyRaw, keysRaw] of Object.entries(params.sessionWorkspaceOrderV1 ?? {})) {
        const scopeKey = typeof scopeKeyRaw === 'string' ? scopeKeyRaw.trim() : '';
        if (!scopeKey) continue;
        const normalizedKeys = capKeys(
            dedupePreserveOrder(Array.isArray(keysRaw) ? keysRaw : []),
            SESSION_WORKSPACE_ORDER_MAX_KEYS_PER_SCOPE,
        );
        const allowedKeys = allowedKeysByScope.get(scopeKey);
        const filtered = allowedKeys
            ? normalizedKeys.filter((key) => allowedKeys.has(key))
            : normalizedKeys;
        if (filtered.length > 0) {
            out[scopeKey] = filtered;
        }
    }

    return out;
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
