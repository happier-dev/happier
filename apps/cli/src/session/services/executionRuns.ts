import { ExecutionRunListRequestSchema, ExecutionRunGetRequestSchema, ExecutionRunGetResponseSchema, ExecutionRunListResponseSchema, ExecutionRunPublicStateSchema, ExecutionRunWaitResultSchema, readExecutionRunStartRunCreation, withExecutionRunStartFailureDetails } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { normalizeExecutionRunWaitTimeoutMs, isExecutionRunTerminalStatus } from '@happier-dev/protocol/execution/runs/waitForTerminal';
import { FeatureAxisSchema, FeatureBlockerCodeSchema } from '@happier-dev/protocol/features/decision';
import { isFeatureId } from '@happier-dev/protocol/features/catalog';
import type { ExecutionRunListRequest, ExecutionRunPublicState, ExecutionRunStartFailureDetailsV1, ExecutionRunStartRunCreation, ExecutionRunTerminalStatus as ProtocolExecutionRunTerminalStatus, ExecutionRunWaitLoopResult, ExecutionRunWaitCondition, ExecutionRunGetResponse, FeatureAxis, FeatureBlockerCode, FeatureId } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError } from '@happier-dev/protocol/rpcErrors';

import { configuration } from '@/configuration';
import { listExecutionRunMarkers, reconcileRetainedExecutionRunRecords } from '@/daemon/executionRunRegistry';
import { projectExecutionRunPublicState } from '@/agent/runtime/bridges/executionRun/publicState';
import type {
    SessionStoredContentCryptoContext,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { readRpcRequestDisposition } from '@happier-dev/sync-client';
import { applyExecutionRunListRequest } from './applyExecutionRunListRequest';
import {
    findExecutionRunPublicStateInHistoryRows,
    listExecutionRunPublicStatesFromHistoryRows,
} from './executionRunPublicStatesFromHistory';
import { readRawSessionHistoryRows } from './getSessionHistory';
import { normalizeExecutionRunPublicStateBackendTarget } from './executionRunPublicStateBackendTarget';

type ExecutionRunRpcContext = Readonly<{
    token: string;
    sessionId: string;
    signal?: AbortSignal;
}> & SessionStoredContentCryptoContext;

export type ExecutionRunTerminalStatus = ProtocolExecutionRunTerminalStatus;
declare const executionRunFeatureBlockerDetailsBrand: unique symbol;
export type ExecutionRunFeatureBlockerDetails = Readonly<{
    featureId: FeatureId;
    blockedBy: FeatureAxis;
    blockerCode: FeatureBlockerCode;
    [executionRunFeatureBlockerDetailsBrand]: true;
}>;
type ExecutionRunServiceFailure = Readonly<{
    ok: false;
    code: string;
    message?: string;
    details?: ExecutionRunFeatureBlockerDetails | ExecutionRunStartFailureDetailsV1;
}>;
export type ExecutionRunServiceResult<T> =
    | Readonly<{ ok: true; data: T }>
    | ExecutionRunServiceFailure;

export type WaitForExecutionRunResult = ExecutionRunWaitLoopResult<unknown, ExecutionRunServiceFailure>;

type ExecutionRunMarkerRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isExecutionRunStartResponseTimeout(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return message.toLowerCase().includes('rpc call timeout');
}

function readOwnDataProperty(record: Record<string, unknown>, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
        ? descriptor.value
        : undefined;
}

export function normalizeExecutionRunFeatureBlockerDetails(
    value: unknown,
): ExecutionRunFeatureBlockerDetails | undefined {
    if (!isRecord(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;

    const featureId = readOwnDataProperty(value, 'featureId');
    const blockedBy = FeatureAxisSchema.safeParse(readOwnDataProperty(value, 'blockedBy'));
    const blockerCode = FeatureBlockerCodeSchema.safeParse(readOwnDataProperty(value, 'blockerCode'));
    if (!isFeatureId(featureId)) return undefined;
    if (!blockedBy.success || !blockerCode.success) return undefined;
    return {
        featureId,
        blockedBy: blockedBy.data,
        blockerCode: blockerCode.data,
    } as ExecutionRunFeatureBlockerDetails;
}

type ExecutionRunFallbackExhaustedCode =
    | 'execution_run_protocol_unsupported'
    | 'execution_run_target_unavailable';

function classifyExecutionRunRpcFallback(error: unknown): ExecutionRunFallbackExhaustedCode | null {
    const errorMessage = error instanceof Error ? error.message : String(error ?? '');
    if (
        isRpcMethodNotAvailableError(error)
        || isRpcMethodNotFoundError(error)
        || errorMessage === 'Method not found'
        || errorMessage === 'RPC method not available'
    ) {
        return 'execution_run_protocol_unsupported';
    }

    const normalizedMessage = errorMessage.toLowerCase();
    if (
        normalizedMessage.includes('connect_error')
        || normalizedMessage.includes('socket connect timeout')
        || normalizedMessage.includes('rpc call timeout')
    ) {
        return 'execution_run_target_unavailable';
    }

    return null;
}

function isFallbackSafeExecutionRunRpcError(error: unknown): boolean {
    return classifyExecutionRunRpcFallback(error) !== null;
}

function classifyExecutionRunServiceFallback(
    result: Readonly<{ code: string; message?: string }>,
): ExecutionRunFallbackExhaustedCode | null {
    if (
        result.code === 'RPC_METHOD_NOT_AVAILABLE'
        || result.code === 'RPC_METHOD_NOT_FOUND'
        || result.message === 'RPC method not available'
        || result.message === 'Method not found'
    ) {
        return 'execution_run_protocol_unsupported';
    }

    return null;
}

function isFallbackSafeExecutionRunServiceError(result: Readonly<{ code: string; message?: string }>): boolean {
    if (result.code === 'execution_run_not_found') {
        return true;
    }

    return classifyExecutionRunServiceFallback(result) !== null;
}

function executionRunNotFound(): ExecutionRunServiceResult<unknown> {
    return {
        ok: false,
        code: 'execution_run_not_found',
        message: 'Execution run not found',
    };
}

function executionRunControlUnavailable(): ExecutionRunServiceResult<unknown> {
    return {
        ok: false,
        code: 'execution_run_not_allowed',
        message: 'Execution run control unavailable',
    };
}

function executionRunStartUnavailable(
    runCreation: ExecutionRunStartRunCreation,
): ExecutionRunServiceResult<unknown> {
    return {
        ok: false,
        code: 'execution_run_not_allowed',
        message: 'Execution run start unavailable',
        details: withExecutionRunStartFailureDetails(undefined, runCreation),
    };
}

function readExecutionRunRequestRunId(request: unknown): string | null {
    if (!isRecord(request)) return null;
    const runId = typeof request.runId === 'string' ? request.runId.trim() : '';
    return runId.length > 0 ? runId : null;
}

function toExecutionRunPublicState(marker: ExecutionRunMarkerRecord): ExecutionRunPublicState | null {
    const permissionMode =
        typeof marker.permissionMode === 'string' && marker.permissionMode.trim().length > 0
            ? marker.permissionMode
            : null;
    if (!permissionMode) {
        return null;
    }
    const backendTarget = normalizeExecutionRunPublicStateBackendTarget(marker.backendTarget);
    if (!backendTarget) {
        return null;
    }

    const payload: Record<string, unknown> = {
        runId: marker.runId,
        callId: marker.callId,
        sidechainId: marker.sidechainId,
        intent: marker.intent,
        backendTarget,
        ...(marker.display !== undefined ? { display: marker.display } : {}),
        ...(marker.launchOrigin !== undefined ? { launchOrigin: marker.launchOrigin } : {}),
        ...(marker.requestedConfiguration !== undefined
            ? { requestedConfiguration: marker.requestedConfiguration }
            : {}),
        permissionMode,
        retentionPolicy: marker.retentionPolicy,
        runClass: marker.runClass,
        ioMode: marker.ioMode,
        status: marker.status,
        ...(marker.resumeHandle && marker.resumeHandle !== null ? { resumeHandle: marker.resumeHandle } : {}),
        startedAtMs: marker.startedAtMs,
        ...(typeof marker.finishedAtMs === 'number' ? { finishedAtMs: marker.finishedAtMs } : {}),
    };

    const errorCode =
        typeof marker.errorCode === 'string' && marker.errorCode.trim().length > 0 ? marker.errorCode : null;
    if (errorCode) {
        payload.error = { code: errorCode };
    }

    const parsed = ExecutionRunPublicStateSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
}

async function listMarkerBackedExecutionRuns(params: Readonly<{ sessionId: string }>): Promise<ExecutionRunPublicState[]> {
    const markers = await listExecutionRunMarkers();
    const runs = markers
        .filter((marker) => marker.happySessionId === params.sessionId)
        .map((marker) => toExecutionRunPublicState(marker as ExecutionRunMarkerRecord))
        .filter((run): run is ExecutionRunPublicState => run !== null);
    runs.sort((left, right) => left.startedAtMs - right.startedAtMs);
    return runs;
}

async function listRetainedExecutionRuns(sessionId: string): Promise<readonly ExecutionRunPublicState[]> {
    return (await reconcileRetainedExecutionRunRecords({ nowMs: Date.now() }))
        .filter((record) => record.state.sessionId === sessionId && record.state.status !== 'running')
        .map((record) => projectExecutionRunPublicState(record.state));
}

async function getMarkerBackedExecutionRun(params: Readonly<{ sessionId: string; runId: string }>): Promise<ExecutionRunPublicState | null> {
    const runs = await listMarkerBackedExecutionRuns({ sessionId: params.sessionId });
    return runs.find((run) => run.runId === params.runId) ?? null;
}

function mergeExecutionRunLists(params: Readonly<{
    primaryRuns: readonly ExecutionRunPublicState[];
    markerRuns: readonly ExecutionRunPublicState[];
}>): readonly ExecutionRunPublicState[] {
    const byRunId = new Map<string, ExecutionRunPublicState>();
    for (const run of params.primaryRuns) {
        byRunId.set(run.runId, run);
    }
    for (const run of params.markerRuns) {
        if (!byRunId.has(run.runId)) {
            byRunId.set(run.runId, run);
        }
    }
    return Array.from(byRunId.values()).sort((left, right) => left.startedAtMs - right.startedAtMs);
}

function toExecutionRunFallbackExhaustedError(
    error: unknown,
    code: ExecutionRunFallbackExhaustedCode,
): ExecutionRunServiceResult<unknown> {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return {
        ok: false,
        code,
        ...(message.trim().length > 0 ? { message } : {}),
    };
}

async function listTranscriptBackedExecutionRuns(
    params: ExecutionRunRpcContext,
): Promise<readonly ExecutionRunPublicState[]> {
    const rows = await readRawSessionHistoryRows({
        ...params,
        limit: configuration.memoryMaxTranscriptWindowMessages,
    });
    return listExecutionRunPublicStatesFromHistoryRows(rows);
}

async function getTranscriptBackedExecutionRun(
    params: ExecutionRunRpcContext & Readonly<{ runId: string }>,
): Promise<ExecutionRunPublicState | null> {
    const rows = await readRawSessionHistoryRows({
        ...params,
        limit: configuration.memoryMaxTranscriptWindowMessages,
    });
    return findExecutionRunPublicStateInHistoryRows(rows, params.runId);
}

async function tryListTranscriptBackedExecutionRuns(
    params: ExecutionRunRpcContext,
): Promise<Readonly<{ ok: true; runs: readonly ExecutionRunPublicState[] }> | Readonly<{ ok: false }>> {
    try {
        return {
            ok: true,
            runs: await listTranscriptBackedExecutionRuns(params),
        };
    } catch {
        return { ok: false };
    }
}

async function tryGetTranscriptBackedExecutionRun(
    params: ExecutionRunRpcContext & Readonly<{ runId: string }>,
): Promise<ExecutionRunPublicState | null> {
    try {
        return await getTranscriptBackedExecutionRun(params);
    } catch {
        return null;
    }
}

async function buildExecutionRunListFallbackRuns(
    params: ExecutionRunRpcContext & Readonly<{ request: ExecutionRunListRequest }>,
): Promise<Readonly<{ runs: readonly ExecutionRunPublicState[] }>> {
    const markerRuns = await listMarkerBackedExecutionRuns({ sessionId: params.sessionId });
    const transcriptResult = await tryListTranscriptBackedExecutionRuns(params);
    const transcriptRuns = transcriptResult.ok ? transcriptResult.runs : null;
    const combinedRuns =
        transcriptRuns && transcriptRuns.length > 0
            ? mergeExecutionRunLists({
                primaryRuns: transcriptRuns,
                markerRuns,
            })
            : markerRuns;
    const retainedRuns = await listRetainedExecutionRuns(params.sessionId);

    return {
        runs: applyExecutionRunListRequest(mergeExecutionRunLists({ primaryRuns: retainedRuns, markerRuns: combinedRuns }), params.request),
    };
}

async function buildExecutionRunGetFallbackRun(
    params: ExecutionRunRpcContext & Readonly<{ runId: string }>,
): Promise<ExecutionRunPublicState | null> {
    const retained = (await listRetainedExecutionRuns(params.sessionId)).find((run) => run.runId === params.runId);
    if (retained) return retained;
    const transcriptRun = await tryGetTranscriptBackedExecutionRun(params);
    if (transcriptRun) {
        return transcriptRun;
    }

    return await getMarkerBackedExecutionRun({
        sessionId: params.sessionId,
        runId: params.runId,
    });
}

async function tryBuildExecutionRunGetFallbackRun(
    params: ExecutionRunRpcContext & Readonly<{ runId: string }>,
): Promise<Readonly<{ ok: true; run: ExecutionRunPublicState | null }> | Readonly<{ ok: false }>> {
    const retained = (await listRetainedExecutionRuns(params.sessionId)).find((run) => run.runId === params.runId);
    if (retained) return { ok: true, run: retained };
    let transcriptLookupOk = true;
    try {
        const transcriptRun = await getTranscriptBackedExecutionRun(params);
        if (transcriptRun) {
            return { ok: true, run: transcriptRun };
        }
    } catch {
        transcriptLookupOk = false;
    }

    try {
        const markerRun = await getMarkerBackedExecutionRun({
            sessionId: params.sessionId,
            runId: params.runId,
        });
        if (markerRun) {
            return { ok: true, run: markerRun };
        }

        return transcriptLookupOk ? { ok: true, run: null } : { ok: false };
    } catch {
        return { ok: false };
    }
}

function normalizeExecutionRunStartFailureDetails(
    value: unknown,
): ExecutionRunStartFailureDetailsV1 {
    return withExecutionRunStartFailureDetails(
        undefined,
        readExecutionRunStartRunCreation(value),
    );
}

export function normalizeExecutionRunRpcPayload<T>(
    payload: unknown,
    options: Readonly<{ executionRunStart?: boolean }> = {},
): ExecutionRunServiceResult<T> {
    if (!isRecord(payload)) {
        return {
            ok: true,
            data: payload as T,
        };
    }

    if (typeof payload.ok !== 'boolean') {
        const topLevelError =
            typeof payload.error === 'string' && payload.error.trim().length > 0
                ? payload.error
                : typeof payload.message === 'string' && payload.message.trim().length > 0
                  ? payload.message
                  : null;
        const topLevelErrorCode =
            typeof payload.errorCode === 'string' && payload.errorCode.trim().length > 0
                ? payload.errorCode
                : typeof payload.code === 'string' && payload.code.trim().length > 0
                  ? payload.code
                  : null;

        if (topLevelError || topLevelErrorCode) {
            const details = options.executionRunStart === true
                ? normalizeExecutionRunStartFailureDetails(payload.details)
                : normalizeExecutionRunFeatureBlockerDetails(payload.details);
            return {
                ok: false,
                code: topLevelErrorCode ?? 'execution_run_failed',
                ...(topLevelError ? { message: topLevelError } : {}),
                ...(details ? { details } : {}),
            };
        }

        return {
            ok: true,
            data: payload as T,
        };
    }

    if (payload.ok === false) {
        const details = options.executionRunStart === true
            ? normalizeExecutionRunStartFailureDetails(payload.details)
            : normalizeExecutionRunFeatureBlockerDetails(payload.details);
        return {
            ok: false,
            code:
                typeof payload.errorCode === 'string' && payload.errorCode.trim().length > 0
                    ? payload.errorCode
                    : typeof payload.code === 'string' && payload.code.trim().length > 0
                      ? payload.code
                      : 'execution_run_failed',
            ...(typeof payload.error === 'string' && payload.error.trim().length > 0
                ? { message: payload.error }
                : typeof payload.message === 'string' && payload.message.trim().length > 0
                  ? { message: payload.message }
                  : {}),
            ...(details ? { details } : {}),
        };
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'data')) {
        return {
            ok: true,
            data: (payload as { data: T }).data,
        };
    }

    const { ok: _ok, ...rest } = payload;
    return {
        ok: true,
        data: rest as T,
    };
}

async function callExecutionRunRpc(
    params: ExecutionRunRpcContext & Readonly<{
        methodSuffix: string;
        request: unknown;
        executionRunStart?: boolean;
        transportTimeoutMs?: number | null;
    }>,
): Promise<ExecutionRunServiceResult<unknown>> {
    const {
        methodSuffix,
        executionRunStart,
        transportTimeoutMs,
        ...rpcContext
    } = params;
    const payload = await callSessionRpc({
        ...rpcContext,
        method: `${params.sessionId}:${methodSuffix}`,
        request: params.request,
        ...(transportTimeoutMs !== undefined ? { timeoutMs: transportTimeoutMs } : {}),
    });
    return normalizeExecutionRunRpcPayload(payload, {
        ...(executionRunStart === true ? { executionRunStart: true } : {}),
    });
}

async function fallbackForUnavailableExecutionRunControl(
    params: ExecutionRunRpcContext & Readonly<{ request: unknown }>,
): Promise<ExecutionRunServiceResult<unknown>> {
    params.signal?.throwIfAborted();
    const runId = readExecutionRunRequestRunId(params.request);
    if (!runId) {
        return executionRunControlUnavailable();
    }

    const fallback = await tryBuildExecutionRunGetFallbackRun({
        ...params,
        runId,
    });
    if (!fallback.ok) {
        return executionRunControlUnavailable();
    }
    return fallback.run ? executionRunControlUnavailable() : executionRunNotFound();
}

async function callExecutionRunControlRpc(
    params: ExecutionRunRpcContext & Readonly<{
        methodSuffix: string;
        request: unknown;
        transportTimeoutMs?: number | null;
    }>,
): Promise<ExecutionRunServiceResult<unknown>> {
    try {
        const result = await callExecutionRunRpc(params);
        if (result.ok || !isFallbackSafeExecutionRunServiceError(result)) {
            return result;
        }
        return await fallbackForUnavailableExecutionRunControl(params);
    } catch (error) {
        if (!isFallbackSafeExecutionRunRpcError(error)) {
            throw error;
        }
        return await fallbackForUnavailableExecutionRunControl(params);
    }
}

export { isExecutionRunTerminalStatus } from '@happier-dev/protocol/execution/runs/waitForTerminal';

export async function startExecutionRun(
    params: ExecutionRunRpcContext & Readonly<{ request: unknown }>,
): Promise<ExecutionRunServiceResult<unknown>> {
    try {
        const result = await callExecutionRunRpc({
            ...params,
            methodSuffix: SESSION_RPC_METHODS.EXECUTION_RUN_START,
            executionRunStart: true,
            transportTimeoutMs: null,
        });
        return result.ok || !isFallbackSafeExecutionRunServiceError(result)
            ? result
            : executionRunStartUnavailable(readExecutionRunStartRunCreation(result.details));
    } catch (error) {
        const runCreation = readRpcRequestDisposition(error) === 'notSent'
            ? 'noRunCreated'
            : 'outcomeUnknown';
        if (runCreation === 'outcomeUnknown' && isExecutionRunStartResponseTimeout(error)) {
            // A run marker is diagnostic evidence, never a durable receipt: a lost
            // start response stays ambiguous and the caller owns any fresh attempt.
            return {
                ok: false,
                code: 'execution_run_start_ambiguous',
                message: 'Execution run start response timed out; accepted outcome is unknown',
                details: withExecutionRunStartFailureDetails(undefined, 'outcomeUnknown'),
            };
        }
        if (!isFallbackSafeExecutionRunRpcError(error)) {
            if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
                let detailsAttached = false;
                try {
                    Object.defineProperty(error, 'details', {
                        configurable: true,
                        value: withExecutionRunStartFailureDetails(
                            (error as { details?: unknown }).details,
                            runCreation,
                        ),
                    });
                    detailsAttached = true;
                } catch {
                    // Fall through to a preserving wrapper for frozen/non-extensible values.
                }
                if (detailsAttached) throw error;
            }
            throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), {
                cause: error,
                details: withExecutionRunStartFailureDetails(undefined, runCreation),
            });
        }
        return executionRunStartUnavailable(runCreation);
    }
}

