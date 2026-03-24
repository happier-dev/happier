import {
    readServerEnabledBit,
    SessionHandoffCommitResponseSchema,
    SessionHandoffPrepareTargetResultGetResponseSchema,
    SessionHandoffPrepareTargetResponseSchema,
    SessionHandoffStartResponseSchema,
    SessionHandoffStatusSchema,
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

import { resumeSession } from './sessions';
import { readMachineTargetForSession, shouldFallbackFromMachineRpc } from './sessionMachineTarget';
import type { Metadata, Session } from '../domains/state/storageTypes';
import { buildSessionHandoffRecoveryPlan, type SessionHandoffRecoveryPlan } from '../domains/sessionHandoff/recoveryPlan';
import { waitForSessionHandoffTargetSessionActive } from '../domains/sessionHandoff/waitForSessionHandoffTargetSessionActive';
import { readSessionHandoffSessionActivity } from '../domains/sessionHandoff/readSessionHandoffSessionActivity';
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

function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
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

const DEFAULT_TARGET_PREPARE_RETRY_TIMEOUT_MS = 15_000;
const DEFAULT_TARGET_PREPARE_POLL_TIMEOUT_MS = 300_000;
const DEFAULT_TARGET_PREPARE_RETRY_INTERVAL_MS = 500;
const DEFAULT_SOURCE_START_RETRY_TIMEOUT_MS = 15_000;
const DEFAULT_SOURCE_START_RETRY_INTERVAL_MS = 500;
const DEFAULT_SESSION_HANDOFF_MACHINE_RPC_TIMEOUT_MS = 90_000;
const DEFAULT_SESSION_HANDOFF_MACHINE_RPC_POLL_TIMEOUT_MS = 10_000;
const DEFAULT_SESSION_HANDOFF_POST_COMMIT_BINDING_STABILIZATION_TIMEOUT_MS = 5_000;
const DEFAULT_SESSION_HANDOFF_POST_COMMIT_BINDING_STABILIZATION_INTERVAL_MS = 250;
const DEFAULT_SESSION_HANDOFF_POST_COMMIT_BINDING_STABLE_POLLS = 2;

function defaultSleep(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function readSessionHandoffMachineRpcTimeoutMs(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_SESSION_HANDOFF_MACHINE_RPC_TIMEOUT_MS ?? '').trim();
    if (!raw) return DEFAULT_SESSION_HANDOFF_MACHINE_RPC_TIMEOUT_MS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_SESSION_HANDOFF_MACHINE_RPC_TIMEOUT_MS;
    return Math.max(5_000, Math.min(300_000, parsed));
}

function readSessionHandoffMachineRpcPollTimeoutMs(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_SESSION_HANDOFF_MACHINE_RPC_POLL_TIMEOUT_MS ?? '').trim();
    if (!raw) return DEFAULT_SESSION_HANDOFF_MACHINE_RPC_POLL_TIMEOUT_MS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_SESSION_HANDOFF_MACHINE_RPC_POLL_TIMEOUT_MS;
    return Math.max(1_000, Math.min(60_000, parsed));
}

function readSessionHandoffTargetPreparePollTimeoutMs(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_SESSION_HANDOFF_TARGET_PREPARE_POLL_TIMEOUT_MS ?? '').trim();
    if (!raw) return DEFAULT_TARGET_PREPARE_POLL_TIMEOUT_MS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_TARGET_PREPARE_POLL_TIMEOUT_MS;
    return Math.max(5_000, Math.min(600_000, parsed));
}

function readSessionHandoffPostCommitBindingStabilizationTimeoutMs(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_SESSION_HANDOFF_POST_COMMIT_BINDING_STABILIZATION_TIMEOUT_MS ?? '').trim();
    if (!raw) return DEFAULT_SESSION_HANDOFF_POST_COMMIT_BINDING_STABILIZATION_TIMEOUT_MS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_SESSION_HANDOFF_POST_COMMIT_BINDING_STABILIZATION_TIMEOUT_MS;
    return Math.max(500, Math.min(30_000, parsed));
}

function readSessionHandoffPostCommitBindingStabilizationIntervalMs(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_SESSION_HANDOFF_POST_COMMIT_BINDING_STABILIZATION_INTERVAL_MS ?? '').trim();
    if (!raw) return DEFAULT_SESSION_HANDOFF_POST_COMMIT_BINDING_STABILIZATION_INTERVAL_MS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_SESSION_HANDOFF_POST_COMMIT_BINDING_STABILIZATION_INTERVAL_MS;
    return Math.max(50, Math.min(5_000, parsed));
}

