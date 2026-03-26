import * as React from 'react';
import {
    machineCapabilitiesDetect,
    type MachineCapabilitiesDetectResult,
} from '@/sync/ops';
import type { CapabilitiesDetectRequest, CapabilitiesDetectResponse, CapabilityDetectResult, CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';
import { CHECKLIST_IDS, resumeChecklistId } from '@happier-dev/protocol/checklists';
import { AGENT_IDS } from '@/agents/catalog/catalog';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

export type MachineCapabilitiesSnapshot = {
    response: CapabilitiesDetectResponse;
};

export type MachineCapabilitiesCacheState =
    | { status: 'idle' }
    | { status: 'loading'; snapshot?: MachineCapabilitiesSnapshot }
    | { status: 'loaded'; snapshot: MachineCapabilitiesSnapshot }
    | { status: 'not-supported' }
    | { status: 'error'; snapshot?: MachineCapabilitiesSnapshot };

type CacheEntry = {
    state: MachineCapabilitiesCacheState;
    updatedAt: number;
    inFlightToken?: number;
};

const cache = new Map<string, CacheEntry>();
const listeners = new Map<string, Set<(state: MachineCapabilitiesCacheState) => void>>();

const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_FETCH_TIMEOUT_MS = 2500;
const DEFAULT_ERROR_BACKOFF_MS = 60_000;
const DEFAULT_SLOW_FETCH_TIMEOUT_MS = 12_000;
const DEFAULT_CLI_LOGIN_STATUS_TIMEOUT_MS = 20_000;

type ScheduledFetch = Readonly<{
    requestKey: string;
    promise: Promise<void>;
}>;

const scheduledFetchByCacheKey = new Map<string, ScheduledFetch>();

function normalizeServerId(raw: string | null | undefined): string {
    return String(raw ?? '').trim();
}

function resolveServerId(raw: string | null | undefined): string {
    const explicit = normalizeServerId(raw);
    if (explicit) return explicit;
    return String(getActiveServerSnapshot().serverId ?? '').trim();
}

function normalizeCacheKeySalt(value: string | number | null | undefined): string | number | null {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    return null;
}

function toCacheKey(machineIdRaw: string, serverIdRaw?: string | null, cacheKeySaltRaw?: string | number | null): string {
    const machineId = String(machineIdRaw ?? '').trim();
    const serverId = resolveServerId(serverIdRaw);
    const cacheKeySalt = normalizeCacheKeySalt(cacheKeySaltRaw);
    return JSON.stringify(['machineCapabilities', serverId || null, machineId, cacheKeySalt]);
}

function getEntry(cacheKey: string): CacheEntry | null {
    return cache.get(cacheKey) ?? null;
}

function withDetectRequestBypassCache(request: CapabilitiesDetectRequest): CapabilitiesDetectRequest {
    if (request.bypassCache === true) return request;
    return {
        ...request,
        bypassCache: true,
    };
}

export function getMachineCapabilitiesCacheState(
    machineId: string,
    serverId?: string | null,
    cacheKeySalt?: string | number | null,
): MachineCapabilitiesCacheState | null {
    const entry = getEntry(toCacheKey(machineId, serverId, cacheKeySalt));
    return entry ? entry.state : null;
}

export function getMachineCapabilitiesSnapshot(
    machineId: string,
    serverId?: string | null,
    cacheKeySalt?: string | number | null,
): MachineCapabilitiesSnapshot | null {
    const state = getMachineCapabilitiesCacheState(machineId, serverId, cacheKeySalt);
    if (!state) return null;
    if (state.status === 'loaded') return state.snapshot;
    if (state.status === 'loading') return state.snapshot ?? null;
    if (state.status === 'error') return state.snapshot ?? null;
    return null;
}

function notify(cacheKey: string) {
    const entry = getEntry(cacheKey);
    if (!entry) return;
    const subs = listeners.get(cacheKey);
    if (!subs || subs.size === 0) return;
    for (const cb of subs) cb(entry.state);
}

function setEntry(cacheKey: string, entry: CacheEntry) {
    cache.set(cacheKey, entry);
    notify(cacheKey);
}

function subscribe(cacheKey: string, cb: (state: MachineCapabilitiesCacheState) => void): () => void {
    let set = listeners.get(cacheKey);
    if (!set) {
        set = new Set();
        listeners.set(cacheKey, set);
    }
    set.add(cb);
    return () => {
        const current = listeners.get(cacheKey);
        if (!current) return;
        current.delete(cb);
        if (current.size === 0) listeners.delete(cacheKey);
    };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function withDurableDepVersionCheckTimestamp(result: CapabilityDetectResult): CapabilityDetectResult {
    if (!result.ok) return result;
    if (!isPlainObject(result.data)) return result;

    const latestVersionCheck = result.data.latestVersionCheck;
    if (!isPlainObject(latestVersionCheck)) return result;
    if (typeof latestVersionCheck.checkedAt === 'number' && latestVersionCheck.checkedAt > 0) return result;
    if (typeof result.checkedAt !== 'number' || result.checkedAt <= 0) return result;

    return {
        ...result,
        data: {
            ...result.data,
            latestVersionCheck: {
                ...latestVersionCheck,
                checkedAt: result.checkedAt,
            },
        },
    };
}

function mergeCapabilityResult(id: CapabilityId, prev: CapabilityDetectResult | undefined, next: CapabilityDetectResult): CapabilityDetectResult {
    const normalizedPrev = prev ? withDurableDepVersionCheckTimestamp(prev) : undefined;
    const normalizedNext = withDurableDepVersionCheckTimestamp(next);

    if (!normalizedPrev) return normalizedNext;
    if (!normalizedPrev.ok || !normalizedNext.ok) return normalizedNext;

    // Only merge partial results for deps; CLI/tool checks should replace to avoid keeping stale paths/versions.
    if (!id.startsWith('dep.')) return normalizedNext;
    if (!isPlainObject(normalizedPrev.data) || !isPlainObject(normalizedNext.data)) return normalizedNext;

    return { ...normalizedNext, data: { ...normalizedPrev.data, ...normalizedNext.data } };
}

function mergeDetectResponses(prev: CapabilitiesDetectResponse | null, next: CapabilitiesDetectResponse): CapabilitiesDetectResponse {
    if (!prev) return next;
    const merged: Partial<Record<CapabilityId, CapabilityDetectResult>> = { ...prev.results };
    for (const [id, result] of Object.entries(next.results) as Array<[CapabilityId, CapabilityDetectResult]>) {
        merged[id] = mergeCapabilityResult(id, merged[id], result);
    }
    return {
        protocolVersion: 1,
        results: merged,
    };
}

function hasSlowLoginStatusProbe(request: CapabilitiesDetectRequest): boolean {
    const requests = Array.isArray(request.requests) ? request.requests : [];
    if (requests.some((entry) => Boolean((entry.params as any)?.includeLoginStatus))) {
        return true;
    }

    const overrides = isPlainObject(request.overrides) ? Object.values(request.overrides) : [];
    return overrides.some((entry) => Boolean((entry as any)?.params?.includeLoginStatus));
}

export function resolveMachineCapabilitiesTimeoutMs(request: CapabilitiesDetectRequest, fallback: number): number {
    // Default fast timeout; opt into longer waits for release/version metadata checks.
    const requests = Array.isArray(request.requests) ? request.requests : [];
    const hasSlowVersionCheck = requests.some((r) => Boolean((r.params as any)?.includeLatestVersion) || Boolean((r.params as any)?.includeRegistry));
    const hasExecutionRunsCheck = requests.some((r) => r?.id === 'tool.executionRuns');
    const hasSlowLoginStatusCheck = hasSlowLoginStatusProbe(request);
    const isResumeChecklist = AGENT_IDS.some((agentId) => request.checklistId === resumeChecklistId(agentId));
    const isMachineDetailsChecklist = request.checklistId === CHECKLIST_IDS.MACHINE_DETAILS;
    const isNewSessionChecklist = request.checklistId === CHECKLIST_IDS.NEW_SESSION;
    if (hasSlowLoginStatusCheck) return Math.max(fallback, DEFAULT_CLI_LOGIN_STATUS_TIMEOUT_MS);
    if (hasExecutionRunsCheck) return Math.max(fallback, DEFAULT_SLOW_FETCH_TIMEOUT_MS);
    if (hasSlowVersionCheck || isResumeChecklist) return Math.max(fallback, DEFAULT_SLOW_FETCH_TIMEOUT_MS);
    if (isMachineDetailsChecklist) return Math.max(fallback, DEFAULT_SLOW_FETCH_TIMEOUT_MS);
    if (isNewSessionChecklist) return Math.max(fallback, DEFAULT_SLOW_FETCH_TIMEOUT_MS);
    return fallback;
}

function readMachineCapabilitiesErrorBackoffMsFromEnv(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_MACHINE_CAPABILITIES_ERROR_BACKOFF_MS ?? '').trim();
    if (!raw) return DEFAULT_ERROR_BACKOFF_MS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_ERROR_BACKOFF_MS;
    return Math.max(0, Math.min(10 * 60_000, parsed));
}

function detectRequestKey(request: CapabilitiesDetectRequest): string {
    const checklistId = typeof request.checklistId === 'string' ? request.checklistId : null;
    const bypassCache = request.bypassCache === true;
    const requests = Array.isArray(request.requests) ? request.requests : [];
    const normalizedRequests = requests
        .map((r) => ({
            id: String((r as any)?.id ?? ''),
            params: isPlainObject((r as any)?.params) ? (r as any).params : null,
        }))
        .filter((r) => r.id.trim().length > 0)
        .sort((a, b) => a.id.localeCompare(b.id) || stableJsonStringify(a.params).localeCompare(stableJsonStringify(b.params)));

    const overridesRaw = isPlainObject(request.overrides) ? (request.overrides as Record<string, any>) : {};
    const normalizedOverrides = Object.keys(overridesRaw)
        .sort()
        .map((id) => ({
            id,
            params: isPlainObject(overridesRaw[id]?.params) ? overridesRaw[id].params : null,
        }));

    return stableJsonStringify({
        checklistId,
        bypassCache,
        requests: normalizedRequests,
        overrides: normalizedOverrides,
    });
}

function requestNeedsRefetchFromState(state: MachineCapabilitiesCacheState, request: CapabilitiesDetectRequest): boolean {
    const snapshot =
        state.status === 'loaded'
            ? state.snapshot
            : state.status === 'loading'
                ? state.snapshot
                : state.status === 'error'
                    ? state.snapshot
                    : undefined;
    if (!snapshot) return false;

    const results = snapshot.response.results;
    const requests = Array.isArray(request.requests) ? request.requests : [];
    const overrideEntries = isPlainObject(request.overrides)
        ? Object.entries(request.overrides as Record<string, { params?: Record<string, unknown> }>)
        : [];

    for (const entry of requests) {
        const capabilityId = typeof entry?.id === 'string' ? entry.id : '';
        if (!capabilityId) continue;
        if (!results[capabilityId as CapabilityId]) {
            return true;
        }
    }

    for (const [capabilityId] of overrideEntries) {
        if (!capabilityId) continue;
        if (!results[capabilityId as CapabilityId]) {
            return true;
        }
    }

    const capabilityIdsNeedingLoginStatus = new Set<string>();

    for (const entry of requests) {
        if (!entry?.id?.startsWith('cli.')) continue;
        if (Boolean((entry.params as any)?.includeLoginStatus)) {
            capabilityIdsNeedingLoginStatus.add(entry.id);
        }
    }

    for (const [capabilityId, override] of overrideEntries) {
        if (!capabilityId.startsWith('cli.')) continue;
        if (Boolean(override?.params?.includeLoginStatus)) {
            capabilityIdsNeedingLoginStatus.add(capabilityId);
        }
    }

    for (const capabilityId of capabilityIdsNeedingLoginStatus) {
        const result = results[capabilityId as CapabilityId];
        if (!result || !result.ok) return true;
        const data = isPlainObject(result.data) ? result.data : null;
        if (!data || !Object.prototype.hasOwnProperty.call(data, 'authStatus')) {
            return true;
        }
    }

    return false;
}

function shouldRefetchEntry(params: Readonly<{ entry: CacheEntry | null; staleMs: number; nowMs: number }>): boolean {
    const { entry, staleMs, nowMs } = params;
    if (!entry) return true;
    const ageMs = nowMs - entry.updatedAt;
    if (entry.state.status === 'idle') return true;
    if (entry.state.status === 'loading') return false;
    if (entry.state.status === 'loaded') return ageMs > staleMs;
    if (entry.state.status === 'not-supported') return false;
    if (entry.state.status === 'error') {
        if (staleMs < 0) return true;
        const backoffMs = readMachineCapabilitiesErrorBackoffMsFromEnv();
        if (backoffMs <= 0) return true;
        const thresholdMs = Math.min(staleMs, backoffMs);
        return ageMs >= thresholdMs;
    }
    return ageMs > staleMs;
}

async function fetchAndMerge(params: {
    machineId: string;
    serverId?: string | null;
    cacheKeySalt?: string | number | null;
    request: CapabilitiesDetectRequest;
    timeoutMs?: number;
}): Promise<void> {
    const cacheKey = toCacheKey(params.machineId, params.serverId, params.cacheKeySalt);
    const requestKey = detectRequestKey(params.request);
    const scheduled = scheduledFetchByCacheKey.get(cacheKey);
    if (scheduled && scheduled.requestKey === requestKey) {
        return await scheduled.promise;
    }

    const previousPromise = scheduled?.promise ?? Promise.resolve();
    const token = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);

    const scheduledPromise = previousPromise.then(async () => {
        const existing = getEntry(cacheKey);
        const prevSnapshot =
            existing?.state.status === 'loaded'
                ? existing.state.snapshot
                : existing?.state.status === 'loading'
                    ? existing.state.snapshot
                    : existing?.state.status === 'error'
                        ? existing.state.snapshot
                        : undefined;

        setEntry(cacheKey, {
            state: { status: 'loading', ...(prevSnapshot ? { snapshot: prevSnapshot } : {}) },
            updatedAt: Date.now(),
            inFlightToken: token,
        });

        const timeoutMs = typeof params.timeoutMs === 'number'
            ? params.timeoutMs
            : resolveMachineCapabilitiesTimeoutMs(params.request, DEFAULT_FETCH_TIMEOUT_MS);

        let result: MachineCapabilitiesDetectResult;
        try {
            result = await machineCapabilitiesDetect(params.machineId, params.request, {
                timeoutMs,
                serverId: params.serverId,
            });
        } catch {
            const current = getEntry(cacheKey);
            if (!current || current.inFlightToken !== token) {
                return;
            }

            setEntry(cacheKey, {
                state: prevSnapshot ? ({ status: 'error', snapshot: prevSnapshot } as const) : ({ status: 'error' } as const),
                updatedAt: Date.now(),
            });
            return;
        }

        const current = getEntry(cacheKey);
        if (!current || current.inFlightToken !== token) {
            return;
        }
        const baseResponse = prevSnapshot?.response ?? null;

        const nextState = (() => {
            if (result.supported) {
                const merged = mergeDetectResponses(baseResponse, result.response);
                const snapshot: MachineCapabilitiesSnapshot = { response: merged };
                return ({ status: 'loaded', snapshot } as const);
            }

            if (result.reason === 'not-supported') {
                return { status: 'not-supported' } as const;
            }

            if (result.reason === 'server-switch-abort') {
                return { status: 'idle' } as const;
            }

            return prevSnapshot
                ? ({ status: 'error', snapshot: prevSnapshot } as const)
                : ({ status: 'error' } as const);
        })();

        setEntry(cacheKey, {
            state: nextState,
            updatedAt: Date.now(),
        });
    });

    const finalPromise = scheduledPromise.finally(() => {
        const current = scheduledFetchByCacheKey.get(cacheKey);
        if (current?.promise === finalPromise) {
            scheduledFetchByCacheKey.delete(cacheKey);
        }
    });

    scheduledFetchByCacheKey.set(cacheKey, {
        requestKey,
        promise: finalPromise,
    });

    return await finalPromise;
}

