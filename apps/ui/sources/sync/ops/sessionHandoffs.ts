import {
    readServerEnabledBit,
    SessionHandoffCommitResponseSchema,
    SessionHandoffAbortResponseV2Schema,
    SessionHandoffPrepareTargetResultGetResponseSchema,
    SessionHandoffPrepareTargetResponseSchema,
    SessionHandoffStartResponseSchema,
    SessionHandoffStatusSchema,
    SessionHandoffTargetResumeResponseV2Schema,
    SPAWN_SESSION_ERROR_CODES,
} from '@happier-dev/protocol';
import type {
    AgentRuntimeDescriptorV1,
    SessionHandoffCommitResponse,
    SessionHandoffPrepareTargetResponse,
    SessionHandoffStartResponse,
    SessionHandoffStatus,
    SessionHandoffStorageMode,
    SessionHandoffTransportStrategy,
    SessionHandoffWorkspaceTransfer,
} from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { buildCodexBackendTransportFields } from '../domains/session/codexBackendTransport';

import { getServerFeaturesSnapshot } from '../api/capabilities/serverFeaturesClient';
import { sync } from '../sync';
import { storage } from '../domains/state/storage';
import { machineRpcWithServerScope } from '../runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { isRpcMethodNotAvailableError, readRpcErrorCode } from '../runtime/rpcErrors';
import { isSocketIoAckTimeoutError } from '../runtime/socketIoAckTimeout';

import { resumeSession } from './sessions';
import { readMachineControlTargetForSession, shouldFallbackFromMachineRpc } from './sessionMachineTarget';
import type { Metadata, Session } from '../domains/state/storageTypes';
import { buildSessionHandoffRecoveryPlan, type SessionHandoffRecoveryPlan } from '../domains/sessionHandoff/recoveryPlan';
import { waitForSessionHandoffTargetSessionActive } from '../domains/sessionHandoff/waitForSessionHandoffTargetSessionActive';
import { readSessionHandoffSessionActivity } from '../domains/sessionHandoff/readSessionHandoffSessionActivity';
import { resolveSessionHandoffRuntimeConfig } from '../domains/sessionHandoff/sessionHandoffRuntimeConfig';
import { resolveSessionHandoffSourceMachineId as resolveCanonicalSessionHandoffSourceMachineId } from '../domains/sessionHandoff/resolveSessionHandoffSourceMachineId';
import { stabilizeSessionHandoffTargetBinding } from '../domains/sessionHandoff/stabilizeSessionHandoffTargetBinding';
import { runSessionHandoffRetryLoop } from '../domains/sessionHandoff/runSessionHandoffRetryLoop';
import { publishSessionHandoffProgress } from '../domains/sessionHandoff/sessionHandoffProgressEvents';
import {
    readCachedDirectPeerRoute,
    recordCachedDirectPeerRouteUnavailable,
    recordCachedDirectPeerRouteViable,
} from '../domains/transfers/runtime/transferRouteCache';
import { resolveMachineTransferAvailability } from '../domains/transfers/runtime/resolveTransferAvailability';
import { followUpSpawnedSessionWithServerScope } from '../runtime/orchestration/serverScopedRpc/followUpSpawnedSession';
import { buildSessionHandoffMetadataPatch } from './buildSessionHandoffMetadataPatch';

type MetadataRecord = Metadata;
type HandoffErrorResult = Readonly<{
    ok: false;
    errorCode: string;
    errorMessage: string;
    recovery?: SessionHandoffRecoveryPlan;
    handoffId?: string;
    status?: SessionHandoffStatus;
}>;

export type StartSessionHandoffOptions = Readonly<{
    sessionId: string;
    sourceMachineId?: string | null;
    targetMachineId: string;
    serverId?: string | null;
    sessionStorageMode: SessionHandoffStorageMode;
    targetSessionStorageMode?: SessionHandoffStorageMode;
    preferredTransportStrategies: readonly SessionHandoffTransportStrategy[];
    negotiatedTransportStrategy?: SessionHandoffTransportStrategy;
    workspaceTransfer?: SessionHandoffWorkspaceTransfer;
    sourceStartRetry?: HandoffRetryOptions;
}>;

type HandoffRetryOptions = Readonly<{
    timeoutMs?: number;
    pollTimeoutMs?: number;
    intervalMs?: number;
    now?: () => number;
    sleep?: (delayMs: number) => Promise<void>;
}>;

export type StartSessionHandoffResult =
    | Readonly<{
        ok: true;
        handoffId: string;
        status: SessionHandoffStartResponse['status'];
        endpointCandidates: SessionHandoffStartResponse['endpointCandidates'];
        handoffMetadataV2?: NonNullable<SessionHandoffStartResponse['handoffMetadataV2']>;
    }>
    | HandoffErrorResult;

type StartSessionHandoffAttemptResult =
    | Readonly<{ ok: true; sourceMachineId: string; response: SessionHandoffStartResponse }>
    | HandoffErrorResult;

export type CompleteSessionHandoffOptions = StartSessionHandoffOptions & Readonly<{
    sourceMetadata: MetadataRecord;
    sourceStartRetry?: HandoffRetryOptions;
    targetPrepareRetry?: HandoffRetryOptions;
}>;

export type CompleteSessionHandoffResult =
    | Readonly<{
        ok: true;
        handoffId: string;
        status: SessionHandoffStatus;
    }>
    | HandoffErrorResult;

export type PerformSessionHandoffRecoveryActionResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; error: string }>;

type SessionHandoffTargetMetadataBuilder = (metadata: MetadataRecord) => MetadataRecord;

function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

function readSessionHandoffFailureMessage(error: unknown, fallback: string): string {
    return error instanceof Error && error.message.trim() ? error.message : fallback;
}

async function finalizeSessionHandoffTargetBinding(params: Readonly<{
    sessionId: string;
    targetMachineId: string;
    serverId: string | null;
    sourceMetadata: MetadataRecord;
    buildNextMetadata: SessionHandoffTargetMetadataBuilder;
}>): Promise<void> {
    const runtimeConfig = resolveSessionHandoffRuntimeConfig();
    const reapplyOptimisticBinding = () => {
        const currentMetadata = (
            storage.getState().sessions?.[params.sessionId]?.metadata
            ?? params.sourceMetadata
        ) as MetadataRecord;
        writeSessionMetadataToLocalSession(
            params.sessionId,
            params.buildNextMetadata(currentMetadata),
        );
    };
    const stabilize = async () => {
        const result = await stabilizeSessionHandoffTargetBinding({
            readSession: () => readSessionHandoffSessionActivity(params.sessionId),
            readTargetMachineId: () => readMachineControlTargetForSession(params.sessionId)?.machineId ?? null,
            reapplyOptimisticBinding,
            targetMachineId: params.targetMachineId,
            timeoutMs: runtimeConfig.postCommitBindingStabilizationTimeoutMs,
            pollIntervalMs: runtimeConfig.postCommitBindingStabilizationIntervalMs,
            requiredStablePolls: runtimeConfig.postCommitBindingStablePolls,
        });
        if (!result.ok) reapplyOptimisticBinding();
    };

    reapplyOptimisticBinding();
    await stabilize();
    await sync.patchSessionMetadataWithRetry(
        params.sessionId,
        (metadata) => params.buildNextMetadata((metadata ?? params.sourceMetadata) as MetadataRecord),
        { serverId: params.serverId },
    );
    await sync.ensureSessionVisibleForMessageRoute(params.sessionId, { forceRefresh: true });
    reapplyOptimisticBinding();
    await stabilize();
}

