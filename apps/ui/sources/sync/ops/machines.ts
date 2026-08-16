/**
 * Machine operations for remote procedure calls
 */

import type {
    AgentSessionStartupInstructionsV1,
    BugReportMachineDiagnosticsSnapshot,
    MachineUpdateMetadataRequest,
    MachineUpdateMetadataResponse,
    SpawnSessionResult,
} from '@happier-dev/protocol';
import {
    normalizeSpawnSessionNonceResolution,
    SPAWN_SESSION_ERROR_CODES,
    settleSpawnSessionNonce,
} from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS, isRpcMethodNotFoundResult } from '@happier-dev/protocol/rpc';

import { apiSocket } from '../api/session/apiSocket';
import type { MachineMetadata } from '../domains/state/storageTypes';
import {
    buildSpawnHappySessionRpcParams,
    buildTrustedHiddenSystemSessionSpawnHappySessionRpcParams,
    type SpawnHappySessionRpcParams,
    type SpawnSessionOptions,
} from '../domains/session/spawn/spawnSessionPayload';
import { createUiSessionSpawnUserAttemptId, normalizeSpawnSessionNonce } from '../domains/session/spawn/spawnSessionNonce';
import { createSpawnAttemptKeyForFreshSpawnOptions } from '../domains/session/spawn/spawnAttemptKey';
import {
    acquireSpawnAttemptCustody,
    clearSpawnAttemptCustody,
    markSpawnAttemptCreated,
    markSpawnAttemptSubmitted,
    normalizeSpawnUserAttemptId,
    readSpawnAttemptCustodyState,
    type PersistedSpawnAttempt,
} from '../domains/session/spawn/spawnAttemptNonceStore';
import { readSpawnSessionRpcTimeoutMsFromEnv } from '../domains/session/spawn/spawnSessionRpcTimeout';
import { storage } from '../domains/state/storage';
import { isPlainObject, normalizeSpawnSessionResult } from './_shared';
import { isSocketIoAckTimeoutError } from '@/sync/runtime/socketIoAckTimeout';
import { mergeMachineMetadataForVersionMismatch } from './machineMetadataMerge';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { stopSessionViaDaemonMachineRpc } from './sessionStopStrategy';
import {
    MACHINE_ENCRYPT_RAW_ATTRIBUTION_EVENTS,
    measureMachineEncryptRawAttribution,
} from '@/sync/encryption/machineEncryption';
import { prepareAccountSettingsForDaemonSpawnIfNeeded } from './accountSettingsDaemonSpawnPreparation';
import { isAccountSettingsScopeChangedDuringSpawnPreparationError } from '@/sync/engine/settings/accountSettingsSpawnPreparationError';
import { delay } from '@/utils/timing/time';
import {
    isVersionSupported,
    MINIMUM_CLI_BACKEND_TARGET_SPAWN_VERSION,
} from '@/utils/system/versionUtils';
import {
    isProviderSafeDaemonSessionMethodAbsent,
    requiresProviderSafeSessionRpc,
} from './providerDaemonSessionCompatibility';

export type { SpawnHappySessionRpcParams, SpawnSessionOptions } from '../domains/session/spawn/spawnSessionPayload';
export { buildSpawnHappySessionRpcParams } from '../domains/session/spawn/spawnSessionPayload';

export type MachineSpawnAttemptCustody =
    | Readonly<{
        status: 'unresolved';
        userAttemptId: string;
        spawnNonce: string;
        targetFingerprint: string;
        machineId: string;
        scope: Readonly<{ serverId: string; accountId: string }>;
        createdSessionId: string | null;
        firstTurnLocalId: string;
        attachmentMessageLocalId: string;
    }>
    | Readonly<{
        status: 'completed';
        userAttemptId: string;
        spawnNonce: string;
        targetFingerprint: string;
        machineId: string;
        scope: Readonly<{ serverId: string; accountId: string }>;
        createdSessionId: string | null;
        firstTurnLocalId: string;
        attachmentMessageLocalId: string;
    }>
    | Readonly<{ status: 'corrupt' }>
    | Readonly<{ status: 'lock_unavailable' }>;

export type MachineSpawnNewSessionResult = SpawnSessionResult & Readonly<{
    spawnAttemptCustody?: MachineSpawnAttemptCustody;
}>;

export type MachineResolveSpawnSessionByNonceResult =
    | { status: 'success'; sessionId: string }
    | { status: 'pending' }
    | { status: 'not_found' }
    | { status: 'unsupported' }
    | { status: 'transport_error' };

const DEFAULT_MACHINE_SPAWN_NONCE_RESOLUTION_POLL_INTERVAL_MS = 1_000;

