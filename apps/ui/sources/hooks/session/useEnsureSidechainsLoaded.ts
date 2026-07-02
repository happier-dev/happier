import * as React from 'react';

import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { runTasksWithLimit } from '@/sync/runtime/orchestration/runTasksWithLimit';
import { sync } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';

const SIDECHAIN_DEMAND_HYDRATION_CONCURRENCY_FALLBACK = 2;
const SIDECHAIN_DEMAND_HYDRATION_CONCURRENCY_MIN = 1;
const SIDECHAIN_DEMAND_HYDRATION_CONCURRENCY_MAX = 8;

type EnsureSidechainMessagesLoadedStatus = Awaited<ReturnType<typeof sync.ensureSidechainMessagesLoaded>>;

export type SidechainHydrationStatus =
    | 'idle'
    | 'loading'
    | 'in_flight'
    | 'loaded'
    | 'not_ready'
    | 'retrying'
    | 'error';

export type SidechainHydrationEntry = Readonly<{
    key: string;
    sessionId: string;
    sidechainId: string;
    status: SidechainHydrationStatus;
    retryCount: number;
}>;

export type SidechainHydrationSnapshot = Readonly<{
    status: SidechainHydrationStatus;
    entries: readonly SidechainHydrationEntry[];
    bySidechainId: Readonly<Record<string, SidechainHydrationEntry>>;
    pendingCount: number;
    loadedCount: number;
}>;

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

function readSidechainDemandHydrationConcurrencyLimit(): number {
    const tuning = typeof sync.getSyncTuning === 'function' ? sync.getSyncTuning() : null;
    const value = tuning?.sidechainDemandHydrationConcurrencyLimit;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return SIDECHAIN_DEMAND_HYDRATION_CONCURRENCY_FALLBACK;
    }
    const normalized = Math.trunc(value);
    if (normalized < SIDECHAIN_DEMAND_HYDRATION_CONCURRENCY_MIN || normalized > SIDECHAIN_DEMAND_HYDRATION_CONCURRENCY_MAX) {
        return SIDECHAIN_DEMAND_HYDRATION_CONCURRENCY_FALLBACK;
    }
    return normalized;
}

function createRequestKey(sessionId: string, sidechainId: string): string {
    return `${sessionId}\n${sidechainId}`;
}

export function isSidechainHydrationPendingStatus(status: SidechainHydrationStatus | undefined): boolean {
    return status === 'loading' || status === 'in_flight' || status === 'retrying';
}

function aggregateStatus(entries: readonly SidechainHydrationEntry[]): SidechainHydrationStatus {
    if (entries.length === 0) return 'idle';
    if (entries.some((entry) => entry.status === 'error')) return 'error';
    if (entries.some((entry) => entry.status === 'retrying')) return 'retrying';
    if (entries.some((entry) => entry.status === 'not_ready')) return 'not_ready';
    if (entries.some((entry) => entry.status === 'loading')) return 'loading';
    if (entries.some((entry) => entry.status === 'in_flight')) return 'in_flight';
    if (entries.every((entry) => entry.status === 'loaded')) return 'loaded';
    return 'idle';
}

