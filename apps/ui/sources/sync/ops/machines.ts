/**
 * Machine operations for remote procedure calls
 */

import type {
    BugReportMachineDiagnosticsSnapshot} from '@happier-dev/protocol/bugs/reports/machineDiagnostics';
import type {
    MachineUpdateMetadataRequest,
    MachineUpdateMetadataResponse} from '@happier-dev/protocol/machines/metadataUpdate';
import type {
    SpawnSessionNonceResolution,
} from '@happier-dev/protocol/sessions/spawnSessionNonce';
import { BugReportMachineDiagnosticsSnapshotSchema, type BugReportLogSelection } from '@happier-dev/protocol/bugs/reports/machineDiagnostics';
import { MACHINE_RPC_POLL_INTERVAL_MS } from './machineRpcPollInterval';
import { parseMachinePublishedMetadataV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { decodePlainMachineStoredContent, encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { normalizeSpawnSessionNonceResolution, settleSpawnSessionNonce } from '@happier-dev/protocol/sessions/spawnSessionNonce';
import { RPC_ERROR_CODES, RPC_METHODS, isRpcMethodNotFoundResult } from '@happier-dev/protocol/rpc';

import type { MachineMetadata } from '../domains/state/storageTypes';
import { clearCreatedSpawnAttemptCustodyForSession } from '../domains/session/spawn/spawnAttemptNonceStore';
import { readSpawnSessionRpcTimeoutMsFromEnv } from '../domains/session/spawn/spawnSessionRpcTimeout';
import { storage } from '../domains/state/storage';
import { apiSocket } from '../api/session/apiSocket';
import { isPlainObject } from './_shared';
import { mergeMachineMetadataForVersionMismatch } from './machineMetadataMerge';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { stopSessionViaDaemonMachineRpc } from './sessionStopStrategy';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    MACHINE_ENCRYPT_RAW_ATTRIBUTION_EVENTS,
    measureMachineEncryptRawAttribution,
    readMachineEncryptionContextInput,
} from '@/sync/encryption/machineEncryption';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { delay } from '@/utils/timing/time';

export type MachineResolveSpawnSessionByNonceResult =
    | SpawnSessionNonceResolution
    | { status: 'transport_error' };

const DEFAULT_MACHINE_SPAWN_NONCE_RESOLUTION_POLL_INTERVAL_MS = MACHINE_RPC_POLL_INTERVAL_MS;

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
    return await clearCreatedSpawnAttemptCustodyForSession({ scope, sessionId });
}