export function prefetchMachineCapabilities(params: {
    machineId: string;
    serverId?: string | null;
    cacheKeySalt?: string | number | null;
    request: CapabilitiesDetectRequest;
    timeoutMs?: number;
}): Promise<void> {
    return fetchAndMerge(params);
}

export function prefetchMachineCapabilitiesIfStale(params: {
    machineId: string;
    serverId?: string | null;
    cacheKeySalt?: string | number | null;
    staleMs: number;
    request: CapabilitiesDetectRequest;
    timeoutMs?: number;
}): Promise<void> {
    const cacheKey = toCacheKey(params.machineId, params.serverId, params.cacheKeySalt);
    const existing = getEntry(cacheKey);
    if (!existing || existing.state.status === 'idle') {
        return fetchAndMerge({
            machineId: params.machineId,
            serverId: params.serverId,
            cacheKeySalt: params.cacheKeySalt,
            request: params.request,
            timeoutMs: params.timeoutMs,
        });
    }
    if (requestNeedsRefetchFromState(existing.state, params.request)) {
        return fetchAndMerge({
            machineId: params.machineId,
            serverId: params.serverId,
            cacheKeySalt: params.cacheKeySalt,
            request: params.request,
            timeoutMs: params.timeoutMs,
        });
    }
    const now = Date.now();
    const shouldFetch = shouldRefetchEntry({ entry: existing, staleMs: params.staleMs, nowMs: now });
    if (shouldFetch) {
        return fetchAndMerge({
            machineId: params.machineId,
            serverId: params.serverId,
            cacheKeySalt: params.cacheKeySalt,
            request: params.request,
            timeoutMs: params.timeoutMs,
        });
    }
    return Promise.resolve();
}

