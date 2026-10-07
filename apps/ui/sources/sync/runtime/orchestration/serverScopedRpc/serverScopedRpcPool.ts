import type { HomeCarrier } from '@/sync/runtime/homeCarrier';
import {
    createNotAuthenticatedError,
    isAuthenticationResponseStatus,
    isTerminalAuthError,
} from '@/sync/runtime/connectivity/authErrors';
import {
    isPlainMachineDataKeyMarker,
    resolvePublishedMachineDataEncryptionKeyV1,
    type ExpectedRunnerMachineContentKeyBindingV1,
} from '@happier-dev/protocol/machines/machineStoredContent';

import { getOrCreateScopedCacheTokenKey, resetScopedCacheTokenKeysForTests } from './scopedCacheTokenKey';
import { createScopedResolutionSingleFlight } from './scopedResolutionSingleFlight';
import { createServerRequestForExplicitServerScope } from './createServerRequestWithServerScope';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from './serverScopedRpcTypes';

export type ScopedMachineTransport =
    | Readonly<{ mode: 'plain' }>
    | Readonly<{ mode: 'e2ee'; dataKey: Uint8Array | null }>;

function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

function toMachineTransportCacheKey(serverId: string, machineId: string, token: string): string {
    const tokenKey = getOrCreateScopedCacheTokenKey(token, readMaxMachineKeyCacheEntriesFromEnv());
    return `${serverId}::${machineId}::${tokenKey}`;
}

type MachineTransportEvidence = Readonly<{
    machine: Parameters<typeof resolvePublishedMachineDataEncryptionKeyV1>[0]['machine'];
    openedDataEncryptionKey: Uint8Array | null;
}>;

const machineTransportCache = new Map<string, MachineTransportEvidence>();
const machineTransportResolutions = createScopedResolutionSingleFlight<MachineTransportEvidence | null>();

function readMaxMachineKeyCacheEntriesFromEnv(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_SCOPED_RPC_MACHINE_KEY_CACHE_MAX ?? '').trim();
    if (!raw) return 256;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return 256;
    return Math.max(1, Math.min(10_000, parsed));
}

function getMachineTransportFromCache(cacheKey: string): MachineTransportEvidence | undefined {
    const existing = machineTransportCache.get(cacheKey);
    if (existing === undefined) return undefined;
    // Refresh LRU ordering.
    machineTransportCache.delete(cacheKey);
    machineTransportCache.set(cacheKey, existing);
    return existing;
}

function setMachineTransportCache(cacheKey: string, value: MachineTransportEvidence): void {
    machineTransportCache.set(cacheKey, value);

    const max = readMaxMachineKeyCacheEntriesFromEnv();
    while (machineTransportCache.size > max) {
        const oldest = machineTransportCache.keys().next();
        if (oldest.done) break;
        machineTransportCache.delete(oldest.value);
    }
}