function readAuthoritativeMachineHomeDir(params: Readonly<{
    machineId: string;
    effectiveServerId: string;
    activeServerId: string;
}>): string | null {
    const state = storage.getState();
    const machineId = params.machineId.trim();
    const machine = params.effectiveServerId === params.activeServerId
        ? state.machines[machineId]
        : state.machineListByServerId[params.effectiveServerId]?.find((candidate) => candidate.id === machineId);
    const homeDir = machine?.metadata?.homeDir;
    return typeof homeDir === 'string' && homeDir.trim() ? homeDir.trim() : null;
}

function resolveSpawnAttemptTargetFingerprint(params: Readonly<{
    options: SpawnSessionOptions;
    effectiveServerId: string;
    activeServerId: string;
}>): string | null {
    const machineHomeDir = readAuthoritativeMachineHomeDir({
        machineId: params.options.machineId,
        effectiveServerId: params.effectiveServerId,
        activeServerId: params.activeServerId,
    });
    if (!machineHomeDir) return null;
    return createSpawnAttemptKeyForFreshSpawnOptions({
        ...params.options,
        serverId: params.effectiveServerId,
    }, machineHomeDir);
}

function readMachineDaemonCliVersion(machineId: string): string | null {
    const rawVersion = storage.getState().machines[machineId]?.daemonState?.startedWithCliVersion;
    return typeof rawVersion === 'string' && rawVersion.trim().length > 0 ? rawVersion.trim() : null;
}

function remapLegacyDirectoryCompatibilityError(params: Readonly<{
    result: SpawnSessionResult;
    directory: string;
    daemonCliVersion: string | null;
}>): SpawnSessionResult {
    if (params.result.type !== 'error') {
        return params.result;
    }

    if (params.result.errorCode !== SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST) {
        return params.result;
    }

    const sentDirectory = params.directory.trim();
    if (!sentDirectory) {
        return params.result;
    }

    const normalizedMessage = params.result.errorMessage.trim().toLowerCase();
    if (normalizedMessage !== 'directory is required') {
        return params.result;
    }

    const versionLabel = params.daemonCliVersion ?? 'an older preview build';
    return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage:
            `The selected machine rejected the session directory even though the app sent one. ` +
            `This usually means the machine is running an incompatible daemon (${versionLabel}) ` +
            `or a stale machine registration. Restart or re-authorize the CLI on that machine, then update it to a compatible 0.1.0-dev or v0.2.0+ build.`,
    };
}

function readSpawnPayloadNonce(params: SpawnHappySessionRpcParams): string | null {
    return normalizeSpawnSessionNonce(params.spawnNonce);
}

function withSpawnAttemptCustody(
    result: SpawnSessionResult,
    spawnAttemptCustody?: MachineSpawnAttemptCustody,
): MachineSpawnNewSessionResult {
    return { ...result, ...(spawnAttemptCustody ? { spawnAttemptCustody } : {}) };
}

function buildSpawnAttemptCustodyIdentity(
    status: 'unresolved' | 'completed',
    record: PersistedSpawnAttempt,
): Extract<MachineSpawnAttemptCustody, { status: 'unresolved' | 'completed' }> {
    return {
        status,
        userAttemptId: record.userAttemptId,
        spawnNonce: record.nonce,
        targetFingerprint: record.targetFingerprint,
        machineId: record.machineId,
        scope: record.scope,
        createdSessionId: record.createdSessionId,
        firstTurnLocalId: record.firstTurnLocalId,
        attachmentMessageLocalId: record.attachmentMessageLocalId,
    };
}

export async function completeMachineSpawnAttemptCustody(
    custody: Extract<MachineSpawnAttemptCustody, { status: 'completed' }>,
): Promise<boolean> {
    return await clearSpawnAttemptCustody({
        scope: custody.scope,
        machineId: custody.machineId,
        targetFingerprint: custody.targetFingerprint,
        userAttemptId: custody.userAttemptId,
        nonce: custody.spawnNonce,
    });
}

export async function completePendingMachineSpawnAttemptCustodyForSession(
    params: Readonly<{ sessionId: string; serverId?: string | null }>,
): Promise<boolean | null> {
    const sessionId = params.sessionId.trim();
    const state = storage.getState();
    const profileScope = state.profileScope;
    if (!sessionId || !profileScope) return null;
    const scope = {
        serverId: params.serverId?.trim() || profileScope.serverId,
        accountId: profileScope.accountId,
    };
    const custodyState = readSpawnAttemptCustodyState(scope);
    if (custodyState.status === 'missing') return null;
    if (custodyState.status !== 'valid') return false;
    const matchingRecords = Object.values(custodyState.attempts)
        .filter((record) => record.createdSessionId === sessionId);
    if (matchingRecords.length === 0) return null;
    if (matchingRecords.length !== 1) return false;
    const [record] = matchingRecords;
    return await clearSpawnAttemptCustody({
        scope: record.scope,
        machineId: record.machineId,
        targetFingerprint: record.targetFingerprint,
        userAttemptId: record.userAttemptId,
        nonce: record.nonce,
    });
}

