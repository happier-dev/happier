import { configuration } from '@/configuration';
import {
    CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES,
    ConnectedServiceBindingsV1Schema,
    resolveConnectedServicesProviderStateSharingPolicyV1,
    type ConnectedServiceBindingsV1,
    type ConnectedServiceMaterializationIdentityV1,
} from '@happier-dev/protocol';
import {
    HAPPIER_DAEMON_INITIAL_PROMPT_ENV_KEY,
} from '@/agent/runtime/daemonInitialPrompt';
import { resolveTerminalRequestFromSpawnOptions } from '@/terminal/runtime/terminalConfig';
import { validateEnvVarRecordStrict } from '@/terminal/runtime/envVarSanitization';
import { logger } from '@/ui/logger';
import { resolveConcreteBackendTargetRefV2 } from '@/session/backendTargets/resolveConcreteBackendTargetRefs';
import type { CatalogAgentId } from '@/backends/types';

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
import {
    ConnectedServiceSpawnResumeUnreachableError,
    resolveConnectedServiceAuthForSpawn,
} from '../connectedServices/resolveConnectedServiceAuthForSpawn';
import { buildSpawnResumeUnreachableErrorResult } from '../connectedServices/buildSpawnResumeUnreachableErrorResult';
import {
    buildConnectedServiceMaterializationSpawnErrorResult,
    buildConnectedServiceCredentialRefreshSpawnErrorResult,
    buildConnectedServiceDiagnosticSpawnValidationErrorResult,
} from '../connectedServices/diagnostics/buildConnectedServiceDiagnosticSpawnErrorResult';
import { shouldResolveConnectedServiceAuthForSpawn } from '../connectedServices/shouldResolveConnectedServiceAuthForSpawn';
import type { ConnectedServiceRefreshCoordinator } from '../connectedServices/refresh/ConnectedServiceRefreshCoordinator';
import type { ConnectedServiceQuotasCoordinator } from '../connectedServices/quotas/ConnectedServiceQuotasCoordinator';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServices/connectedServiceChildEnvironment';
import { ConnectedServiceMaterializationBlockedError } from '../connectedServices/materialize/materializeConnectedServicesForSpawn';
import {
    readConnectedServiceMaterializationIdentityFromSpawnOptions,
    readConnectedServiceMaterializationIdentityFromEnvironment,
    resolveConnectedServiceMaterializationIdentityForSpawn,
    withConnectedServiceMaterializationIdentityEnv,
} from '../connectedServices/materialization/identity';
import type { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../connectedServices/accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { prepareExecuteSpawnSessionRequest } from './prepareExecuteSpawnSessionRequest';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { refreshAccountSettingsForDaemonRequest } from './accountSettingsFreshness';
import {
    buildConnectedServiceUxDiagnostic,
} from '../connectedServices/diagnostics/connectedServiceUxDiagnostics';

type SpawnCredentials = NonNullable<Parameters<typeof resolveSpawnBackendIdentity>[0]['credentials']>;
type SpawnApi = Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]['api'];
type SpawnAuthGroupSwitchCoordinator = Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]['authGroupSwitchCoordinator'];
type SpawnSoftSwitchRecoveryGuard = Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]['softSwitchRecoveryGuard'];
type LoadLocalHandoffMetadataByVendorResumeId =
    Parameters<typeof resolveSpawnBackendIdentity>[0]['loadLocalHandoffMetadataByVendorResumeId'];

function buildDaemonOwnedSpawnChildEnv(): Record<string, string> {
    return {
        HAPPIER_HOME_DIR: configuration.happyHomeDir,
        HAPPIER_ACTIVE_SERVER_ID: configuration.activeServerId,
        HAPPIER_SERVER_URL: configuration.serverUrl,
        HAPPIER_LOCAL_SERVER_URL: configuration.apiServerUrl,
        HAPPIER_PUBLIC_SERVER_URL: configuration.publicServerUrl,
        HAPPIER_WEBAPP_URL: configuration.webappUrl,
    };
}

