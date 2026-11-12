import { MachineReadBatchRequestV1Schema, MachineReadBatchResponseV1Schema } from '@happier-dev/protocol/machines/machineReadBatchV1';
import type { MachinePublishedRowV1 } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { createServerHttpRequestBodyItemBudgetV1 } from '@happier-dev/protocol/server/http/requestBodyBoundsV1';
import type { FetchedMachineRow } from '@/sync/engine/machines/syncMachines';
import type { CapturedServerReadTransport } from '@/sync/runtime/orchestration/serverScopedRpc/capturedServerReadTransport';
import { createScopedBatchResolutionSingleFlight, createScopedResolutionSingleFlight } from '@/sync/runtime/orchestration/serverScopedRpc/scopedResolutionSingleFlight';
import { createNotAuthenticatedError, isAuthenticationResponseStatus } from '@/sync/runtime/connectivity/authErrors';
import { HappyError } from '@/utils/errors/errors';
import type { HomeCarrier } from '@/sync/runtime/homeCarrier';
import { createServerRequestForExplicitServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { createRpcCallError } from '@/sync/runtime/rpcErrors';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';

const selectedReads = createScopedBatchResolutionSingleFlight<MachinePublishedRowV1 | null>();
const censusReads = createScopedResolutionSingleFlight<readonly FetchedMachineRow[]>();
const explicitReads = createScopedResolutionSingleFlight<unknown>();

function machineRowTimeoutError() {
    return createRpcCallError({ error: 'Machine row request timed out', errorCode: 'MACHINE_RPC_TIMEOUT' });
}

/** Legacy explicit transports already capture their physical URL/carrier/credential inputs.
 * Unlike an arbitrary request callback, these arguments establish a neutral pending read.
 * Production captured Account readers use the selected batch above. */
export async function readExplicitMachineTransportRow(params: Readonly<{
    authorityKey: string;
    serverUrl: string;
    runtimeOrigin?: string;
    homeCarrier?: HomeCarrier;
    token: string;
    machineId: string;
    timeoutMs: number;
    signal: AbortSignal;
}>): Promise<unknown> {
    const deadlineAt = Date.now() + params.timeoutMs;
    const key = JSON.stringify([params.authorityKey, params.serverUrl, params.runtimeOrigin ?? null]);
    const read = async (): Promise<unknown> => {
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0) throw machineRowTimeoutError();
        try {
            return await explicitReads.run(key, async sharedSignal => {
                const timeout = new AbortController();
                const merged = mergeAbortSignals([sharedSignal, timeout.signal]);
                const timer = setTimeout(() => timeout.abort(), Math.max(1, remainingMs));
                try {
                    const request = createServerRequestForExplicitServerScope({ ...params, timeoutMs: remainingMs });
                    const response = await request(`/v1/machines/${encodeURIComponent(params.machineId)}`, {
                        method: 'GET', headers: { 'Content-Type': 'application/json' }, signal: merged.signal,
                    });
                    if (response.status === 404) return null;
                    assertMachineReadResponse(response);
                    return await response.json() as unknown;
                } catch (error) {
                    if (timeout.signal.aborted) throw Object.assign(machineRowTimeoutError(), { physicalMachineRowTimeout: true });
                    throw error;
                } finally { clearTimeout(timer); merged.dispose(); }
            }, { scope: params.homeCarrier ?? 'explicit-url', signal: params.signal });
        } catch (error) {
            // A shorter incumbent physical attempt cannot spend a later reader's
            // remaining budget. Other transport/auth failures never trigger this retry.
            if (!params.signal.aborted && error && typeof error === 'object' && 'physicalMachineRowTimeout' in error
                && error.physicalMachineRowTimeout === true && deadlineAt > Date.now()) return read();
            throw error;
        }
    };
    return read();
}

function assertMachineReadResponse(response: Response): void {
    if (response.ok) return;
    if (isAuthenticationResponseStatus(response.status)) throw createNotAuthenticatedError(response.status);
    throw new HappyError(`Machine row request failed (${response.status})`, response.status >= 500 || response.status === 429,
        { status: response.status, kind: response.status >= 500 ? 'server' : 'config' });
}

/** Exact selected IDs, not ordinary discovery: ephemeral targets retain exact admission. */
type MachineRowsReadOptions = Readonly<{
    readTransport: CapturedServerReadTransport;
    signal?: AbortSignal;
    /** Conditional mutation/readback witnesses must not borrow an older read. */
    fresh?: boolean;
}>;