function isInterruptedSpawnRpcTransportError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const message = error.message.toLowerCase();
    return message.includes('socket has been disconnected')
        || message.includes('socket connection was closed unexpectedly');
}

function isSessionWebhookTimeoutResult(result: SpawnSessionResult): boolean {
    return result.type === 'error'
        && result.errorCode === SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT;
}

function isAcceptedPendingSpawnResult(result: SpawnSessionResult): boolean {
    return result.type === 'success'
        && !result.sessionId
        && result.sessionIdStatus === 'pending';
}

async function recoverMachineSpawnResultByNonce(params: Readonly<{
    result: SpawnSessionResult;
    machineId: string;
    spawnNonce: string | null;
    serverId: string | null;
}>): Promise<SpawnSessionResult> {
    const acceptedPending = isAcceptedPendingSpawnResult(params.result);
    if (!acceptedPending && !isSessionWebhookTimeoutResult(params.result)) {
        return params.result;
    }
    if (!params.spawnNonce) {
        return params.result;
    }

    const resolved = await machineResolveSpawnSessionByNonceUntilSettled({
        machineId: params.machineId,
        spawnNonce: params.spawnNonce,
        serverId: params.serverId,
    });
    if (resolved.status !== 'success') {
        return acceptedPending
            ? {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
                errorMessage: 'Session startup is still pending for the accepted launch attempt',
              }
            : params.result;
    }

    return {
        type: 'success',
        sessionId: resolved.sessionId,
    };
}

// Exported session operation functions

/**
 * Spawn a new remote session on a specific machine
 */