function readSessionHandoffPostCommitBindingStablePolls(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_SESSION_HANDOFF_POST_COMMIT_BINDING_STABLE_POLLS ?? '').trim();
    if (!raw) return DEFAULT_SESSION_HANDOFF_POST_COMMIT_BINDING_STABLE_POLLS;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_SESSION_HANDOFF_POST_COMMIT_BINDING_STABLE_POLLS;
    return Math.max(1, Math.min(10, parsed));
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
    const sourceTarget = readMachineTargetForSession(options.sessionId);
    const explicitSourceMachineId = normalizeId(options.sourceMachineId);
    const sourceMachineId = sourceTarget?.machineId ?? explicitSourceMachineId;
    const targetMachineId = normalizeId(options.targetMachineId);
    if (sourceMachineId && targetMachineId && sourceMachineId === targetMachineId && explicitSourceMachineId && explicitSourceMachineId !== targetMachineId) {
        return null;
    }
    return sourceMachineId || null;
}

async function startSessionHandoffOnSource(options: StartSessionHandoffOptions): Promise<StartSessionHandoffAttemptResult> {
    return await startSessionHandoffOnSourceWithMachineRpcTimeout(options, readSessionHandoffMachineRpcTimeoutMs());
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
    return await runSessionHandoffRetryLoop({
        fallbackTimeoutMs: readSessionHandoffMachineRpcTimeoutMs(),
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
    return await prepareTargetSessionHandoffWithMachineRpcTimeout(params, readSessionHandoffMachineRpcTimeoutMs());
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
            method: RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET,
            payload: {
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
    const serverId = normalizeId(params.serverId) || null;
    const pollMachineRpcTimeoutMs = Math.min(
        readSessionHandoffMachineRpcTimeoutMs(),
        readSessionHandoffMachineRpcPollTimeoutMs(),
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
                method: RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET,
                payload: {
                    handoffId: params.handoffId,
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
    const pollTimeoutMs =
        typeof retryOptions?.pollTimeoutMs === 'number' && retryOptions.pollTimeoutMs >= 0
            ? retryOptions.pollTimeoutMs
            : readSessionHandoffTargetPreparePollTimeoutMs();
    const prepareAttempt = await runSessionHandoffRetryLoop({
        fallbackTimeoutMs: readSessionHandoffMachineRpcTimeoutMs(),
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

async function commitSessionHandoff(params: Readonly<{
    machineId: string;
    handoffId: string;
    mode: 'target' | 'source_cleanup';
    serverId?: string | null;
    workspaceReplicationReverseSourceRootPath?: string | null;
    workspaceReplicationReverseTargetRootPath?: string | null;
}>): Promise<
    | Readonly<{ ok: true; response: SessionHandoffCommitResponse }>
    | Readonly<{ ok: false; errorCode: string; errorMessage: string }>
> {
    try {
        const reverseSourceRootPath = normalizeId(params.workspaceReplicationReverseSourceRootPath);
        const reverseTargetRootPath = normalizeId(params.workspaceReplicationReverseTargetRootPath);
        const payload: Record<string, unknown> = { handoffId: params.handoffId, mode: params.mode };
        if (reverseSourceRootPath && reverseTargetRootPath) {
            payload.workspaceReplicationReverseSourceRootPath = reverseSourceRootPath;
            payload.workspaceReplicationReverseTargetRootPath = reverseTargetRootPath;
        }
        const raw = await machineRpcWithServerScope<unknown, unknown>({
            machineId: params.machineId,
            method: RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT,
            payload,
            serverId: normalizeId(params.serverId) || null,
            timeoutMs: readSessionHandoffMachineRpcTimeoutMs(),
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

async function abortSessionHandoff(params: Readonly<{
    sourceMachineId: string;
    targetMachineId?: string | null;
    handoffId: string;
    reason: string;
    serverId?: string | null;
}>): Promise<void> {
    const abortOnMachine = async (machineId: string): Promise<void> => {
        await machineRpcWithServerScope<unknown, unknown>({
            machineId,
            method: RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT,
            payload: {
                handoffId: params.handoffId,
                reason: params.reason,
            },
            serverId: normalizeId(params.serverId) || null,
            timeoutMs: readSessionHandoffMachineRpcTimeoutMs(),
        });
    };

    const machineIds = [
        normalizeId(params.targetMachineId),
        normalizeId(params.sourceMachineId),
    ].filter((machineId, index, values): machineId is string => Boolean(machineId) && values.indexOf(machineId) === index);

    for (const machineId of machineIds) {
        try {
            await abortOnMachine(machineId);
        } catch {
            // Best-effort abort.
        }
    }
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

    const buildSourceRecovery = (handoffId: string) => buildSessionHandoffRecoveryPlan({
        handoffId,
        sessionId: options.sessionId,
        sourceMachineId: resolvedSourceMachineId,
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

            // When handing back to the previous source machine with `sync_changes`, we must target
            // the original source workspace root so one-way-safe baseline checks don't treat the
            // entire tree as diverged (a cross-platform rewrite would create a fresh sibling path).
            const priorHandoff = (options.sourceMetadata as { handoffV1?: Record<string, unknown> } | null)?.handoffV1 ?? null;
            const priorSourceMachineId = normalizeId(priorHandoff?.sourceMachineId);
            const priorTargetMachineId = normalizeId(priorHandoff?.targetMachineId);
            const requestedTargetMachineId = normalizeId(options.targetMachineId);
            const currentSourceMachineId = normalizeId(started.sourceMachineId);
            const priorSourceWorkspaceRootPath = normalizeWorkspaceRootPath(priorHandoff?.sourceWorkspaceRootPath);

            if (
                options.workspaceTransfer?.enabled === true
                && options.workspaceTransfer.strategy === 'sync_changes'
                && priorSourceMachineId
                && priorTargetMachineId
                && priorSourceMachineId === requestedTargetMachineId
                && priorTargetMachineId === currentSourceMachineId
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
        await abortSessionHandoff({
            sourceMachineId: started.sourceMachineId,
            targetMachineId: options.targetMachineId,
            handoffId: started.response.handoffId,
            reason: prepared.errorCode,
            serverId: options.serverId,
        });
        return {
            ...prepared,
            ...(sourceRecovery ? { recovery: sourceRecovery } : {}),
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

    const preparedAgentRuntimeDescriptor = isAgentRuntimeDescriptorV1(preparedResponse.agentRuntimeDescriptorV1)
        ? preparedResponse.agentRuntimeDescriptorV1
        : undefined;
    const resumeResult = await resumeSession({
        sessionId: options.sessionId,
        machineId: options.targetMachineId,
        directory: preparedResponse.resume.directory,
        backendTarget: { kind: 'builtInAgent', agentId: preparedResponse.resume.agent },
        resume: preparedResponse.resume.resume,
        attachMetadataIdentityPolicy: 'replace_with_runtime_identity',
        preferRequestedMachineTarget: true,
        preferScopedMachineRpc: true,
        ...(preparedAgentRuntimeDescriptor ? { agentRuntimeDescriptorV1: preparedAgentRuntimeDescriptor } : {}),
        ...(preparedResponse.resume.environmentVariables ? { environmentVariables: preparedResponse.resume.environmentVariables } : {}),
        transcriptStorage: preparedResponse.resume.transcriptStorage,
        ...buildCodexBackendTransportFields({
            codexBackendMode: preparedResponse.resume.codexBackendMode,
            agentRuntimeDescriptorV1: preparedAgentRuntimeDescriptor,
        }),
        ...(normalizeId(options.serverId) ? { serverId: normalizeId(options.serverId) } : {}),
    });
    if (resumeResult.type === 'error') {
        await abortSessionHandoff({
            sourceMachineId: started.sourceMachineId,
            targetMachineId: options.targetMachineId,
            handoffId: started.response.handoffId,
            reason: resumeResult.errorCode,
            serverId: options.serverId,
        });
        return {
            ok: false,
            errorCode: resumeResult.errorCode,
            errorMessage: resumeResult.errorMessage,
            ...(sourceRecovery ? { recovery: sourceRecovery } : {}),
        };
    }
    const providerId = preparedResponse.resume.agent;
    const targetSessionStorageMode = options.targetSessionStorageMode ?? options.sessionStorageMode;
    const completedAtMs = Date.now();
    const buildNextMetadata = (metadata: MetadataRecord) => buildSessionHandoffMetadataPatch({
        metadata,
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
    const currentSessionMetadata = (storage.getState().sessions?.[options.sessionId]?.metadata ?? options.sourceMetadata) as MetadataRecord;
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
            readTargetMachineId: () => readMachineTargetForSession(options.sessionId)?.machineId ?? null,
            targetMachineId: options.targetMachineId,
        });
    } catch (error) {
        restoreOptimisticBinding?.();
        await abortSessionHandoff({
            sourceMachineId: started.sourceMachineId,
            targetMachineId: options.targetMachineId,
            handoffId: started.response.handoffId,
            reason: 'target_session_not_active',
            serverId: options.serverId,
        });
        return {
            ok: false,
            errorCode: 'target_session_not_active',
            errorMessage: error instanceof Error ? error.message : 'Failed to wait for session handoff target session',
            ...(sourceRecovery ? { recovery: sourceRecovery } : {}),
        };
    }
    if (!targetSessionActive.ok) {
        restoreOptimisticBinding?.();
        await abortSessionHandoff({
            sourceMachineId: started.sourceMachineId,
            targetMachineId: options.targetMachineId,
            handoffId: started.response.handoffId,
            reason: 'target_session_not_active',
            serverId: options.serverId,
        });
        return {
            ok: false,
            errorCode: 'target_session_not_active',
            errorMessage: targetSessionActive.error,
            ...(sourceRecovery ? { recovery: sourceRecovery } : {}),
        };
    }

    await publishTargetMetadata();
    await sync.ensureSessionVisibleForMessageRoute(options.sessionId, { forceRefresh: true });
    reapplyOptimisticBinding();

    const committed = await commitSessionHandoff({
        machineId: options.targetMachineId,
        handoffId: started.response.handoffId,
        mode: 'target',
        serverId: options.serverId,
    });
    if (!committed.ok) return committed;
    reportStatus(committed.response.status);
    reapplyOptimisticBinding();

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
        workspaceReplicationReverseTargetRootPath: started.response.targetPath,
    });
    if (!sourceCleanup.ok) return sourceCleanup;

    const stabilizedBinding = await stabilizeSessionHandoffTargetBinding({
        readSession: () => readSessionHandoffSessionActivity(options.sessionId),
        readTargetMachineId: () => readMachineTargetForSession(options.sessionId)?.machineId ?? null,
        reapplyOptimisticBinding,
        targetMachineId: options.targetMachineId,
        timeoutMs: readSessionHandoffPostCommitBindingStabilizationTimeoutMs(),
        pollIntervalMs: readSessionHandoffPostCommitBindingStabilizationIntervalMs(),
        requiredStablePolls: readSessionHandoffPostCommitBindingStablePolls(),
    });
    if (!stabilizedBinding.ok) {
        reapplyOptimisticBinding();
    }
    await publishTargetMetadata();
    await sync.ensureSessionVisibleForMessageRoute(options.sessionId, { forceRefresh: true });
    reapplyOptimisticBinding();
    const finalStabilizedBinding = await stabilizeSessionHandoffTargetBinding({
        readSession: () => readSessionHandoffSessionActivity(options.sessionId),
        readTargetMachineId: () => readMachineTargetForSession(options.sessionId)?.machineId ?? null,
        reapplyOptimisticBinding,
        targetMachineId: options.targetMachineId,
        timeoutMs: readSessionHandoffPostCommitBindingStabilizationTimeoutMs(),
        pollIntervalMs: readSessionHandoffPostCommitBindingStabilizationIntervalMs(),
        requiredStablePolls: readSessionHandoffPostCommitBindingStablePolls(),
    });
    if (!finalStabilizedBinding.ok) {
        reapplyOptimisticBinding();
    }

    return {
        ok: true,
        handoffId: committed.response.handoffId,
        status: committed.response.status,
    };
}

export async function performSessionHandoffRecoveryAction(params: Readonly<{
    recovery: SessionHandoffRecoveryPlan;
    action: 'restart_on_source' | 'keep_stopped';
}>): Promise<PerformSessionHandoffRecoveryActionResult> {
    if (params.action === 'keep_stopped') {
        return { ok: true };
    }
    const sourceResume = params.recovery.sourceResume;
    if (!sourceResume) {
        return { ok: false, error: 'No source recovery resume plan is available' };
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