export async function machineResolveSpawnSessionByNonce(params: Readonly<{
    machineId: string;
    spawnNonce: string;
    serverId?: string | null;
    timeoutMs?: number;
    signal?: AbortSignal;
}>): Promise<MachineResolveSpawnSessionByNonceResult> {
    const spawnNonce = params.spawnNonce.trim();
    if (!spawnNonce) return { status: 'not_found' };

    try {
        const callResolver = async (method: string) => await machineRpcWithServerScope<unknown, { spawnNonce: string }>({
            machineId: params.machineId,
            method,
            payload: { spawnNonce },
            serverId: params.serverId ?? null,
            timeoutMs: params.timeoutMs,
            ...(params.signal ? { signal: params.signal } : {}),
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
    signal?: AbortSignal;
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
        signal: params.signal,
        resolve: async (_spawnNonce, remainingTimeoutMs) => {
            const result = await machineResolveSpawnSessionByNonce({
                ...params,
                timeoutMs: remainingTimeoutMs,
            });
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
    options?: Readonly<{ serverId?: string | null; signal?: AbortSignal }>,
): Promise<{ message: string }> {
    return await machineRpcWithServerScope<{ message: string }, {}>({
        machineId,
        method: RPC_METHODS.STOP_DAEMON,
        payload: {},
        serverId: options?.serverId ?? null,
        ...(options?.signal ? { signal: options.signal } : {}),
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
    options?: Readonly<{
        serverId?: string | null;
        /** The Account captured by the original Stop invocation. */
        scope?: ServerAccountScope;
        /** Withdraws the observer; after issuance only credential retirement cancels the physical wait. */
        signal?: AbortSignal;
    }>,
): Promise<MachineStopSessionResult> {
    const serverId = options?.scope?.serverId ?? options?.serverId ?? getActiveServerSnapshot().serverId;
    if (!serverId) return { ok: false, error: 'action_home_not_found', errorCode: 'action_home_not_found' };
    const result = await stopSessionViaDaemonMachineRpc({
        machineId, sessionId, serverId,
        ...(options?.scope ? { accountId: options.scope.accountId } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
    });
    if (result.type === 'stopped') return { ok: true, status: 'stopped' };
    if (result.type === 'requested') return { ok: true, status: 'requested' };
    return { ok: false, error: result.message, ...(result.errorCode ? { errorCode: result.errorCode } : {}) };
}

/**
 * Execute a bash command on a specific machine
 */
export async function machineBash(
    machineId: string,
    command: MachineBashRequest,
    cwd: string,
    options?: { serverId?: string | null; signal?: AbortSignal }
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
            ...(options?.signal ? { signal: options.signal } : {}),
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
    options?: { serverId?: string | null; signal?: AbortSignal },
): Promise<MachinePreviewEnvResult> {
    try {
        const result = await machineRpcWithServerScope<unknown, PreviewEnvRequest>({
            machineId,
            method: RPC_METHODS.PREVIEW_ENV,
            payload: params,
            serverId: options?.serverId,
            ...(options?.signal ? { signal: options.signal } : {}),
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
    options?: { timeoutMs?: number; serverId?: string | null; signal?: AbortSignal; accountId?: string | null; sessionId?: string; logSelection?: BugReportLogSelection },
): Promise<BugReportCollectDiagnosticsResult | null> {
    try {
        const response = await machineRpcWithServerScope<unknown, { sessionId?: string; logSelection?: BugReportLogSelection }>({
            machineId,
            method: RPC_METHODS.BUGREPORT_COLLECT_DIAGNOSTICS,
            payload: { ...(options?.sessionId ? { sessionId: options.sessionId } : {}), ...(options?.logSelection ? { logSelection: options.logSelection } : {}) },
            serverId: options?.serverId ?? null,
            accountId: options?.accountId ?? null,
            ...(options?.signal ? { signal: options.signal } : {}),
            timeoutMs: options?.timeoutMs,
        });
        const parsed = BugReportMachineDiagnosticsSnapshotSchema.safeParse(response);
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

export async function machineGetBugReportLogTail(
    machineId: string,
    params?: { path?: string; maxBytes?: number },
    options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<BugReportLogTailResult> {
    try {
        return await machineRpcWithServerScope<BugReportLogTailResult, { path?: string; maxBytes?: number }>({
            machineId,
            method: RPC_METHODS.BUGREPORT_GET_LOG_TAIL,
            payload: {
                path: params?.path,
                maxBytes: params?.maxBytes,
            },
            timeoutMs: options?.timeoutMs,
            ...(options?.signal ? { signal: options.signal } : {}),
        });
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
    options?: { timeoutMs?: number; serverId?: string | null; signal?: AbortSignal },
): Promise<MachineReadSessionLogTailResult> {
    try {
        return await machineRpcWithServerScope<MachineReadSessionLogTailResult, { path: string; maxBytes?: number }>({
            machineId,
            method: RPC_METHODS.DAEMON_SESSION_LOG_TAIL,
            serverId: options?.serverId,
            payload: {
                path: params.path,
                maxBytes: params.maxBytes,
            },
            timeoutMs: options?.timeoutMs,
            ...(options?.signal ? { signal: options.signal } : {}),
        });
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
    let currentMetadata = parseMachinePublishedMetadataV1(metadata);
    let retryCount = 0;

    const sync = getSyncSingleton();
    const sourceServer = getActiveServerSnapshot();
    const sourceAccountId = storage.getState().profile.id;
    const assertScopeCurrent = () => {
        const current = getActiveServerSnapshot();
        if (current.serverId !== sourceServer.serverId || current.generation !== sourceServer.generation
            || storage.getState().profile.id !== sourceAccountId) {
            throw Object.assign(new Error('Machine metadata target changed'), { code: 'machine_target_changed' });
        }
    };
    const refreshUnappliedWrite = async () => {
        assertScopeCurrent();
        await sync.refreshMachines();
        assertScopeCurrent();
        const latest = storage.getState().machines[machineId];
        if (!latest?.metadata || latest.availability?.kind === 'locked') throw new Error(`Machine encryption unavailable for ${machineId}`);
        currentVersion = latest.metadataVersion;
        currentMetadata = parseMachinePublishedMetadataV1(mergeMachineMetadataForVersionMismatch({ latest: latest.metadata, intended: currentMetadata }));
        retryCount++;
    };

    while (retryCount < maxRetries) {
        assertScopeCurrent();
        const machine = storage.getState().machines[machineId];
        if (!machine || machine.availability?.kind === 'locked' || (machine.access && machine.access.accessState !== 'ready')) {
            throw new Error(`Machine encryption unavailable for ${machineId}`);
        }
        const storageMode = machine.access?.resourceMode ?? machine.storageMode ?? 'e2ee';
        const encryption = sync.encryption;
        const machineEncryption = storageMode === 'plain' ? null : encryption?.getMachineEncryption(machineId);
        const expectedDataEncryptionKey = storageMode === 'plain'
            ? readMachineEncryptionContextInput({ ...machine, dataEncryptionKey: machine.dataEncryptionKey ?? MACHINE_PLAIN_DATA_KEY_MARKER }, sourceAccountId).expectedDataEncryptionKey
            : encryption?.getMachineDataEncryptionKey(machineId);
        if (expectedDataEncryptionKey === undefined || (storageMode === 'e2ee' && !machineEncryption)) {
            throw new Error(`Machine encryption unavailable for ${machineId}`);
        }
        const isContextCurrent = () => {
            const current = storage.getState().machines[machineId];
            return Boolean(current) && sync.encryption === encryption && current?.availability?.kind !== 'locked'
                && (!current?.access || current.access.accessState === 'ready')
                && (current?.access?.resourceMode ?? current?.storageMode ?? 'e2ee') === storageMode
                && (storageMode === 'plain'
                    ? readMachineEncryptionContextInput({ ...current, dataEncryptionKey: current?.dataEncryptionKey ?? MACHINE_PLAIN_DATA_KEY_MARKER }, sourceAccountId).expectedDataEncryptionKey === expectedDataEncryptionKey
                    : encryption?.getMachineEncryption(machineId) === machineEncryption
                        && encryption?.getMachineDataEncryptionKey(machineId) === expectedDataEncryptionKey);
        };
        const storedMetadata = storageMode === 'plain'
            ? encodePlainMachineStoredContent(currentMetadata)
            : await measureMachineEncryptRawAttribution(
                MACHINE_ENCRYPT_RAW_ATTRIBUTION_EVENTS.metadataWrite,
                async () => await machineEncryption!.encryptRaw(currentMetadata),
            );
        assertScopeCurrent();
        if (!isContextCurrent()) {
            await refreshUnappliedWrite();
            continue;
        }

        const request = {
            machineId,
            metadata: storedMetadata,
            expectedVersion: currentVersion,
            expectedDataEncryptionKey,
        } satisfies MachineUpdateMetadataRequest;
        const result = await apiSocket.emitWithAck<MachineUpdateMetadataResponse>(
            'machine-update-metadata',
            request,
        );
        assertScopeCurrent();

        if ('error' in result) {
            throw Object.assign(
                new Error('Machine metadata update requires a compatible client.'),
                {
                    code: result.error,
                    retryable: false as const,
                    requirement: result.requirement,
                },
            );
        }

        if (result.result === 'success') {
            const currentMachine = storage.getState().machines[machineId] ?? null;
            if (currentMachine && isContextCurrent() && currentMachine.metadataVersion <= result.version) {
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
        } else if (result.result === 'key-mismatch' || !isContextCurrent()) {
            await refreshUnappliedWrite();
        } else if (result.result === 'version-mismatch') {
            // Get the latest version and metadata from the response
            currentVersion = result.version;
            const latestMetadata = storageMode === 'plain'
                ? decodePlainMachineStoredContent(result.metadata) as MachineMetadata
                : await machineEncryption!.decryptRaw(result.metadata) as MachineMetadata;
            if (!isContextCurrent()) {
                await refreshUnappliedWrite();
                continue;
            }

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

    throw new Error(`Failed to update after ${maxRetries} retries due to version or encryption conflicts`);
}

/**
 * Abort the current session operation
 */
