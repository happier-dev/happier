import type { CatalogAgentId } from '@/agent/catalog/ids';
import { configuration } from '@/configuration';
import { HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY } from '@/plugins/runtime/providerBindings/handoff';
import {
    serializeProviderBindingLaunchHandoffForEnv,
    type ProviderBindingLaunchHandoffV1,
} from '@/plugins/runtime/providerBindings/handoff';
import type { ProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import { resolveAbsentSessionControlEnvKeys } from '@/session/runtime/control/sessionControlEnvironment';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { normalizeUnsetEnvKeys } from '@/utils/processEnv/buildScopedProcessEnv';
import type {
    AccountScopedCryptoMaterial,
    BackendTargetRefV2,
    ConnectedServiceMaterializationIdentityV1,
} from '@happier-dev/protocol';
import type {
    ManagedLocalServiceRunAttachmentMarkerOwnership,
    ManagedLocalServiceRunAttachmentV1,
} from '../sessionRegistry';
import type {
    DaemonSpawnStartupReadinessFailure,
    TrackedSession,
} from '../types';

import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServices/connectedServiceChildEnvironment';
import type { ConnectedServiceQuotasCoordinator } from '../connectedServices/quotas/ConnectedServiceQuotasCoordinator';
import type { ConnectedServiceRefreshCoordinator } from '../connectedServices/refresh/ConnectedServiceRefreshCoordinator';
import type { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { createSessionAttachFile } from '../sessionAttachFile';
import { createSpawnLifecycleCallbacks } from './createSpawnLifecycleCallbacks';
import { preparePluginLocalServicesBridge } from './preparePluginLocalServicesBridge';
import { prepareAgentRuntimeSessionBridge } from './prepareAgentRuntimeSessionBridge';
import type { SpawnPluginRuntimeLease } from './spawnPluginRuntimeLease';
import { resolveStackProcessKindOverrideForSessionSpawn } from './resolveStackProcessKindOverrideForSessionSpawn';
import { persistAcceptedSpawnMarker } from './persistAcceptedSpawnMarker';

type SpawnResourceCleanup = () => void | Promise<void>;

function buildDaemonOwnedSpawnChildEnv(): Record<string, string> {
    return {
        HAPPIER_HOME_DIR: configuration.happyHomeDir,
        HAPPIER_ACTIVE_SERVER_ID: configuration.activeServerId,
        HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID:
            String(process.env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID ?? '').trim()
            || configuration.activeServerId,
        HAPPIER_SERVER_URL: configuration.serverUrl,
        HAPPIER_LOCAL_SERVER_URL: configuration.apiServerUrl,
        HAPPIER_PUBLIC_SERVER_URL: configuration.publicServerUrl,
        HAPPIER_WEBAPP_URL: configuration.webappUrl,
    };
}

export async function prepareDaemonSpawnLifecycle(input: Readonly<{
    effectiveBackendTarget: BackendTargetRefV2;
    pluginRuntimeLease: SpawnPluginRuntimeLease;
    launchResourceScope: ProviderLaunchResourceScope;
    normalizedExistingSessionId: string;
    sessionAttachPayload: Parameters<typeof createSessionAttachFile>[0]['payload'] | null;
    extraEnv: Record<string, string>;
    extraEnvForChild: Record<string, string>;
    providerBindingLaunchHandoff: ProviderBindingLaunchHandoffV1 | null;
    unsetEnvKeys?: readonly string[];
    processEnv: NodeJS.ProcessEnv;
    effectiveConnectedServicesBindings: SpawnSessionOptions['connectedServices'];
    connectedServiceSelectionsEnv?: Readonly<Record<string, string>>;
    catalogAgentId: CatalogAgentId;
    connectedServiceAuthSessionId?: string;
    sessionDirectory?: string;
    materializationKey: string;
    connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1;
    hasConnectedServiceAuth: boolean;
    activateConnectedAccountSessionBindingOnCanonicalSession?: (
        sessionId: string,
    ) => Promise<DaemonSpawnStartupReadinessFailure | null>;
    connectedServiceRefreshCoordinator: ConnectedServiceRefreshCoordinator | null;
    connectedServiceQuotasCoordinator: ConnectedServiceQuotasCoordinator | null;
    connectedServiceRuntimeRegistry: Pick<ConnectedServiceRuntimeRegistry, 'registerTarget'>;
    spawnResourceCleanupByPid: Map<number, SpawnResourceCleanup>;
    sessionAttachCleanupByPid: Map<number, () => Promise<void>>;
    setPendingSessionAttachCleanup: (cleanup: (() => Promise<void>) | null) => void;
    getSpawnResourceCleanupOnExit: () => SpawnResourceCleanup | null;
    onSpawnResourceCleanupArmed: () => void;
    respawnDescriptorEncryptionMaterial: AccountScopedCryptoMaterial;
    managedLocalServiceRunAttachment?: ManagedLocalServiceRunAttachmentV1;
    onManagedLocalServiceRunAttachmentPersisted?: (input: Readonly<{
        pid: number;
        ownership: ManagedLocalServiceRunAttachmentMarkerOwnership;
        attachment: ManagedLocalServiceRunAttachmentV1;
    }>) => void | Promise<void>;
    onManagedLocalServiceRunAttachmentPidPromoted?: NonNullable<
        TrackedSession['onManagedLocalServiceMarkerPidPromoted']
    >;
}>): Promise<Readonly<{
    extraEnvForChildWithMessage: Record<string, string>;
    unsetEnvKeys: readonly string[];
    localServicesBridgeAuthorization: Awaited<ReturnType<typeof preparePluginLocalServicesBridge>>['authorization'];
    agentRuntimeSessionBridgeAuthorization:
        NonNullable<Awaited<ReturnType<typeof prepareAgentRuntimeSessionBridge>>>['authorization'] | null;
    spawnLifecycleCallbacks: ReturnType<typeof createSpawnLifecycleCallbacks>;
    cleanupPendingSessionAttach: () => Promise<void>;
}>> {
    let sessionAttachCleanup: (() => Promise<void>) | null = null;
    let sessionAttachFilePath: string | null = null;
    if (input.normalizedExistingSessionId) {
        if (!input.sessionAttachPayload) {
            throw new Error('Missing session attach payload for existing session');
        }
        const attach = await createSessionAttachFile({
            happySessionId: input.normalizedExistingSessionId,
            payload: input.sessionAttachPayload,
        });
        sessionAttachFilePath = attach.filePath;
        sessionAttachCleanup = attach.cleanup;
        input.setPendingSessionAttachCleanup(attach.cleanup);
    }

    const appliedPluginRuntimeLease = await input.pluginRuntimeLease.acquire();
    const localServicesBridge = await preparePluginLocalServicesBridge({
        target: input.effectiveBackendTarget,
        acceptedRegistry: appliedPluginRuntimeLease.registry,
    });
    input.launchResourceScope.register(localServicesBridge.cleanupTokenFile);
    const agentRuntimeSessionBridge = await prepareAgentRuntimeSessionBridge({
        target: input.effectiveBackendTarget,
        pluginRuntimeLease: input.pluginRuntimeLease,
    });
    if (agentRuntimeSessionBridge) {
        input.launchResourceScope.register(agentRuntimeSessionBridge.cleanupTokenFile);
    }
    const extraEnvForChildWithMessage = {
        ...input.extraEnvForChild,
        ...(input.providerBindingLaunchHandoff
            ? {
                [HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY]:
                    serializeProviderBindingLaunchHandoffForEnv(
                        input.providerBindingLaunchHandoff.materialization,
                        input.providerBindingLaunchHandoff.sessionBindingMetadata,
                    ),
            }
            : {}),
        ...buildDaemonOwnedSpawnChildEnv(),
        ...localServicesBridge.childEnv,
        ...(agentRuntimeSessionBridge ? agentRuntimeSessionBridge.childEnv : {}),
        ...(sessionAttachFilePath ? { HAPPIER_SESSION_ATTACH_FILE: sessionAttachFilePath } : {}),
        ...resolveStackProcessKindOverrideForSessionSpawn(input.processEnv),
    };
    const unsetEnvKeys = normalizeUnsetEnvKeys([
        ...(input.unsetEnvKeys ?? []),
        ...resolveAbsentSessionControlEnvKeys(extraEnvForChildWithMessage),
    ]);
    const spawnLifecycleCallbacks = createSpawnLifecycleCallbacks({
        connectedServicesBindingsRaw: input.effectiveConnectedServicesBindings,
        connectedServiceSelectionsEnvRaw: input.extraEnvForChild[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY],
        connectedServiceSelectionsEnv: input.connectedServiceSelectionsEnv,
        catalogAgentId: input.catalogAgentId,
        ...(input.connectedServiceAuthSessionId ? { sessionId: input.connectedServiceAuthSessionId } : {}),
        sessionDirectory: input.sessionDirectory,
        materializationKey: input.materializationKey,
        ...(input.connectedServiceMaterializationIdentityV1
            ? { connectedServiceMaterializationIdentityV1: input.connectedServiceMaterializationIdentityV1 }
            : {}),
        hasConnectedServiceAuth: () => input.hasConnectedServiceAuth,
        ...(input.activateConnectedAccountSessionBindingOnCanonicalSession
            ? {
                activateConnectedAccountSessionBindingOnCanonicalSession:
                    input.activateConnectedAccountSessionBindingOnCanonicalSession,
            }
            : {}),
        registerConnectedServiceRefreshTarget: (target) =>
            input.connectedServiceRefreshCoordinator?.registerSpawnTarget(target),
        registerConnectedServiceQuotaTarget: (target) =>
            input.connectedServiceQuotasCoordinator?.registerSpawnTarget({
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
        registerConnectedServiceRuntimeTarget: (target) => {
            input.connectedServiceRuntimeRegistry.registerTarget(target);
        },
        getSpawnResourceCleanupOnExit: input.getSpawnResourceCleanupOnExit,
        onSpawnResourceCleanupArmed: input.onSpawnResourceCleanupArmed,
        spawnResourceCleanupByPid: input.spawnResourceCleanupByPid,
        getSessionAttachCleanup: () => sessionAttachCleanup,
        setSessionAttachCleanup: (cleanup) => {
            sessionAttachCleanup = cleanup;
            input.setPendingSessionAttachCleanup(cleanup);
        },
        sessionAttachCleanupByPid: input.sessionAttachCleanupByPid,
        persistAcceptedSpawnMarker: async (
            trackedSession,
            options,
        ) => {
            if (input.managedLocalServiceRunAttachment) {
                trackedSession.managedLocalServiceRunAttachment =
                    input.managedLocalServiceRunAttachment;
                trackedSession.onManagedLocalServiceMarkerPidPromoted =
                    input.onManagedLocalServiceRunAttachmentPidPromoted;
            }
            await persistAcceptedSpawnMarker({
                trackedSession,
                encryptionMaterial: input.respawnDescriptorEncryptionMaterial,
                ...(input.managedLocalServiceRunAttachment
                    ? {
                        managedLocalServiceRunAttachment:
                            input.managedLocalServiceRunAttachment,
                    }
                    : {}),
                ...(options?.processPid !== undefined
                    ? { processPid: options.processPid }
                    : {}),
                ...(options?.expectedProcessIdentity
                    ? {
                        expectedProcessIdentity:
                            options.expectedProcessIdentity,
                    }
                    : {}),
            });
            if (
                input.managedLocalServiceRunAttachment
                && trackedSession.processCommandHash
                && trackedSession.processStartTimeMs !== undefined
            ) {
                const markerPid =
                    options?.processPid
                    ?? trackedSession.pid;
                await input.onManagedLocalServiceRunAttachmentPersisted?.({
                    pid: markerPid,
                    ownership: {
                        happySessionId:
                            trackedSession.happySessionId?.trim()
                            || `PID-${markerPid}`,
                        processCommandHash: trackedSession.processCommandHash,
                        processStartTimeMs: trackedSession.processStartTimeMs,
                    },
                    attachment: input.managedLocalServiceRunAttachment,
                });
            }
        },
    });

    return {
        extraEnvForChildWithMessage,
        unsetEnvKeys,
        localServicesBridgeAuthorization: localServicesBridge.authorization,
        agentRuntimeSessionBridgeAuthorization:
            agentRuntimeSessionBridge?.authorization ?? null,
        spawnLifecycleCallbacks,
        cleanupPendingSessionAttach: async () => {
            if (!sessionAttachCleanup) return;
            const cleanup = sessionAttachCleanup;
            sessionAttachCleanup = null;
            input.setPendingSessionAttachCleanup(null);
            await cleanup();
        },
    };
}
