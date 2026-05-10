import { randomBytes } from 'node:crypto';

import { configuration } from '@/configuration';
import {
    HAPPIER_DAEMON_INITIAL_PROMPT_ENV_KEY,
} from '@/agent/runtime/daemonInitialPrompt';
import { resolveTerminalRequestFromSpawnOptions } from '@/terminal/runtime/terminalConfig';
import { validateEnvVarRecordStrict } from '@/terminal/runtime/envVarSanitization';
import { logger } from '@/ui/logger';
import { resolveConcreteBackendTargetRefV2 } from '@/session/backendTargets/resolveConcreteBackendTargetRefs';

import type { TrackedSession } from '../types';
import type {
    SpawnSessionOptions,
    SpawnSessionResult,
} from '@/rpc/handlers/registerSessionHandlers';
import {
    SPAWN_SESSION_ERROR_CODES,
} from '@/rpc/handlers/registerSessionHandlers';
import { createSessionAttachFile } from '../sessionAttachFile';
import { buildTrackedSessionRespawnEnvironmentVariables } from '../processSupervision/sessionRunnerRespawnDescriptor';
import { resolveSpawnChildEnvironment } from '../spawn/resolveSpawnChildEnvironment';
import { resolveStackProcessKindOverrideForSessionSpawn } from '../spawn/resolveStackProcessKindOverrideForSessionSpawn';
import { createSpawnLifecycleCallbacks } from '../spawn/createSpawnLifecycleCallbacks';
import { resolveSpawnBackendIdentity } from '../spawn/resolveSpawnBackendIdentity';
import { routeSpawnModeAndWaitForWebhook } from '../spawn/routeSpawnModeAndWaitForWebhook';
import { resolveConnectedServiceAuthForSpawn } from '../connectedServices/resolveConnectedServiceAuthForSpawn';
import { shouldResolveConnectedServiceAuthForSpawn } from '../connectedServices/shouldResolveConnectedServiceAuthForSpawn';
import type { ConnectedServiceRefreshCoordinator } from '../connectedServices/refresh/ConnectedServiceRefreshCoordinator';
import type { ConnectedServiceQuotasCoordinator } from '../connectedServices/quotas/ConnectedServiceQuotasCoordinator';
import { prepareExecuteSpawnSessionRequest } from './prepareExecuteSpawnSessionRequest';
import { refreshAccountSettingsForMinimumVersion } from '@/settings/accountSettings/refreshAccountSettingsForMinimumVersion';

type SpawnCredentials = NonNullable<Parameters<typeof resolveSpawnBackendIdentity>[0]['credentials']>;
type SpawnApi = Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]['api'];
type LoadLocalHandoffMetadataByVendorResumeId =
    Parameters<typeof resolveSpawnBackendIdentity>[0]['loadLocalHandoffMetadataByVendorResumeId'];

export type ExecuteSpawnSessionRequestParams = Readonly<{
    options: SpawnSessionOptions;
    credentials: SpawnCredentials;
    api: SpawnApi;
    loadLocalHandoffMetadataByVendorResumeId: LoadLocalHandoffMetadataByVendorResumeId;
    connectedServicesMaterializationBaseDir: string;
    connectedServiceRefreshCoordinator: ConnectedServiceRefreshCoordinator | null;
    connectedServiceQuotasCoordinator: ConnectedServiceQuotasCoordinator | null;
    pidToTrackedSession: Map<number, TrackedSession>;
    pidToAwaiter: Map<number, (session: TrackedSession) => void>;
    pidToSpawnResultResolver: Map<number, (result: SpawnSessionResult) => void>;
    pidToSpawnWebhookTimeout: Map<number, NodeJS.Timeout>;
    resolveCanonicalTrackedSessionId: (pid: number) => string;
    onChildExited: (pid: number, exit: { reason: string; code: number | null; signal: string | null }) => void;
    spawnResourceCleanupByPid: Map<number, () => void>;
    sessionAttachCleanupByPid: Map<number, () => Promise<void>>;
    processEnv?: NodeJS.ProcessEnv;
}>;

async function refreshAccountSettingsForSpawn(
    params: Pick<ExecuteSpawnSessionRequestParams, 'credentials' | 'options'>,
): Promise<void> {
    const accountSettingsVersionHint = params.options.accountSettingsVersionHint;
    if (typeof accountSettingsVersionHint !== 'number') return;

    try {
        await refreshAccountSettingsForMinimumVersion({
            credentials: params.credentials,
            minSettingsVersion: accountSettingsVersionHint,
            mode: 'blocking',
        });
    } catch (error) {
        logger.warn('[DAEMON RUN] Account settings freshness refresh failed before spawn; continuing with last available settings', error);
    }
}