export async function listExecutionRuns(
    params: ExecutionRunRpcContext & Readonly<{ request: unknown; skipLiveRpc?: boolean }>,
): Promise<ExecutionRunServiceResult<unknown>> {
    params.signal?.throwIfAborted();
    const request = ExecutionRunListRequestSchema.parse(params.request);

    if (params.skipLiveRpc === true) {
        const fallback = await buildExecutionRunListFallbackRuns({ ...params, request });
        if (fallback.runs.length > 0) {
            return {
                ok: true,
                data: { runs: fallback.runs },
            };
        }

        return {
            ok: false,
            code: 'execution_run_target_unavailable',
            message: 'Execution run list unavailable',
        };
    }

    try {
        const result = await callExecutionRunRpc({
            ...params,
            methodSuffix: SESSION_RPC_METHODS.EXECUTION_RUN_LIST,
            request,
        });
        if (!result.ok) {
            if (!isFallbackSafeExecutionRunServiceError(result)) {
                return result;
            }

            const fallback = await buildExecutionRunListFallbackRuns({ ...params, request });
            if (fallback.runs.length > 0) {
                return {
                    ok: true,
                    data: { runs: fallback.runs },
                };
            }

            const fallbackExhaustedCode = classifyExecutionRunServiceFallback(result);
            return fallbackExhaustedCode
                ? toExecutionRunFallbackExhaustedError(result.message, fallbackExhaustedCode)
                : result;
        }

        const parsed = ExecutionRunListResponseSchema.safeParse(result.data);
        if (!parsed.success) {
            return {
                ok: false,
                code: 'execution_run_invalid_response',
                message: 'Invalid execution run list response',
            };
        }

        const markerRuns = await listMarkerBackedExecutionRuns({ sessionId: params.sessionId });
        const runs = markerRuns.length === 0
            ? applyExecutionRunListRequest(parsed.data.runs, request)
            : applyExecutionRunListRequest(
                mergeExecutionRunLists({
                    primaryRuns: parsed.data.runs,
                    markerRuns,
                }),
                request,
            );

        return {
            ok: true,
            data: {
                ...parsed.data,
                runs,
            },
        };
    } catch (error) {
        if (!isFallbackSafeExecutionRunRpcError(error)) {
            throw error;
        }

        const fallback = await buildExecutionRunListFallbackRuns({ ...params, request });
        if (fallback.runs.length > 0) {
            return {
                ok: true,
                data: { runs: fallback.runs },
            };
        }

        return toExecutionRunFallbackExhaustedError(
            error,
            classifyExecutionRunRpcFallback(error) ?? 'execution_run_target_unavailable',
        );
    }
}