export type ExecuteSpawnSessionRequestParams = Readonly<{
    options: SpawnSessionOptions;
    credentials: SpawnCredentials;
    api: SpawnApi;
    loadLocalHandoffMetadataByVendorResumeId: LoadLocalHandoffMetadataByVendorResumeId;
    connectedServicesMaterializationBaseDir: string;
    connectedServiceRefreshCoordinator: ConnectedServiceRefreshCoordinator | null;
    connectedServiceQuotasCoordinator: ConnectedServiceQuotasCoordinator | null;
    authGroupSwitchCoordinator?: SpawnAuthGroupSwitchCoordinator | null;
    softSwitchRecoveryGuard?: SpawnSoftSwitchRecoveryGuard;
    repairMissingConnectedServiceMaterializationIdentityForSpawn?: (input: Readonly<{
        sessionId: string;
        agentId: CatalogAgentId;
        connectedServices: ConnectedServiceBindingsV1;
        vendorResumeId: string | null;
    }>) => Promise<ConnectedServiceMaterializationIdentityV1 | null>;
    connectedServiceRuntimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore;
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

function readConnectedServiceBindingsOrNull(raw: unknown): ConnectedServiceBindingsV1 | null {
    const parsed = ConnectedServiceBindingsV1Schema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

function connectedServiceBindingsRequireMaterializationIdentity(
    bindings: ConnectedServiceBindingsV1 | null,
): bindings is ConnectedServiceBindingsV1 {
    return Boolean(
        bindings
        && Object.values(bindings.bindingsByServiceId).some((binding) => binding.source === 'connected'),
    );
}

function buildMaterializationIdentityMissingSpawnErrorResult(input: Readonly<{
    agentId: CatalogAgentId;
    reason: string;
}>): Extract<SpawnSessionResult, { type: 'error' }> {
    return buildConnectedServiceDiagnosticSpawnValidationErrorResult({
        errorMessage: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceMaterializationIdentityMissing,
        uxDiagnostic: buildConnectedServiceUxDiagnostic({
            code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceMaterializationIdentityMissing,
            failurePhase: 'materialization',
            source: 'spawn_resume',
            agentId: input.agentId,
            retryable: false,
            diagnostics: {
                reason: input.reason,
            },
        }),
    });
}

async function refreshAccountSettingsForSpawn(
    params: Pick<ExecuteSpawnSessionRequestParams, 'credentials' | 'options'>,
): Promise<void> {
    const refreshed = await refreshAccountSettingsForDaemonRequest({
        credentials: params.credentials,
        accountSettingsVersionHint: params.options.accountSettingsVersionHint,
    });
    if (!refreshed.ok) {
        logger.warn('[DAEMON RUN] Account settings freshness refresh failed before spawn; continuing with last available settings', refreshed.error);
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

            let connectedServiceAuth: Awaited<ReturnType<typeof resolveConnectedServiceAuthForSpawn>> = null;
            const shouldResolveConnectedServiceAuth = shouldResolveConnectedServiceAuthForSpawn(options);
            let connectedServiceMaterializationIdentity =
                readConnectedServiceMaterializationIdentityFromSpawnOptions(options)
                ?? readConnectedServiceMaterializationIdentityFromEnvironment(options.environmentVariables);
            if (shouldResolveConnectedServiceAuth && !connectedServiceMaterializationIdentity) {
                if (normalizedExistingSessionId) {
                    const connectedServices = readConnectedServiceBindingsOrNull(options.connectedServices);
                    if (
                        catalogAgentId
                        && connectedServiceBindingsRequireMaterializationIdentity(connectedServices)
                        && params.repairMissingConnectedServiceMaterializationIdentityForSpawn
                    ) {
                        connectedServiceMaterializationIdentity =
                            await params.repairMissingConnectedServiceMaterializationIdentityForSpawn({
                                sessionId: normalizedExistingSessionId,
                                agentId: catalogAgentId,
                                connectedServices,
                                vendorResumeId: effectiveResume || null,
                            });
                    }
                    if (!connectedServiceMaterializationIdentity) {
                        return buildMaterializationIdentityMissingSpawnErrorResult({
                            agentId: catalogAgentId ?? catalogAgentIdForConnectedServices,
                            reason: 'missing_identity_and_resume_state',
                        });
                    }
                } else {
                    connectedServiceMaterializationIdentity = resolveConnectedServiceMaterializationIdentityForSpawn({
                        options,
                    });
                }
            }
            const optionsForSpawn: SpawnSessionOptions = connectedServiceMaterializationIdentity
                ? {
                    ...options,
                    connectedServiceMaterializationIdentityV1: connectedServiceMaterializationIdentity,
                }
                : options;
            const requestedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
            const materializationKey =
                connectedServiceMaterializationIdentity?.id
                || normalizedExistingSessionId
                || requestedSessionId
                || 'unmaterialized-connected-services';
            const connectedServiceAuthSessionId =
                normalizedExistingSessionId ||
                requestedSessionId ||
                undefined;

            if (shouldResolveConnectedServiceAuth && catalogAgentId) {
                const activeAccountSettings = getActiveAccountSettingsSnapshot();
                // K1 §2: only continuity-gate the spawn when shared-state continuity was requested
                // for this agent. The gate proves the post-materialization target the vendor reads;
                // a fresh (no-resume) spawn or an isolated spawn is not gated.
                const spawnSharedStateContinuityRequested = resolveConnectedServicesProviderStateSharingPolicyV1(
                    (activeAccountSettings?.settings as { connectedServicesProviderStateSharingSettingsV1?: unknown } | null)
                        ?.connectedServicesProviderStateSharingSettingsV1,
                    catalogAgentId,
                ).stateMode === 'shared';
                try {
                    connectedServiceAuth = await resolveConnectedServiceAuthForSpawn({
                        agentId: catalogAgentId,
                        connectedServicesBindingsRaw: optionsForSpawn.connectedServices,
                        materializationKey,
                        activeServerDir: configuration.activeServerDir,
                        baseDir: params.connectedServicesMaterializationBaseDir,
                        sessionDirectory: optionsForSpawn.directory,
                        credentials: params.credentials,
                        api: params.api,
                        runtimeQuotaSnapshots: params.connectedServiceRuntimeQuotaSnapshots,
                        quotaFreshnessMs: 5 * 60_000,
                        nowMs: () => Date.now(),
                        ...(connectedServiceAuthSessionId ? { sessionId: connectedServiceAuthSessionId } : {}),
                        authGroupSwitchCoordinator: params.authGroupSwitchCoordinator ?? null,
                        softSwitchRecoveryGuard: params.softSwitchRecoveryGuard ?? null,
                        accountSettings: activeAccountSettings?.settings ?? null,
                        processEnv: params.processEnv ?? process.env,
                        credentialRefreshService: params.connectedServiceRefreshCoordinator,
                        vendorResumeId: effectiveResume || null,
                        resumeReachabilityRequired: spawnSharedStateContinuityRequested,
                    });
                } catch (error) {
                    // K1 §2: the post-materialization re-verify proved the resumed session is
                    // unreachable in the REAL materialized target. Fail closed BEFORE the vendor
                    // launches with the concrete structured continuity reason, instead of respawning
                    // into a missing session file ("Pi process exited"). D2: we keep the verbatim
                    // SPAWN_VALIDATION_FAILED code + message (legacy consumers unchanged) AND attach a
                    // structured `errorDetail` so the client can programmatically recognize "resume
                    // unreachable" and offer "start fresh under the new account".
                    if (error instanceof ConnectedServiceSpawnResumeUnreachableError) {
                        logger.warn('[DAEMON RUN] Connected services resume reachability re-verify failed; failing closed before spawn', {
                            agentId: error.agentId,
                            errorCode: error.errorCode,
                            failurePhase: error.failurePhase,
                            vendorResumeId: error.vendorResumeId,
                            cwd: error.cwd,
                            targetMaterializedRoot: error.targetMaterializedRoot,
                            reason: error.reason,
                        });
                        return buildSpawnResumeUnreachableErrorResult(error);
                    }
                    if (error instanceof ConnectedServiceMaterializationBlockedError) {
                        logger.warn('[DAEMON RUN] Connected services materialization failed; failing closed before spawn', {
                            agentId: catalogAgentId,
                            diagnostics: error.diagnostics.map((diagnostic) => ({
                                code: diagnostic.code,
                                providerId: diagnostic.providerId,
                                serviceId: diagnostic.serviceId,
                                reason: diagnostic.reason,
                                severity: diagnostic.severity,
                            })),
                        });
                        return buildConnectedServiceMaterializationSpawnErrorResult({
                            agentId: catalogAgentId,
                            diagnostics: error.diagnostics,
                        });
                    }
                    const credentialRefreshErrorResult = buildConnectedServiceCredentialRefreshSpawnErrorResult({
                        agentId: catalogAgentId,
                        error,
                    });
                    if (credentialRefreshErrorResult) {
                        logger.warn('[DAEMON RUN] Connected services credential preflight failed; failing closed before spawn', {
                            agentId: catalogAgentId,
                            code: credentialRefreshErrorResult.errorMessage,
                        });
                        return credentialRefreshErrorResult;
                    }
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
            } else if (shouldResolveConnectedServiceAuth && !catalogAgentId) {
                logger.warn('[DAEMON RUN] Ignoring connected-services spawn request for configured backend target');
            }

            const effectiveConnectedServicesBindings =
                connectedServiceAuth?.connectedServicesBindings ?? optionsForSpawn.connectedServices;
            const effectiveOptionsForSpawn: SpawnSessionOptions = {
                ...optionsForSpawn,
                ...(effectiveConnectedServicesBindings
                    ? { connectedServices: effectiveConnectedServicesBindings }
                    : {}),
            };

            const spawnEnvironment = await resolveSpawnChildEnvironment({
                happyHomeDir: configuration.happyHomeDir,
                options: effectiveOptionsForSpawn,
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
            const extraEnvForChild = connectedServiceMaterializationIdentity
                ? withConnectedServiceMaterializationIdentityEnv(
                    spawnEnvironment.extraEnvForChild,
                    connectedServiceMaterializationIdentity,
                )
                : spawnEnvironment.extraEnvForChild;
            const materializationDiagnostics = spawnEnvironment.materializationDiagnostics;
            const trackedSessionEnvironmentVariables = buildTrackedSessionRespawnEnvironmentVariables({
                expandedEnvironmentVariables: extraEnv,
                extraEnvForChild,
            });
            const {
                initialTranscriptAfterSeq: _initialTranscriptAfterSeq,
                ...trackedSpawnOptionsBase
            } = effectiveOptionsForSpawn;
            const trackedSpawnOptions: SpawnSessionOptions = {
                ...trackedSpawnOptionsBase,
                ...(trackedSessionEnvironmentVariables
                    ? { environmentVariables: trackedSessionEnvironmentVariables }
                    : {}),
                ...(materializationDiagnostics ? { materializationDiagnostics } : {}),
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
                ...buildDaemonOwnedSpawnChildEnv(),
                ...(sessionAttachFilePath
                    ? { HAPPIER_SESSION_ATTACH_FILE: sessionAttachFilePath }
                    : {}),
                ...(normalizedInitialPrompt
                    ? { [HAPPIER_DAEMON_INITIAL_PROMPT_ENV_KEY]: normalizedInitialPrompt }
                    : {}),
                ...stackProcessKindOverride,
            };
            const spawnLifecycleCallbacks = createSpawnLifecycleCallbacks({
                connectedServicesBindingsRaw: effectiveConnectedServicesBindings,
                connectedServiceSelectionsEnvRaw: extraEnvForChild[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY],
                catalogAgentId: catalogAgentIdForConnectedServices,
                ...(connectedServiceAuthSessionId ? { sessionId: connectedServiceAuthSessionId } : {}),
                materializationKey,
                hasConnectedServiceAuth: () => connectedServiceAuth !== null,
                registerConnectedServiceRefreshTarget: (target) =>
                    params.connectedServiceRefreshCoordinator?.registerSpawnTarget(target),
                registerConnectedServiceQuotaTarget: (target) =>
                    params.connectedServiceQuotasCoordinator?.registerSpawnTarget({
                        pid: target.pid,
                        ...(target.sessionId ? { sessionId: target.sessionId } : {}),
                        connectedServicesBindingsRaw: target.connectedServicesBindingsRaw as Readonly<{
                            v?: unknown;
                            bindingsByServiceId?: Record<string, unknown>;
                        }>,
                        ...(typeof target.connectedServiceSelectionsEnvRaw === 'string'
                            ? {
                                connectedServiceSelectionsEnv: {
                                    [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: target.connectedServiceSelectionsEnvRaw,
                                },
                            }
                            : {}),
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
                options: optionsForSpawn,
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
                processEnv: params.processEnv ?? process.env,
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