async function machineSpawnNewSessionInternal(
    options: SpawnSessionOptions,
    trustedHiddenSystemSessionStartupInstructions?: AgentSessionStartupInstructionsV1,
): Promise<MachineSpawnNewSessionResult> {
    let providerSafeRpcRequired = false;
    let custody: Readonly<{
        scope: Readonly<{ serverId: string; accountId: string }>;
        machineId: string;
        targetFingerprint: string;
        record: PersistedSpawnAttempt;
        serverId: string | null;
    }> | null = null;
    let spawnSubmitted = false;
    let nonceRecoveryContext: Readonly<{
        machineId: string;
        spawnNonce: string;
        serverId: string | null;
    }> | null = null;
    const clearCustody = async (): Promise<boolean> => {
        if (!custody) return true;
        const cleared = await clearSpawnAttemptCustody({
            scope: custody.scope,
            machineId: custody.machineId,
            targetFingerprint: custody.targetFingerprint,
            userAttemptId: custody.record.userAttemptId,
        });
        custody = null;
        return cleared;
    };
    try {
        providerSafeRpcRequired = requiresProviderSafeSessionRpc({
            modelSelection: options.modelSelection,
        });

        const preparation = await prepareAccountSettingsForDaemonSpawnIfNeeded(options.accountSettingsVersionHint);
        const preparedOptionsWithoutNonce: SpawnSessionOptions = { ...options, ...preparation };
        const { machineId } = preparedOptionsWithoutNonce;
        const serverId = typeof preparedOptionsWithoutNonce.serverId === 'string'
            ? preparedOptionsWithoutNonce.serverId.trim()
            : null;
        const daemonCliVersion = readMachineDaemonCliVersion(machineId);
        if (
            daemonCliVersion
            && !isVersionSupported(daemonCliVersion, MINIMUM_CLI_BACKEND_TARGET_SPAWN_VERSION)
        ) {
            return withSpawnAttemptCustody({
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage:
                    `This machine is running an unsupported Happier CLI (detected ${daemonCliVersion}). ` +
                    'Update Happier CLI on the machine before starting a session.',
            });
        }

        const profileScope = storage.getState().profileScope;
        if (!profileScope) {
            return withSpawnAttemptCustody({
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.ACCOUNT_SCOPE_CHANGED,
                errorMessage: 'Account scope is unavailable for durable session launch recovery.',
            });
        }
        const scope = {
            serverId: serverId || profileScope.serverId,
            accountId: profileScope.accountId,
        };
        const targetFingerprint = resolveSpawnAttemptTargetFingerprint({
            options: preparedOptionsWithoutNonce,
            effectiveServerId: scope.serverId,
            activeServerId: profileScope.serverId,
        });
        if (!targetFingerprint) {
            return withSpawnAttemptCustody({
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'The selected machine home directory is unavailable. Refresh the machine list before starting a session.',
            });
        }
        const userAttemptId =
            normalizeSpawnUserAttemptId(preparedOptionsWithoutNonce.userAttemptId)
            ?? createUiSessionSpawnUserAttemptId();
        const acquired = await acquireSpawnAttemptCustody({
            scope,
            machineId,
            targetFingerprint,
            userAttemptId,
            seedNonce: normalizeSpawnSessionNonce(preparedOptionsWithoutNonce.spawnNonce),
        });
        if (acquired.status === 'corrupt') {
            return withSpawnAttemptCustody({
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Saved launch recovery state is corrupt. No session was started.',
            }, { status: 'corrupt' });
        }
        if (acquired.status === 'lock_unavailable') {
            return withSpawnAttemptCustody({
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'This browser cannot safely coordinate session launch recovery. No session was started.',
            }, { status: 'lock_unavailable' });
        }
        custody = {
            scope,
            machineId,
            targetFingerprint,
            record: acquired.record,
            serverId,
        };

        if (acquired.reused) {
            if (acquired.record.createdSessionId) {
                return withSpawnAttemptCustody(
                    { type: 'success', sessionId: acquired.record.createdSessionId },
                    buildSpawnAttemptCustodyIdentity('completed', acquired.record),
                );
            }
            if (acquired.record.submissionState === 'prepared') {
                await clearCustody();
                return await machineSpawnNewSessionInternal(
                    options,
                    trustedHiddenSystemSessionStartupInstructions,
                );
            }
            const resolved = await machineResolveSpawnSessionByNonceUntilSettled({
                machineId,
                spawnNonce: acquired.record.nonce,
                serverId,
            });
            if (resolved.status === 'success') {
                const created = await markSpawnAttemptCreated({
                    scope,
                    machineId,
                    targetFingerprint,
                    userAttemptId: acquired.record.userAttemptId,
                    nonce: acquired.record.nonce,
                    createdSessionId: resolved.sessionId,
                });
                if (!created) {
                    return withSpawnAttemptCustody({
                        type: 'error',
                        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                        errorMessage: 'Created session custody could not be committed.',
                    }, buildSpawnAttemptCustodyIdentity('unresolved', acquired.record));
                }
                const completed = buildSpawnAttemptCustodyIdentity('completed', created);
                return withSpawnAttemptCustody({ type: 'success', sessionId: resolved.sessionId }, completed);
            }
            if (resolved.status === 'not_found') {
                await clearCustody();
                return await machineSpawnNewSessionInternal(
                    options,
                    trustedHiddenSystemSessionStartupInstructions,
                );
            }
            return withSpawnAttemptCustody({
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
                errorMessage: `Session startup remains ambiguous (${resolved.status}); retry will resume the original launch attempt.`,
            }, buildSpawnAttemptCustodyIdentity('unresolved', acquired.record));
        }

        const preparedOptions: SpawnSessionOptions = {
            ...preparedOptionsWithoutNonce,
            spawnNonce: acquired.record.nonce,
        };
        const params = trustedHiddenSystemSessionStartupInstructions
            ? buildTrustedHiddenSystemSessionSpawnHappySessionRpcParams(
                preparedOptions,
                trustedHiddenSystemSessionStartupInstructions,
            )
            : buildSpawnHappySessionRpcParams(preparedOptions);
        const sentSpawnNonce = readSpawnPayloadNonce(params);
        nonceRecoveryContext = sentSpawnNonce
            ? { machineId, spawnNonce: sentSpawnNonce, serverId }
            : null;
        const submittedRecord = sentSpawnNonce
            ? await markSpawnAttemptSubmitted({
                scope,
                machineId,
                targetFingerprint,
                userAttemptId: acquired.record.userAttemptId,
                nonce: sentSpawnNonce,
            })
            : null;
        if (!submittedRecord) {
            await clearCustody();
            return withSpawnAttemptCustody({
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage: 'Session launch custody could not be committed before submission.',
            });
        }
        custody = {
            scope,
            machineId,
            targetFingerprint,
            record: submittedRecord,
            serverId,
        };
        spawnSubmitted = true;
        const result = await machineRpcWithServerScope<unknown, SpawnHappySessionRpcParams>({
            machineId,
            method: providerSafeRpcRequired
                ? RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE
                : RPC_METHODS.SPAWN_HAPPY_SESSION,
            payload: params,
            serverId,
            timeoutMs: readSpawnSessionRpcTimeoutMsFromEnv(),
        });
        const normalizedResult = remapLegacyDirectoryCompatibilityError({
            result: normalizeSpawnSessionResult(result),
            directory: preparedOptions.directory,
            daemonCliVersion,
        });
        const recoveredResult = await recoverMachineSpawnResultByNonce({
            result: normalizedResult,
            machineId,
            spawnNonce: sentSpawnNonce,
            serverId,
        });
        let settledRecord = submittedRecord;
        if (recoveredResult.type === 'success' && recoveredResult.sessionId) {
            settledRecord = await markSpawnAttemptCreated({
                scope,
                machineId,
                targetFingerprint,
                userAttemptId: submittedRecord.userAttemptId,
                nonce: submittedRecord.nonce,
                createdSessionId: recoveredResult.sessionId,
            }) ?? submittedRecord;
        } else if (
            recoveredResult.type === 'error'
            && recoveredResult.errorCode !== SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT
        ) {
            await clearCustody();
        }
        return withSpawnAttemptCustody(
            recoveredResult,
            recoveredResult.type === 'error'
                && recoveredResult.errorCode === SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT
                ? buildSpawnAttemptCustodyIdentity('unresolved', submittedRecord)
                : recoveredResult.type === 'success'
                    ? buildSpawnAttemptCustodyIdentity('completed', settledRecord)
                    : undefined,
        );
    } catch (error) {
        if (isAccountSettingsScopeChangedDuringSpawnPreparationError(error)) {
            if (!spawnSubmitted) await clearCustody();
            return withSpawnAttemptCustody({
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.ACCOUNT_SCOPE_CHANGED,
                errorMessage: 'Account changed while syncing settings. Please retry from the current account.',
            });
        }
        const rpcErrorCode = readRpcErrorCode(error);
        if (
            (providerSafeRpcRequired && isProviderSafeDaemonSessionMethodAbsent(error))
            || rpcErrorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
        ) {
            await clearCustody();
            return withSpawnAttemptCustody({
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
                errorMessage:
                    `Daemon RPC is not available (RPC method not available). ` +
                    `The daemon may be stopped, still starting, or not connected to the server.`,
            });
        }
        if (isSocketIoAckTimeoutError(error) || isInterruptedSpawnRpcTransportError(error)) {
            const timeoutResult: SpawnSessionResult = {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
                errorMessage: 'Session startup timed out',
            };
            const recoveredResult = nonceRecoveryContext
                ? await recoverMachineSpawnResultByNonce({
                    result: timeoutResult,
                    machineId: nonceRecoveryContext.machineId,
                    spawnNonce: nonceRecoveryContext.spawnNonce,
                    serverId: nonceRecoveryContext.serverId,
                })
                : timeoutResult;
            let settledRecord = custody?.record ?? null;
            if (custody && recoveredResult.type === 'success' && recoveredResult.sessionId) {
                settledRecord = await markSpawnAttemptCreated({
                    scope: custody.scope,
                    machineId: custody.machineId,
                    targetFingerprint: custody.targetFingerprint,
                    userAttemptId: custody.record.userAttemptId,
                    nonce: custody.record.nonce,
                    createdSessionId: recoveredResult.sessionId,
                }) ?? custody.record;
                custody = { ...custody, record: settledRecord };
            } else if (
                recoveredResult.type === 'error'
                && (
                    !nonceRecoveryContext
                    || recoveredResult.errorCode !== SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT
                )
            ) {
                await clearCustody();
            }
            return withSpawnAttemptCustody(
                recoveredResult,
                custody && recoveredResult.type === 'error'
                    && recoveredResult.errorCode === SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT
                    ? buildSpawnAttemptCustodyIdentity('unresolved', custody.record)
                    : settledRecord && recoveredResult.type === 'success'
                        ? buildSpawnAttemptCustodyIdentity('completed', settledRecord)
                        : undefined,
            );
        }
        if (!spawnSubmitted) await clearCustody();
        return withSpawnAttemptCustody({
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
            errorMessage: error instanceof Error ? error.message : 'Failed to spawn session'
        }, custody && spawnSubmitted
            ? buildSpawnAttemptCustodyIdentity('unresolved', custody.record)
            : undefined);
    }
}

