import type { CatalogAgentId } from '@/agent/catalog/ids';
import { configuration } from '@/configuration';
import { HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1_ENV_KEY } from '@/plugins/runtime/providerBindings/handoff';
import {
    serializeProviderBindingLaunchHandoffForEnv,
    type ProviderBindingLaunchHandoffV1,
} from '@/plugins/runtime/providerBindings/handoff';
import {
    HAPPIER_SESSION_STARTUP_SPAWN_NONCE_ENV_KEY,
    resolveAbsentSessionControlEnvKeys,
} from '@/session/runtime/control/sessionControlEnvironment';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { normalizeUnsetEnvKeys } from '@/utils/processEnv/buildScopedProcessEnv';
import type { ConnectedServiceMaterializationIdentityV1 } from '@happier-dev/protocol';
import type {
    DaemonSpawnStartupReadinessFailure,
} from '../types';

import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServices/connectedServiceChildEnvironment';
import type { ConnectedServiceQuotasCoordinator } from '../connectedServices/quotas/ConnectedServiceQuotasCoordinator';
import type { ConnectedServiceRefreshCoordinator } from '../connectedServices/refresh/ConnectedServiceRefreshCoordinator';
import type { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { createSessionAttachFile } from '../sessionAttachFile';
import { createSpawnLifecycleCallbacks } from './createSpawnLifecycleCallbacks';
import type {
    prepareRunnerAgentSessionBootstrapForLease,
} from './prepareAgentRuntimeSessionBridge';
import { resolveStackProcessKindOverrideForSessionSpawn } from './resolveStackProcessKindOverrideForSessionSpawn';
import { persistAcceptedSpawnMarker } from './persistAcceptedSpawnMarker';
import type { DeviceLocalSecretStorage } from '../deviceLocalSecretStorage';

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
    runnerAgentSessionBootstrap: Awaited<ReturnType<
        typeof prepareRunnerAgentSessionBootstrapForLease
    >>;
    normalizedExistingSessionId: string;
    /** One-shot daemon attempt correlation returned only through startup control. */
    spawnNonce?: string;
    sessionAttachPayload: Parameters<typeof createSessionAttachFile>[0]['payload'] | null;
    extraEnv: Record<string, string>;
    extraEnvForChild: Record<string, string>;
    providerBindingLaunchHandoff: ProviderBindingLaunchHandoffV1 | null;
    unsetEnvKeys?: readonly string[];
    processEnv: NodeJS.ProcessEnv;
    effectiveConnectedServicesBindings: SpawnSessionOptions['connectedServices'];
    connectedServiceSelectionsEnv?: Readonly<Record<string, string>>;
    catalogAgentId: CatalogAgentId | null;
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
    deviceLocalSecretStorage?: DeviceLocalSecretStorage;
}>): Promise<Readonly<{
    extraEnvForChildWithMessage: Record<string, string>;
    unsetEnvKeys: readonly string[];
    runnerAgentSessionBootstrapAuthorization:
        NonNullable<Awaited<ReturnType<
            typeof prepareRunnerAgentSessionBootstrapForLease
        >>>['authorization'] | null;
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

    const runnerAgentSessionBootstrap =
        input.runnerAgentSessionBootstrap;
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
        ...(typeof input.spawnNonce === 'string' && input.spawnNonce.trim()
            ? { [HAPPIER_SESSION_STARTUP_SPAWN_NONCE_ENV_KEY]: input.spawnNonce.trim() }
            : {}),
        ...(runnerAgentSessionBootstrap
            ? runnerAgentSessionBootstrap.childEnv
            : {}),
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
            if (!input.deviceLocalSecretStorage) {
                throw new Error('Device-local secret storage is unavailable for accepted spawn custody');
            }
            await persistAcceptedSpawnMarker({
                trackedSession,
                deviceLocalSecretStorage: input.deviceLocalSecretStorage,
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
        },
    });

    return {
        extraEnvForChildWithMessage,
        unsetEnvKeys,
        runnerAgentSessionBootstrapAuthorization:
            runnerAgentSessionBootstrap?.authorization ?? null,
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
