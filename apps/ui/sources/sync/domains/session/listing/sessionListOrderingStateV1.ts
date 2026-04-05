import type { SessionListViewItem } from './sessionListViewData';

export const PINNED_GROUP_KEY_V1 = 'pinned-v1';

export const SESSION_LIST_GROUP_ORDER_MAX_KEYS_PER_GROUP = 100;

export type SessionListOrderingModeV1 = 'custom' | 'created' | 'updated';

function normalizeSessionKey(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

function dedupePreserveOrder(keys: ReadonlyArray<string>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const key of keys) {
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(key);
    }
    return out;
}

function capKeys(keys: ReadonlyArray<string>, max: number): string[] {
    if (keys.length <= max) return [...keys];
    return keys.slice(0, max);
}

function buildSessionKey(item: Extract<SessionListViewItem, { type: 'session' }>): string | null {
    const serverId = typeof item.serverId === 'string' ? item.serverId.trim() : '';
    const sessionId = typeof item.session?.id === 'string' ? item.session.id.trim() : '';
    if (!serverId || !sessionId) return null;
    return `${serverId}:${sessionId}`;
}

function compareSessionItemsByOrderingMode(
    a: Extract<SessionListViewItem, { type: 'session' }>,
    b: Extract<SessionListViewItem, { type: 'session' }>,
    orderingMode: SessionListOrderingModeV1,
): number {
    if (orderingMode === 'updated') {
        if (b.session.updatedAt !== a.session.updatedAt) {
            return b.session.updatedAt - a.session.updatedAt;
        }
    } else if (orderingMode === 'created') {
        if (b.session.createdAt !== a.session.createdAt) {
            return b.session.createdAt - a.session.createdAt;
        }
    } else {
        if (b.session.createdAt !== a.session.createdAt) {
            return b.session.createdAt - a.session.createdAt;
        }
    }

    if (orderingMode === 'updated' && b.session.createdAt !== a.session.createdAt) {
        return b.session.createdAt - a.session.createdAt;
    }

    const aId = String(a.session?.id ?? '').trim();
    const bId = String(b.session?.id ?? '').trim();
    return aId.localeCompare(bId);
}

export function sortSessionListViewItemsByOrderingMode(
    source: ReadonlyArray<SessionListViewItem>,
    orderingMode: SessionListOrderingModeV1,
): SessionListViewItem[] {
    if (orderingMode === 'custom') {
        return source as SessionListViewItem[];
    }

    const sessionsByGroupKey = new Map<string, Array<Extract<SessionListViewItem, { type: 'session' }>>>();
    for (const item of source) {
        if (item.type !== 'session') continue;
        const groupKey = typeof item.groupKey === 'string' ? item.groupKey.trim() : '';
        if (!groupKey) continue;
        if (!sessionsByGroupKey.has(groupKey)) {
            sessionsByGroupKey.set(groupKey, []);
        }
        sessionsByGroupKey.get(groupKey)!.push(item);
    }

    const sortedByGroupKey = new Map<string, Array<Extract<SessionListViewItem, { type: 'session' }>>>();
    for (const [groupKey, sessions] of sessionsByGroupKey.entries()) {
        if (sessions.length < 2) continue;
        const next = [...sessions].sort((a, b) => compareSessionItemsByOrderingMode(a, b, orderingMode));
        sortedByGroupKey.set(groupKey, next);
    }

    if (sortedByGroupKey.size === 0) {
        return source as SessionListViewItem[];
    }

    const indicesByGroupKey = new Map<string, number>();
    const out: SessionListViewItem[] = [];
    let didChange = false;
    for (const item of source) {
        if (item.type !== 'session') {
            out.push(item);
            continue;
        }
        const groupKey = typeof item.groupKey === 'string' ? item.groupKey.trim() : '';
        const replacementList = groupKey ? sortedByGroupKey.get(groupKey) : undefined;
        if (!replacementList) {
            out.push(item);
            continue;
        }
        const index = indicesByGroupKey.get(groupKey) ?? 0;
        const replacement = replacementList[index] ?? item;
        if (replacement !== item) {
            didChange = true;
        }
        out.push(replacement);
        indicesByGroupKey.set(groupKey, index + 1);
    }

    return didChange ? out : (source as SessionListViewItem[]);
}

function buildSessionKeySetByGroupKey(source: ReadonlyArray<SessionListViewItem>): Map<string, Set<string>> {
    const map = new Map<string, Set<string>>();
    for (const item of source) {
        if (item.type !== 'session') continue;
        const groupKey = typeof item.groupKey === 'string' ? item.groupKey.trim() : '';
        if (!groupKey) continue;
        const sessionKey = buildSessionKey(item);
        if (!sessionKey) continue;
        const bucket = map.get(groupKey);
        if (!bucket) {
            map.set(groupKey, new Set([sessionKey]));
        } else {
            bucket.add(sessionKey);
        }
    }
    return map;
}