/**
 * Spawn an ordinary user-authored session. This API intentionally has no path
 * for callers to supply host startup instructions.
 */
export async function machineSpawnNewSession(
    options: SpawnSessionOptions,
): Promise<MachineSpawnNewSessionResult> {
    return await machineSpawnNewSessionInternal(options);
}

/**
 * Spawn a host-owned hidden system session with bounded developer instructions.
 * This seam is intentionally separate from ordinary user session creation.
 */
export async function machineSpawnTrustedHiddenSystemSession(
    options: SpawnSessionOptions,
    startupInstructions: AgentSessionStartupInstructionsV1,
): Promise<MachineSpawnNewSessionResult> {
    return await machineSpawnNewSessionInternal(options, startupInstructions);
}

export async function machineResolveSpawnSessionByNonce(params: Readonly<{
    machineId: string;
    spawnNonce: string;
    serverId?: string | null;
}>): Promise<MachineResolveSpawnSessionByNonceResult> {
    const spawnNonce = params.spawnNonce.trim();
    if (!spawnNonce) return { status: 'not_found' };

    try {
        const callResolver = async (method: string) => await machineRpcWithServerScope<unknown, { spawnNonce: string }>({
            machineId: params.machineId,
            method,
            payload: { spawnNonce },
            serverId: params.serverId ?? null,
        });
        try {
            return normalizeSpawnSessionNonceResolution(
                await callResolver(RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE),
            );
        } catch (error) {
            const rpcErrorCode = readRpcErrorCode(error);
            if (
                rpcErrorCode !== RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
                && rpcErrorCode !== RPC_ERROR_CODES.METHOD_NOT_FOUND
            ) {
                throw error;
            }
        }
        const legacyResult = await callResolver(RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE);
        return legacyResult === undefined
            ? { status: 'unsupported' }
            : normalizeSpawnSessionNonceResolution(legacyResult);
    } catch (error) {
        const rpcErrorCode = readRpcErrorCode(error);
        if (
            rpcErrorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
            || rpcErrorCode === RPC_ERROR_CODES.METHOD_NOT_FOUND
        ) {
            return { status: 'unsupported' };
        }
        return { status: 'transport_error' };
    }
}

