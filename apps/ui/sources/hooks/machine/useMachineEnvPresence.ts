import * as React from 'react';

import { machinePreviewEnv, type PreviewEnvValue } from '@/sync/ops';

export type EnvPresenceMeta = Record<string, { isSet: boolean; display: PreviewEnvValue['display'] }>;

export type UseMachineEnvPresenceResult = Readonly<{
    isLoading: boolean;
    isPreviewEnvSupported: boolean;
    meta: EnvPresenceMeta;
    refreshedAt: number | null;
    refresh: () => void;
}>;

type CacheEntry = {
    updatedAt: number;
    isPreviewEnvSupported: boolean;
    meta: EnvPresenceMeta;
};

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<CacheEntry>>();

function parseScopedMachineKey(cacheKey: string): { serverId: string | null; machineId: string } | null {
    const firstSep = cacheKey.indexOf('::');
    if (firstSep <= 0) return null;

    const secondSep = cacheKey.indexOf('::', firstSep + 2);
    if (secondSep <= 0) {
        return {
            serverId: null,
            machineId: cacheKey.slice(0, firstSep),
        };
    }

    return {
        serverId: cacheKey.slice(0, firstSep),
        machineId: cacheKey.slice(firstSep + 2, secondSep),
    };
}

function matchesInvalidationTarget(cacheKey: string, machineId: string, serverId?: string | null): boolean {
    const parsed = parseScopedMachineKey(cacheKey);
    if (!parsed) return false;
    if (parsed.machineId !== machineId) return false;
    const normalizedServerId = String(serverId ?? '').trim();
    if (!normalizedServerId) return true;
    return parsed.serverId === normalizedServerId;
}

export function invalidateMachineEnvPresence(params?: { machineId?: string; serverId?: string | null }) {
    const machineId = typeof params?.machineId === 'string' ? params.machineId.trim() : '';
    for (const key of cache.keys()) {
        if (!machineId || matchesInvalidationTarget(key, machineId, params?.serverId)) {
            cache.delete(key);
        }
    }
    for (const key of inflight.keys()) {
        if (!machineId || matchesInvalidationTarget(key, machineId, params?.serverId)) {
            inflight.delete(key);
        }
    }
}

function makeCacheKey(machineId: string, keys: string[]): string {
    const sorted = [...keys].sort((a, b) => a.localeCompare(b)).join(',');
    return `${machineId}::${sorted}`;
}

function makeServerScopedMachineKey(machineId: string, serverId?: string | null): string {
    const sid = String(serverId ?? '').trim();
    if (!sid) return machineId;
    return `${sid}::${machineId}`;
}

function normalizeKeys(keys: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of keys) {
        if (typeof raw !== 'string') continue;
        const name = raw.trim();
        if (!name) continue;
        // Match the daemon-side var name validation.
        if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        out.push(name);
    }
    return out;
}

export function useMachineEnvPresence(
    machineId: string | null,
    keys: string[],
    opts?: {
        ttlMs?: number;
        serverId?: string | null;
    },
): UseMachineEnvPresenceResult {
    const ttlMs = opts?.ttlMs ?? 2 * 60_000;
    const serverId = opts?.serverId ?? null;
    const [refreshNonce, setRefreshNonce] = React.useState(0);

    const normalizedKeys = React.useMemo(() => normalizeKeys(keys), [keys]);
    const cacheKey = React.useMemo(() => {
        if (!machineId || normalizedKeys.length === 0) return null;
        const scopedMachineId = makeServerScopedMachineKey(machineId, serverId);
        return makeCacheKey(scopedMachineId, normalizedKeys);
    }, [machineId, normalizedKeys, serverId]);

    const [state, setState] = React.useState<{
        isLoading: boolean;
        isPreviewEnvSupported: boolean;
        meta: EnvPresenceMeta;
        refreshedAt: number | null;
    }>(() => ({
        isLoading: false,
        isPreviewEnvSupported: false,
        meta: {},
        refreshedAt: null,
    }));

    const refresh = React.useCallback(() => {
        if (cacheKey) cache.delete(cacheKey);
        setRefreshNonce((n) => n + 1);
    }, [cacheKey]);

    React.useEffect(() => {
        if (!machineId || normalizedKeys.length === 0 || !cacheKey) {
            setState({
                isLoading: false,
                isPreviewEnvSupported: false,
                meta: {},
                refreshedAt: null,
            });
            return;
        }

        let cancelled = false;
        const now = Date.now();
        const cached = cache.get(cacheKey);
        const isFresh = cached ? now - cached.updatedAt <= ttlMs : false;

        if (cached && isFresh) {
            setState({
                isLoading: false,
                isPreviewEnvSupported: cached.isPreviewEnvSupported,
                meta: cached.meta,
                refreshedAt: cached.updatedAt,
            });
            return;
        }

        // Keep any cached meta while refreshing (so UI doesn't flicker).
        setState((prev) => ({
            isLoading: true,
            isPreviewEnvSupported: cached?.isPreviewEnvSupported ?? prev.isPreviewEnvSupported,
            meta: cached?.meta ?? prev.meta,
            refreshedAt: cached?.updatedAt ?? prev.refreshedAt,
        }));

        const run = async (): Promise<CacheEntry> => {
            const preview = await machinePreviewEnv(machineId, {
                keys: normalizedKeys,
                // Never fetch secret values for presence-only checks.
                sensitiveKeys: normalizedKeys,
            }, {
                serverId,
            });

            if (!preview.supported) {
                return {
                    updatedAt: Date.now(),
                    isPreviewEnvSupported: false,
                    meta: {},
                };
            }

            const meta: EnvPresenceMeta = {};
            for (const name of normalizedKeys) {
                const entry = preview.response.values[name];
                meta[name] = {
                    isSet: Boolean(entry?.isSet),
                    display: entry?.display ?? 'unset',
                };
            }

            return {
                updatedAt: Date.now(),
                isPreviewEnvSupported: true,
                meta,
            };
        };

        const p = inflight.get(cacheKey) ?? run().finally(() => inflight.delete(cacheKey));
        inflight.set(cacheKey, p);

        void p.then((next) => {
            if (cancelled) return;
            cache.set(cacheKey, next);
            setState({
                isLoading: false,
                isPreviewEnvSupported: next.isPreviewEnvSupported,
                meta: next.meta,
                refreshedAt: next.updatedAt,
            });
        }).catch(() => {
            if (cancelled) return;
            setState((prev) => ({ ...prev, isLoading: false }));
        });

        return () => {
            cancelled = true;
        };
    }, [cacheKey, machineId, normalizedKeys, refreshNonce, ttlMs]);

    return {
        ...state,
        refresh,
    };
}