async function fetchMachineTransport(params: Readonly<{
    serverUrl: string;
    runtimeOrigin?: string;
    homeCarrier?: HomeCarrier;
    token: string;
    machineId: string;
    serverId: string;
    accountId?: string;
    decryptEncryptionKey?: (value: string) => Promise<Uint8Array | null>;
    timeoutMs: number;
}>): Promise<MachineTransportEvidence | null> {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller
        ? setTimeout(() => controller.abort(), Math.max(1, params.timeoutMs))
        : null;

    try {
        const request = createServerRequestForExplicitServerScope({
            serverUrl: params.serverUrl,
            token: params.token,
            ...(params.runtimeOrigin ? { runtimeOrigin: params.runtimeOrigin } : {}),
            ...(params.homeCarrier ? { homeCarrier: params.homeCarrier } : {}),
            timeoutMs: params.timeoutMs,
        });
        const response = await request(`/v1/machines/${encodeURIComponent(params.machineId)}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            ...(controller ? { signal: controller.signal } : {}),
        });
        if (!response.ok) {
            if (isAuthenticationResponseStatus(response.status)) {
                throw createNotAuthenticatedError(response.status);
            }
            return null;
        }

        const body = await response.json() as {
            machine?: {
                id?: unknown;
                kind?: 'persistent' | 'ephemeral_session_runner';
                installationId?: string | null;
                dataEncryptionKey?: unknown;
                runnerContentKeyBinding?: unknown;
            };
        };
        const machine = body?.machine;
        if (normalizeId(machine?.id) !== params.machineId) {
            return null;
        }
        const published = machine?.dataEncryptionKey;
        const dataKey = typeof published === 'string'
            && !isPlainMachineDataKeyMarker(published)
            && params.decryptEncryptionKey
            ? await params.decryptEncryptionKey(published)
            : null;
        return {
            machine: {
                id: params.machineId,
                kind: machine?.kind,
                installationId: machine?.installationId,
                dataEncryptionKey: published,
                runnerContentKeyBinding: machine?.runnerContentKeyBinding,
            },
            openedDataEncryptionKey: dataKey,
        };
    } catch (error) {
        if (isTerminalAuthError(error)) {
            throw error;
        }
        return null;
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

export async function resolveScopedMachineTransport(params: Readonly<{
    serverId: string;
    serverUrl: string;
    runtimeOrigin?: string;
    homeCarrier?: HomeCarrier;
    token: string;
    machineId: string;
    accountId?: string;
    expectedAccountMode?: 'plain' | 'e2ee';
    expectedRunnerBinding?: ExpectedRunnerMachineContentKeyBindingV1;
    trustedMachineKind?: 'ephemeral_session_runner';
    decryptEncryptionKey?: (value: string) => Promise<Uint8Array | null>;
    timeoutMs?: number;
}>): Promise<ScopedMachineTransport | null> {
    const machineId = normalizeId(params.machineId);
    const serverId = normalizeId(params.serverId);
    const token = String(params.token ?? '');
    const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS;
    const keyCacheKey = toMachineTransportCacheKey(serverId, machineId, token);
    // A cold lookup is bounded by its caller's remaining RPC budget. Calls
    // with different budgets cannot share the first caller's timeout result.
    const flightKey = `${keyCacheKey}::${timeoutMs}`;

    // Share only the published row and envelope open. Trust is caller-owned and
    // must be rechecked even on cache hits and joins of an earlier cold read.
    const evidence = getMachineTransportFromCache(keyCacheKey)
        ?? await machineTransportResolutions.run(flightKey, async () => await fetchMachineTransport({
            serverId,
            serverUrl: params.serverUrl,
            ...(params.runtimeOrigin ? { runtimeOrigin: params.runtimeOrigin } : {}),
            ...(params.homeCarrier ? { homeCarrier: params.homeCarrier } : {}),
            token,
            machineId,
            ...(params.accountId ? { accountId: params.accountId } : {}),
            decryptEncryptionKey: params.decryptEncryptionKey,
            timeoutMs,
        }));
    if (!evidence) return null;
    const resolution = resolvePublishedMachineDataEncryptionKeyV1({
        ...evidence,
        ...(params.expectedAccountMode ? { expectedAccountMode: params.expectedAccountMode } : {}),
        ...(params.expectedRunnerBinding ? { expectedRunnerBinding: params.expectedRunnerBinding } : {}),
        ...(params.trustedMachineKind ? { trustedMachineKind: params.trustedMachineKind } : {}),
    });
    if (resolution.status === 'unavailable') {
        machineTransportCache.delete(keyCacheKey);
        return null;
    }
    if (resolution.status === 'legacy') return { mode: 'e2ee', dataKey: null };
    setMachineTransportCache(keyCacheKey, evidence);
    return resolution.status === 'plain'
        ? { mode: 'plain' }
        : { mode: 'e2ee', dataKey: resolution.dataKey };
}

export function resetScopedMachineTransportCacheForTests(): void {
    machineTransportCache.clear();
    machineTransportResolutions.reset();
    resetScopedCacheTokenKeysForTests();
}