export function useEnsureSidechainsLoaded(params: Readonly<{
    enabled: boolean;
    sessionId?: string;
    sidechainIds: readonly (string | null | undefined)[];
}>): SidechainHydrationSnapshot {
    const { enabled, sessionId, sidechainIds } = params;
    const normalizedSessionId = React.useMemo(() => normalizeSessionId(sessionId), [sessionId]);
    const requestedKeysRef = React.useRef<Set<string>>(new Set());
    const retryTimeoutsRef = React.useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
    const retryCountsRef = React.useRef<Map<string, number>>(new Map());
    const [entryState, setEntryState] = React.useState<Record<string, SidechainHydrationEntry>>({});
    const [retryTick, bumpRetryTick] = React.useReducer((value: number) => value + 1, 0);

    const normalizedSidechainIds = React.useMemo(() => {
        const ids = new Set<string>();
        for (const rawSidechainId of sidechainIds) {
            const normalizedSidechainId = typeof rawSidechainId === 'string' ? rawSidechainId.trim() : '';
            if (normalizedSidechainId) {
                ids.add(normalizedSidechainId);
            }
        }
        return [...ids];
    }, [sidechainIds]);

    const requests = React.useMemo(() => {
        if (!enabled || !normalizedSessionId) return [];
        return normalizedSidechainIds.map((sidechainId) => ({
            key: createRequestKey(normalizedSessionId, sidechainId),
            sessionId: normalizedSessionId,
            sidechainId,
        }));
    }, [enabled, normalizedSessionId, normalizedSidechainIds]);

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

    const scheduleRetry = React.useCallback((requestKey: string, options?: Readonly<{
        countAgainstRetryBudget?: boolean;
        respectMaxRetries?: boolean;
    }>): boolean => {
        if (retryTimeoutsRef.current.has(requestKey)) return true;
        const retryCount = retryCountsRef.current.get(requestKey) ?? 0;
        const countAgainstRetryBudget = options?.countAgainstRetryBudget ?? true;
        const respectMaxRetries = options?.respectMaxRetries ?? true;
        if (respectMaxRetries && retryCount >= readEnsureSidechainMaxRetriesFromEnv()) return false;
        if (countAgainstRetryBudget) {
            retryCountsRef.current.set(requestKey, retryCount + 1);
        }
        const timeoutId = setTimeout(() => {
            retryTimeoutsRef.current.delete(requestKey);
            bumpRetryTick();
        }, computeRetryDelayMs(countAgainstRetryBudget ? retryCount : 0));
        retryTimeoutsRef.current.set(requestKey, timeoutId);
        return true;
    }, []);

    const updateEntryStatus = React.useCallback((
        request: Readonly<{ key: string; sessionId: string; sidechainId: string }>,
        status: SidechainHydrationStatus,
    ) => {
        setEntryState((previous) => ({
            ...previous,
            [request.key]: {
                key: request.key,
                sessionId: request.sessionId,
                sidechainId: request.sidechainId,
                status,
                retryCount: retryCountsRef.current.get(request.key) ?? 0,
            },
        }));
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
        if (!enabled || requests.length === 0) return;

        const pendingRequests = requests.filter((request) => {
            if (requestedKeysRef.current.has(request.key)) return false;
            const existingStatus = entryState[request.key]?.status;
            if (!existingStatus || existingStatus === 'idle') return true;
            if (existingStatus !== 'retrying' && existingStatus !== 'in_flight') return false;
            return !retryTimeoutsRef.current.has(request.key);
        });
        if (pendingRequests.length === 0) return;

        for (const request of pendingRequests) {
            requestedKeysRef.current.add(request.key);
        }

        setEntryState((previous) => {
            const next = { ...previous };
            for (const request of pendingRequests) {
                next[request.key] = {
                    key: request.key,
                    sessionId: request.sessionId,
                    sidechainId: request.sidechainId,
                    status: 'loading',
                    retryCount: retryCountsRef.current.get(request.key) ?? 0,
                };
            }
            return next;
        });

        const tasks = pendingRequests.map((request) => async (): Promise<EnsureSidechainMessagesLoadedStatus> => {
            try {
                const status = await sync.ensureSidechainMessagesLoaded(request.sessionId, request.sidechainId);
                if (status === 'loaded') {
                    resetRetryState(request.key);
                    updateEntryStatus(request, 'loaded');
                    return status;
                }
                requestedKeysRef.current.delete(request.key);
                if (status === 'in_flight') {
                    scheduleRetry(request.key, {
                        countAgainstRetryBudget: false,
                        respectMaxRetries: false,
                    });
                    updateEntryStatus(request, 'in_flight');
                    return status;
                }
                const retryScheduled = scheduleRetry(request.key);
                updateEntryStatus(request, retryScheduled ? 'retrying' : 'not_ready');
                return status;
            } catch {
                requestedKeysRef.current.delete(request.key);
                const retryScheduled = scheduleRetry(request.key);
                updateEntryStatus(request, retryScheduled ? 'retrying' : 'error');
                return 'not_ready';
            }
        });

        fireAndForget(runTasksWithLimit(tasks, readSidechainDemandHydrationConcurrencyLimit()), {
            tag: 'useEnsureSidechainsLoaded',
        });
    }, [enabled, entryState, requests, resetRetryState, retryTick, scheduleRetry, updateEntryStatus]);

    return React.useMemo(() => {
        const entries = requests.map((request): SidechainHydrationEntry => (
            entryState[request.key] ?? {
                key: request.key,
                sessionId: request.sessionId,
                sidechainId: request.sidechainId,
                status: 'idle',
                retryCount: retryCountsRef.current.get(request.key) ?? 0,
            }
        ));
        const bySidechainId: Record<string, SidechainHydrationEntry> = {};
        let pendingCount = 0;
        let loadedCount = 0;
        for (const entry of entries) {
            bySidechainId[entry.sidechainId] = entry;
            if (isSidechainHydrationPendingStatus(entry.status)) pendingCount += 1;
            if (entry.status === 'loaded') loadedCount += 1;
        }
        return {
            status: aggregateStatus(entries),
            entries,
            bySidechainId,
            pendingCount,
            loadedCount,
        };
    }, [entryState, requests]);
}