/** Register the exact captured binding before awaiting Machine-specific preparation. */
export function prepareMachineRows(params: MachineRowsReadOptions) {
    const transportKey = params.readTransport.key;
    const reservation = selectedReads.reserve(JSON.stringify(['machine-exact-v1', transportKey]), {
        scope: params.readTransport.scope ?? transportKey, signal: params.signal, fresh: params.fresh,
    });
    return {
        release: reservation.release,
        async read(machineIds: readonly string[], signal?: AbortSignal): Promise<ReadonlyMap<string, MachinePublishedRowV1 | null>> {
            try {
                return await reservation.run(machineIds,
                    (ids, sharedSignal) => readMachineRowsBatch(params, ids, sharedSignal), signal);
            } finally { reservation.release(); }
        },
    };
}

export type PreparedMachineRows = ReturnType<typeof prepareMachineRows>;

type MachineRowsRequest = (path: string, init: RequestInit) => Promise<Response>;
type MachineRowsSource = Readonly<{ readTransport: CapturedServerReadTransport; request?: MachineRowsRequest }>
    | Readonly<{ readTransport?: CapturedServerReadTransport; request: MachineRowsRequest }>;

export async function readMachineRows(params: MachineRowsSource & Readonly<{ machineIds: readonly string[]; signal?: AbortSignal; fresh?: boolean }>): Promise<ReadonlyMap<string, MachinePublishedRowV1 | null>> {
    if (!params.readTransport) return readMachineRowsBatch(params, params.machineIds, params.signal);
    return await prepareMachineRows({ ...params, readTransport: params.readTransport }).read(params.machineIds);
}

async function readMachineRowsBatch(source: MachineRowsSource, ids: readonly string[], signal?: AbortSignal) {
    const emptyBody = { machineIds: [] as string[] };
    const batches: string[][] = [];
    let budget = createServerHttpRequestBodyItemBudgetV1(emptyBody);
    let batch: string[] = [];
    for (const id of ids) {
        if (!budget.tryAdmit(id)) {
            if (!batch.length) throw new Error('Machine id exceeds the HTTP request body limit');
            batches.push(batch);
            batch = [];
            budget = createServerHttpRequestBodyItemBudgetV1(emptyBody);
            if (!budget.tryAdmit(id)) throw new Error('Machine id exceeds the HTTP request body limit');
        }
        batch.push(id);
    }
    if (batch.length) batches.push(batch);
    const result = new Map<string, MachinePublishedRowV1 | null>();
    for (const machineIds of batches) {
        const input = MachineReadBatchRequestV1Schema.parse({ machineIds });
        const init = {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal,
        };
        const consume = async (response: Response) => {
            assertMachineReadResponse(response);
            return MachineReadBatchResponseV1Schema.parse(await response.json());
        };
        const body = source.readTransport
            ? await source.readTransport.read('/v1/machines/read-batch', init, undefined, consume)
            // Request-only API-token/embed Accounts have no shared read transport.
            : await consume(await source.request!('/v1/machines/read-batch', init));
        const expected = new Set(machineIds);
        for (const row of body.results) {
            if (!expected.delete(row.machineId) || (row.status === 'found' && row.machine.id !== row.machineId)) {
                throw new Error('Invalid Machine batch response');
            }
            result.set(row.machineId, row.status === 'found' ? row.machine : null);
        }
        if (expected.size) throw new Error('Incomplete Machine batch response');
    }
    return result;
}

/** The complete include-revoked census remains a different projection from exact selection. */
export async function readMachineCensus(params: Readonly<{
    readTransport?: CapturedServerReadTransport;
    request: (path: string, init: RequestInit) => Promise<Response>;
    headers: HeadersInit;
    signal?: AbortSignal;
    fresh?: boolean;
}>): Promise<readonly FetchedMachineRow[]> {
    const path = '/v1/machines?includeRevoked=true';
    const consume = async (response: Response) => {
        assertMachineReadResponse(response);
        // Incumbent census admission/opening validates these rows. This owner
        // shares only the physical observation, never a decrypted authority.
        return await response.json() as FetchedMachineRow[];
    };
    if (!params.readTransport) return consume(await params.request(path, { headers: params.headers, signal: params.signal }));
    const headers = new Headers(params.headers);
    headers.delete('Authorization');
    const transportKey = params.readTransport.key;
    return censusReads.run(JSON.stringify(['machine-census-include-revoked-v1', transportKey]), signal => params.readTransport!.read(path,
        { method: 'GET', headers, signal }, undefined, consume),
    { scope: params.readTransport.scope ?? transportKey, signal: params.signal, fresh: params.fresh });
}

export function resetMachineRowReadsForTests(): void {
    selectedReads.reset();
    censusReads.reset();
    explicitReads.reset();
}
