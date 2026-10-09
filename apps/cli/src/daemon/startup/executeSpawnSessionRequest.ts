import type { PersistedTakeoverAdmissionWaiter } from '../spawn/persistedTakeoverAdmission';
import { configuration } from '@/configuration';
import { createSessionInitialAccessFile } from '../spawn/sessionInitialAccessFile';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { ConnectedServiceBindingsV2 } from '@happier-dev/protocol';
import { validateEnvVarRecordStrict } from '@/terminal/runtime/envVarSanitization';
import { resolveTerminalRequestFromSpawnOptions } from '@/terminal/runtime/terminalConfig';
import { prepareHerdrTerminalContext } from '@/terminal/runtime/prepareHerdrTerminalContext';
import { resolveDaemonSessionTerminalPresentation } from '../sessions/resolveTrackedSessionTerminalPresentation';
import { resolveTerminalHostUnavailableSpawnErrorDetail } from '@/integrations/terminal/host/errors';
import { resolveBackendExecutionSurfaces } from '@/agent/runtime/registry/engineRegistry';
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
import { createManagedSessionDirectories } from '@/session/creation/managedSessionDirectories';
import { seedManagedSessionDirectory } from '@/session/creation/seedManagedSessionDirectory';
import { isDefiniteSpawnPreAdmissionRejection } from '@/session/services/spawnPreAdmissionRejection';
import { readSessionCreationTerminalSpawnErrorDetail } from '@/api/session/sessionCreationTerminalSpawnErrorDetail';
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
import {
    commitDaemonLaunchSession,
    daemonLaunchRequiresCommittedSession,
    withoutFreshSessionCreationFields,
    type CommittedDaemonLaunchSession,
} from '../spawn/commitDaemonLaunchSession';
import { archiveSessionOnceInactive } from '@/session/services/archiveSessionOnceInactive';
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
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { refreshActiveAcpCatalog } from '@/agent/acp/catalog/hydrateAcpCatalog';
import { AcpCatalogUnavailableError } from '@/agent/acp/catalog/configured/resolveBackend';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { resolveSpawnLaunchProfileDefaults } from '../spawn/resolveSpawnLaunchProfileDefaults';
import { readProfileSettingsFromAccountSnapshot,
    readAccountLaunchProfiles, ProfileCatalogUnavailableError } from '@/settings/profiles/readProfilesFromAccountSettings';
import {
    LaunchSecretReferenceOverlayError,
    readLaunchSecretReferenceOverlayProviderErrorCodeV1,
    resolveLaunchProfileSavedSecretEnvironment,
} from '../agentRuntime/resolveForegroundProfileSavedSecretEnvironment';
import type { DaemonPluginChangeService } from '@/plugins/daemon/changeService';
import { isRequesterLaunchAdmissionCurrent } from '../lifecycle/requesterWorkAttribution';
import type { RequesterSessionRuntimeContext } from '../sessionEncryption/requesterSessionCredentials';