function buildRecoveryTargetMetadataBuilder(
    plan: NonNullable<SessionHandoffRecoveryPlan['targetFinalization']>,
): SessionHandoffTargetMetadataBuilder {
    return (metadata) => buildSessionHandoffMetadataPatch({
        metadata,
        sourceMetadataForHandoff: plan.sourceMetadataForHandoff,
        providerId: plan.providerId,
        sourceMachineId: plan.sourceMachineId,
        targetMachineId: plan.targetMachineId,
        sessionStorageBefore: plan.sessionStorageBefore,
        sessionStorageAfter: plan.sessionStorageAfter,
        targetPath: plan.targetPath,
        transportStrategy: plan.transportStrategy,
        completedAtMs: plan.completedAtMs,
        targetRemoteSessionId: plan.targetRemoteSessionId,
        targetDirectSource: plan.targetDirectSource,
        targetRuntimeDescriptor: plan.targetRuntimeDescriptor as AgentRuntimeDescriptorV1 | undefined,
    });
}

function resolveTargetPreparePathForCrossPlatformHandoff(params: Readonly<{
    sourceMachineId: string;
    targetMachineId: string;
    sourcePath: string;
}>): string {
    if (params.sourceMachineId === params.targetMachineId) return params.sourcePath;

    const sourcePath = params.sourcePath.trim();

    const normalizeHomeDir = (raw: unknown): string => {
        const home = String(raw ?? '').trim();
        if (!home.startsWith('/')) return '';
        return home.replace(/\/+$/u, '');
    };

    const state = storage.getState();
    const sourceHomeDir = normalizeHomeDir(state.machines?.[params.sourceMachineId]?.metadata?.homeDir);
    const targetHomeDir = normalizeHomeDir(state.machines?.[params.targetMachineId]?.metadata?.homeDir);
    if (!targetHomeDir) {
        // Fail closed: without a known target home directory, rewriting can accidentally redirect a
        // user-selected absolute path into an unrelated location.
        return sourcePath;
    }

    const homePrefixMatches = [
        sourceHomeDir,
        sourcePath.match(/^\/Users\/[^/]+/u)?.[0] ?? '',
        sourcePath.match(/^\/home\/[^/]+/u)?.[0] ?? '',
    ].filter(Boolean);

    const homePrefix = homePrefixMatches.find((prefix) => sourcePath === prefix || sourcePath.startsWith(`${prefix}/`)) ?? '';
    if (!homePrefix) return sourcePath;

    const relativeCandidate =
        sourcePath === homePrefix
            ? 'workspace'
            : sourcePath.slice(homePrefix.length + 1).trim();

    const relative =
        relativeCandidate
        && !relativeCandidate.split('/').some((segment) => segment === '..')
            ? relativeCandidate
            : (sourcePath.split('/').filter(Boolean).slice(-1)[0] ?? 'workspace');

    return `${targetHomeDir.replace(/\/+$/u, '')}/${relative}`;
}

const DEFAULT_TARGET_PREPARE_RETRY_TIMEOUT_MS = 600_000;
const DEFAULT_TARGET_PREPARE_RETRY_INTERVAL_MS = 500;
const DEFAULT_SOURCE_START_RETRY_TIMEOUT_MS = 600_000;
const DEFAULT_SOURCE_START_RETRY_INTERVAL_MS = 500;

