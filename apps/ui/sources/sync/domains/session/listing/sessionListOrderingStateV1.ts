import type { SessionListViewItem } from './sessionListViewData';

export const PINNED_GROUP_KEY_V1 = 'pinned-v1';

export const SESSION_LIST_GROUP_ORDER_MAX_KEYS_PER_GROUP = 100;

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

export function normalizeSessionListGroupOrderV1ForSource(params: Readonly<{
    source: ReadonlyArray<SessionListViewItem>;
    pinnedSessionKeysV1: ReadonlyArray<string>;
    sessionListGroupOrderV1: Readonly<Record<string, ReadonlyArray<string> | undefined>>;
}>): Record<string, string[]> {
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
