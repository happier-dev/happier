/**
 * Machine operations for remote procedure calls
 */

import type {
    BugReportMachineDiagnosticsSnapshot} from '@happier-dev/protocol/bugs/reports/machineDiagnostics';
import type {
    SpawnSessionNonceResolution,
} from '@happier-dev/protocol/sessions/spawnSessionNonce';
import { BugReportMachineDiagnosticsSnapshotSchema, type BugReportLogSelection } from '@happier-dev/protocol/bugs/reports/machineDiagnostics';
import { MACHINE_RPC_POLL_INTERVAL_MS } from './machineRpcPollInterval';
import { normalizeSpawnSessionNonceResolution, settleSpawnSessionNonce } from '@happier-dev/protocol/sessions/spawnSessionNonce';
import { RPC_ERROR_CODES, RPC_METHODS, isRpcMethodNotFoundResult } from '@happier-dev/protocol/rpc';

import { clearCreatedSpawnAttemptCustodyForSession } from '../domains/session/spawn/spawnAttemptNonceStore';
import { readSpawnSessionRpcTimeoutMsFromEnv } from '../domains/session/spawn/spawnSessionRpcTimeout';
import { storage } from '../domains/state/storage';
import { isPlainObject } from './_shared';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { stopSessionViaDaemonMachineRpc } from './sessionStopStrategy';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
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
 * Abort the current session operation
 */

export { machineUpdateMetadata } from './machineFinitePolicy';