export async function getExecutionRun(
    params: ExecutionRunRpcContext & Readonly<{ request: unknown }>,
): Promise<ExecutionRunServiceResult<unknown>> {
    params.signal?.throwIfAborted();
    const request = ExecutionRunGetRequestSchema.parse(params.request);
    const runId = request.runId;

    try {
        const result = await callExecutionRunRpc({
            ...params,
            methodSuffix: SESSION_RPC_METHODS.EXECUTION_RUN_GET,
            ...(request.waitForOutput || request.waitForInputId ? { transportTimeoutMs: null } : {}),
        });
        if (result.ok) {
            const parsed = ExecutionRunGetResponseSchema.safeParse(result.data);
            if (!parsed.success) {
                return {
                    ok: false,
                    code: 'execution_run_invalid_response',
                    message: 'Invalid execution run get response',
                };
            }
            return {
                ok: true,
                data: parsed.data,
            };
        }
        if (!isFallbackSafeExecutionRunServiceError(result)) {
            return result;
        }

        const fallback = await tryBuildExecutionRunGetFallbackRun({
            ...params,
            runId,
        });
        if (!fallback.ok) {
            return result;
        }
        if (!fallback.run) {
            const fallbackExhaustedCode = classifyExecutionRunServiceFallback(result);
            return fallbackExhaustedCode
                ? toExecutionRunFallbackExhaustedError(result.message, fallbackExhaustedCode)
                : executionRunNotFound();
        }

        return {
            ok: true,
            data: ExecutionRunGetResponseSchema.parse({ run: fallback.run }),
        };
    } catch (error) {
        if (!isFallbackSafeExecutionRunRpcError(error)) {
            throw error;
        }

        const fallback = await tryBuildExecutionRunGetFallbackRun({
            ...params,
            runId,
        });
        if (!fallback.ok) {
            return toExecutionRunFallbackExhaustedError(
                error,
                classifyExecutionRunRpcFallback(error) ?? 'execution_run_target_unavailable',
            );
        }
        if (!fallback.run) {
            return toExecutionRunFallbackExhaustedError(
                error,
                classifyExecutionRunRpcFallback(error) ?? 'execution_run_target_unavailable',
            );
        }

        return {
            ok: true,
            data: ExecutionRunGetResponseSchema.parse({ run: fallback.run }),
        };
    }
}

