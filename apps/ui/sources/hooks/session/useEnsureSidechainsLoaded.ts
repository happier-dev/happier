import * as React from 'react';

import { sync } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';

function readEnsureSidechainRetryDelayMsFromEnv(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_ENSURE_SIDECHAIN_RETRY_MS ?? '').trim();
    if (!raw) return 250;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return 250;
    return Math.max(10, Math.min(10_000, parsed));
}

function readEnsureSidechainMaxRetriesFromEnv(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_ENSURE_SIDECHAIN_MAX_RETRIES ?? '').trim();
    if (!raw) return 6;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return 6;
    return Math.max(0, Math.min(100, parsed));
}

function computeRetryDelayMs(retryCount: number): number {
    const baseDelayMs = readEnsureSidechainRetryDelayMsFromEnv();
    const exponent = Math.max(0, Math.min(6, retryCount));
    return Math.min(30_000, baseDelayMs * (2 ** exponent));
}

export function useEnsureSidechainsLoaded(params: Readonly<{
    enabled: boolean;
    sessionId?: string;
    sidechainIds: readonly (string | null | undefined)[];
}>): void {
    const { enabled, sessionId, sidechainIds } = params;
    const requestedKeysRef = React.useRef<Set<string>>(new Set());
    const retryTimeoutsRef = React.useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
    const retryCountsRef = React.useRef<Map<string, number>>(new Map());
    const [retryTick, bumpRetryTick] = React.useReducer((value: number) => value + 1, 0);

    const clearRetry = React.useCallback((requestKey: string) => {
        const existing = retryTimeoutsRef.current.get(requestKey);
        if (existing === undefined) return;
        clearTimeout(existing);
        retryTimeoutsRef.current.delete(requestKey);
    }, []);

    const resetRetryState = React.useCallback((requestKey: string) => {
        clearRetry(requestKey);
        retryCountsRef.current.delete(requestKey);
    }, [clearRetry]);

    const scheduleRetry = React.useCallback((requestKey: string) => {
        if (retryTimeoutsRef.current.has(requestKey)) return;
        const retryCount = retryCountsRef.current.get(requestKey) ?? 0;
        if (retryCount >= readEnsureSidechainMaxRetriesFromEnv()) return;
        retryCountsRef.current.set(requestKey, retryCount + 1);
        const timeoutId = setTimeout(() => {
            retryTimeoutsRef.current.delete(requestKey);
            bumpRetryTick();
        }, computeRetryDelayMs(retryCount));
        retryTimeoutsRef.current.set(requestKey, timeoutId);
    }, []);

    React.useEffect(() => {
        return () => {
            for (const timeoutId of retryTimeoutsRef.current.values()) {
                clearTimeout(timeoutId);
            }
            retryTimeoutsRef.current.clear();
            retryCountsRef.current.clear();
        };
    }, []);

    React.useEffect(() => {
        if (!enabled) return;

        const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
        if (!normalizedSessionId) return;

        for (const rawSidechainId of sidechainIds) {
            const normalizedSidechainId = typeof rawSidechainId === 'string' ? rawSidechainId.trim() : '';
            if (!normalizedSidechainId) continue;
            const requestKey = `${normalizedSessionId}\n${normalizedSidechainId}`;
            if (requestedKeysRef.current.has(requestKey)) continue;
            requestedKeysRef.current.add(requestKey);

            const request = sync.ensureSidechainMessagesLoaded(normalizedSessionId, normalizedSidechainId)
                .then((status) => {
                    if (status === 'loaded') {
                        resetRetryState(requestKey);
                        return status;
                    }
                    requestedKeysRef.current.delete(requestKey);
                    scheduleRetry(requestKey);
                    return status;
                })
                .catch((error) => {
                    requestedKeysRef.current.delete(requestKey);
                    scheduleRetry(requestKey);
                    throw error;
                });

            fireAndForget(request, { tag: 'useEnsureSidechainsLoaded' });
        }
    }, [enabled, resetRetryState, retryTick, scheduleRetry, sessionId, sidechainIds]);
}
