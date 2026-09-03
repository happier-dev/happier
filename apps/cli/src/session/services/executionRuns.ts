import {
    ExecutionRunListRequestSchema,
    ExecutionRunGetRequestSchema,
    ExecutionRunGetResponseSchema,
    ExecutionRunListResponseSchema,
    ExecutionRunPublicStateSchema,
    type ExecutionRunListRequest,
    type ExecutionRunPublicState,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    isRpcMethodNotAvailableError,
    isRpcMethodNotFoundError,
} from '@happier-dev/protocol/rpcErrors';

import { configuration } from '@/configuration';
import { listExecutionRunMarkers } from '@/daemon/executionRunRegistry';
import type {
    SessionEncryptionContext,
    SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { delay } from '@/utils/time';
import { applyExecutionRunListRequest } from './applyExecutionRunListRequest';
import {
    findExecutionRunPublicStateInHistoryRows,
    listExecutionRunPublicStatesFromHistoryRows,
} from './deriveExecutionRunPublicStatesFromHistory';
import { readRawSessionHistoryRows } from './getSessionHistory';
import { normalizeExecutionRunWaitPollIntervalMs } from './executionRunWaitTiming';

type ExecutionRunRpcContext = Readonly<{
    token: string;
    sessionId: string;
    ctx: SessionEncryptionContext;
    mode?: SessionStoredContentEncryptionMode;
}>;

export type ExecutionRunTerminalStatus = 'succeeded' | 'failed' | 'cancelled' | 'timeout';
export type ExecutionRunServiceResult<T> =
    | Readonly<{ ok: true; data: T }>
    | Readonly<{ ok: false; code: string; message?: string; details?: unknown }>;

export type WaitForExecutionRunResult =
    | {
          ok: true;
          status: ExecutionRunTerminalStatus;
          result: unknown;
      }
    | {
          ok: true;
          status: 'running';
          disposition: 'observation_timeout';
          runId: string;
          timeoutMs: number;
          observedAtMs: number;
          deadlineAtMs: number;
      }
    | {
          ok: false;
          code: string;
          message?: string;
      };

type ExecutionRunMarkerRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function isExecutionRunStartObservationTimeout(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return message.toLowerCase().includes('rpc call timeout');
}

async function recoverCorrelatedExecutionRunStart(params: Readonly<{
    sessionId: string;
    request: unknown;
}>): Promise<ExecutionRunServiceResult<unknown> | null> {
    if (!isRecord(params.request)) return null;
    const startRequestId = typeof params.request.startRequestId === 'string'
        ? params.request.startRequestId.trim()
        : '';
    if (!startRequestId) return null;

    let markers;
    try {
        markers = await listExecutionRunMarkers();
    } catch {
        return null;
    }
    const matches = markers.filter((marker) => (
        marker.happySessionId === params.sessionId
        && (marker as ExecutionRunMarkerRecord).startRequestId === startRequestId
    ));
    if (matches.length !== 1) return null;
    const marker = matches[0] as ExecutionRunMarkerRecord;
    const runId = typeof marker.runId === 'string' ? marker.runId : '';
    const callId = typeof marker.callId === 'string' ? marker.callId : '';
    const sidechainId = typeof marker.sidechainId === 'string' ? marker.sidechainId : '';
    if (!runId || !callId || !sidechainId) return null;

    return {
        ok: true,
        data: {
            runId,
            callId,
            sidechainId,
            intent: marker.intent,
            backendTarget: marker.backendTarget,
            permissionMode: marker.permissionMode,
            retentionPolicy: marker.retentionPolicy,
            runClass: marker.runClass,
            ioMode: marker.ioMode,
            startDisposition: 'recovered_after_observation_timeout',
        },
    };
}

function isFallbackSafeExecutionRunServiceError(result: Readonly<{ code: string; message?: string }>): boolean {
    return result.code === 'execution_run_not_found' || classifyExecutionRunServiceFallback(result) !== null;
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

function toExecutionRunPublicState(marker: ExecutionRunMarkerRecord): ExecutionRunPublicState | null {
    const permissionMode =
        typeof marker.permissionMode === 'string' && marker.permissionMode.trim().length > 0
            ? marker.permissionMode
            : null;
    if (!permissionMode) {
        return null;
    }

    const payload: Record<string, unknown> = {
        runId: marker.runId,
        callId: marker.callId,
        sidechainId: marker.sidechainId,
        intent: marker.intent,
        backendTarget: marker.backendTarget,
        ...(marker.display !== undefined ? { display: marker.display } : {}),
        ...(marker.launchOrigin !== undefined ? { launchOrigin: marker.launchOrigin } : {}),
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
    const summary = typeof marker.summary === 'string' && marker.summary.trim().length > 0 ? marker.summary : null;
    if (errorCode) {
        payload.error = {
            code: errorCode,
            ...(summary ? { message: summary } : {}),
        };
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
        token: params.token,
        sessionId: params.sessionId,
        ctx: params.ctx,
        limit: configuration.memoryMaxTranscriptWindowMessages,
    });
    return listExecutionRunPublicStatesFromHistoryRows(rows);
}

async function getTranscriptBackedExecutionRun(
    params: ExecutionRunRpcContext & Readonly<{ runId: string }>,
): Promise<ExecutionRunPublicState | null> {
    const rows = await readRawSessionHistoryRows({
        token: params.token,
        sessionId: params.sessionId,
        ctx: params.ctx,
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

    return {
        runs: applyExecutionRunListRequest(combinedRuns, params.request),
    };
}

async function buildExecutionRunGetFallbackRun(
    params: ExecutionRunRpcContext & Readonly<{ runId: string }>,
): Promise<ExecutionRunPublicState | null> {
    const transcriptRun = await tryGetTranscriptBackedExecutionRun(params);
    if (transcriptRun) {
        return transcriptRun;
    }

    return await getMarkerBackedExecutionRun({
        sessionId: params.sessionId,
        runId: params.runId,
    });
}

export function normalizeExecutionRunRpcPayload<T>(payload: unknown): ExecutionRunServiceResult<T> {
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
            return {
                ok: false,
                code: topLevelErrorCode ?? 'execution_run_failed',
                ...(topLevelError ? { message: topLevelError } : {}),
            };
        }

        return {
            ok: true,
            data: payload as T,
        };
    }

    if (payload.ok === false) {
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
    params: ExecutionRunRpcContext & Readonly<{ methodSuffix: string; request: unknown }>,
): Promise<ExecutionRunServiceResult<unknown>> {
    const payload = await callSessionRpc({
        token: params.token,
        sessionId: params.sessionId,
        mode: params.mode,
        ctx: params.ctx,
        method: `${params.sessionId}:${params.methodSuffix}`,
        request: params.request,
    });
    return normalizeExecutionRunRpcPayload(payload);
}

export function isExecutionRunTerminalStatus(status: unknown): status is ExecutionRunTerminalStatus {
    return status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'timeout';
}

export async function startExecutionRun(
    params: ExecutionRunRpcContext & Readonly<{ request: unknown }>,
): Promise<ExecutionRunServiceResult<unknown>> {
    try {
        const result = await callExecutionRunRpc({
            ...params,
            methodSuffix: SESSION_RPC_METHODS.EXECUTION_RUN_START,
        });
        if (!result.ok) {
            const fallbackCode = classifyExecutionRunServiceFallback(result);
            return fallbackCode
                ? toExecutionRunFallbackExhaustedError(result.message, fallbackCode)
                : result;
        }
        return result;
    } catch (error) {
        if (isExecutionRunStartObservationTimeout(error)) {
            const recovered = await recoverCorrelatedExecutionRunStart({
                sessionId: params.sessionId,
                request: params.request,
            });
            if (recovered) return recovered;
            const startRequestId = isRecord(params.request) && typeof params.request.startRequestId === 'string'
                ? params.request.startRequestId.trim()
                : '';
            return {
                ok: false,
                code: 'execution_run_start_ambiguous',
                message: error instanceof Error ? error.message : String(error ?? ''),
                ...(startRequestId
                    ? {
                        details: {
                            startRequestId,
                            retrySafe: true,
                            reconcileVia: 'retry_execution_run_start',
                        },
                    }
                    : {}),
            };
        }
        const fallbackCode = classifyExecutionRunRpcFallback(error);
        if (!fallbackCode) throw error;
        return toExecutionRunFallbackExhaustedError(error, fallbackCode);
    }
}

export async function listExecutionRuns(
    params: ExecutionRunRpcContext & Readonly<{ request: unknown }>,
): Promise<ExecutionRunServiceResult<unknown>> {
    const request = ExecutionRunListRequestSchema.parse(params.request);

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
        const fallbackExhaustedCode = classifyExecutionRunRpcFallback(error);
        if (!fallbackExhaustedCode) {
            throw error;
        }

        const fallback = await buildExecutionRunListFallbackRuns({ ...params, request });
        if (fallback.runs.length > 0) {
            return {
                ok: true,
                data: { runs: fallback.runs },
            };
        }

        return toExecutionRunFallbackExhaustedError(error, fallbackExhaustedCode);
    }
}

export async function getExecutionRun(
    params: ExecutionRunRpcContext & Readonly<{ request: unknown }>,
): Promise<ExecutionRunServiceResult<unknown>> {
    const runId = ExecutionRunGetRequestSchema.parse(params.request).runId;

    try {
        const result = await callExecutionRunRpc({
            ...params,
            methodSuffix: SESSION_RPC_METHODS.EXECUTION_RUN_GET,
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

        const fallbackRun = await buildExecutionRunGetFallbackRun({
            ...params,
            runId,
        });
        if (!fallbackRun) {
            const fallbackExhaustedCode = classifyExecutionRunServiceFallback(result);
            return fallbackExhaustedCode
                ? toExecutionRunFallbackExhaustedError(result.message, fallbackExhaustedCode)
                : result;
        }

        return {
            ok: true,
            data: ExecutionRunGetResponseSchema.parse({ run: fallbackRun }),
        };
    } catch (error) {
        const fallbackExhaustedCode = classifyExecutionRunRpcFallback(error);
        if (!fallbackExhaustedCode) {
            throw error;
        }

        const fallbackRun = await buildExecutionRunGetFallbackRun({
            ...params,
            runId,
        });
        if (!fallbackRun) {
            return toExecutionRunFallbackExhaustedError(error, fallbackExhaustedCode);
        }

        return {
            ok: true,
            data: ExecutionRunGetResponseSchema.parse({ run: fallbackRun }),
        };
    }
}

export async function sendExecutionRunMessage(
    params: ExecutionRunRpcContext & Readonly<{ request: unknown }>,
): Promise<ExecutionRunServiceResult<unknown>> {
    return await callExecutionRunRpc({
        ...params,
        methodSuffix: SESSION_RPC_METHODS.EXECUTION_RUN_SEND,
    });
}

export async function stopExecutionRun(
    params: ExecutionRunRpcContext & Readonly<{ request: unknown }>,
): Promise<ExecutionRunServiceResult<unknown>> {
    return await callExecutionRunRpc({
        ...params,
        methodSuffix: SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
    });
}

export async function executeExecutionRunAction(
    params: ExecutionRunRpcContext & Readonly<{ request: unknown }>,
): Promise<ExecutionRunServiceResult<unknown>> {
    return await callExecutionRunRpc({
        ...params,
        methodSuffix: SESSION_RPC_METHODS.EXECUTION_RUN_ACTION,
    });
}

export async function startExecutionRunStream(
    params: ExecutionRunRpcContext & Readonly<{ request: unknown }>,
): Promise<ExecutionRunServiceResult<unknown>> {
    return await callExecutionRunRpc({
        ...params,
        methodSuffix: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START,
    });
}

export async function readExecutionRunStream(
    params: ExecutionRunRpcContext & Readonly<{ request: unknown }>,
): Promise<ExecutionRunServiceResult<unknown>> {
    return await callExecutionRunRpc({
        ...params,
        methodSuffix: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ,
    });
}

export async function cancelExecutionRunStream(
    params: ExecutionRunRpcContext & Readonly<{ request: unknown }>,
): Promise<ExecutionRunServiceResult<unknown>> {
    return await callExecutionRunRpc({
        ...params,
        methodSuffix: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL,
    });
}

export async function waitForExecutionRun(
    params: ExecutionRunRpcContext &
        Readonly<{
            runId: string;
            timeoutMs: number | null;
            pollIntervalMs: number;
        }>,
): Promise<WaitForExecutionRunResult> {
    const request = ExecutionRunGetRequestSchema.parse({ runId: params.runId });
    const timeoutMs =
        typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
            ? params.timeoutMs
            : null;
    const pollIntervalMs = normalizeExecutionRunWaitPollIntervalMs(params.pollIntervalMs);
    const deadlineMs = timeoutMs === null ? null : Date.now() + timeoutMs;

    while (deadlineMs === null || Date.now() <= deadlineMs) {
        const result = await getExecutionRun({
            token: params.token,
            sessionId: params.sessionId,
            mode: params.mode,
            ctx: params.ctx,
            request,
        });
        if (!result.ok) {
            return result;
        }
        const status = (result.data as { run?: { status?: unknown } } | null)?.run?.status;
        if (isExecutionRunTerminalStatus(status)) {
            return {
                ok: true,
                status,
                result: result.data,
            };
        }
        await delay(pollIntervalMs);
    }

    const observedAtMs = Date.now();
    return {
        ok: true,
        status: 'running',
        disposition: 'observation_timeout',
        runId: params.runId,
        timeoutMs: timeoutMs!,
        observedAtMs,
        deadlineAtMs: deadlineMs!,
    };
}