/** Released attached-send compatibility: current input uses session.message.send. */
export async function sendExecutionRunMessage(
    _params: ExecutionRunRpcContext & Readonly<{ request: unknown }>,
): Promise<ExecutionRunServiceResult<unknown>> {
    return {
        ok: false,
        code: 'session_input_target_update_required',
        message: 'session_input_target_update_required',
    };
}

export async function stopExecutionRun(
    params: ExecutionRunRpcContext & Readonly<{ request: unknown }>,
): Promise<ExecutionRunServiceResult<unknown>> {
    return await callExecutionRunControlRpc({
        ...params,
        methodSuffix: SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
        transportTimeoutMs: null,
    });
}

export async function executeExecutionRunAction(
    params: ExecutionRunRpcContext & Readonly<{ request: unknown }>,
): Promise<ExecutionRunServiceResult<unknown>> {
    return await callExecutionRunControlRpc({
        ...params,
        methodSuffix: SESSION_RPC_METHODS.EXECUTION_RUN_ACTION,
        transportTimeoutMs: null,
    });
}

export async function ensureExecutionRun(
    params: ExecutionRunRpcContext & Readonly<{ request: unknown }>,
): Promise<ExecutionRunServiceResult<unknown>> {
    return await callExecutionRunControlRpc({
        ...params,
        methodSuffix: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE,
        transportTimeoutMs: null,
    });
}