export function useMachineCapabilitiesCache(params: {
    machineId: string | null;
    serverId?: string | null;
    cacheKeySalt?: string | number | null;
    enabled: boolean;
    staleMs?: number;
    request: CapabilitiesDetectRequest;
    timeoutMs?: number;
}): { state: MachineCapabilitiesCacheState; refresh: (next?: { request?: CapabilitiesDetectRequest; timeoutMs?: number; bypassCache?: boolean }) => void } {
    const { machineId, enabled, staleMs = DEFAULT_STALE_MS, serverId, cacheKeySalt } = params;
    const cacheKey = machineId ? toCacheKey(machineId, serverId, cacheKeySalt) : null;

    // Keep the refresh function referentially stable even when callers pass a new request
    // object each render. This prevents effect churn (and, in extreme cases, navigation
    // setOptions loops) while still ensuring refresh uses the latest request/timeout.
    const requestRef = React.useRef<CapabilitiesDetectRequest>(params.request);
    requestRef.current = params.request;
    const timeoutMsRef = React.useRef<number | undefined>(params.timeoutMs);
    timeoutMsRef.current = params.timeoutMs;

    const [state, setState] = React.useState<MachineCapabilitiesCacheState>(() => {
        if (!cacheKey) return { status: 'idle' };
        const entry = getEntry(cacheKey);
        return entry?.state ?? { status: 'idle' };
    });

    const refresh = React.useCallback((next?: { request?: CapabilitiesDetectRequest; timeoutMs?: number; bypassCache?: boolean }) => {
        if (!machineId) return;
        void fetchAndMerge({
            machineId,
            serverId,
            cacheKeySalt,
            request: next?.bypassCache === true
                ? withDetectRequestBypassCache(next?.request ?? requestRef.current)
                : (next?.request ?? requestRef.current),
            timeoutMs: typeof next?.timeoutMs === 'number' ? next.timeoutMs : timeoutMsRef.current,
        });
        const entry = getEntry(toCacheKey(machineId, serverId, cacheKeySalt));
        if (entry) setState(entry.state);
    }, [cacheKeySalt, machineId, serverId]);

    React.useEffect(() => {
        if (!cacheKey) {
            setState({ status: 'idle' });
            return;
        }

        const unsubscribe = subscribe(cacheKey, (nextState) => setState(nextState));

        const entry = getEntry(cacheKey);
        if (entry) setState(entry.state);

        if (!enabled) {
            return unsubscribe;
        }

        if (entry && requestNeedsRefetchFromState(entry.state, requestRef.current)) {
            refresh();
            return unsubscribe;
        }

        const now = Date.now();
        const shouldFetch = shouldRefetchEntry({ entry: entry ?? null, staleMs, nowMs: now });
        if (shouldFetch) {
            refresh();
        }

        return unsubscribe;
    }, [cacheKey, enabled, refresh, staleMs]);

    return { state, refresh };
}