function normalizeMachineSpawnNonceRecoveryDuration(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.max(0, Math.trunc(value));
}

function readDefaultMachineSpawnNonceResolutionTimeoutMs(): number {
    return readSpawnSessionRpcTimeoutMsFromEnv();
}

export async function machineResolveSpawnSessionByNonceUntilSettled(params: Readonly<{
    machineId: string;
    spawnNonce: string;
    serverId?: string | null;
    timeoutMs?: number;
    pollIntervalMs?: number;
}>): Promise<MachineResolveSpawnSessionByNonceResult> {
    const timeoutMs = normalizeMachineSpawnNonceRecoveryDuration(
        params.timeoutMs,
        readDefaultMachineSpawnNonceResolutionTimeoutMs(),
    );
    const pollIntervalMs = normalizeMachineSpawnNonceRecoveryDuration(
        params.pollIntervalMs,
        DEFAULT_MACHINE_SPAWN_NONCE_RESOLUTION_POLL_INTERVAL_MS,
    );
    let lastResolutionWasTransportError = false;
    const settled = await settleSpawnSessionNonce({
        spawnNonce: params.spawnNonce,
        resolve: async () => {
            const result = await machineResolveSpawnSessionByNonce(params);
            if (result.status === 'transport_error') {
                lastResolutionWasTransportError = true;
                return { status: 'pending' };
            }
            lastResolutionWasTransportError = false;
            return result;
        },
        timeoutMs,
        pollIntervalMs: Math.max(1, pollIntervalMs),
        sleep: async (ms) => { await delay(ms); },
    });

    return settled.status === 'timeout'
        ? lastResolutionWasTransportError
            ? { status: 'transport_error' }
            : { status: 'pending' }
        : settled;
}

/**
 * Stop the daemon on a specific machine
 */
export async function machineStopDaemon(
    machineId: string,
    options?: Readonly<{ serverId?: string | null }>,
): Promise<{ message: string }> {
    return await machineRpcWithServerScope<{ message: string }, {}>({
        machineId,
        method: RPC_METHODS.STOP_DAEMON,
        payload: {},
        serverId: options?.serverId ?? null,
    });
}

export type MachineStopSessionResult =
    | { ok: true; status: 'stopped' | 'requested' }
    | { ok: false; error: string; errorCode?: string };

export type MachineBashRequest =
    | string
    | Readonly<{
        command?: string;
        argv?: readonly string[];
    }>;

/**
 * Stop an existing session process through the daemon supervising a specific machine.
 */
export async function machineStopSession(
    machineId: string,
    sessionId: string,
    options?: Readonly<{ serverId?: string | null }>,
): Promise<MachineStopSessionResult> {
    const result = await stopSessionViaDaemonMachineRpc({
        machineId,
        sessionId,
        serverId: options?.serverId,
    });
    if (result.type === 'stopped') {
        return { ok: true, status: 'stopped' };
    }
    if (result.type === 'requested') {
        return { ok: true, status: 'requested' };
    }
    if (result.errorCode) {
        return {
            ok: false,
            error: result.message,
            errorCode: result.errorCode,
        };
    }
    return { ok: false, error: result.message };
}

/**
 * Execute a bash command on a specific machine
 */
export async function machineBash(
    machineId: string,
    command: MachineBashRequest,
    cwd: string,
    options?: { serverId?: string | null }
): Promise<{
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
}> {
    try {
        const payload = typeof command === 'string' ? { command, cwd } : { ...command, cwd };
        const result = await machineRpcWithServerScope<{
            success: boolean;
            stdout: string;
            stderr: string;
            exitCode: number;
        }, {
            command?: string;
            argv?: readonly string[];
            cwd: string;
        }>({
            machineId,
            method: 'bash',
            payload,
            serverId: options?.serverId,
        });
        return result;
    } catch (error) {
        return {
            success: false,
            stdout: '',
            stderr: error instanceof Error ? error.message : 'Unknown error',
            exitCode: -1
        };
    }
}