type SpawnCredentials = NonNullable<Parameters<typeof resolveSpawnBackendIdentity>[0]['credentials']>;
type SpawnApi = Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]['api'];
type SpawnAccountUsageStore = Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]['accountUsageStore'];
type SpawnAuthGroupSwitchCoordinator = Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]['authGroupSwitchCoordinator'];
type SpawnPredictiveSwitchGuard = Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]['predictiveSwitchGuard'];
export type ExecuteSpawnSessionRequestParams = Readonly<{
    options: SpawnSessionOptions;
    requesterSessionRuntimeContext?: RequesterSessionRuntimeContext;
    retainedTerminalRecovery?: 'adopt';
    persistedTakeoverAdmissionWaiter?: Pick<PersistedTakeoverAdmissionWaiter, 'getRegistration'>;
    credentials: SpawnCredentials;
    deviceLocalSecretStorage?: DeviceLocalSecretStorage;
    api: SpawnApi;
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
        connectedServices: ConnectedServiceBindingsV2;
        vendorResumeId: string | null;
    }>) => Promise<MissingConnectedServiceMaterializationIdentityRepair | null>;
    pidToTrackedSession: Map<number, TrackedSession>;
    pidToAwaiter: Map<number, (session: TrackedSession) => void>;
    pidToSpawnResultResolver: Map<number, (result: SpawnSessionResult) => void>;
    pidToSpawnWebhookTimeout: Map<number, NodeJS.Timeout>;
    resolveCanonicalTrackedSessionId: (pid: number) => string;
    onChildExited: (pid: number, exit: { reason: string; code: number | null; signal: string | null }) => void | Promise<void>;
    onTrackedSessionRegistered?: () => void;
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
    controlPluginDevelopment?: DaemonPluginChangeService['controlPluginDevelopment'];
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
    const requesterRuntime = options.requesterSessionBootstrap ? params.requesterSessionRuntimeContext : undefined;
    if (options.requesterSessionBootstrap) {
        if (!requesterRuntime || requesterRuntime.bootstrap !== options.requesterSessionBootstrap
            || !await requesterRuntime.bootstrap.savedSecretOperationContext.isCurrent()) {
            return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
                errorMessage: 'Requester Account runtime unavailable' };
        }
        params = { ...params, credentials: requesterRuntime.bootstrap.credentials, api: requesterRuntime.api,
            connectedServicesMaterializationBaseDir: requesterRuntime.connectedServicesMaterializationBaseDir,
            connectedServiceRefreshCoordinator: requesterRuntime.connectedServiceRefreshCoordinator,
            connectedServiceQuotasCoordinator: requesterRuntime.connectedServiceQuotasCoordinator,
            connectedServiceRuntimeRegistry: requesterRuntime.connectedServiceRuntimeRegistry,
            providerAccountUsageStore: requesterRuntime.providerAccountUsageStore,
            authGroupSwitchCoordinator: requesterRuntime.authGroupSwitchCoordinator,
            predictiveSwitchGuard: requesterRuntime.predictiveSwitchGuard,
            resolveManagedPurposeBindingIntent: requesterRuntime.resolveManagedPurposeBindingIntent,
            activateSessionPurposeBindings: requesterRuntime.activateSessionPurposeBindings,
            activatePurposeBindings: requesterRuntime.activatePurposeBindings };
    }
    if (!await isRequesterLaunchAdmissionCurrent(options)) {
        return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
            errorMessage: 'Requester Machine admission unavailable' };
    }
    let takeoverAdmission: ReturnType<PersistedTakeoverAdmissionWaiter['getRegistration']> = null;
    try {
        takeoverAdmission = options.persistedTakeoverAdmission
            ? params.persistedTakeoverAdmissionWaiter?.getRegistration(options.persistedTakeoverAdmission) ?? null
            : null;
        if (options.persistedTakeoverAdmission && !takeoverAdmission) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
                errorMessage: 'Takeover admission attempt is unavailable',
            };
        }
        // A profile id is stable Account intent. Refresh before resolving it so
        // the daemon, rather than an Action/UI caller, owns the profile overlay.
        if (requesterRuntime) {
            if (!await requesterRuntime.refreshAccountSettings(options.accountSettingsVersionHint)) return {
                type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
                errorMessage: 'Requester Account settings unavailable' };
        } else await refreshAccountSettingsForSpawn(params);

        let activeAccountSettingsSnapshot = requesterRuntime?.readAccountSettingsSnapshot() ?? getActiveAccountSettingsSnapshot();
        let profilesSnapshot: Awaited<ReturnType<typeof readAccountLaunchProfiles>> | undefined;
        if (options.profileId) {
            try {
                profilesSnapshot = requesterRuntime ? await requesterRuntime.readAccountLaunchProfiles()
                    : await readAccountLaunchProfiles(activeAccountSettingsSnapshot?.settings, params.credentials);
            } catch (error) {
                if (!(error instanceof ProfileCatalogUnavailableError)) throw error;
                return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST, errorMessage: error.message };
            }
            activeAccountSettingsSnapshot = requesterRuntime?.readAccountSettingsSnapshot() ?? getActiveAccountSettingsSnapshot();
        }
        const profileSettings = readProfileSettingsFromAccountSnapshot(activeAccountSettingsSnapshot);
        const launchProfileArtifacts = profilesSnapshot?.artifactsById;
        const acpOperationContext = requesterRuntime?.bootstrap.savedSecretOperationContext;
        const acpScopeKey = (acpOperationContext ? acpOperationContext.readSnapshot() : activeAccountSettingsSnapshot)?.scopeKey;
        const acpLifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
        const readAcpCatalogSnapshot = async (): Promise<AcpCatalogSnapshotV1> => {
            const readSnapshot = () => acpOperationContext ? acpOperationContext.readSnapshot() : getActiveAccountSettingsSnapshot();
            const assertCurrent = async () => {
                const credentialScope = acpOperationContext
                    ? runWithServerHttpBaseUrl(acpOperationContext.serverHttpBaseUrl, () => resolveAccountSettingsScopeKey(params.credentials))
                    : resolveAccountSettingsScopeKey(params.credentials);
                if (!acpScopeKey || credentialScope !== acpScopeKey
                    || acpOperationContext && !await acpOperationContext.isCurrent()
                    || readSnapshot()?.scopeKey !== acpScopeKey
                    || !acpOperationContext && getActiveAccountSettingsSnapshotLifetimeToken() !== acpLifetimeToken) {
                    throw new AcpCatalogUnavailableError('scope-retired');
                }
            };
            await assertCurrent();
            if (readSnapshot()?.acpCatalog?.status !== 'ready') await refreshActiveAcpCatalog({
                credentials: params.credentials, operationContext: acpOperationContext,
            });
            await assertCurrent();
            return readSnapshot()?.acpCatalog ?? { status: 'unavailable', reason: 'catalog-unobserved' };
        };
        let prepared = await prepareExecuteSpawnSessionRequest({
            request: {
                ...params,
                options,
                accountSettings: activeAccountSettingsSnapshot?.settings ?? {},
                readAcpCatalogSnapshot,
            },
            validateEnvVarRecordStrict,
        });
        if ('type' in prepared) {
            return prepared;
        }

        const profileResolution = resolveSpawnLaunchProfileDefaults({
            options,
            effectiveBackendTarget: prepared.effectiveBackendTargetV2,
            rawSettings: profileSettings,
            profileCatalog: activeAccountSettingsSnapshot?.profileCatalog,
            artifactsById: launchProfileArtifacts,
            profilesSnapshot,
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
            directory: preparedDirectory,
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
        let directory = preparedDirectory;
        options = {
            ...options,
            directoryKind: prepared.directoryKind,
            ...(prepared.runtimeDescriptorV1 ? { runtimeDescriptorV1: prepared.runtimeDescriptorV1 } : {}),
            ...(prepared.sessionCreationTag ? { sessionCreationTag: prepared.sessionCreationTag } : {}),
        };
        const managedDirectoryOwner = prepared.directoryKind === 'managed'
            ? createManagedSessionDirectories()
            : null;
        let managedAllocation: Readonly<{ allocationId: string; created: boolean }> | null = null;
        let childLaunchSubmitted = false;
        const rollbackManagedAllocation = async () => {
            if (!managedDirectoryOwner || !managedAllocation?.created) return;
            try { await managedDirectoryOwner.rollbackFreshSpawn({ ...managedAllocation,
                ...(normalizedExistingSessionId ? { sessionId: normalizedExistingSessionId } : {}),
            }); }
            catch (error) { logger.warn('[DAEMON RUN] Managed directory rollback remains pending', { error }); }
        };

        let spawnResourceCleanupOnExit: (() => void | Promise<void>) | null = null;
        let retainResourcesForUntrackedHostedChild = false;
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
        let profileLaunchEnvironment = environmentVariablesValidation.env;
        if (options.profileId) {
            if (!profilesSnapshot) throw new ProfileCatalogUnavailableError('unavailable');
            const matchingProfiles = profilesSnapshot.visibleProfiles.filter((profile) => profile.id === options.profileId);
            if (matchingProfiles.length === 1 && activeAccountSettingsSnapshot) {
                try {
                    const savedSecretEnvironment =
                        resolveLaunchProfileSavedSecretEnvironment({
                            profile: matchingProfiles[0]!,
                            accountSettings:
                                activeAccountSettingsSnapshot.settings,
                            settingsSecretsReadKeys:
                                activeAccountSettingsSnapshot
                                    .settingsSecretsReadKeys,
                            savedSecretResources:
                                activeAccountSettingsSnapshot
                                    .savedSecretResources,
                            ...(requesterRuntime ? { isCurrent: () => requesterRuntime.bootstrap.savedSecretOperationContext.readSnapshot()
                                === activeAccountSettingsSnapshot } : {}),
                            foregroundSatisfiedSecretRequirementNames: [],
                            ...(options.secretReferenceOverlay
                                ? {
                                    secretReferenceOverlay:
                                        options.secretReferenceOverlay,
                                }
                                : {}),
                        });
                    profileLaunchEnvironment = Object.freeze({
                        ...profileLaunchEnvironment,
                        ...savedSecretEnvironment,
                    });
                    providerDiagnosticRedactionLease.add(
                        Object.values(savedSecretEnvironment),
                    );
                } catch (error) {
                    if (!(error instanceof LaunchSecretReferenceOverlayError)) {
                        throw error;
                    }
                    await launchResourceScope.retire();
                    return buildProviderSpawnErrorResult(createProviderErrorV1(
                        readLaunchSecretReferenceOverlayProviderErrorCodeV1(
                            error.reason,
                        ),
                        { sourceProfileId: options.profileId },
                    ));
                }
            } else if (options.secretReferenceOverlay) {
                await launchResourceScope.retire();
                return buildProviderSpawnErrorResult(createProviderErrorV1(
                    'provider_settings_invalid',
                    { sourceProfileId: options.profileId },
                ));
            }
        } else if (options.secretReferenceOverlay) {
            await launchResourceScope.retire();
            return buildProviderSpawnErrorResult(createProviderErrorV1(
                'provider_settings_invalid',
            ));
        }
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
                await rollbackManagedAllocation();
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
                ...(requesterRuntime ? { accountSettingsSnapshot: requesterRuntime.readAccountSettingsSnapshot(),
                    readAccountSettingsSnapshot: () => requesterRuntime.bootstrap.savedSecretOperationContext.readSnapshot(),
                    providerRuntimeHomeDir: requesterRuntime.activeServerDir,
                    savedSecretOperationContext: requesterRuntime.bootstrap.savedSecretOperationContext,
                } : {}),
                options,
                effectiveBackendTarget: effectiveBackendTargetV2,
                catalogAgentId,
                ...(modelSelection ? { modelSelection } : {}),
                profileEnvironmentVariables: profileLaunchEnvironment,
                launchProfileArtifacts,
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
            const managedDirectory = managedDirectoryOwner
                ? await managedDirectoryOwner.prepareForSpawn({
                    directory,
                    sessionCreationTag: options.sessionCreationTag,
                    existingSessionId: normalizedExistingSessionId,
                    freshSessionCreation: options.freshSessionCreation,
                    approvedNewDirectoryCreation: options.approvedNewDirectoryCreation,
                    resumeRequestId: options.executionAuthorization?.requestId,
                })
                : null;
            if (managedDirectory && !managedDirectory.ok) {
                return await refuseSpawn({
                    type: 'error', errorCode: managedDirectory.errorCode,
                    errorMessage: 'The private Session directory is missing. Confirm creation of a new directory to resume.',
                });
            }
            if (managedDirectory?.ok) {
                managedAllocation = { allocationId: managedDirectory.allocationId, created: managedDirectory.created === true };
                const identityChanged = directory !== managedDirectory.directory;
                directory = managedDirectory.directory;
                options = {
                    ...options, directory,
                    ...(identityChanged ? { attachMetadataIdentityPolicy: 'replace_with_runtime_identity' } : {}),
                };
            }
            const ensuredDirectory = managedDirectory?.ok
                ? { ok: true as const, directoryCreated: managedDirectory.directoryCreated === true }
                : await ensureSessionDirectory({
                    directory,
                    approvedNewDirectoryCreation: options.approvedNewDirectoryCreation ?? true,
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
            if (managedDirectoryOwner && options.managedDirectorySeed) {
                if (!options.sessionCreationTag || (normalizedExistingSessionId && !options.freshSessionCreation)) {
                    return await refuseSpawn({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                        errorMessage: 'Managed directory seeding requires a fresh creation allocation' });
                }
                const seeded = await seedManagedSessionDirectory({
                    activeServerDir: configuration.activeServerDir,
                    sessionCreationTag: options.sessionCreationTag,
                    targetPath: directory,
                    seed: options.managedDirectorySeed,
                });
                if (!seeded.ok) {
                    return await refuseSpawn({ type: 'error', errorCode: seeded.errorCode,
                        errorMessage: 'The source private Session directory is missing; fork files could not be copied.' });
                }
            }
            if (params.controlPluginDevelopment) {
                try {
                    const developmentRegistration = await params.controlPluginDevelopment({
                        kind: 'registerWorkspace',
                        projectRoot: directory,
                    });
                    if (developmentRegistration.kind !== 'status') {
                        logger.debug('[DAEMON RUN] Workspace plugin development registration needs attention', {
                            kind: developmentRegistration.kind,
                            ...(developmentRegistration.kind === 'failed'
                                ? { code: developmentRegistration.code }
                                : {}),
                        });
                    }
                } catch (error) {
                    logger.debug('[DAEMON RUN] Workspace plugin development registration failed', error);
                }
            }
            // Resolve the runtime-owned placement once, before either daemon
            // or runner commits the fresh Session. The selected descriptor
            // travels separately from the runner's authority identity.
            let selectedTerminalRequest = resolveTerminalRequestFromSpawnOptions({
                happyHomeDir: configuration.happyHomeDir,
                terminal: options.terminal,
                environmentVariables: profileLaunchEnvironment,
            });
            const executionSurfaces = await resolveBackendExecutionSurfaces(effectiveBackendTargetV2, {
                runtimeRegistry: appliedPluginRuntimeLease.registry,
            });
            const selectedLaunchEnvironment = Object.fromEntries(Object.entries({
                ...(params.processEnv ?? process.env),
                ...daemonProviderLaunch.options.environmentVariables,
                ...profileLaunchEnvironment,
            }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
            const terminalPresentation = await resolveDaemonSessionTerminalPresentation(executionSurfaces, {
                cwd: directory,
                requestedHost: selectedTerminalRequest.requested ?? 'plain',
                runtimeDescriptorV1: options.runtimeDescriptorV1,
                // This is the admitted selection context, before native auth
                // materialization. The child-environment owner prepares and
                // preserves actual provider unset keys later in this launch.
                launchEnvironment: { values: selectedLaunchEnvironment, unset: [] },
                configuration: { options: Object.fromEntries(Object.entries(options.sessionConfigOptionOverrides?.overrides ?? {})
                    .map(([id, option]) => [id, { value: option.value, updatedAtMs: option.updatedAt }])) },
            }, normalizedExistingSessionId, params.retainedTerminalRecovery);
            if (selectedTerminalRequest.requested === 'herdr' && terminalPresentation.kind !== 'none') {
                const context = await prepareHerdrTerminalContext({ happyHomeDir: configuration.happyHomeDir,
                    sessionName: selectedTerminalRequest.herdr.sessionName,
                    ...(normalizedExistingSessionId ? { existingSessionId: normalizedExistingSessionId } : {}),
                    processEnv: selectedLaunchEnvironment });
                selectedTerminalRequest = { requested: 'herdr', herdr: context };
            }
            const runnerAgentSessionBootstrap =
                await prepareRunnerAgentSessionBootstrapForLease({
                    target: effectiveBackendTargetV2,
                    lease: appliedPluginRuntimeLease,
                    ...(terminalPresentation.runtimeDescriptorV1 ? { launch: { runtimeDescriptorV1: terminalPresentation.runtimeDescriptorV1 } } : {}),
                });
            if (runnerAgentSessionBootstrap) {
                launchResourceScope.register(
                    runnerAgentSessionBootstrap.cleanupBootstrapFile,
                );
            }
            const optionsWithProviderIsolation = {
                ...daemonProviderLaunch.options, directory,
                ...(terminalPresentation.runtimeDescriptorV1 ? { runtimeDescriptorV1: terminalPresentation.runtimeDescriptorV1 } : {}),
                ...(terminalPresentation.environmentOverlay ? { environmentVariables: {
                    ...daemonProviderLaunch.options.environmentVariables,
                    ...terminalPresentation.environmentOverlay,
                } } : {}),
                directoryKind: options.directoryKind,
                ...(options.sessionCreationTag ? { sessionCreationTag: options.sessionCreationTag } : {}),
                ...(options.attachMetadataIdentityPolicy ? { attachMetadataIdentityPolicy: options.attachMetadataIdentityPolicy } : {}),
            };
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

            // Direct Team launch material is disclosed only to an existing
            // Session carrying its Home-accepted Team binding (lane 10 child 06
            // L10D-R11, §15; child 01 principle 3). Such a fresh launch commits
            // its Session here, through the runner's own create-or-load owner,
            // and from then on is an attach to that exact Session.
            let launchExistingSessionId = normalizedExistingSessionId;
            let launchSessionAttachPayload = sessionAttachPayload;
            let launchOptions: SpawnSessionOptions = optionsWithProviderIsolation;
            let committedLaunchSession: CommittedDaemonLaunchSession | null = null;
            if (!await isRequesterLaunchAdmissionCurrent(options)) return await refuseSpawn({
                type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
                errorMessage: 'Requester Machine admission unavailable',
            });
            if (
                !normalizedExistingSessionId
                && daemonLaunchRequiresCommittedSession(optionsWithProviderIsolation)
            ) {
                const committed = await commitDaemonLaunchSession({
                    ...(requesterRuntime ? { accountSettings: requesterRuntime.readAccountSettingsSnapshot().settings } : {}),
                    api: params.api,
                    credentials: params.credentials,
                    options: optionsWithProviderIsolation,
                    directory,
                    ...(agentModeId ? { agentModeId } : {}),
                    ...(typeof agentModeUpdatedAt === 'number' ? { agentModeUpdatedAt } : {}),
                });
                if (!committed.ok) return await refuseSpawn(committed.result);
                committedLaunchSession = committed.session;
                launchExistingSessionId = committed.session.sessionId;
                launchSessionAttachPayload = committed.session.attachPayload;
                launchOptions = committed.session.options;
                if (committed.session.created) {
                    const committedSessionId = committed.session.sessionId;
                    launchResourceScope.register({
                        // A launch refused before its runner started leaves no
                        // Session behind; once submitted, the runner owns it.
                        onFailure: async () => {
                            if (childLaunchSubmitted) return;
                            await archiveSessionOnceInactive({
                                token: params.credentials.token,
                                sessionId: committedSessionId,
                            }).catch(() => undefined);
                        },
                        onExit: () => undefined,
                    });
                }
            }

            if (requesterRuntime) {
                const tag = launchOptions.sessionCreationTag;
                const custody = normalizedExistingSessionId
                    && requesterRuntime.bootstrap.getBoundSessionId() === normalizedExistingSessionId
                    ? await requesterRuntime.bootstrap.bindExistingSession(normalizedExistingSessionId)
                    : launchExistingSessionId && tag
                      ? await requesterRuntime.bootstrap.bindSession(launchExistingSessionId, tag) : null;
                if (!custody) return await refuseSpawn({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
                    errorMessage: 'Requester Session custody unavailable' });
                launchOptions = { ...launchOptions, requesterSessionCredentialFile: custody.path };
                launchResourceScope.register({ onFailure: custody.cleanup, onExit: () => requesterRuntime.dispose() });
            }

            const connectedServices = await prepareDaemonConnectedServices({
                ...(requesterRuntime ? { accountSettingsSnapshot: requesterRuntime.readAccountSettingsSnapshot(),
                    activeServerDir: requesterRuntime.activeServerDir,
                    connectedAccountsOwner: requesterRuntime.connectedAccountsOwner,
                    qualifiedConnectedAccountApi: requesterRuntime.qualifiedConnectedAccountApi,
                    isAccountRuntimeCurrent: requesterRuntime.bootstrap.savedSecretOperationContext.isCurrent,
                } : {}),
                options: launchOptions,
                normalizedExistingSessionId: launchExistingSessionId,
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
                            // The composed snapshot carries purposes and bindings only;
                            // direct Team material origins come from the Agent snapshot alone.
                            ...(agentPurposeBindingSnapshot?.directMaterialOrigins?.length
                                ? { directMaterialOrigins: agentPurposeBindingSnapshot.directMaterialOrigins }
                                : {}),
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
                                parentSessionId: canonicalSessionId,
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
                admittedTerminalRequest: selectedTerminalRequest,
                profileEnvironmentVariables: { ...profileLaunchEnvironment, ...terminalPresentation.environmentOverlay },
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
            // A committed Session was created with its initial access; the
            // attaching runner receives none of the fresh-creation fields.
            const initialAccessFile = effectiveOptionsForSpawn.initialAccess === undefined
                || committedLaunchSession
                ? undefined
                : await createSessionInitialAccessFile(configuration.happyHomeDir, effectiveOptionsForSpawn.initialAccess);
            if (initialAccessFile) launchResourceScope.register(initialAccessFile.cleanup);
            const spawnLifecycle = await prepareDaemonSpawnLifecycle({
                ...(requesterRuntime ? { requesterSessionRuntimeContext: requesterRuntime } : {}),
                onTrackedSessionRegistered: params.onTrackedSessionRegistered,
                runnerAgentSessionBootstrap,
                normalizedExistingSessionId: launchExistingSessionId,
                spawnNonce: effectiveOptionsForSpawn.spawnNonce,
                sessionAttachPayload: launchSessionAttachPayload ?? null,
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
                    connectedServiceAuth !== null,
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

            if (!await isRequesterLaunchAdmissionCurrent(options)) return await refuseSpawn({
                type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
                errorMessage: 'Requester Machine admission unavailable',
            });
            if (options.beforeSessionRunnerLaunch && !await options.beforeSessionRunnerLaunch()) return await refuseSpawn({
                type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
                errorMessage: 'Session handoff launch custody unavailable',
            });
            childLaunchSubmitted = true;
            let spawnResult = await routeSpawnModeAndWaitForWebhook({
                initialAccessFilePath: initialAccessFile?.path,
                terminalRequest,
                terminalPresentation,
                directory,
                options: committedLaunchSession
                    ? withoutFreshSessionCreationFields(effectiveOptionsForSpawn)
                    : effectiveOptionsForSpawn,
                trackedSpawnOptions,
                normalizedExistingSessionId: launchExistingSessionId,
                ...(committedLaunchSession?.sessionCreationOutcome
                    ? { sessionCreationOutcome: committedLaunchSession.sessionCreationOutcome }
                    : {}),
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
                takeoverAdmission: takeoverAdmission ?? undefined,
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
                onUntrackedHostedChild: () => {
                    retainResourcesForUntrackedHostedChild = true;
                },
            });
            if (spawnResult.type === 'success' && spawnResult.sessionId && managedAllocation && managedDirectoryOwner) {
                try {
                    await managedDirectoryOwner.bind({ allocationId: managedAllocation.allocationId, sessionId: spawnResult.sessionId });
                } catch (error) {
                    // Admission already succeeded. Retain its owner record for
                    // startup tag reconciliation and preserve the true result.
                    logger.warn('[DAEMON RUN] Managed directory binding remains pending', {
                        allocationId: managedAllocation.allocationId, sessionId: spawnResult.sessionId, error,
                    });
                }
            }
            if (spawnResult.type === 'error' && !retainResourcesForUntrackedHostedChild) {
                if (isDefiniteSpawnPreAdmissionRejection(spawnResult.errorCode)) await rollbackManagedAllocation();
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
            if (!providerBindingAttempt && !retainResourcesForUntrackedHostedChild) {
                await pluginRuntimeLease.release();
            }
            return spawnResult;
        } catch (error) {
            if (!childLaunchSubmitted) await rollbackManagedAllocation();
            const terminalDetail = readSessionCreationTerminalSpawnErrorDetail(error)
                ?? resolveTerminalHostUnavailableSpawnErrorDetail(error);
            const errorMessage = launchResourceScope.sanitize(error);
            let incompleteRetirement: string | null = null;
            if (!retainResourcesForUntrackedHostedChild) {
                incompleteRetirement =
                    await retireLaunchResources();
            }
            logger.debug('[DAEMON RUN] Session spawn failed after startup preparation', {
                error: errorMessage,
            });
            return {
                type: 'error',
                errorCode: terminalDetail && !incompleteRetirement
                    ? SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED
                    : SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
                ...(terminalDetail && !incompleteRetirement ? { errorDetail: terminalDetail } : {}),
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
    } finally {
        takeoverAdmission?.cancel();
    }
}