export async function ensureOrStartExecutionRun(
    params: ExecutionRunRpcContext & Readonly<{ request: unknown }>,
): Promise<ExecutionRunServiceResult<unknown>> {
    return await callExecutionRunControlRpc({
        ...params,
        methodSuffix: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START,
        transportTimeoutMs: null,
    });
}

export async function startExecutionRunStream(
    params: ExecutionRunRpcContext & Readonly<{ request: unknown }>,
): Promise<ExecutionRunServiceResult<unknown>> {
    return await callExecutionRunControlRpc({
        ...params,
        methodSuffix: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START,
        transportTimeoutMs: null,
    });
}

export async function readExecutionRunStream(
    params: ExecutionRunRpcContext & Readonly<{ request: unknown }>,
): Promise<ExecutionRunServiceResult<unknown>> {
    return await callExecutionRunControlRpc({
        ...params,
        methodSuffix: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ,
        ...(isRecord(params.request) && params.request.waitForEvents === true ? { transportTimeoutMs: null } : {}),
    });
}

export async function cancelExecutionRunStream(
    params: ExecutionRunRpcContext & Readonly<{ request: unknown }>,
): Promise<ExecutionRunServiceResult<unknown>> {
    return await callExecutionRunControlRpc({
        ...params,
        methodSuffix: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL,
        transportTimeoutMs: null,
    });
}