export async function machineCreateDirectory(
    machineId: string,
    path: string,
    options?: { serverId?: string | null },
): Promise<
    | { success: true }
    | { success: false; error: string; errorCode?: string }
> {
    try {
        return await machineRpcWithServerScope<{ success: true } | { success: false; error: string }, { path: string }>({
            machineId,
            method: RPC_METHODS.CREATE_DIRECTORY,
            payload: { path },
            serverId: options?.serverId,
        });
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error),
        };
    }
}

export type EnvPreviewSecretsPolicy = 'none' | 'redacted' | 'full';

export type PreviewEnvSensitivitySource = 'forced' | 'hinted' | 'none';

export interface PreviewEnvValue {
    value: string | null;
    isSet: boolean;
    isSensitive: boolean;
    isForcedSensitive: boolean;
    sensitivitySource: PreviewEnvSensitivitySource;
    display: 'full' | 'redacted' | 'hidden' | 'unset';
}

export interface PreviewEnvResponse {
    policy: EnvPreviewSecretsPolicy;
    values: Record<string, PreviewEnvValue>;
}

interface PreviewEnvRequest {
    keys: string[];
    extraEnv?: Record<string, string>;
    sensitiveKeys?: string[];
}

export type MachinePreviewEnvResult =
    | { supported: true; response: PreviewEnvResponse }
    | { supported: false };

export type BugReportCollectDiagnosticsResult = BugReportMachineDiagnosticsSnapshot;

export type BugReportLogTailResult =
    | { ok: true; path: string; tail: string }
    | { ok: false; error: string };


/**
 * Preview environment variables exactly as the daemon will spawn them.
 *
 * This calls the daemon's `preview-env` RPC (if supported). The daemon computes:
 * - effective env = { ...daemon.process.env, ...expand(extraEnv) }
 * - applies `HAPPIER_ENV_PREVIEW_SECRETS` policy for sensitive variables
 *
 * If the daemon is old and doesn't support `preview-env`, returns `{ supported: false }`.
 */
export async function machinePreviewEnv(
    machineId: string,
    params: PreviewEnvRequest,
    options?: { serverId?: string | null },
): Promise<MachinePreviewEnvResult> {
    try {
        const result = await machineRpcWithServerScope<unknown, PreviewEnvRequest>({
            machineId,
            method: RPC_METHODS.PREVIEW_ENV,
            payload: params,
            serverId: options?.serverId,
        });

        // Older daemons (or errors) return an encrypted `{ error: ... }` payload.
        // Treat method-not-found as “unsupported” and fallback to bash-based probing.
        if (isRpcMethodNotFoundResult(result)) return { supported: false };
        // For any other error, degrade gracefully in UI by using fallback behavior.
        if (isPlainObject(result) && typeof result.error === 'string') return { supported: false };

        // Basic shape validation (be defensive for mixed daemon versions).
        if (
            !isPlainObject(result) ||
            (result.policy !== 'none' && result.policy !== 'redacted' && result.policy !== 'full') ||
            !isPlainObject(result.values)
        ) {
            return { supported: false };
        }

        const response: PreviewEnvResponse = {
            policy: result.policy as EnvPreviewSecretsPolicy,
            values: Object.fromEntries(
                Object.entries(result.values as Record<string, unknown>).map(([k, v]) => {
                    if (!isPlainObject(v)) {
                        const fallback: PreviewEnvValue = {
                            value: null,
                            isSet: false,
                            isSensitive: false,
                            isForcedSensitive: false,
                            sensitivitySource: 'none',
                            display: 'unset',
                        };
                        return [k, fallback] as const;
                    }

                    const display = v.display;
                    const safeDisplay =
                        display === 'full' || display === 'redacted' || display === 'hidden' || display === 'unset'
                            ? display
                            : 'unset';

                    const value = v.value;
                    const safeValue = typeof value === 'string' ? value : null;

                    const isSet = v.isSet;
                    const safeIsSet = typeof isSet === 'boolean' ? isSet : safeValue !== null;

                    const isSensitive = v.isSensitive;
                    const safeIsSensitive = typeof isSensitive === 'boolean' ? isSensitive : false;

                    // Back-compat for intermediate daemons: default to “not forced” if missing.
                    const isForcedSensitive = v.isForcedSensitive;
                    const safeIsForcedSensitive = typeof isForcedSensitive === 'boolean' ? isForcedSensitive : false;

                    const sensitivitySource = v.sensitivitySource;
                    const safeSensitivitySource: PreviewEnvSensitivitySource =
                        sensitivitySource === 'forced' || sensitivitySource === 'hinted' || sensitivitySource === 'none'
                            ? sensitivitySource
                            : (safeIsSensitive ? 'hinted' : 'none');

                    const entry: PreviewEnvValue = {
                        value: safeValue,
                        isSet: safeIsSet,
                        isSensitive: safeIsSensitive,
                        isForcedSensitive: safeIsForcedSensitive,
                        sensitivitySource: safeSensitivitySource,
                        display: safeDisplay,
                    };

                    return [k, entry] as const;
                }),
            ) as Record<string, PreviewEnvValue>,
        };
        return { supported: true, response };
    } catch {
        return { supported: false };
    }
}

