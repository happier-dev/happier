/**
 * Machine operations for remote procedure calls
 */

import type { SpawnSessionResult } from '@happier-dev/protocol';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';
import { RPC_METHODS, isRpcMethodNotFoundResult } from '@happier-dev/protocol/rpc';

import { apiSocket } from '../api/session/apiSocket';
import { sync } from '../sync';
import type { MachineMetadata } from '../domains/state/storageTypes';
import { buildSpawnHappySessionRpcParams, type SpawnHappySessionRpcParams, type SpawnSessionOptions } from '../domains/session/spawn/spawnSessionPayload';
import { isPlainObject, normalizeSpawnSessionResult } from './_shared';
import { mergeMachineMetadataForVersionMismatch } from './machineMetadataMerge';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

export type { SpawnHappySessionRpcParams, SpawnSessionOptions } from '../domains/session/spawn/spawnSessionPayload';
export { buildSpawnHappySessionRpcParams } from '../domains/session/spawn/spawnSessionPayload';

// Exported session operation functions

/**
 * Spawn a new remote session on a specific machine
 */
export async function machineSpawnNewSession(options: SpawnSessionOptions): Promise<SpawnSessionResult> {
    const { machineId } = options;
    const serverId = typeof options.serverId === 'string' ? options.serverId.trim() : null;

    try {
        const params = buildSpawnHappySessionRpcParams(options);
        const result = await machineRpcWithServerScope<unknown, SpawnHappySessionRpcParams>({
            machineId,
            method: RPC_METHODS.SPAWN_HAPPY_SESSION,
            payload: params,
            serverId,
        });
        return normalizeSpawnSessionResult(result);
    } catch (error) {
        // Handle RPC errors
        return {
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
            errorMessage: error instanceof Error ? error.message : 'Failed to spawn session'
        };
    }
}

/**
 * Stop the daemon on a specific machine
 */
export async function machineStopDaemon(machineId: string): Promise<{ message: string }> {
    const result = await apiSocket.machineRPC<{ message: string }, {}>(
        machineId,
        RPC_METHODS.STOP_DAEMON,
        {}
    );
    return result;
}

export type MachineStopSessionResult =
    | { ok: true }
    | { ok: false; error: string; errorCode?: string };

/**
 * Stop an existing remote session process on a specific machine.
 *
 * This is intentionally destructive and should be used only as a last resort
 * when session-scoped RPC (for example, execution run stop) is unavailable.
 */
export async function machineStopSession(
    machineId: string,
    sessionId: string,
    options?: Readonly<{ serverId?: string | null }>,
): Promise<MachineStopSessionResult> {
    try {
        const response = await machineRpcWithServerScope<unknown, { sessionId: string }>({
            machineId,
            method: RPC_METHODS.STOP_SESSION,
            payload: { sessionId },
            serverId: options?.serverId,
        });
        if (!response || typeof response !== 'object' || typeof (response as any).message !== 'string') {
            return { ok: false, error: 'Unsupported response from machine RPC' };
        }
        return { ok: true };
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error),
        };
    }
}

/**
 * Execute a bash command on a specific machine
 */
export async function machineBash(
    machineId: string,
    command: string,
    cwd: string,
    options?: { serverId?: string | null }
): Promise<{
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
}> {
    try {
        const result = await machineRpcWithServerScope<{
            success: boolean;
            stdout: string;
            stderr: string;
            exitCode: number;
        }, {
            command: string;
            cwd: string;
        }>({
            machineId,
            method: 'bash',
            payload: { command, cwd },
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

export type BugReportCollectDiagnosticsResult = {
    daemonState: {
        pid: number;
        httpPort: number;
        startedAt: number;
        startedWithCliVersion: string;
        hasControlToken: boolean;
        daemonLogPath: string | null;
    } | null;
    daemonLogs: Array<{ file: string; path: string; modifiedAt: string }>;
    runtime: { cwd: string; platform: string; nodeVersion: string };
    stackContext?: {
        stackName: string | null;
        stackEnvPath: string | null;
        runtimeStatePath: string | null;
        runtimeState: string | null;
        logCandidates: string[];
    } | null;
};

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
    options?: { timeoutMs?: number },
): Promise<BugReportCollectDiagnosticsResult | null> {
    try {
        return await apiSocket.machineRPC<BugReportCollectDiagnosticsResult, {}>(
            machineId,
            RPC_METHODS.BUGREPORT_COLLECT_DIAGNOSTICS,
            {},
            options,
        );
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

    const machineEncryption = sync.encryption.getMachineEncryption(machineId);
    if (!machineEncryption) {
        throw new Error(`Machine encryption not found for ${machineId}`);
    }

    while (retryCount < maxRetries) {
        const encryptedMetadata = await machineEncryption.encryptRaw(currentMetadata);

        const result = await apiSocket.emitWithAck<{
            result: 'success' | 'version-mismatch' | 'error';
            version?: number;
            metadata?: string;
            message?: string;
        }>('machine-update-metadata', {
            machineId,
            metadata: encryptedMetadata,
            expectedVersion: currentVersion
        });

        if (result.result === 'success') {
            return {
                version: result.version!,
                metadata: result.metadata!
            };
        } else if (result.result === 'version-mismatch') {
            // Get the latest version and metadata from the response
            currentVersion = result.version!;
            const latestMetadata = await machineEncryption.decryptRaw(result.metadata!) as MachineMetadata;

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
