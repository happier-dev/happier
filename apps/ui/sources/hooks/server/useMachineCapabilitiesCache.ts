import * as React from 'react';
import {
    machineCapabilitiesDetect,
    type MachineCapabilitiesDetectResult,
} from '@/sync/ops';
import type { CapabilitiesDetectRequest, CapabilitiesDetectResponse, CapabilityDetectResult, CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';
import { CHECKLIST_IDS, resumeChecklistId } from '@happier-dev/protocol/checklists';
import { AGENT_IDS } from '@/agents/catalog/catalog';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

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

function toCacheKey(machineIdRaw: string, serverIdRaw?: string | null): string {
    const machineId = String(machineIdRaw ?? '').trim();
    const serverId = resolveServerId(serverIdRaw);
    return JSON.stringify(['machineCapabilities', serverId || null, machineId]);
}

function getEntry(cacheKey: string): CacheEntry | null {
    return cache.get(cacheKey) ?? null;
}

export function getMachineCapabilitiesCacheState(machineId: string, serverId?: string | null): MachineCapabilitiesCacheState | null {
    const entry = getEntry(toCacheKey(machineId, serverId));
    return entry ? entry.state : null;
}

export function getMachineCapabilitiesSnapshot(machineId: string, serverId?: string | null): MachineCapabilitiesSnapshot | null {
    const state = getMachineCapabilitiesCacheState(machineId, serverId);
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

function mergeCapabilityResult(id: CapabilityId, prev: CapabilityDetectResult | undefined, next: CapabilityDetectResult): CapabilityDetectResult {
    if (!prev) return next;
    if (!prev.ok || !next.ok) return next;

    // Only merge partial results for deps; CLI/tool checks should replace to avoid keeping stale paths/versions.
    if (!id.startsWith('dep.')) return next;
    if (!isPlainObject(prev.data) || !isPlainObject(next.data)) return next;

    return { ...next, data: { ...prev.data, ...next.data } };
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

function getTimeoutMsForRequest(request: CapabilitiesDetectRequest, fallback: number): number {
    // Default fast timeout; opt into longer waits for npm registry checks.
    const requests = Array.isArray(request.requests) ? request.requests : [];
    const hasRegistryCheck = requests.some((r) => Boolean((r.params as any)?.includeRegistry));
    const isResumeChecklist = AGENT_IDS.some((agentId) => request.checklistId === resumeChecklistId(agentId));
    const isMachineDetailsChecklist = request.checklistId === CHECKLIST_IDS.MACHINE_DETAILS;
    if (hasRegistryCheck || isResumeChecklist) return Math.max(fallback, 12_000);
    if (isMachineDetailsChecklist) return Math.max(fallback, 8_000);
    return fallback;
}

function readMachineCapabilitiesErrorBackoffMsFromEnv(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_MACHINE_CAPABILITIES_ERROR_BACKOFF_MS ?? '').trim();
    if (!raw) return DEFAULT_ERROR_BACKOFF_MS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_ERROR_BACKOFF_MS;
    return Math.max(0, Math.min(10 * 60_000, parsed));
}

function stableJsonStringify(value: unknown): string {
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (Array.isArray(value)) return `[${value.map((v) => stableJsonStringify(v)).join(',')}]`;
    if (typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        const keys = Object.keys(obj).sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJsonStringify(obj[k])}`).join(',')}}`;
    }
    // functions/symbols/etc: treat as null for cache key stability
    return 'null';
}

function detectRequestKey(request: CapabilitiesDetectRequest): string {
    const checklistId = typeof request.checklistId === 'string' ? request.checklistId : null;
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
        requests: normalizedRequests,
        overrides: normalizedOverrides,
    });
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
    request: CapabilitiesDetectRequest;
    timeoutMs?: number;
}): Promise<void> {
    const cacheKey = toCacheKey(params.machineId, params.serverId);
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
            : getTimeoutMsForRequest(params.request, DEFAULT_FETCH_TIMEOUT_MS);

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
    request: CapabilitiesDetectRequest;
    timeoutMs?: number;
}): Promise<void> {
    return fetchAndMerge(params);
}

export function prefetchMachineCapabilitiesIfStale(params: {
    machineId: string;
    serverId?: string | null;
    staleMs: number;
    request: CapabilitiesDetectRequest;
    timeoutMs?: number;
}): Promise<void> {
    const cacheKey = toCacheKey(params.machineId, params.serverId);
    const existing = getEntry(cacheKey);
    if (!existing || existing.state.status === 'idle') {
        return fetchAndMerge({
            machineId: params.machineId,
            serverId: params.serverId,
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
            request: params.request,
            timeoutMs: params.timeoutMs,
        });
    }
    return Promise.resolve();
}

export function useMachineCapabilitiesCache(params: {
    machineId: string | null;
    serverId?: string | null;
    enabled: boolean;
    staleMs?: number;
    request: CapabilitiesDetectRequest;
    timeoutMs?: number;
}): { state: MachineCapabilitiesCacheState; refresh: (next?: { request?: CapabilitiesDetectRequest; timeoutMs?: number }) => void } {
    const { machineId, enabled, staleMs = DEFAULT_STALE_MS, serverId } = params;
    const cacheKey = machineId ? toCacheKey(machineId, serverId) : null;

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

    const refresh = React.useCallback((next?: { request?: CapabilitiesDetectRequest; timeoutMs?: number }) => {
        if (!machineId) return;
        void fetchAndMerge({
            machineId,
            serverId,
            request: next?.request ?? requestRef.current,
            timeoutMs: typeof next?.timeoutMs === 'number' ? next.timeoutMs : timeoutMsRef.current,
        });
        const entry = getEntry(toCacheKey(machineId, serverId));
        if (entry) setState(entry.state);
    }, [machineId, serverId]);

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

        const now = Date.now();
        const shouldFetch = shouldRefetchEntry({ entry: entry ?? null, staleMs, nowMs: now });
        if (shouldFetch) {
            refresh();
        }

        return unsubscribe;
    }, [cacheKey, enabled, refresh, staleMs]);

    return { state, refresh };
}