export async function machineCollectBugReportDiagnostics(
    machineId: string,
    options?: { timeoutMs?: number; serverId?: string | null },
): Promise<BugReportCollectDiagnosticsResult | null> {
    try {
        return await machineRpcWithServerScope<BugReportCollectDiagnosticsResult, {}>({
            machineId,
            method: RPC_METHODS.BUGREPORT_COLLECT_DIAGNOSTICS,
            payload: {},
            serverId: options?.serverId ?? null,
            timeoutMs: options?.timeoutMs,
        });
    } catch {
        return null;
    }
}

export async function machineGetBugReportLogTail(
    machineId: string,
    params?: { path?: string; maxBytes?: number },
    options?: { timeoutMs?: number },
): Promise<BugReportLogTailResult> {
    try {
        return await apiSocket.machineRPC<BugReportLogTailResult, { path?: string; maxBytes?: number }>(
            machineId,
            RPC_METHODS.BUGREPORT_GET_LOG_TAIL,
            {
                path: params?.path,
                maxBytes: params?.maxBytes,
            },
            options,
        );
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Failed to read log tail',
        };
    }
}

export type MachineReadSessionLogTailResult =
    | { success: true; path: string; tail: string; truncated?: boolean }
    | { success: false; error: string; errorCode?: string };

export async function machineReadSessionLogTail(
    machineId: string,
    params: { path: string; maxBytes?: number },
    options?: { timeoutMs?: number },
): Promise<MachineReadSessionLogTailResult> {
    try {
        return await apiSocket.machineRPC<MachineReadSessionLogTailResult, { path: string; maxBytes?: number }>(
            machineId,
            RPC_METHODS.SESSION_LOG_TAIL,
            {
                path: params.path,
                maxBytes: params.maxBytes,
            },
            options,
        );
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to read session log tail',
        };
    }
}

/**
 * Update machine metadata with optimistic concurrency control and automatic retry
 */
export async function machineUpdateMetadata(
    machineId: string,
    metadata: MachineMetadata,
    expectedVersion: number,
    maxRetries: number = 3
): Promise<{ version: number; metadata: string }> {
    let currentVersion = expectedVersion;
    let currentMetadata = { ...metadata };
    let retryCount = 0;

    const sync = getSyncSingleton();
    const machineEncryption = sync.encryption.getMachineEncryption(machineId);
    if (!machineEncryption) {
        throw new Error(`Machine encryption not found for ${machineId}`);
    }

    while (retryCount < maxRetries) {
        const encryptedMetadata = await measureMachineEncryptRawAttribution(
            MACHINE_ENCRYPT_RAW_ATTRIBUTION_EVENTS.metadataWrite,
            async () => await machineEncryption.encryptRaw(currentMetadata),
        );

        const request = {
            machineId,
            metadata: encryptedMetadata,
            expectedVersion: currentVersion,
        } satisfies MachineUpdateMetadataRequest;
        const result = await apiSocket.emitWithAck<MachineUpdateMetadataResponse>(
            'machine-update-metadata',
            request,
        );

        if (result.result === 'success') {
            const currentMachine = storage.getState().machines[machineId] ?? null;
            if (currentMachine) {
                storage.getState().applyMachines([{
                    ...currentMachine,
                    metadata: currentMetadata,
                    metadataVersion: result.version,
                }]);
            }
            return {
                version: result.version,
                metadata: result.metadata
            };
        } else if (result.result === 'version-mismatch') {
            // Get the latest version and metadata from the response
            currentVersion = result.version;
            const latestMetadata = await machineEncryption.decryptRaw(result.metadata) as MachineMetadata;

            currentMetadata = mergeMachineMetadataForVersionMismatch({
                latest: latestMetadata,
                intended: currentMetadata,
            });

            retryCount++;

            // If we've exhausted retries, throw error
            if (retryCount >= maxRetries) {
                throw new Error(`Failed to update after ${maxRetries} retries due to version conflicts`);
            }

            // Otherwise, loop will retry with updated version and merged metadata
        } else {
            throw new Error(result.message || 'Failed to update machine metadata');
        }
    }

    throw new Error('Unexpected error in machineUpdateMetadata');
}

/**
 * Abort the current session operation
 */