type ExecutionRunWaitRequest = Readonly<{
    runId: string;
    timeoutMs: number | null;
    signal?: AbortSignal;
    condition?: ExecutionRunWaitCondition;
    after?: ExecutionRunGetResponse;
    onSnapshot?: (snapshot: ExecutionRunGetResponse) => void | Promise<void>;
}>;

function projectTerminalExecutionRunWaitResult(data: unknown): WaitForExecutionRunResult | null {
    if (!isRecord(data) || !isRecord(data.run) || !isExecutionRunTerminalStatus(data.run.status)) {
        return null;
    }
    return {
        ok: true,
        status: data.run.status,
        result: data,
    };
}

async function readExecutionRunWaitCompatibilitySnapshot(
    params: ExecutionRunRpcContext & ExecutionRunWaitRequest,
): Promise<WaitForExecutionRunResult | null> {
    const snapshot = await getExecutionRun({
        ...params,
        request: ExecutionRunGetRequestSchema.parse({
            runId: params.runId,
            includeStructured: true,
        }),
    });
    return snapshot.ok ? projectTerminalExecutionRunWaitResult(snapshot.data) : snapshot;
}

export async function waitForExecutionRun(
    params: ExecutionRunRpcContext & ExecutionRunWaitRequest,
): Promise<WaitForExecutionRunResult> {
    const observationTimeoutMs = normalizeExecutionRunWaitTimeoutMs(
        params.timeoutMs === null ? null : params.timeoutMs / 1_000,
    );
    const request = {
        runId: params.runId,
        ...(params.onSnapshot ? { condition: 'change' as const } : params.condition ? { condition: params.condition } : {}),
        ...(observationTimeoutMs === null
            ? {}
            : { timeoutSeconds: Math.max(1, Math.ceil(observationTimeoutMs / 1_000)) }),
    };
    const deadlineAtMs = observationTimeoutMs === null ? null : Date.now() + observationTimeoutMs;
    const deadlineAbort = deadlineAtMs === null ? null : new AbortController();
    const signal = deadlineAbort
        ? params.signal ? AbortSignal.any([params.signal, deadlineAbort.signal]) : deadlineAbort.signal
        : params.signal;
    const observedParams = { ...params, signal };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const armDeadline = () => {
        if (deadlineAtMs === null) return;
        // The authored observation budget includes offline time and output
        // backpressure. Chunk only at Node's timer boundary, never cap it.
        timer = setTimeout(() => {
            if (Date.now() < deadlineAtMs) { armDeadline(); return; }
            deadlineAbort?.abort(new DOMException('Execution-run observation deadline reached', 'TimeoutError'));
        }, Math.min(2_147_483_647, Math.max(0, deadlineAtMs - Date.now())));
    };
    let after = params.after;
    let snapshotDelivery: Promise<void> = Promise.resolve();
    const readRequest = async () => {
        // A reconnect must not bypass output backpressure from the previous
        // connection's accepted snapshot.
        await snapshotDelivery;
        signal?.throwIfAborted();
        const current = { ...request, ...(after ? { after } : {}) };
        if (deadlineAtMs === null) return current;
        const remainingMs = deadlineAtMs - Date.now();
        // The remaining budget never grants a reconnect a fresh lifetime.
        // The wire retains its one-second quantum; the caller signal carries
        // the precise containing deadline, including a fractional second.
        return { ...current, timeoutSeconds: Math.max(1, Math.ceil(remainingMs / 1_000)) };
    };
    try {
        armDeadline();
        let waitedPayload: unknown;
        try {
            waitedPayload = await callSessionRpc({
                ...observedParams,
                token: params.token,
                sessionId: params.sessionId,
                method: `${params.sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_WAIT}`,
                request,
                // No acknowledgement timeout: the observation's own signal spans
                // the entire connection/reconnect/output lifetime.
                timeoutMs: null,
                reattachOnReconnect: { readRequest, ...(params.onSnapshot ? {
                    onResult: async (raw: unknown) => {
                        signal?.throwIfAborted();
                        const parsed = ExecutionRunWaitResultSchema.safeParse(raw);
                        if (!parsed.success || !parsed.data.ok || !('disposition' in parsed.data) || parsed.data.disposition !== 'snapshot') return true;
                        // State snapshots are refreshable; reconnect recovers current state,
                        // not every transient event missed while disconnected.
                        after = parsed.data.result;
                        snapshotDelivery = Promise.resolve(params.onSnapshot!(after));
                        await snapshotDelivery;
                        return false;
                    },
                } : {}) },
            });
        } catch (error) {
            signal?.throwIfAborted();
            const fallbackCode = classifyExecutionRunRpcFallback(error);
            if (!fallbackCode) throw error;
            if (params.condition || params.onSnapshot) return { ok: false, code: fallbackCode };
            const fallback = await readExecutionRunWaitCompatibilitySnapshot(observedParams);
            return fallback ?? {
                ok: false,
                code: fallbackCode,
                message: error instanceof Error ? error.message : String(error),
            };
        }
        const waited = ExecutionRunWaitResultSchema.safeParse(waitedPayload);
        if (waited.success) {
            const value = waited.data;
            if (value.ok) {
                const condition = params.onSnapshot ? 'change' : params.condition ?? 'terminal';
                const disposition = 'disposition' in value ? value.disposition : 'terminal';
                const matchesRequest = disposition === 'observation_timeout'
                    || condition === disposition
                    || condition === 'change' && disposition === 'snapshot'
                    || condition === 'terminal_or_needs_attention' && (disposition === 'terminal' || disposition === 'needs_attention');
                if (!matchesRequest) return { ok: false, code: 'execution_run_wait_result_invalid',
                    message: 'Execution run wait response does not match the requested condition' };
            }
            return waited.data;
        }
        const normalized = normalizeExecutionRunRpcPayload(waitedPayload);
        if (!params.condition && !params.onSnapshot && !normalized.ok && isFallbackSafeExecutionRunServiceError(normalized)) {
            return await readExecutionRunWaitCompatibilitySnapshot(observedParams) ?? normalized;
        }
        return {
            ok: false,
            code: 'execution_run_wait_result_invalid',
            message: 'Execution run wait returned an invalid result',
        };
    } catch (error) {
        params.signal?.throwIfAborted();
        if (deadlineAbort?.signal.aborted) {
            // No current readable owner fact is available. Do not invent a Run
            // status or reconnect/get after this observation has ended.
            return { ok: false, code: 'observation_timeout', message: 'Execution-run observation deadline reached' };
        }
        throw error;
    } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Passive snapshots from the same supervised execution wait RPC; cancellation ends observation only. */
export async function watchExecutionRun(params: ExecutionRunRpcContext & ExecutionRunWaitRequest & Readonly<{
    onSnapshot: (snapshot: ExecutionRunGetResponse) => void | Promise<void>;
}>): Promise<WaitForExecutionRunResult> {
    return await waitForExecutionRun(params);
}