function defaultSleep(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isMachineRpcTimeoutError(error: unknown): boolean {
    return Boolean(
        error
        && typeof error === 'object'
        && (error as { code?: unknown }).code === 'MACHINE_RPC_TIMEOUT',
    );
}

function isTransientDaemonRpcAvailabilityError(error: unknown): boolean {
    return isRpcMethodNotAvailableError(error as any)
        || readRpcErrorCode(error) === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
        || isMachineRpcTimeoutError(error)
        || isSocketIoAckTimeoutError(error)
        || shouldFallbackFromMachineRpc(error);
}

function unsupportedError(errorMessage: string): HandoffErrorResult {
    return {
        ok: false,
        errorCode: 'UNEXPECTED',
        errorMessage,
    };
}

function applyOptimisticSessionHandoffBinding(params: Readonly<{
    sessionId: string;
    metadata: MetadataRecord;
}>): (() => void) | null {
    const currentSession = writeSessionMetadataToLocalSession(params.sessionId, params.metadata);
    if (!currentSession) {
        return null;
    }

    return () => {
        storage.getState().applySessions([currentSession]);
    };
}

function writeSessionMetadataToLocalSession(sessionId: string, metadata: MetadataRecord): Session | null {
    const state = storage.getState();
    const currentSession = state.sessions?.[sessionId] as Session | undefined;
    if (!currentSession) {
        return null;
    }

    state.applySessions([{
        ...currentSession,
        metadata,
    }]);

    return currentSession;
}

function isAgentRuntimeDescriptorV1(value: unknown): value is AgentRuntimeDescriptorV1 {
    return Boolean(
        value
        && typeof value === 'object'
        && !Array.isArray(value)
        && (value as { v?: unknown }).v === 1
        && typeof (value as { providerId?: unknown }).providerId === 'string'
        && (value as { provider?: unknown }).provider
        && typeof (value as { provider?: unknown }).provider === 'object'
        && !Array.isArray((value as { provider?: unknown }).provider),
    );
}

function readRawSessionHandoffError(raw: unknown): Readonly<{
    errorCode: string;
    errorMessage: string;
    handoffId?: string;
    status?: SessionHandoffStatus;
}> | null {
    if (!raw || typeof raw !== 'object') return null;

    const parsedStatus = SessionHandoffStatusSchema.safeParse((raw as { status?: unknown }).status);
    const status = parsedStatus.success ? parsedStatus.data : undefined;
    const handoffId =
        typeof (raw as { handoffId?: unknown }).handoffId === 'string'
            ? String((raw as { handoffId: string }).handoffId)
            : status?.handoffId;

    if (
        (raw as { ok?: unknown }).ok === false &&
        typeof (raw as { errorCode?: unknown }).errorCode === 'string'
    ) {
        return {
            errorCode: String((raw as { errorCode: string }).errorCode),
            errorMessage:
                typeof (raw as { error?: unknown }).error === 'string'
                    ? String((raw as { error: string }).error)
                    : 'Session handoff failed',
            ...(handoffId ? { handoffId } : {}),
            ...(status ? { status } : {}),
        };
    }

    if (typeof (raw as { error?: unknown }).error === 'string') {
        return {
            errorCode: 'UNEXPECTED',
            errorMessage: String((raw as { error: string }).error),
            ...(handoffId ? { handoffId } : {}),
            ...(status ? { status } : {}),
        };
    }

    return null;
}

function resolveSourceMachineId(options: Readonly<{
    sessionId: string;
    sourceMachineId?: string | null;
    targetMachineId: string;
}>): string | null {
    const sourceTarget = readMachineControlTargetForSession(options.sessionId);
    const explicitSourceMachineId = normalizeId(options.sourceMachineId);
    const sourceMachineId = resolveCanonicalSessionHandoffSourceMachineId({
        reachableMachineId: sourceTarget?.machineId ?? null,
        sourceMachineId: explicitSourceMachineId,
    });
    const targetMachineId = normalizeId(options.targetMachineId);
    if (sourceMachineId && targetMachineId && sourceMachineId === targetMachineId && explicitSourceMachineId && explicitSourceMachineId !== targetMachineId) {
        return null;
    }
    return sourceMachineId || null;
}

async function startSessionHandoffOnSource(options: StartSessionHandoffOptions): Promise<StartSessionHandoffAttemptResult> {
    return await startSessionHandoffOnSourceWithMachineRpcTimeout(
        options,
        resolveSessionHandoffRuntimeConfig().machineRpcTimeoutMs,
    );
}

async function startSessionHandoffOnSourceWithMachineRpcTimeout(
    options: StartSessionHandoffOptions,
    machineRpcTimeoutMs: number,
): Promise<Awaited<ReturnType<typeof startSessionHandoffOnSource>>> {
    const serverId = normalizeId(options.serverId) || null;
    const sourceMachineId = resolveSourceMachineId(options);
    if (!sourceMachineId) {
        return {
            ok: false,
            errorCode: 'machine_not_found',
            errorMessage: 'No reachable source machine target found for session handoff',
        };
    }

    try {
        const raw = await machineRpcWithServerScope<unknown, unknown>({
            machineId: sourceMachineId,
            method: RPC_METHODS.DAEMON_SESSION_HANDOFF_START,
            payload: {
                sessionId: options.sessionId,
                sourceMachineId,
                targetMachineId: options.targetMachineId,
                sessionStorageMode: options.sessionStorageMode,
                preferredTransportStrategies: options.preferredTransportStrategies,
                ...(options.negotiatedTransportStrategy ? { negotiatedTransportStrategy: options.negotiatedTransportStrategy } : {}),
                ...(options.workspaceTransfer ? { workspaceTransfer: options.workspaceTransfer } : {}),
            },
            serverId,
            timeoutMs: machineRpcTimeoutMs,
        });

        const errorResult = readRawSessionHandoffError(raw);
        if (errorResult) {
            return {
                ok: false,
                errorCode: errorResult.errorCode,
                errorMessage: errorResult.errorMessage,
                ...(errorResult.handoffId ? { handoffId: errorResult.handoffId } : {}),
                ...(errorResult.status ? { status: errorResult.status } : {}),
            };
        }

        const parsed = SessionHandoffStartResponseSchema.safeParse(raw);
        if (!parsed.success) {
            return unsupportedError('Unsupported session handoff response from daemon');
        }

        return {
            ok: true,
            sourceMachineId,
            response: parsed.data,
        };
    } catch (error) {
        if (isTransientDaemonRpcAvailabilityError(error)) {
            return {
                ok: false,
                errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
                errorMessage:
                    `Daemon RPC is not available (RPC method not available). ` +
                    `The daemon may be stopped, still starting, or not connected to the server.`,
            };
        }

        return {
            ok: false,
            errorCode: 'UNEXPECTED',
            errorMessage: error instanceof Error ? error.message : 'Failed to start session handoff',
        };
    }
}

function shouldRetrySourceStart(result: Readonly<{ ok: false; errorCode: string }>): boolean {
    return result.errorCode === SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE;
}

export async function startSessionHandoffOnSourceWithRetry(
    options: StartSessionHandoffOptions,
    retryOptions?: HandoffRetryOptions,
): Promise<Awaited<ReturnType<typeof startSessionHandoffOnSource>>> {
    const now = retryOptions?.now ?? Date.now;
    const sleep = retryOptions?.sleep ?? defaultSleep;
    const timeoutMs =
        typeof retryOptions?.timeoutMs === 'number' && retryOptions.timeoutMs >= 0
            ? retryOptions.timeoutMs
            : DEFAULT_SOURCE_START_RETRY_TIMEOUT_MS;
    const runtimeConfig = resolveSessionHandoffRuntimeConfig();
    return await runSessionHandoffRetryLoop({
        fallbackTimeoutMs: runtimeConfig.machineRpcTimeoutMs,
        retryTimeoutMs: timeoutMs,
        intervalMs:
            typeof retryOptions?.intervalMs === 'number' && retryOptions.intervalMs >= 0
                ? retryOptions.intervalMs
                : DEFAULT_SOURCE_START_RETRY_INTERVAL_MS,
        now,
        sleep,
        runAttempt: async (machineRpcTimeoutMs) =>
            await startSessionHandoffOnSourceWithMachineRpcTimeout(options, machineRpcTimeoutMs),
        shouldRetry: (result) => !result.ok && shouldRetrySourceStart(result),
    });
}

async function prepareTargetSessionHandoff(params: Readonly<{
    sessionId: string;
    handoffId: string;
    sourceMachineId: string;
    targetMachineId: string;
    targetPath: string;
    negotiatedTransportStrategy: SessionHandoffTransportStrategy;
    sourceSessionStorageMode: SessionHandoffStorageMode;
    targetSessionStorageMode?: SessionHandoffStorageMode;
    workspaceTransfer?: SessionHandoffWorkspaceTransfer;
    handoffMetadataV2?: SessionHandoffStartResponse['handoffMetadataV2'];
    allowServerRoutedFallback?: boolean;
    serverId?: string | null;
}>): Promise<
    | Readonly<{ ok: true; response: SessionHandoffPrepareTargetResponse }>
    | Readonly<{ ok: false; errorCode: string; errorMessage: string }>
> {
    return await prepareTargetSessionHandoffWithMachineRpcTimeout(
        params,
        resolveSessionHandoffRuntimeConfig().machineRpcTimeoutMs,
    );
}

async function prepareTargetSessionHandoffWithMachineRpcTimeout(
    params: Parameters<typeof prepareTargetSessionHandoff>[0],
    machineRpcTimeoutMs: number,
): Promise<Awaited<ReturnType<typeof prepareTargetSessionHandoff>>> {
    // Canonical V2: cross-machine prepare requires `handoffMetadataV2` so the target can fetch
    // provider/workspace publications (no inline/legacy fallback), regardless of transport.
    if (
        params.sourceMachineId !== params.targetMachineId
        && !params.handoffMetadataV2
    ) {
        return {
            ok: false,
            errorCode: 'missing_handoff_metadata_v2',
            errorMessage: 'handoffMetadataV2 is required to prepare the target',
        };
    }

    try {
        const raw = await machineRpcWithServerScope<unknown, unknown>({
            machineId: params.targetMachineId,
            method: RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V2,
            payload: {
                sessionId: params.sessionId,
                handoffId: params.handoffId,
                sourceMachineId: params.sourceMachineId,
                targetMachineId: params.targetMachineId,
                negotiatedTransportStrategy: params.negotiatedTransportStrategy,
                ...(typeof params.allowServerRoutedFallback === 'boolean' ? { allowServerRoutedFallback: params.allowServerRoutedFallback } : {}),
                sourceSessionStorageMode: params.sourceSessionStorageMode,
                ...(params.targetSessionStorageMode ? { targetSessionStorageMode: params.targetSessionStorageMode } : {}),
                targetPath: params.targetPath,
                ...(params.handoffMetadataV2 ? { handoffMetadataV2: params.handoffMetadataV2 } : {}),
                ...(params.workspaceTransfer ? { workspaceTransfer: params.workspaceTransfer } : {}),
            },
            serverId: normalizeId(params.serverId) || null,
            timeoutMs: machineRpcTimeoutMs,
            preferScoped: true,
        });
        const errorResult = readRawSessionHandoffError(raw);
        if (errorResult) {
            return {
                ok: false,
                errorCode: errorResult.errorCode,
                errorMessage: errorResult.errorMessage,
            };
        }
        const parsed = SessionHandoffPrepareTargetResponseSchema.safeParse(raw);
        if (!parsed.success) {
            return unsupportedError('Unsupported target handoff prepare response from daemon');
        }
        return { ok: true, response: parsed.data };
    } catch (error) {
        if (isTransientDaemonRpcAvailabilityError(error)) {
            return {
                ok: false,
                errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
                errorMessage:
                    `Daemon RPC is not available (RPC method not available). ` +
                    `The daemon may be stopped, still starting, or not connected to the server.`,
            };
        }
        return {
            ok: false,
            errorCode: 'UNEXPECTED',
            errorMessage: error instanceof Error ? error.message : 'Failed to prepare target handoff',
        };
    }
}

function shouldRetryTargetPrepare(result: Readonly<{ ok: false; errorCode: string }>): boolean {
    return result.errorCode === SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE;
}

function hasPrepareTargetReadyPayload(
    response: SessionHandoffPrepareTargetResponse,
): response is SessionHandoffPrepareTargetResponse & Readonly<{
    remoteSessionId: string;
    directSource: NonNullable<SessionHandoffPrepareTargetResponse['directSource']>;
    resume: NonNullable<SessionHandoffPrepareTargetResponse['resume']>;
}> {
    return typeof response.remoteSessionId === 'string'
        && response.directSource !== undefined
        && response.resume !== undefined;
}

async function pollPreparedTargetSessionHandoffResult(params: Readonly<{
    handoffId: string;
    sessionId: string;
    targetMachineId: string;
    serverId?: string | null;
    timeoutMs: number;
    intervalMs: number;
    now: () => number;
    sleep: (delayMs: number) => Promise<void>;
    onStatus?: (status: SessionHandoffStatus) => void;
}>): Promise<
    | Readonly<{ ok: true; response: SessionHandoffPrepareTargetResponse }>
    | Readonly<{ ok: false; errorCode: string; errorMessage: string; status?: SessionHandoffStatus }>
> {
    // Treat pollTimeoutMs as an idle timeout (time since last observed progress/status change),
    // not as an absolute wall-clock cap. Large replications can legitimately exceed 5m.
    let lastProgressAtMs = params.now();
    let lastStatusKey = '';
    const pollRuntimeConfig = resolveSessionHandoffRuntimeConfig();
    const serverId = normalizeId(params.serverId) || null;
    const pollMachineRpcTimeoutMs = Math.min(
        pollRuntimeConfig.machineRpcTimeoutMs,
        pollRuntimeConfig.machineRpcPollTimeoutMs,
    );

    const buildStatusKey = (status: SessionHandoffStatus): string => {
        const progress = status.progress;
        const planned = progress?.planned ?? null;
        const transferred = progress?.transferred ?? null;
        const current = progress?.current ?? null;
        return [
            status.status,
            status.phase,
            progress?.checkpoint ?? '',
            progress?.updatedAtMs ?? '',
            planned ? JSON.stringify(planned) : '',
            transferred ? JSON.stringify(transferred) : '',
            current ? JSON.stringify(current) : '',
        ].join('|');
    };

    const noteProgress = (status: SessionHandoffStatus) => {
        const nextKey = buildStatusKey(status);
        if (nextKey !== lastStatusKey) {
            lastStatusKey = nextKey;
            lastProgressAtMs = params.now();
        }
    };

    while ((params.now() - lastProgressAtMs) <= params.timeoutMs) {
        try {
            const rawResult = await machineRpcWithServerScope<unknown, unknown>({
                machineId: params.targetMachineId,
                method: RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V2,
                payload: {
                    handoffId: params.handoffId,
                    sessionId: params.sessionId,
                },
                serverId,
                timeoutMs: pollMachineRpcTimeoutMs,
                preferScoped: true,
            });
            const resultError = readRawSessionHandoffError(rawResult);
            if (!resultError) {
                const parsedResult = SessionHandoffPrepareTargetResultGetResponseSchema.safeParse(rawResult);
                if (parsedResult.success) {
                    params.onStatus?.(parsedResult.data.status);
                    return { ok: true, response: parsedResult.data };
                }
                return unsupportedError('Unsupported target handoff prepare result response from daemon');
            }
            if (resultError.errorCode !== 'not_found') {
                return {
                    ok: false,
                    errorCode: resultError.errorCode,
                    errorMessage: resultError.errorMessage,
                    ...(resultError.status ? { status: resultError.status } : {}),
                };
            }
        } catch (error) {
            if (!isTransientDaemonRpcAvailabilityError(error)) {
                return {
                    ok: false,
                    errorCode: 'UNEXPECTED',
                    errorMessage: error instanceof Error ? error.message : 'Failed to poll prepared target handoff result',
                };
            }
        }

        try {
            const rawStatus = await machineRpcWithServerScope<unknown, unknown>({
                machineId: params.targetMachineId,
                method: RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET,
                payload: {
                    handoffId: params.handoffId,
                },
                serverId,
                timeoutMs: pollMachineRpcTimeoutMs,
                preferScoped: true,
            });
            const statusError = readRawSessionHandoffError(rawStatus);
            if (statusError) {
                return {
                    ok: false,
                    errorCode: statusError.errorCode,
                    errorMessage: statusError.errorMessage,
                    ...(statusError.status ? { status: statusError.status } : {}),
                };
            }
            const parsedStatus = SessionHandoffStatusSchema.safeParse((rawStatus as { status?: unknown }).status);
            if (!parsedStatus.success) {
                return unsupportedError('Unsupported target handoff status response from daemon');
            }
            params.onStatus?.(parsedStatus.data);
            noteProgress(parsedStatus.data);
            if (
                parsedStatus.data.status === 'aborted'
                || parsedStatus.data.status === 'awaiting_recovery'
                || parsedStatus.data.status === 'failed'
            ) {
                return {
                    ok: false,
                    errorCode: parsedStatus.data.status,
                    errorMessage: 'Target handoff preparation did not complete successfully',
                    status: parsedStatus.data,
                };
            }
        } catch (error) {
            if (!isTransientDaemonRpcAvailabilityError(error)) {
                return {
                    ok: false,
                    errorCode: 'UNEXPECTED',
                    errorMessage: error instanceof Error ? error.message : 'Failed to poll target handoff status',
                };
            }
        }

        const elapsedIdleMs = params.now() - lastProgressAtMs;
        const remainingMs = params.timeoutMs - elapsedIdleMs;
        if (remainingMs <= 0) {
            break;
        }
        await params.sleep(Math.min(params.intervalMs, remainingMs));
    }

    return {
        ok: false,
        errorCode: 'target_prepare_timeout',
        errorMessage: 'Timed out waiting for target handoff preparation to finish',
    };
}

export async function prepareTargetSessionHandoffWithRetry(
    params: Parameters<typeof prepareTargetSessionHandoff>[0] & Readonly<{
        onStatus?: (status: SessionHandoffStatus) => void;
    }>,
    retryOptions?: CompleteSessionHandoffOptions['targetPrepareRetry'],
): Promise<Awaited<ReturnType<typeof prepareTargetSessionHandoff>>> {
    const now = retryOptions?.now ?? Date.now;
    const sleep = retryOptions?.sleep ?? defaultSleep;
    const timeoutMs =
        typeof retryOptions?.timeoutMs === 'number' && retryOptions.timeoutMs >= 0
            ? retryOptions.timeoutMs
            : DEFAULT_TARGET_PREPARE_RETRY_TIMEOUT_MS;
    const runtimeConfig = resolveSessionHandoffRuntimeConfig();
    const pollTimeoutMs =
        typeof retryOptions?.pollTimeoutMs === 'number' && retryOptions.pollTimeoutMs >= 0
            ? retryOptions.pollTimeoutMs
            : runtimeConfig.targetPreparePollTimeoutMs;
    const prepareAttempt = await runSessionHandoffRetryLoop({
        fallbackTimeoutMs: runtimeConfig.machineRpcTimeoutMs,
        retryTimeoutMs: timeoutMs,
        intervalMs:
            typeof retryOptions?.intervalMs === 'number' && retryOptions.intervalMs >= 0
                ? retryOptions.intervalMs
                : DEFAULT_TARGET_PREPARE_RETRY_INTERVAL_MS,
        now,
        sleep,
        runAttempt: async (machineRpcTimeoutMs) =>
            await prepareTargetSessionHandoffWithMachineRpcTimeout(params, machineRpcTimeoutMs),
        shouldRetry: (result) => !result.ok && shouldRetryTargetPrepare(result),
    });
    if (!prepareAttempt.ok) {
        return prepareAttempt;
    }
    if (hasPrepareTargetReadyPayload(prepareAttempt.response)) {
        params.onStatus?.(prepareAttempt.response.status);
        return prepareAttempt;
    }
    return await pollPreparedTargetSessionHandoffResult({
        handoffId: params.handoffId,
        sessionId: params.sessionId,
        targetMachineId: params.targetMachineId,
        serverId: params.serverId,
        timeoutMs: pollTimeoutMs,
        intervalMs:
            typeof retryOptions?.intervalMs === 'number' && retryOptions.intervalMs >= 0
                ? retryOptions.intervalMs
                : DEFAULT_TARGET_PREPARE_RETRY_INTERVAL_MS,
        now,
        sleep,
        onStatus: params.onStatus,
    });
}

type SessionHandoffCommitParams = Readonly<{
    machineId: string;
    handoffId: string;
    serverId?: string | null;
    workspaceReplicationReverseSourceRootPath?: string | null;
    workspaceReplicationReverseTargetRootPath?: string | null;
}> & (
    | Readonly<{ mode: 'target'; sessionId: string; attemptId: string }>
    | Readonly<{ mode: 'source_cleanup'; sessionId?: never; attemptId?: never }>
);

async function commitSessionHandoff(params: SessionHandoffCommitParams): Promise<
    | Readonly<{ ok: true; response: SessionHandoffCommitResponse }>
    | Readonly<{ ok: false; errorCode: string; errorMessage: string }>
> {
    const runtimeConfig = resolveSessionHandoffRuntimeConfig();
    try {
        const reverseSourceRootPath = normalizeId(params.workspaceReplicationReverseSourceRootPath);
        const reverseTargetRootPath = normalizeId(params.workspaceReplicationReverseTargetRootPath);
        const isTargetV2 = params.mode === 'target';
        const payload: Record<string, unknown> = {
            handoffId: params.handoffId,
            mode: params.mode,
            ...(isTargetV2 ? { sessionId: params.sessionId, attemptId: params.attemptId } : {}),
        };
        if (reverseSourceRootPath && reverseTargetRootPath) {
            payload.workspaceReplicationReverseSourceRootPath = reverseSourceRootPath;
            payload.workspaceReplicationReverseTargetRootPath = reverseTargetRootPath;
        }
        const raw = await machineRpcWithServerScope<unknown, unknown>({
            machineId: params.machineId,
            method: isTargetV2 ? RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT_V2 : RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT,
            payload,
            serverId: normalizeId(params.serverId) || null,
            timeoutMs: runtimeConfig.machineRpcTimeoutMs,
        });
        const errorResult = readRawSessionHandoffError(raw);
        if (errorResult) {
            return {
                ok: false,
                errorCode: errorResult.errorCode,
                errorMessage: errorResult.errorMessage,
            };
        }
        const parsed = SessionHandoffCommitResponseSchema.safeParse(raw);
        if (!parsed.success) {
            return unsupportedError('Unsupported handoff commit response from daemon');
        }
        return { ok: true, response: parsed.data };
    } catch (error) {
        return {
            ok: false,
            errorCode: 'UNEXPECTED',
            errorMessage: error instanceof Error ? error.message : 'Failed to finalize session handoff',
        };
    }
}

async function requireSafeSessionHandoffV2Target(params: Readonly<{
    targetMachineId: string;
    serverId?: string | null;
}>): Promise<Readonly<{ ok: true }> | HandoffErrorResult> {
    try {
        const raw = await machineRpcWithServerScope<unknown, unknown>({
            machineId: params.targetMachineId,
            method: RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V2_GET,
            payload: {},
            serverId: normalizeId(params.serverId) || null,
            timeoutMs: resolveSessionHandoffRuntimeConfig().machineRpcPollTimeoutMs,
            preferScoped: true,
        });
        const capability = raw as { protocolVersion?: unknown; atomicTargetResume?: unknown; targetCleanup?: unknown };
        if (capability.protocolVersion === 2 && capability.atomicTargetResume === true && capability.targetCleanup === true) {
            return { ok: true };
        }
    } catch {
        // A missing/unreachable v2 peer must fail before source stop.
    }
    return unsupportedError('Target daemon does not support safe atomic session handoff v2');
}

async function resumeSessionHandoffTargetV2(params: Readonly<{
    machineId: string;
    handoffId: string;
    sessionId: string;
    attemptId: string;
    connectedServices?: unknown;
    serverId?: string | null;
}>): Promise<Readonly<{ ok: true }> | HandoffErrorResult> {
    try {
        const raw = await machineRpcWithServerScope<unknown, unknown>({
            machineId: params.machineId,
            method: RPC_METHODS.DAEMON_SESSION_HANDOFF_TARGET_RESUME_V2,
            payload: {
                handoffId: params.handoffId,
                sessionId: params.sessionId,
                attemptId: params.attemptId,
                ...(params.connectedServices !== undefined ? { connectedServices: params.connectedServices } : {}),
            },
            serverId: normalizeId(params.serverId) || null,
            timeoutMs: resolveSessionHandoffRuntimeConfig().machineRpcTimeoutMs,
            preferScoped: true,
        });
        const error = readRawSessionHandoffError(raw);
        if (error) return { ok: false, errorCode: error.errorCode, errorMessage: error.errorMessage };
        const parsed = SessionHandoffTargetResumeResponseV2Schema.safeParse(raw);
        if (!parsed.success || parsed.data.disposition === 'preexisting_or_adopted') {
            return unsupportedError('Target runner was preexisting or adopted and is not owned by this handoff');
        }
        return { ok: true };
    } catch (error) {
        return { ok: false, errorCode: 'UNEXPECTED', errorMessage: error instanceof Error ? error.message : 'Failed to resume handoff target' };
    }
}

async function abortSessionHandoff(params: Readonly<{
    sourceMachineId: string;
    targetMachineId?: string | null;
    handoffId: string;
    sessionId?: string;
    reason: string;
    serverId?: string | null;
}>): Promise<boolean> {
    const runtimeConfig = resolveSessionHandoffRuntimeConfig();
    let targetAbsenceProved = false;
    if (params.targetMachineId && params.sessionId) {
        try {
            const raw = await machineRpcWithServerScope<unknown, unknown>({
                machineId: params.targetMachineId,
                method: RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V2,
                payload: { handoffId: params.handoffId, sessionId: params.sessionId, reason: params.reason },
                serverId: normalizeId(params.serverId) || null,
                timeoutMs: runtimeConfig.machineRpcTimeoutMs,
            });
            const parsed = SessionHandoffAbortResponseV2Schema.safeParse(raw);
            targetAbsenceProved = parsed.success && parsed.data.targetCleanup.status === 'proved_absent';
        } catch {
            targetAbsenceProved = false;
        }
    }
    try {
        await machineRpcWithServerScope<unknown, unknown>({
            machineId: params.sourceMachineId,
            method: RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT,
            payload: { handoffId: params.handoffId, reason: params.reason },
            serverId: normalizeId(params.serverId) || null,
            timeoutMs: runtimeConfig.machineRpcTimeoutMs,
        });
    } catch {
        // Source diagnostics are best effort; target absence remains the restart gate.
    }
    return targetAbsenceProved;
}

export async function startSessionHandoff(options: StartSessionHandoffOptions): Promise<StartSessionHandoffResult> {
    const started = await startSessionHandoffOnSourceWithRetry(options, options.sourceStartRetry);
    if (!started.ok) return started;
    return {
        ok: true,
        handoffId: started.response.handoffId,
        status: started.response.status,
        endpointCandidates: started.response.endpointCandidates,
        ...(started.response.handoffMetadataV2 ? { handoffMetadataV2: started.response.handoffMetadataV2 } : {}),
    };
}

export async function completeSessionHandoff(options: CompleteSessionHandoffOptions): Promise<CompleteSessionHandoffResult> {
    const serverId = normalizeId(options.serverId) || null;
    const runtimeConfig = resolveSessionHandoffRuntimeConfig();
    const serverSnapshot = await getServerFeaturesSnapshot({
        force: true,
        ...(serverId ? { serverId } : {}),
    });
    const transport = resolveMachineTransferAvailability({
        serverFeatures: serverSnapshot,
        preferredTransportStrategies: options.preferredTransportStrategies,
    });
    if (!transport.ok) {
        return transport;
    }

    const resolvedSourceMachineId = resolveSourceMachineId(options);
    if (!resolvedSourceMachineId) {
        return {
            ok: false,
            errorCode: 'machine_not_found',
            errorMessage: 'No reachable source machine target found for session handoff',
        };
    }
    const targetV2Capability = await requireSafeSessionHandoffV2Target({
        targetMachineId: options.targetMachineId,
        serverId: options.serverId,
    });
    if (!targetV2Capability.ok) return targetV2Capability;

    const buildSourceRecovery = (handoffId: string) => buildSessionHandoffRecoveryPlan({
        handoffId,
        sessionId: options.sessionId,
        sourceMachineId: resolvedSourceMachineId,
        targetMachineId: options.targetMachineId,
        sourceMetadata: options.sourceMetadata,
        sessionStorageMode: options.sessionStorageMode,
        serverId: options.serverId,
    });
    let sourceRecovery: SessionHandoffRecoveryPlan | undefined;
    let lastReportedStatus: SessionHandoffStatus | null = null;
    const reportStatus = (status: SessionHandoffStatus) => {
        lastReportedStatus = status;
        publishSessionHandoffProgress({
            sessionId: options.sessionId,
            targetMachineId: options.targetMachineId,
            status,
        });
    };

    const reportUiProgressCheckpoint = (input: Readonly<{
        status: SessionHandoffStatus['status'];
        phase: SessionHandoffStatus['phase'];
        phaseDetail: string;
    }>) => {
        const base = lastReportedStatus;
        if (!base) {
            return;
        }
        const baseProgress = base.progress;
        const checkpoint = baseProgress?.checkpoint ?? 'import_session';
        reportStatus({
            ...base,
            status: input.status,
            phase: input.phase,
            progress: {
                updatedAtMs: Date.now(),
                checkpoint,
                planned: baseProgress?.planned ?? {},
                transferred: baseProgress?.transferred ?? {},
                current: {
                    ...(baseProgress?.current ?? {}),
                    phaseDetail: input.phaseDetail,
                },
                resumable: false,
                ...(baseProgress?.warnings ? { warnings: baseProgress.warnings } : {}),
            },
        });
    };

    const started = await startSessionHandoffOnSourceWithRetry({
        ...options,
        sourceMachineId: resolvedSourceMachineId,
        negotiatedTransportStrategy: transport.negotiatedTransportStrategy,
    }, options.sourceStartRetry);
    if (!started.ok) {
        const shouldAttachSourceRecovery = started.status?.recoveryActions.includes('restart_on_source') === true;
        const recoveryHandoffId = shouldAttachSourceRecovery
            ? (started.handoffId ?? started.status?.handoffId ?? null)
            : null;
        const recovery = recoveryHandoffId ? buildSourceRecovery(recoveryHandoffId) : null;
        return {
            ...started,
            ...(recovery ? { recovery } : {}),
        };
    }
    sourceRecovery = buildSourceRecovery(started.response.handoffId) ?? undefined;
    reportStatus(started.response.status);

    const directPeerEndpointCandidates =
        started.response.handoffMetadataV2?.providerBundleTransferPublication?.endpointCandidates
        ?? started.response.endpointCandidates;
    const directPeerRouteInput = {
        serverId,
        remoteMachineId: started.sourceMachineId,
        endpointCandidates: directPeerEndpointCandidates,
    } as const;
    const prepareTransportStrategy =
        transport.negotiatedTransportStrategy === 'direct_peer'
        && transport.allowServerRoutedFallback
        && (
            directPeerEndpointCandidates.length === 0
            || readCachedDirectPeerRoute(directPeerRouteInput).status === 'unavailable'
        )
            ? 'server_routed_stream'
            : transport.negotiatedTransportStrategy;

    const prepared = await prepareTargetSessionHandoffWithRetry({
        sessionId: options.sessionId,
        handoffId: started.response.handoffId,
        sourceMachineId: started.sourceMachineId,
        targetMachineId: options.targetMachineId,
        targetPath: (() => {
            const normalizeWorkspaceRootPath = (raw: unknown): string | null => {
                const candidate = typeof raw === 'string' ? raw.trim() : '';
                if (!candidate.startsWith('/')) return null;
                if (candidate.includes('\0')) return null;
                const segments = candidate.split('/').filter(Boolean);
                if (segments.length === 0) return null;
                if (segments.some((segment) => segment === '..')) return null;
                return `/${segments.join('/')}`;
            };

            // Prefer a daemon-supplied handoff-back target root when present. This avoids relying
            // on hydrated UI state (which can be stale after a cross-machine cutover).
            const daemonHandoffBackTargetRootPath = normalizeWorkspaceRootPath(
                started.response.handoffMetadataV2?.workspaceReplicationHandoffBackTargetRootPath,
            );
            if (
                options.workspaceTransfer?.enabled === true
                && options.workspaceTransfer.strategy === 'sync_changes'
                && daemonHandoffBackTargetRootPath
            ) {
                return daemonHandoffBackTargetRootPath;
            }

            // When handing back to the previous source machine with `sync_changes`, we must target
            // the original source workspace root so one-way-safe baseline checks don't treat the
            // entire tree as diverged (a cross-platform rewrite would create a fresh sibling path).
            const metadataForTargetPathOverride =
                (storage.getState().sessions?.[options.sessionId]?.metadata ?? options.sourceMetadata) as
                    | { handoffV1?: Record<string, unknown> }
                    | null;
            const priorHandoff = metadataForTargetPathOverride?.handoffV1 ?? null;
            const priorSourceMachineId = normalizeId(priorHandoff?.sourceMachineId);
            const requestedTargetMachineId = normalizeId(options.targetMachineId);
            const priorSourceWorkspaceRootPath = normalizeWorkspaceRootPath(priorHandoff?.sourceWorkspaceRootPath);

            if (
                options.workspaceTransfer?.enabled === true
                && options.workspaceTransfer.strategy === 'sync_changes'
                && priorSourceMachineId
                && priorSourceMachineId === requestedTargetMachineId
                && priorSourceWorkspaceRootPath
            ) {
                return priorSourceWorkspaceRootPath;
            }

            return resolveTargetPreparePathForCrossPlatformHandoff({
                sourceMachineId: started.sourceMachineId,
                targetMachineId: options.targetMachineId,
                sourcePath: started.response.targetPath,
            });
        })(),
        ...(started.response.handoffMetadataV2 ? { handoffMetadataV2: started.response.handoffMetadataV2 } : {}),
        negotiatedTransportStrategy: prepareTransportStrategy,
        sourceSessionStorageMode: options.sessionStorageMode,
        ...(options.targetSessionStorageMode ? { targetSessionStorageMode: options.targetSessionStorageMode } : {}),
        ...(options.workspaceTransfer ? { workspaceTransfer: options.workspaceTransfer } : {}),
        allowServerRoutedFallback: transport.allowServerRoutedFallback,
        serverId: options.serverId,
        onStatus: reportStatus,
    }, options.targetPrepareRetry);
        if (!prepared.ok) {
            if (
                transport.negotiatedTransportStrategy === 'direct_peer'
                && directPeerEndpointCandidates.length > 0
                && prepared.errorCode === 'direct_peer_transfer_unavailable'
            ) {
                recordCachedDirectPeerRouteUnavailable(directPeerRouteInput, prepared.errorCode);
            }
        const targetSafeForRestart = await abortSessionHandoff({
            sourceMachineId: started.sourceMachineId,
            targetMachineId: options.targetMachineId,
            handoffId: started.response.handoffId,
            sessionId: options.sessionId,
            reason: prepared.errorCode,
            serverId: options.serverId,
        });
        return {
            ...prepared,
            ...(targetSafeForRestart && sourceRecovery ? { recovery: sourceRecovery } : {}),
        };
    }
    if (prepareTransportStrategy === 'direct_peer' && directPeerEndpointCandidates.length > 0) {
        recordCachedDirectPeerRouteViable(directPeerRouteInput);
    }
    if (!hasPrepareTargetReadyPayload(prepared.response)) {
        return unsupportedError('Target handoff prepare did not return a ready session payload');
    }
    const preparedResponse = prepared.response;

    // From this point onward, the handoff orchestration is primarily UI-driven (resume/wait/commit).
    // Publish a checkpoint-aligned status update so the progress modal doesn't remain stuck on
    // `ready_for_cutover` while the UI is still working.
    reportUiProgressCheckpoint({
        status: 'in_progress',
        phase: 'resuming',
        phaseDetail: 'resuming_target_session',
    });

    const resumeConnectedServices = (() => {
        const metadata = (storage.getState().sessions?.[options.sessionId]?.metadata ?? options.sourceMetadata) as MetadataRecord | null;
        if (!metadata) return undefined;
        return Object.prototype.hasOwnProperty.call(metadata, 'connectedServices')
            ? (metadata as unknown as Record<string, unknown>).connectedServices
            : undefined;
    })();
    const targetAttemptId = `target_${started.response.handoffId}`;
    const resumeResult = await resumeSessionHandoffTargetV2({
        machineId: options.targetMachineId,
        handoffId: started.response.handoffId,
        sessionId: options.sessionId,
        attemptId: targetAttemptId,
        ...(resumeConnectedServices !== undefined ? { connectedServices: resumeConnectedServices } : {}),
        serverId: options.serverId,
    });
    if (!resumeResult.ok) {
        const targetSafeForRestart = await abortSessionHandoff({
            sourceMachineId: started.sourceMachineId,
            targetMachineId: options.targetMachineId,
            handoffId: started.response.handoffId,
            sessionId: options.sessionId,
            reason: resumeResult.errorCode,
            serverId: options.serverId,
        });
        return {
            ok: false,
            errorCode: resumeResult.errorCode,
            errorMessage: resumeResult.errorMessage,
            ...(targetSafeForRestart && sourceRecovery ? { recovery: sourceRecovery } : {}),
        };
    }
    const providerId = preparedResponse.resume.agent;
    const targetSessionStorageMode = options.targetSessionStorageMode ?? options.sessionStorageMode;
    const completedAtMs = Date.now();
    const sourceMetadataForHandoffPatch = (storage.getState().sessions?.[options.sessionId]?.metadata ?? options.sourceMetadata) as MetadataRecord;
    const buildNextMetadata = (metadata: MetadataRecord) => buildSessionHandoffMetadataPatch({
        metadata,
        sourceMetadataForHandoff: sourceMetadataForHandoffPatch,
        providerId,
        sourceMachineId: started.sourceMachineId,
        targetMachineId: options.targetMachineId,
        sessionStorageBefore: options.sessionStorageMode,
        sessionStorageAfter: targetSessionStorageMode,
        targetPath: preparedResponse.resume.directory,
        transportStrategy: prepared.response.status.transportStrategy ?? transport.negotiatedTransportStrategy,
        completedAtMs,
        targetRemoteSessionId: preparedResponse.remoteSessionId,
        targetDirectSource: preparedResponse.directSource as unknown as Record<string, unknown>,
        targetRuntimeDescriptor: preparedResponse.agentRuntimeDescriptorV1,
    });
    const targetFinalization: NonNullable<SessionHandoffRecoveryPlan['targetFinalization']> = {
        sessionId: options.sessionId,
        sourceMachineId: started.sourceMachineId,
        targetMachineId: options.targetMachineId,
        serverId,
        sourceMetadataForHandoff: sourceMetadataForHandoffPatch,
        providerId,
        sessionStorageBefore: options.sessionStorageMode,
        sessionStorageAfter: targetSessionStorageMode,
        targetPath: preparedResponse.resume.directory,
        transportStrategy:
            prepared.response.status.transportStrategy ?? transport.negotiatedTransportStrategy,
        completedAtMs,
        targetRemoteSessionId: preparedResponse.remoteSessionId,
        targetDirectSource: preparedResponse.directSource as unknown as Record<string, unknown>,
        ...(preparedResponse.agentRuntimeDescriptorV1
            ? { targetRuntimeDescriptor: preparedResponse.agentRuntimeDescriptorV1 }
            : {}),
    };
    const currentSessionMetadata = sourceMetadataForHandoffPatch;
    const restoreOptimisticBinding = applyOptimisticSessionHandoffBinding({
        sessionId: options.sessionId,
        metadata: buildNextMetadata(currentSessionMetadata),
    });
    const publishTargetMetadata = async () => {
        await sync.patchSessionMetadataWithRetry(
            options.sessionId,
            (metadata) => buildNextMetadata((metadata ?? options.sourceMetadata) as MetadataRecord),
            { serverId },
        );
    };
    const reapplyOptimisticBinding = () => {
        const reboundMetadata = (storage.getState().sessions?.[options.sessionId]?.metadata ?? options.sourceMetadata) as MetadataRecord;
        writeSessionMetadataToLocalSession(options.sessionId, buildNextMetadata(reboundMetadata));
    };
    let targetSessionActive;
    try {
        targetSessionActive = await waitForSessionHandoffTargetSessionActive({
            sessionId: options.sessionId,
            ensureSessionVisible: async (sessionId) => {
                await followUpSpawnedSessionWithServerScope({
                    sessionId,
                    targetServerId: normalizeId(options.serverId) || null,
                });
                reapplyOptimisticBinding();
            },
            readSession: () => readSessionHandoffSessionActivity(options.sessionId),
            readTargetMachineId: () => readMachineControlTargetForSession(options.sessionId)?.machineId ?? null,
            targetMachineId: options.targetMachineId,
        });
    } catch (error) {
        restoreOptimisticBinding?.();
        const targetSafeForRestart = await abortSessionHandoff({
            sourceMachineId: started.sourceMachineId,
            targetMachineId: options.targetMachineId,
            handoffId: started.response.handoffId,
            sessionId: options.sessionId,
            reason: 'target_session_not_active',
            serverId: options.serverId,
        });
        return {
            ok: false,
            errorCode: 'target_session_not_active',
            errorMessage: error instanceof Error ? error.message : 'Failed to wait for session handoff target session',
            ...(targetSafeForRestart && sourceRecovery ? { recovery: sourceRecovery } : {}),
        };
    }
    if (!targetSessionActive.ok) {
        restoreOptimisticBinding?.();
        const targetSafeForRestart = await abortSessionHandoff({
            sourceMachineId: started.sourceMachineId,
            targetMachineId: options.targetMachineId,
            handoffId: started.response.handoffId,
            sessionId: options.sessionId,
            reason: 'target_session_not_active',
            serverId: options.serverId,
        });
        return {
            ok: false,
            errorCode: 'target_session_not_active',
            errorMessage: targetSessionActive.error,
            ...(targetSafeForRestart && sourceRecovery ? { recovery: sourceRecovery } : {}),
        };
    }

    const confirmedRaw = await machineRpcWithServerScope<unknown, unknown>({
        machineId: options.targetMachineId,
        method: RPC_METHODS.DAEMON_SESSION_HANDOFF_TARGET_CONFIRM_V2,
        payload: {
            handoffId: started.response.handoffId,
            sessionId: options.sessionId,
            attemptId: targetAttemptId,
        },
        serverId: normalizeId(options.serverId) || null,
        timeoutMs: runtimeConfig.machineRpcTimeoutMs,
        preferScoped: true,
    });
    const confirmError = readRawSessionHandoffError(confirmedRaw);
    if (confirmError) {
        restoreOptimisticBinding?.();
        const targetSafeForRestart = await abortSessionHandoff({
            sourceMachineId: started.sourceMachineId,
            targetMachineId: options.targetMachineId,
            handoffId: started.response.handoffId,
            sessionId: options.sessionId,
            reason: confirmError.errorCode,
            serverId: options.serverId,
        });
        return { ok: false, errorCode: confirmError.errorCode, errorMessage: confirmError.errorMessage, ...(targetSafeForRestart && sourceRecovery ? { recovery: sourceRecovery } : {}) };
    }

    await publishTargetMetadata();
    await sync.ensureSessionVisibleForMessageRoute(options.sessionId, { forceRefresh: true });
    reapplyOptimisticBinding();

    const committed = await commitSessionHandoff({
        machineId: options.targetMachineId,
        handoffId: started.response.handoffId,
        mode: 'target',
        sessionId: options.sessionId,
        attemptId: targetAttemptId,
        serverId: options.serverId,
    });
    if (!committed.ok) return committed;
    reportStatus(committed.response.status);
    reapplyOptimisticBinding();

    const committedRecovery: SessionHandoffRecoveryPlan = {
        handoffId: committed.response.handoffId,
        actions: ['retry_source_cleanup'],
        sourceCleanup: {
            machineId: started.sourceMachineId,
            serverId: normalizeId(options.serverId) || null,
            workspaceReplicationReverseSourceRootPath:
                normalizeId(preparedResponse.resume.directory) || null,
            workspaceReplicationReverseTargetRootPath:
                normalizeId(started.response.handoffMetadataV2?.workspaceReplicationSourceRootPath) || null,
        },
        targetFinalization,
    };

    // Source-side cleanup must complete before we declare the handoff "done". If the source keeps
    // running, it can still publish metadata updates (including machine binding) that overwrite the
    // target-side cutover, making handoff-back planning and QA validation unreliable.
    const sourceCleanup = await commitSessionHandoff({
        machineId: started.sourceMachineId,
        handoffId: started.response.handoffId,
        mode: 'source_cleanup',
        serverId: options.serverId,
        workspaceReplicationReverseSourceRootPath: preparedResponse.resume.directory,
        // For handoff-back planning, the reverse direction must target the original source
        // workspace root, not a cross-platform rewrite of the target machine's prepare path.
        workspaceReplicationReverseTargetRootPath: started.response.handoffMetadataV2?.workspaceReplicationSourceRootPath ?? null,
    });
    if (!sourceCleanup.ok) {
        return {
            ...sourceCleanup,
            handoffId: committed.response.handoffId,
            status: committed.response.status,
            recovery: committedRecovery,
        };
    }

    try {
        await finalizeSessionHandoffTargetBinding({
            sessionId: options.sessionId,
            targetMachineId: options.targetMachineId,
            serverId,
            sourceMetadata: options.sourceMetadata,
            buildNextMetadata,
        });
    } catch (error) {
        return {
            ok: false,
            errorCode: 'target_finalization_failed',
            errorMessage: readSessionHandoffFailureMessage(
                error,
                'Failed to finalize session handoff target binding',
            ),
            handoffId: committed.response.handoffId,
            status: committed.response.status,
            recovery: committedRecovery,
        };
    }

    return {
        ok: true,
        handoffId: committed.response.handoffId,
        status: committed.response.status,
    };
}

export async function performSessionHandoffRecoveryAction(params: Readonly<{
    recovery: SessionHandoffRecoveryPlan;
    action: 'restart_on_source' | 'keep_stopped' | 'retry_source_cleanup';
}>): Promise<PerformSessionHandoffRecoveryActionResult> {
    if (params.action === 'keep_stopped') {
        return { ok: true };
    }
    if (params.action === 'retry_source_cleanup') {
        const sourceCleanup = params.recovery.sourceCleanup;
        if (!sourceCleanup) {
            return { ok: false, error: 'No exact source cleanup coordinates are available' };
        }
        const targetFinalization = params.recovery.targetFinalization;
        if (!targetFinalization) {
            return { ok: false, error: 'No exact target finalization coordinates are available' };
        }
        const buildNextMetadata = buildRecoveryTargetMetadataBuilder(targetFinalization);
        try {
            await finalizeSessionHandoffTargetBinding({
                sessionId: targetFinalization.sessionId,
                targetMachineId: targetFinalization.targetMachineId,
                serverId: targetFinalization.serverId,
                sourceMetadata: targetFinalization.sourceMetadataForHandoff,
                buildNextMetadata,
            });
        } catch (error) {
            return {
                ok: false,
                error: readSessionHandoffFailureMessage(
                    error,
                    'Failed to finalize session handoff target binding before source cleanup',
                ),
            };
        }
        const result = await commitSessionHandoff({
            machineId: sourceCleanup.machineId,
            handoffId: params.recovery.handoffId,
            mode: 'source_cleanup',
            serverId: sourceCleanup.serverId,
            workspaceReplicationReverseSourceRootPath:
                sourceCleanup.workspaceReplicationReverseSourceRootPath,
            workspaceReplicationReverseTargetRootPath:
                sourceCleanup.workspaceReplicationReverseTargetRootPath,
        });
        if (!result.ok) return { ok: false, error: result.errorMessage };
        try {
            await finalizeSessionHandoffTargetBinding({
                sessionId: targetFinalization.sessionId,
                targetMachineId: targetFinalization.targetMachineId,
                serverId: targetFinalization.serverId,
                sourceMetadata: targetFinalization.sourceMetadataForHandoff,
                buildNextMetadata,
            });
        } catch (error) {
            return {
                ok: false,
                error: readSessionHandoffFailureMessage(
                    error,
                    'Failed to finalize session handoff target binding after source cleanup',
                ),
            };
        }
        return { ok: true };
    }
    const sourceResume = params.recovery.sourceResume;
    if (!sourceResume) {
        return { ok: false, error: 'No source recovery resume plan is available' };
    }
    const targetCleanup = params.recovery.targetCleanup;
    if (!targetCleanup) {
        return { ok: false, error: 'No exact target cleanup coordinates are available' };
    }
    try {
        const raw = await machineRpcWithServerScope<unknown, unknown>({
            machineId: targetCleanup.machineId,
            method: RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V2,
            payload: {
                handoffId: params.recovery.handoffId,
                sessionId: targetCleanup.sessionId,
                reason: 'restart_on_source_revalidation',
            },
            serverId: targetCleanup.serverId,
            timeoutMs: resolveSessionHandoffRuntimeConfig().machineRpcTimeoutMs,
        });
        const parsed = SessionHandoffAbortResponseV2Schema.safeParse(raw);
        if (
            !parsed.success
            || parsed.data.targetCleanup.status !== 'proved_absent'
            || !parsed.data.status.recoveryActions.includes('restart_on_source')
        ) {
            return { ok: false, error: 'Target absence could not be revalidated' };
        }
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Target absence revalidation failed' };
    }
    const sourceAgentRuntimeDescriptor = isAgentRuntimeDescriptorV1(sourceResume.agentRuntimeDescriptorV1)
        ? sourceResume.agentRuntimeDescriptorV1
        : undefined;
    const resumed = await resumeSession({
        sessionId: sourceResume.sessionId,
        machineId: sourceResume.machineId,
        directory: sourceResume.directory,
        backendTarget: { kind: 'builtInAgent', agentId: sourceResume.agent },
        ...(sourceResume.resume ? { resume: sourceResume.resume } : {}),
        ...(sourceAgentRuntimeDescriptor ? { agentRuntimeDescriptorV1: sourceAgentRuntimeDescriptor } : {}),
        ...(sourceResume.environmentVariables ? { environmentVariables: sourceResume.environmentVariables } : {}),
        transcriptStorage: sourceResume.transcriptStorage,
        ...buildCodexBackendTransportFields({
            codexBackendMode: sourceResume.codexBackendMode,
            agentRuntimeDescriptorV1: sourceAgentRuntimeDescriptor,
        }),
        ...(sourceResume.serverId ? { serverId: sourceResume.serverId } : {}),
    });
    if (resumed.type === 'error') {
        return { ok: false, error: resumed.errorMessage };
    }
    return { ok: true };
}