function isSessionListGroupOrderV1AlreadyNormalizedForSource(params: Readonly<{
    source: ReadonlyArray<SessionListViewItem>;
    pinnedSessionKeysV1: ReadonlyArray<string>;
    sessionListGroupOrderV1: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
}>): boolean {
    const pinnedSet = new Set(
        (params.pinnedSessionKeysV1 ?? [])
            .map((k) => normalizeSessionKey(k))
            .filter((k): k is string => Boolean(k)),
    );
    const sessionsByGroupKey = buildSessionKeySetByGroupKey(params.source);

    for (const [groupKeyRaw, keysRaw] of Object.entries(params.sessionListGroupOrderV1 ?? {})) {
        const groupKey = String(groupKeyRaw ?? '').trim();
        if (!groupKey) return false;
        if (!Array.isArray(keysRaw)) return false;

        const normalizedKeys = dedupePreserveOrder(
            keysRaw
                .map((k) => normalizeSessionKey(k))
                .filter((k): k is string => Boolean(k)),
        );

        if (normalizedKeys.length !== keysRaw.length) return false;
        for (let i = 0; i < normalizedKeys.length; i++) {
            if (normalizedKeys[i] !== keysRaw[i]) return false;
        }

        const capped = capKeys(normalizedKeys, SESSION_LIST_GROUP_ORDER_MAX_KEYS_PER_GROUP);
        if (capped.length !== normalizedKeys.length) return false;

        if (groupKey === PINNED_GROUP_KEY_V1) {
            for (const key of capped) {
                if (!pinnedSet.has(key)) return false;
            }
            continue;
        }

        const allowedKeys = sessionsByGroupKey.get(groupKey);
        if (!allowedKeys) continue;

        for (const key of capped) {
            if (!allowedKeys.has(key)) return false;
        }
    }

    return true;
}

export function normalizeSessionListGroupOrderV1ForSource(params: Readonly<{
    source: ReadonlyArray<SessionListViewItem>;
    pinnedSessionKeysV1: ReadonlyArray<string>;
    sessionListGroupOrderV1: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
}>): Record<string, string[]> {
    if (isSessionListGroupOrderV1AlreadyNormalizedForSource(params)) {
        return params.sessionListGroupOrderV1 as Record<string, string[]>;
    }

    const pinnedSet = new Set(
        (params.pinnedSessionKeysV1 ?? [])
            .map((k) => normalizeSessionKey(k))
            .filter((k): k is string => Boolean(k)),
    );
    const sessionsByGroupKey = buildSessionKeySetByGroupKey(params.source);
    const out: Record<string, string[]> = {};

    for (const [groupKeyRaw, keysRaw] of Object.entries(params.sessionListGroupOrderV1 ?? {})) {
        const groupKey = String(groupKeyRaw ?? '').trim();
        if (!groupKey) continue;

        const normalizedKeys = dedupePreserveOrder(
            (Array.isArray(keysRaw) ? keysRaw : [])
                .map((k) => normalizeSessionKey(k))
                .filter((k): k is string => Boolean(k)),
        );

        const capped = capKeys(normalizedKeys, SESSION_LIST_GROUP_ORDER_MAX_KEYS_PER_GROUP);

        if (groupKey === PINNED_GROUP_KEY_V1) {
            const filtered = capped.filter((k) => pinnedSet.has(k));
            if (filtered.length > 0) {
                out[groupKey] = filtered;
            }
            continue;
        }

        const allowedKeys = sessionsByGroupKey.get(groupKey);
        if (!allowedKeys) {
            if (capped.length > 0) {
                out[groupKey] = capped;
            }
            continue;
        }

        const filtered = capped.filter((k) => allowedKeys.has(k));
        const finalKeys = filtered;

        if (finalKeys.length > 0) {
            out[groupKey] = finalKeys;
        }
    }

    return out;
}

export function areSessionListGroupOrderMapsEqual(
    a: Readonly<Record<string, ReadonlyArray<string> | undefined>>,
    b: Readonly<Record<string, ReadonlyArray<string> | undefined>>,
): boolean {
    const aKeys = Object.keys(a ?? {}).sort();
    const bKeys = Object.keys(b ?? {}).sort();
    if (aKeys.length !== bKeys.length) return false;
    for (let i = 0; i < aKeys.length; i++) {
        if (aKeys[i] !== bKeys[i]) return false;
        const ak = aKeys[i];
        const av = a[ak] ?? [];
        const bv = b[ak] ?? [];
        if (av.length !== bv.length) return false;
        for (let j = 0; j < av.length; j++) {
            if (av[j] !== bv[j]) return false;
        }
    }
    return true;
}
