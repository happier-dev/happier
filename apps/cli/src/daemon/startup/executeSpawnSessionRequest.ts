import { configuration } from '@/configuration';
import {
    createProviderErrorV1,
    type ConnectedServiceBindingsV1,
} from '@happier-dev/protocol';
import { validateEnvVarRecordStrict } from '@/terminal/runtime/envVarSanitization';
import { logger } from '@/ui/logger';
import { resolveConcreteBackendTargetRefV2 } from '@/session/backendTargets/resolveConcreteBackendTargetRefs';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import {
    findCatalogEntry,
    isLegacyServiceKeyedCompatibilityCatalogAgent,
} from '@/agent/catalog/registry';

import type {
    DaemonSpawnStartupReadinessFailure,
    TrackedSession,
} from '../types';
import type {
    SpawnSessionOptions,
    SpawnSessionResult,
} from '@/session/shared/spawnSessionContract';
import {
    SPAWN_SESSION_ERROR_CODES,
} from '@/session/shared/spawnSessionContract';
import { resolveSpawnBackendIdentity } from '../spawn/resolveSpawnBackendIdentity';
import { routeSpawnModeAndWaitForWebhook } from '../spawn/routeSpawnModeAndWaitForWebhook';
import { resolveConnectedServiceAuthForSpawn } from '../connectedServices/resolveConnectedServiceAuthForSpawn';
import type { ConnectedServiceRefreshCoordinator } from '../connectedServices/refresh/ConnectedServiceRefreshCoordinator';
import type { ConnectedServiceQuotasCoordinator } from '../connectedServices/quotas/ConnectedServiceQuotasCoordinator';
import { ensureSessionDirectory } from './ensureSessionDirectory';
import { prepareExecuteSpawnSessionRequest } from './prepareExecuteSpawnSessionRequest';
import { refreshAccountSettingsForDaemonRequest } from './accountSettingsFreshness';
import {
    type ProviderSpawnAuthorizationAttempt,
} from '@/providers/spawn/authorize';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import type { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { createSpawnPluginRuntimeLease } from '../spawn/spawnPluginRuntimeLease';
import { prepareDaemonProviderLaunch } from '../spawn/prepareDaemonProviderLaunch';
import {
    prepareDaemonConnectedServices,
    type MissingConnectedServiceMaterializationIdentityRepair,
} from '../spawn/prepareDaemonConnectedServices';
import { prepareDaemonSpawnChildEnvironment } from '../spawn/prepareDaemonSpawnChildEnvironment';
import { prepareDaemonSpawnLifecycle } from '../spawn/prepareDaemonSpawnLifecycle';
import { bindAgentCliLaunchSpec } from '@/packagedRuntime/managedTools/agentCliLaunchSpec';
import {
    prepareRunnerAgentSessionBootstrapForLease,
} from '../spawn/prepareAgentRuntimeSessionBridge';
import { buildProviderSpawnErrorResult } from '../spawn/buildProviderSpawnErrorResult';
import type {
    ConnectedAccountRequestAuthSubjectRegistry,
} from '../connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import {
    activateConnectedAccountRequestAuthForSpawn,
} from '../connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import type {
    SessionSyncPendingInputServerContractResult,
} from '@/api/clientCompatibility/sessionSyncPendingInputServerContract';
import type {
    ResolveManagedProviderPurposeBindingIntent,
} from '@/providers/managed/resolvePurposeBindingSnapshot';
import type {
    ConnectedAccountPurposeBindingOwner,
} from '../connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import {
    composeConnectedAccountSessionPurposeBindingSnapshot,
    scopeConnectedAccountSessionPurposeBindingLease,
} from '../connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import type { DeviceLocalSecretStorage } from '../deviceLocalSecretStorage';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveSpawnLaunchProfileDefaults } from '../spawn/resolveSpawnLaunchProfileDefaults';