export async function executeSpawnSessionRequest(
    params: ExecuteSpawnSessionRequestParams,
): Promise<SpawnSessionResult> {
    const { options } = params;

    try {
        await refreshAccountSettingsForSpawn(params);

        const prepared = await prepareExecuteSpawnSessionRequest({
            request: {
                ...params,
                options,
            },
            validateEnvVarRecordStrict,
        });
        if ('type' in prepared) {
            return prepared;
        }

        const {
            directory,
            sessionId,
            permissionMode,
            permissionModeUpdatedAt,
            agentModeId,
            agentModeUpdatedAt,
            modelId,
            modelUpdatedAt,
            directoryCreated,
            normalizedInitialPrompt,
            normalizedExistingSessionId,
            effectiveResume,
            effectiveBackendTargetV2,
            sessionAttachPayload,
            catalogAgentId,
            catalogAgentIdForConnectedServices,
            daemonSpawnHooks,
            environmentVariablesValidation,
        } = prepared;

        let spawnResourceCleanupOnFailure: (() => void) | null = null;
        let spawnResourceCleanupOnExit: (() => void) | null = null;
        let spawnResourceCleanupArmed = false;
        let sessionAttachCleanup: (() => Promise<void>) | null = null;

        try {
            const cleanupSpawnResources = () => {
                if (spawnResourceCleanupOnFailure && !spawnResourceCleanupArmed) {
                    spawnResourceCleanupOnFailure();
                    spawnResourceCleanupOnFailure = null;
                    spawnResourceCleanupOnExit = null;
                }
            };

            let connectedServiceAuth: {
                env: Record<string, string>;
                cleanupOnFailure: (() => void) | null;
                cleanupOnExit: (() => void) | null;
            } | null = null;
            const materializationKey =
                normalizedExistingSessionId ||
                (typeof sessionId === 'string' ? sessionId.trim() : '') ||
                `spawn-${Date.now()}-${randomBytes(8).toString('hex')}`;

            if (shouldResolveConnectedServiceAuthForSpawn(options) && catalogAgentId) {
                try {
                    connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
                        agentId: catalogAgentId,
                        connectedServicesBindingsRaw: options.connectedServices,
                        materializationKey,
                        activeServerDir: configuration.activeServerDir,
                        baseDir: params.connectedServicesMaterializationBaseDir,
                        credentials: params.credentials,
                        api: params.api,
                    });
                } catch (error) {
                    logger.debug('[DAEMON RUN] Connected services resolution failed', error);
                    return {
                        type: 'error',
                        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
                        errorMessage:
                            error instanceof Error
                                ? `Connected services resolution failed: ${error.message}`
                                : 'Connected services resolution failed.',
                    };
                }
            } else if (shouldResolveConnectedServiceAuthForSpawn(options) && !catalogAgentId) {
                logger.warn('[DAEMON RUN] Ignoring connected-services spawn request for configured backend target');
            }

            const spawnEnvironment = await resolveSpawnChildEnvironment({
                options,
                profileEnvironmentVariables: environmentVariablesValidation.env,
                daemonSpawnHooks,
                processEnv: params.processEnv ?? process.env,
                logDebug: (message) => logger.debug(message),
                logInfo: (message) => logger.info(message),
                logWarn: (message) => logger.warn(message),
                connectedServiceAuth,
            });
            spawnResourceCleanupOnFailure = spawnEnvironment.cleanupOnFailure;
            spawnResourceCleanupOnExit = spawnEnvironment.cleanupOnExit;
            if (!spawnEnvironment.ok) {
                cleanupSpawnResources();
                return {
                    type: 'error',
                    errorCode: spawnEnvironment.errorCode,
                    errorMessage: spawnEnvironment.errorMessage,
                };
            }

            const extraEnv = spawnEnvironment.expandedEnvironmentVariables;
            const extraEnvForChild = spawnEnvironment.extraEnvForChild;
            const trackedSessionEnvironmentVariables = buildTrackedSessionRespawnEnvironmentVariables({
                expandedEnvironmentVariables: extraEnv,
                extraEnvForChild,
            });
            const trackedSpawnOptions: SpawnSessionOptions = {
                ...options,
                ...(trackedSessionEnvironmentVariables
                    ? { environmentVariables: trackedSessionEnvironmentVariables }
                    : {}),
            };

            const terminalRequest = resolveTerminalRequestFromSpawnOptions({
                happyHomeDir: configuration.happyHomeDir,
                terminal: options.terminal,
                environmentVariables: extraEnv,
            });
            let sessionAttachFilePath: string | null = null;
            if (normalizedExistingSessionId) {
                if (!sessionAttachPayload) {
                    throw new Error('Missing session attach payload for existing session');
                }
                const attach = await createSessionAttachFile({
                    happySessionId: normalizedExistingSessionId,
                    payload: sessionAttachPayload,
                });
                sessionAttachFilePath = attach.filePath;
                sessionAttachCleanup = attach.cleanup;
            }

            const stackProcessKindOverride = resolveStackProcessKindOverrideForSessionSpawn(params.processEnv ?? process.env);
            const extraEnvForChildWithMessage = {
                ...extraEnvForChild,
                ...(sessionAttachFilePath
                    ? { HAPPIER_SESSION_ATTACH_FILE: sessionAttachFilePath }
                    : {}),
                ...(normalizedInitialPrompt
                    ? { [HAPPIER_DAEMON_INITIAL_PROMPT_ENV_KEY]: normalizedInitialPrompt }
                    : {}),
                ...stackProcessKindOverride,
            };
            const spawnLifecycleCallbacks = createSpawnLifecycleCallbacks({
                connectedServicesBindingsRaw: options.connectedServices,
                catalogAgentId: catalogAgentIdForConnectedServices,
                materializationKey,
                hasConnectedServiceAuth: () => connectedServiceAuth !== null,
                registerConnectedServiceRefreshTarget: (target) =>
                    params.connectedServiceRefreshCoordinator?.registerSpawnTarget(target),
                registerConnectedServiceQuotaTarget: (target) =>
                    params.connectedServiceQuotasCoordinator?.registerSpawnTarget({
                        pid: target.pid,
                        connectedServicesBindingsRaw: target.connectedServicesBindingsRaw as Readonly<{
                            v?: unknown;
                            bindingsByServiceId?: Record<string, unknown>;
                        }>,
                    }),
                getSpawnResourceCleanupOnExit: () => spawnResourceCleanupOnExit,
                onSpawnResourceCleanupArmed: () => {
                    spawnResourceCleanupArmed = true;
                },
                spawnResourceCleanupByPid: params.spawnResourceCleanupByPid,
                getSessionAttachCleanup: () => sessionAttachCleanup,
                setSessionAttachCleanup: (cleanup) => {
                    sessionAttachCleanup = cleanup;
                },
                sessionAttachCleanupByPid: params.sessionAttachCleanupByPid,
            });

            return await routeSpawnModeAndWaitForWebhook({
                terminalRequest,
                directory,
                options,
                trackedSpawnOptions,
                normalizedExistingSessionId,
                effectiveResume,
                effectiveBackendTargetV2,
                reservedSessionId: typeof sessionId === 'string' ? sessionId : undefined,
                permissionMode,
                permissionModeUpdatedAt,
                agentModeId,
                agentModeUpdatedAt,
                modelId,
                modelUpdatedAt,
                directoryCreated,
                extraEnvForChildWithMessage,
                happyHomeDir: configuration.happyHomeDir,
                pidToTrackedSession: params.pidToTrackedSession,
                pidToAwaiter: params.pidToAwaiter,
                pidToSpawnResultResolver: params.pidToSpawnResultResolver,
                pidToSpawnWebhookTimeout: params.pidToSpawnWebhookTimeout,
                resolveCanonicalTrackedSessionId: params.resolveCanonicalTrackedSessionId,
                onChildExited: params.onChildExited,
                spawnLifecycleCallbacks,
                cleanupSpawnResources,
                logDebug: (message, payload) => logger.debug(message, payload),
                warn: (message) => logger.warn(message),
            });
        } catch (error) {
            if (spawnResourceCleanupOnFailure && !spawnResourceCleanupArmed) {
                spawnResourceCleanupOnFailure();
                spawnResourceCleanupOnFailure = null;
                spawnResourceCleanupOnExit = null;
            }
            if (sessionAttachCleanup) {
                await sessionAttachCleanup();
                sessionAttachCleanup = null;
            }
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.debug('[DAEMON RUN] Failed to spawn session:', error);
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
                errorMessage: `Failed to spawn session: ${errorMessage}`,
            };
        }
    } catch (error) {
        logger.warn('[DAEMON RUN] Failed before spawn session work started', {
            error,
            hasExistingSessionId: typeof options.existingSessionId === 'string' && options.existingSessionId.trim().length > 0,
            hasResume: typeof options.resume === 'string' && options.resume.trim().length > 0,
            backendTargetKind: resolveConcreteBackendTargetRefV2(options.backendTarget)?.kind ?? null,
        });
        throw error;
    }
}