type SpawnCredentials = NonNullable<Parameters<typeof resolveSpawnBackendIdentity>[0]['credentials']>;
type SpawnApi = Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]['api'];
type SpawnAccountUsageStore = Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]['accountUsageStore'];
type SpawnAuthGroupSwitchCoordinator = Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]['authGroupSwitchCoordinator'];
type SpawnPredictiveSwitchGuard = Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]['predictiveSwitchGuard'];
type LoadLocalHandoffMetadataByVendorResumeId =
    Parameters<typeof resolveSpawnBackendIdentity>[0]['loadLocalHandoffMetadataByVendorResumeId'];
export type ExecuteSpawnSessionRequestParams = Readonly<{
    options: SpawnSessionOptions;
    credentials: SpawnCredentials;
    deviceLocalSecretStorage?: DeviceLocalSecretStorage;
    api: SpawnApi;
    loadLocalHandoffMetadataByVendorResumeId: LoadLocalHandoffMetadataByVendorResumeId;
    connectedServicesMaterializationBaseDir: string;
    connectedServiceRefreshCoordinator: ConnectedServiceRefreshCoordinator | null;
    connectedServiceQuotasCoordinator: ConnectedServiceQuotasCoordinator | null;
    connectedServiceRuntimeRegistry: Pick<ConnectedServiceRuntimeRegistry, 'registerTarget'>;
    providerAccountUsageStore?: SpawnAccountUsageStore;
    authGroupSwitchCoordinator?: SpawnAuthGroupSwitchCoordinator | null;
    predictiveSwitchGuard?: SpawnPredictiveSwitchGuard;
    repairMissingConnectedServiceMaterializationIdentityForSpawn?: (input: Readonly<{
        sessionId: string;
        agentId: CatalogAgentId;
        connectedServices: ConnectedServiceBindingsV1;
        vendorResumeId: string | null;
    }>) => Promise<MissingConnectedServiceMaterializationIdentityRepair | null>;
    pidToTrackedSession: Map<number, TrackedSession>;
    pidToAwaiter: Map<number, (session: TrackedSession) => void>;
    pidToSpawnResultResolver: Map<number, (result: SpawnSessionResult) => void>;
    pidToSpawnWebhookTimeout: Map<number, NodeJS.Timeout>;
    resolveCanonicalTrackedSessionId: (pid: number) => string;
    onChildExited: (pid: number, exit: { reason: string; code: number | null; signal: string | null }) => void | Promise<void>;
    spawnResourceCleanupByPid: Map<number, () => void | Promise<void>>;
    sessionAttachCleanupByPid: Map<number, () => Promise<void>>;
    processEnv?: NodeJS.ProcessEnv;
    /** Canonical daemon/server feature decision. Missing or non-enabled fails provider spawns closed. */
    resolveProvidersFeatureEnabled?: () => boolean | Promise<boolean>;
    connectedAccountRequestAuthRegistry?: Pick<
        ConnectedAccountRequestAuthSubjectRegistry,
        'activate' | 'retire'
    >;
    connectedAccountRequestAuthHttpPort?: number;
    resolveManagedPurposeBindingIntent?: ResolveManagedProviderPurposeBindingIntent;
    activateSessionPurposeBindings?: ConnectedAccountPurposeBindingOwner['activateSessionPurposeBindings'];
    activatePurposeBindings?: ConnectedAccountPurposeBindingOwner['activatePurposeBindings'];
    resolveSessionSyncPendingInputServerContractResult?: () =>
        SessionSyncPendingInputServerContractResult | null;
}>;

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
    let options = params.options;

    try {
        // A profile id is stable Account intent. Refresh before resolving it so
        // the daemon, rather than an Action/UI caller, owns the profile overlay.
        await refreshAccountSettingsForSpawn(params);

        let prepared = await prepareExecuteSpawnSessionRequest({
            request: {
                ...params,
                options,
                accountSettings: getActiveAccountSettingsSnapshot()?.settings ?? {},
            },
            validateEnvVarRecordStrict,
        });
        if ('type' in prepared) {
            return prepared;
        }

        const profileResolution = resolveSpawnLaunchProfileDefaults({
            options,
            effectiveBackendTarget: prepared.effectiveBackendTargetV2,
            rawSettings: getActiveAccountSettingsSnapshot()?.settings,
        });
        if (!profileResolution.ok) return profileResolution.result;
        if (profileResolution.options !== options) {
            options = profileResolution.options;
            prepared = {
                ...prepared,
                permissionMode: options.permissionMode,
                permissionModeUpdatedAt: options.permissionModeUpdatedAt,
                // Rejoin/resume metadata remains the canonical selection owner.
                // A sparse profile model is only a fresh-launch default and
                // must not turn an existing Session into a model transition.
                modelSelection:
                    prepared.persistedProviderResumeState.selection
                    ?? options.modelSelection,
                // The caller overlay was validated by preparation and the
                // profile overlay came from the strict Protocol schema.
                environmentVariablesValidation: {
                    ok: true,
                    env: options.environmentVariables ?? {},
                },
            };
        }

        const {
            directory,
            sessionId,
            permissionMode,
            permissionModeUpdatedAt,
            agentModeId,
            agentModeUpdatedAt,
            modelSelection,
            normalizedExistingSessionId,
            effectiveResume,
            effectiveBackendTargetV2,
            sessionAttachPayload,
            catalogAgentId,
            daemonSpawnHooks,
            environmentVariablesValidation,
            persistedProviderResumeState,
        } = prepared;

        let spawnResourceCleanupOnExit: (() => void | Promise<void>) | null = null;
        let retainResourcesForUntrackedTmuxChild = false;
        let cleanupPendingSessionAttach: (() => Promise<void>) | null = null;
        const launchResourceScope = createProviderLaunchResourceScope({
            onCleanupError: (safeMessage) => {
                logger.warn('[DAEMON RUN] Provider launch cleanup failed', { error: safeMessage });
            },
        });
        const providerDiagnosticRedactionLease = createProviderRedactionLease({
            values: [],
        });
        launchResourceScope.setSanitizer(
            providerDiagnosticRedactionLease.redact,
        );
        launchResourceScope.register(
            providerDiagnosticRedactionLease.close,
        );
        const pluginRuntimeLease = createSpawnPluginRuntimeLease(launchResourceScope);
        let launchRetirementOutcome:
            Promise<string | null> | null = null;
        const retireLaunchResources =
            (): Promise<string | null> => {
                launchRetirementOutcome ??= (async () => {
                    try {
                        await launchResourceScope.retire();
                    } catch {
                        return 'startup_retirement_incomplete:exit_cleanup_incomplete';
                    }
                    const pendingAttachCleanup =
                        cleanupPendingSessionAttach;
                    if (pendingAttachCleanup) {
                        try {
                            await pendingAttachCleanup();
                            if (
                                cleanupPendingSessionAttach
                                === pendingAttachCleanup
                            ) {
                                cleanupPendingSessionAttach = null;
                            }
                        } catch (cleanupError) {
                            logger.warn(
                                '[DAEMON RUN] Session attach cleanup failed during startup retirement',
                                {
                                    error:
                                        launchResourceScope.sanitize(
                                            cleanupError,
                                        ),
                                },
                            );
                            return 'startup_retirement_incomplete:exit_cleanup_incomplete';
                        }
                    }
                    return null;
                })();
                return launchRetirementOutcome;
            };

        try {
            const cleanupSpawnResources = async () => {
                const incompleteRetirement =
                    await retireLaunchResources();
                if (incompleteRetirement) {
                    throw new Error(incompleteRetirement);
                }
            };
            const refuseSpawn = async (
                result: Extract<
                    SpawnSessionResult,
                    { type: 'error' | 'requestToApproveDirectoryCreation' }
                >,
            ): Promise<SpawnSessionResult> => {
                const incompleteRetirement =
                    await retireLaunchResources();
                return incompleteRetirement
                    ? {
                        type: 'error',
                        errorCode:
                            SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
                        errorMessage: incompleteRetirement,
                    }
                    : result;
            };

            const requestedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
            const priorBindingMetadata = persistedProviderResumeState.binding
                ?? options.providerBindingMetadataV1
                ?? null;
            const appliedPluginRuntimeLease = await pluginRuntimeLease.acquire();
            // The Provider decision runs before the workspace is created and
            // before any runner bootstrap material is written or the Agent
            // runtime contribution is activated. Cleanup can remove a bootstrap
            // file, but it cannot un-create the workspace or un-activate a
            // runtime, so every refusal this owner can already establish is
            // established first.
            const daemonProviderLaunch = await prepareDaemonProviderLaunch({
                options,
                effectiveBackendTarget: effectiveBackendTargetV2,
                catalogAgentId,
                ...(modelSelection ? { modelSelection } : {}),
                profileEnvironmentVariables: environmentVariablesValidation.env,
                daemonSpawnHooks,
                persistedProviderBinding: priorBindingMetadata,
                normalizedExistingSessionId,
                pluginRuntimeLease,
                launchResourceScope,
                resolveProvidersFeatureEnabled: params.resolveProvidersFeatureEnabled,
                ...(params.resolveManagedPurposeBindingIntent
                    ? {
                        resolveManagedPurposeBindingIntent:
                            params.resolveManagedPurposeBindingIntent,
                    }
                    : {}),
                processEnv: params.processEnv ?? process.env,
            });
            if (!daemonProviderLaunch.ok) {
                return await refuseSpawn(daemonProviderLaunch.result);
            }
            const ensuredDirectory = await ensureSessionDirectory({
                directory,
                approvedNewDirectoryCreation:
                    options.approvedNewDirectoryCreation ?? true,
            });
            if (!ensuredDirectory.ok) {
                logger.debug(
                    '[DAEMON RUN] Session directory setup failed',
                    ensuredDirectory.response.type === 'error'
                        ? {
                            resultType: ensuredDirectory.response.type,
                            errorCode: ensuredDirectory.response.errorCode,
                        }
                        : { resultType: ensuredDirectory.response.type },
                );
                return await refuseSpawn(ensuredDirectory.response);
            }
            const directoryCreated = ensuredDirectory.directoryCreated;
            const runnerAgentSessionBootstrap =
                await prepareRunnerAgentSessionBootstrapForLease({
                    target: effectiveBackendTargetV2,
                    lease: appliedPluginRuntimeLease,
                });
            if (runnerAgentSessionBootstrap) {
                launchResourceScope.register(
                    runnerAgentSessionBootstrap.cleanupBootstrapFile,
                );
            }
            const optionsWithProviderIsolation = daemonProviderLaunch.options;
            const providerBindingAttempt: ProviderSpawnAuthorizationAttempt | null = daemonProviderLaunch.attempt;
            const providerAgentTargetKey = daemonProviderLaunch.agentTargetKey;
            const managedProviderBindingAttempt = (
                providerBindingAttempt
                && 'materializeManagedEndpoint' in providerBindingAttempt
            )
                ? providerBindingAttempt
                : null;
            if (
                managedProviderBindingAttempt
                && !runnerAgentSessionBootstrap
            ) {
                return await refuseSpawn(buildProviderSpawnErrorResult(
                    createProviderErrorV1('provider_endpoint_unavailable', {
                        connectionId:
                            managedProviderBindingAttempt.authorization.ticket.connectionId,
                        machineId:
                            managedProviderBindingAttempt.authorization.ticket.machineId,
                    }),
                ));
            }

            const connectedServices = await prepareDaemonConnectedServices({
                options: optionsWithProviderIsolation,
                normalizedExistingSessionId,
                requestedSessionId,
                effectiveResume,
                catalogAgentId,
                credentials: params.credentials,
                api: params.api,
                ...(params.providerAccountUsageStore
                    ? { providerAccountUsageStore: params.providerAccountUsageStore }
                    : {}),
                connectedServiceRefreshCoordinator: params.connectedServiceRefreshCoordinator,
                authGroupSwitchCoordinator: params.authGroupSwitchCoordinator,
                predictiveSwitchGuard: params.predictiveSwitchGuard,
                processEnv: params.processEnv ?? process.env,
                connectedServicesMaterializationBaseDir: params.connectedServicesMaterializationBaseDir,
                pluginContributions: appliedPluginRuntimeLease.registry.contributes,
                ...(params.activatePurposeBindings
                    ? { activatePurposeBindings: params.activatePurposeBindings }
                    : {}),
                serverContract:
                    params
                        .resolveSessionSyncPendingInputServerContractResult?.()
                    ?? null,
                repairMissingMaterializationIdentity:
                    params.repairMissingConnectedServiceMaterializationIdentityForSpawn,
            });
            if (!connectedServices.ok) {
                return await refuseSpawn(connectedServices.result);
            }
            const connectedServiceAuth = connectedServices.auth;
            if (connectedServiceAuth?.materializationPurposeLease) {
                launchResourceScope.register({
                    onFailure: () => connectedServiceAuth.materializationPurposeLease?.dispose(),
                    onExit: () => connectedServiceAuth.materializationPurposeLease?.dispose(),
                });
            }
            const connectedServiceMaterializationIdentity = connectedServices.materializationIdentity;
            const effectiveOptionsForSpawn = connectedServices.options;
            const effectiveConnectedServicesBindings = connectedServices.effectiveBindings;
            const materializationKey = connectedServices.materializationKey;
            const connectedServiceAuthSessionId = connectedServices.authSessionId;
            const agentPurposeBindingSnapshot =
                connectedServices.qualifiedPurposeBindingSnapshot;
            const requestAuthPurposeBindings =
                connectedServiceAuth?.requestAuthPurposeBindings ?? [];
            const managedPurposeBindings = managedProviderBindingAttempt
                ? managedProviderBindingAttempt.authorization.deployment
                    .implementation.purposeBindings.bindings
                : [];
            const managedPurposes = managedPurposeBindings.map(
                (binding) => binding.purpose,
            );
            let sessionPurposeBindingSnapshot:
                ReturnType<
                    typeof composeConnectedAccountSessionPurposeBindingSnapshot
                >;
            try {
                sessionPurposeBindingSnapshot =
                    composeConnectedAccountSessionPurposeBindingSnapshot([
                        ...(agentPurposeBindingSnapshot?.purposes.length
                            ? [agentPurposeBindingSnapshot]
                            : []),
                        ...(managedPurposes.length
                            ? [{
                                purposes: managedPurposes,
                                bindings: managedPurposeBindings,
                            }]
                            : []),
                    ]);
            } catch {
                return await refuseSpawn({
                    type: 'error',
                    errorCode:
                        SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
                    errorMessage:
                        'connected_account_session_binding_snapshot_invalid',
                });
            }
            type SessionPurposeBindingLease = ReturnType<
                ConnectedAccountPurposeBindingOwner['activateSessionPurposeBindings']
            >;
            type SessionPurposeBindingActivationResult =
                | {
                    ok: true;
                    lease: SessionPurposeBindingLease;
                }
                | {
                    ok: false;
                    failure: DaemonSpawnStartupReadinessFailure;
                };
            let sessionPurposeBindingLease: SessionPurposeBindingLease | null =
                null;
            const activateSessionPurposeBindingLeaseAndAgent = async (
                canonicalSessionId: string,
            ): Promise<SessionPurposeBindingActivationResult> => {
                const activateSessionPurposeBindings =
                    params.activateSessionPurposeBindings;
                if (
                    sessionPurposeBindingSnapshot.purposes.length === 0
                    || !activateSessionPurposeBindings
                ) {
                    return {
                        ok: false,
                        failure: {
                            type: 'error',
                            errorCode:
                                SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
                            errorMessage:
                                'connected_account_session_binding_unavailable',
                        },
                    };
                }
                let activatedLease: SessionPurposeBindingLease;
                try {
                    activatedLease =
                        activateSessionPurposeBindings({
                            sessionId: canonicalSessionId,
                            purposes: sessionPurposeBindingSnapshot.purposes,
                            bindings: sessionPurposeBindingSnapshot.bindings,
                        });
                    launchResourceScope.register({
                        onFailure: () => activatedLease.dispose(),
                        onExit: () => activatedLease.dispose(),
                    });
                    await connectedServiceAuth?.materializationPurposeLease?.dispose();
                } catch {
                    return {
                        ok: false,
                        failure: {
                            type: 'error',
                            errorCode:
                                SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
                            errorMessage:
                                'connected_account_session_binding_activation_failed',
                        },
                    };
                }
                if (requestAuthPurposeBindings.length === 0) {
                    return { ok: true, lease: activatedLease };
                }
                const materializedRootDir =
                    connectedServiceAuth
                        ?.requestAuthMaterializedRoot
                        ?.trim() ?? '';
                const requestAuthRegistry =
                    params.connectedAccountRequestAuthRegistry;
                const requestAuthHttpPort =
                    params.connectedAccountRequestAuthHttpPort;
                if (
                    !agentPurposeBindingSnapshot?.requestAuthUses?.length
                    || !materializedRootDir
                    || !requestAuthRegistry
                    || typeof requestAuthHttpPort !== 'number'
                    || !Number.isSafeInteger(requestAuthHttpPort)
                    || requestAuthHttpPort < 1
                    || requestAuthHttpPort > 65535
                ) {
                    return {
                        ok: false,
                        failure: {
                            type: 'error',
                            errorCode:
                                SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
                            errorMessage:
                                'connected_account_request_auth_unavailable',
                        },
                    };
                }
                try {
                    await activateConnectedAccountRequestAuthForSpawn({
                        materializationId: materializationKey,
                        materializedRootDir,
                        httpPort: requestAuthHttpPort,
                        subject:
                            scopeConnectedAccountSessionPurposeBindingLease({
                                lease: activatedLease,
                                subjectId: activatedLease.subjectId,
                                uses:
                                    agentPurposeBindingSnapshot.requestAuthUses,
                                ...(catalogAgentId
                                    && isLegacyServiceKeyedCompatibilityCatalogAgent(
                                        findCatalogEntry(catalogAgentId),
                                    )
                                    ? {
                                        legacyServiceKeyedCompatibility:
                                            true as const,
                                    }
                                    : {}),
                                registerRedaction:
                                    providerDiagnosticRedactionLease.add,
                            }),
                        registry: requestAuthRegistry,
                        launchResourceScope,
                    });
                } catch {
                    return {
                        ok: false,
                        failure: {
                            type: 'error',
                            errorCode:
                                SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
                            errorMessage:
                                'connected_account_request_auth_activation_failed',
                        },
                    };
                }
                return { ok: true, lease: activatedLease };
            };
            if (sessionPurposeBindingSnapshot.purposes.length > 0) {
                if (!params.activateSessionPurposeBindings) {
                    return await refuseSpawn({
                        type: 'error',
                        errorCode:
                            SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
                        errorMessage:
                            'connected_account_session_binding_unavailable',
                    });
                }
                if (connectedServiceAuthSessionId) {
                    const activation =
                        await activateSessionPurposeBindingLeaseAndAgent(
                            connectedServiceAuthSessionId,
                        );
                    if (!activation.ok) {
                        return await refuseSpawn(activation.failure);
                    }
                    sessionPurposeBindingLease = activation.lease;
                }
            } else if (requestAuthPurposeBindings.length > 0) {
                return await refuseSpawn({
                    type: 'error',
                    errorCode:
                        SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
                    errorMessage:
                        'connected_account_request_auth_unavailable',
                });
            }
            const childEnvironment = await prepareDaemonSpawnChildEnvironment({
                options: effectiveOptionsForSpawn,
                resolvedAgentId: catalogAgentId,
                effectiveModelSelection: modelSelection,
                terminal: options.terminal,
                profileEnvironmentVariables: environmentVariablesValidation.env,
                daemonSpawnHooks,
                pluginRuntimeRegistry: appliedPluginRuntimeLease.registry,
                processEnv: params.processEnv ?? process.env,
                connectedServiceAuth,
                connectedServiceMaterializationIdentity,
                providerBindingAttempt,
                providerAgentTargetKey,
                providerDiagnosticRedactionLease,
                launchResourceScope,
            });
            if (!childEnvironment.ok) {
                return await refuseSpawn(childEnvironment.result);
            }
            const { spawnEnvironment, extraEnv, extraEnvForChild, trackedSpawnOptions, terminalRequest } = childEnvironment;
            const runnerAgentInvocationContext =
                runnerAgentSessionBootstrap
                    ? Object.freeze({
                        cwd: directory,
                        environment: Object.freeze({}),
                        ...(spawnEnvironment.agentCliLaunchSpec
                            ? {
                                agentCliLaunch: bindAgentCliLaunchSpec({
                                    localAgentId:
                                        runnerAgentSessionBootstrap.authorization
                                            .descriptor.agentDeclaration!
                                            .definition.id,
                                    spec: spawnEnvironment.agentCliLaunchSpec,
                                }),
                            }
                            : {}),
                        providerBindingActive: Boolean(
                            spawnEnvironment.providerBindingLaunchHandoff,
                        ),
                    })
                    : null;
            const activateConnectedAccountSessionBinding = async (
                canonicalSessionId: string,
            ): Promise<DaemonSpawnStartupReadinessFailure | null> => {
                const activation =
                    await activateSessionPurposeBindingLeaseAndAgent(
                        canonicalSessionId,
                    );
                if (!activation.ok) return activation.failure;
                sessionPurposeBindingLease = activation.lease;
                return null;
            };
            let activateConnectedAccountSessionBindingOnCanonicalSession:
                ((sessionId: string) => Promise<DaemonSpawnStartupReadinessFailure | null>)
                | undefined;
            if (sessionPurposeBindingSnapshot.purposes.length > 0) {
                if (!connectedServiceAuthSessionId) {
                    activateConnectedAccountSessionBindingOnCanonicalSession =
                        activateConnectedAccountSessionBinding;
                }
            } else if (requestAuthPurposeBindings.length > 0) {
                return await refuseSpawn({
                    type: 'error',
                    errorCode:
                        SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
                    errorMessage:
                        'connected_account_request_auth_unavailable',
                });
            }
            const spawnLifecycle = await prepareDaemonSpawnLifecycle({
                runnerAgentSessionBootstrap,
                normalizedExistingSessionId,
                spawnNonce: effectiveOptionsForSpawn.spawnNonce,
                sessionAttachPayload: sessionAttachPayload ?? null,
                extraEnv,
                extraEnvForChild,
                providerBindingLaunchHandoff: spawnEnvironment.providerBindingLaunchHandoff ?? null,
                unsetEnvKeys: spawnEnvironment.unsetEnvKeys,
                processEnv: params.processEnv ?? process.env,
                effectiveConnectedServicesBindings,
                connectedServiceSelectionsEnv: connectedServiceAuth?.env,
                catalogAgentId,
                connectedServiceAuthSessionId,
                sessionDirectory: effectiveOptionsForSpawn.directory,
                materializationKey,
                ...(connectedServiceMaterializationIdentity
                    ? { connectedServiceMaterializationIdentityV1: connectedServiceMaterializationIdentity }
                    : {}),
                hasConnectedServiceAuth:
                    connectedServiceAuth !== null
                    && connectedServiceAuth
                        .ongoingRuntimeRegistrationAllowed !== false,
                ...(activateConnectedAccountSessionBindingOnCanonicalSession
                    ? {
                        activateConnectedAccountSessionBindingOnCanonicalSession,
                    }
                    : {}),
                connectedServiceRefreshCoordinator: params.connectedServiceRefreshCoordinator,
                connectedServiceQuotasCoordinator: params.connectedServiceQuotasCoordinator,
                connectedServiceRuntimeRegistry: params.connectedServiceRuntimeRegistry,
                spawnResourceCleanupByPid: params.spawnResourceCleanupByPid,
                sessionAttachCleanupByPid: params.sessionAttachCleanupByPid,
                setPendingSessionAttachCleanup: (cleanup) => {
                    cleanupPendingSessionAttach = cleanup;
                },
                getSpawnResourceCleanupOnExit: () => {
                    spawnResourceCleanupOnExit ??= launchResourceScope.transfer();
                    return spawnResourceCleanupOnExit;
                },
                onSpawnResourceCleanupArmed: () => undefined,
                deviceLocalSecretStorage: params.deviceLocalSecretStorage,
            });
            cleanupPendingSessionAttach = spawnLifecycle.cleanupPendingSessionAttach;

            let providerCleanupTransferred = false;
            const revalidateProviderBeforeCommit = providerBindingAttempt
                ? async (): Promise<SpawnSessionResult | null> => {
                    const providerCommitAuthorization = await providerBindingAttempt!.revalidateBeforeCommit();
                    if (!providerCommitAuthorization.ok) {
                        await cleanupSpawnResources();
                        return buildProviderSpawnErrorResult(providerCommitAuthorization.error);
                    }
                    if (!providerCleanupTransferred) {
                        providerCleanupTransferred = true;
                        const providerCleanupOnExit = providerBindingAttempt!.takeCleanupOnExit();
                        launchResourceScope.register(providerCleanupOnExit);
                    }
                    return null;
                }
                : undefined;

            let spawnResult = await routeSpawnModeAndWaitForWebhook({
                terminalRequest,
                directory,
                options: effectiveOptionsForSpawn,
                trackedSpawnOptions,
                normalizedExistingSessionId,
                effectiveResume,
                effectiveBackendTargetV2,
                reservedSessionId: typeof sessionId === 'string' ? sessionId : undefined,
                permissionMode,
                permissionModeUpdatedAt,
                agentModeId,
                agentModeUpdatedAt,
                modelSelection,
                directoryCreated,
                extraEnvForChildWithMessage: spawnLifecycle.extraEnvForChildWithMessage,
                unsetEnvKeys: spawnLifecycle.unsetEnvKeys,
                runnerAgentSessionBootstrapAuthorization:
                    spawnLifecycle
                        .runnerAgentSessionBootstrapAuthorization,
                runnerAgentInvocationContext,
                processEnv: params.processEnv ?? process.env,
                happyHomeDir: configuration.happyHomeDir,
                pidToTrackedSession: params.pidToTrackedSession,
                pidToAwaiter: params.pidToAwaiter,
                pidToSpawnResultResolver: params.pidToSpawnResultResolver,
                pidToSpawnWebhookTimeout: params.pidToSpawnWebhookTimeout,
                resolveCanonicalTrackedSessionId: params.resolveCanonicalTrackedSessionId,
                onChildExited: params.onChildExited,
                spawnLifecycleCallbacks: spawnLifecycle.spawnLifecycleCallbacks,
                cleanupSpawnResources,
                logDebug: (message, payload) => logger.debug(message, payload),
                warn: (message) => logger.warn(message),
                sanitizeDiagnosticText: childEnvironment.sanitizeDiagnosticText,
                createStreamingSanitizer: childEnvironment.createStreamingSanitizer,
                revalidateBeforeCommit: revalidateProviderBeforeCommit,
                onUntrackedTmuxChild: () => {
                    retainResourcesForUntrackedTmuxChild = true;
                },
            });
            if (spawnResult.type === 'error' && !retainResourcesForUntrackedTmuxChild) {
                const incompleteRetirement =
                    await retireLaunchResources();
                if (incompleteRetirement) {
                    spawnResult = {
                        type: 'error',
                        errorCode:
                            SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
                        errorMessage: incompleteRetirement,
                    };
                }
            }
            if (!providerBindingAttempt && !retainResourcesForUntrackedTmuxChild) {
                await pluginRuntimeLease.release();
            }
            return spawnResult;
        } catch (error) {
            const errorMessage = launchResourceScope.sanitize(error);
            let incompleteRetirement: string | null = null;
            if (!retainResourcesForUntrackedTmuxChild) {
                incompleteRetirement =
                    await retireLaunchResources();
            }
            logger.debug('[DAEMON RUN] Session spawn failed after startup preparation', {
                error: errorMessage,
            });
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
                errorMessage:
                    incompleteRetirement
                    ?? (
                        errorMessage.startsWith(
                            'startup_retirement_incomplete:',
                        )
                            ? errorMessage
                            : `Failed to spawn session: ${errorMessage}`
                    ),
            };
        }
    } catch (error) {
        logger.warn('[DAEMON RUN] Failed before spawn session work started', {
            hasExistingSessionId: typeof options.existingSessionId === 'string' && options.existingSessionId.trim().length > 0,
            hasResume: typeof options.resume === 'string' && options.resume.trim().length > 0,
            backendTargetKind: resolveConcreteBackendTargetRefV2(options.backendTarget)?.kind ?? null,
        });
        throw error;
    }
}
