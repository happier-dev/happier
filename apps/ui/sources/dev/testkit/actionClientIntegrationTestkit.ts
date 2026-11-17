import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import type { RegistryKindV1 } from '@happier-dev/protocol/registries';
import { authGetTokenAtEndpoint } from '@/auth/flows/getToken';
import { encodeBase64 } from '@/encryption/base64';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { readMachineActivity } from '@/sync/domains/machines/machineActivity';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { disconnectActiveServerConnection, restoreConnectionToActiveServer } from '@/sync/runtime/orchestration/connectionManager';
import { loadSyncSingletonForTests } from './harness/syncSingletonLoader';
import { createPublishedHomeOutputFetch } from './machineClientEnrollmentOutputFixture';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
export { allowRealServerSocketBoundary as allowRealActionServerSocketBoundary } from './harness/serverAccountConnectionHarness';
export { createMachineClientEnrollmentOutputFixture } from './machineClientEnrollmentOutputFixture';
export { createAccountOutputFixture } from './machineAccountOutputContractFixture';
export { createUiMachineOutputFixture } from './machinesOutputContractFixture';

/** Real UI client for cross-app journeys; only the platform lock API is substituted. */
export async function connectUiActionClient(params: Readonly<{ serverUrl: string; publicEndpoint?: string; addressAnchorUrl?: string; credentials: AuthCredentials }>) {
    const locks = installWebLockManagerMock();
    // A recording proxy carries the Home's bytes; it is not another Home profile.
    const profileUrl = params.addressAnchorUrl ?? params.serverUrl;
    const forwardedOrigin = params.addressAnchorUrl ?? params.publicEndpoint;
    if (forwardedOrigin) setRuntimeFetch(createPublishedHomeOutputFetch({
        publishedOrigin: forwardedOrigin, loopbackUrl: params.serverUrl }));
    let bridge: Awaited<ReturnType<typeof loadSyncSingletonForTests>> | undefined;
    const close = async () => {
        try {
            if (bridge) await disconnectActiveServerConnection();
        } finally {
            try { await bridge?.dispose(); } finally {
                if (forwardedOrigin) resetRuntimeFetch();
                locks.restore();
            }
        }
    };
    try {
        const { id: configuredServerId } = await upsertServerProfile({ name: 'Composed Action client', serverUrl: profileUrl });
        if (!await TokenStorage.setCredentialsForServerUrl(profileUrl, { serverId: configuredServerId }, params.credentials)) {
            throw new Error('UI credential storage failed');
        }
        await setActiveServerId(configuredServerId, { scope: 'device' });
        if ((await getServerFeaturesSnapshot({ serverId: configuredServerId, force: true })).status !== 'ready') {
            throw new Error('UI Home discovery did not become ready');
        }
        bridge = await loadSyncSingletonForTests();
        await restoreConnectionToActiveServer(params.credentials);
        // Cold restore prepares transport; bootstrap publishes Account readiness
        // separately. A composed caller starts after that real initial read.
        await getSyncSingleton().awaitBootstrapForegroundAcquisition();
        if (!storage.getState().isDataReady) await new Promise<void>(resolve => {
            const unsubscribe = storage.subscribe(state => {
                if (!state.isDataReady) return;
                unsubscribe();
                resolve();
            });
        });
        await getSyncSingleton().refreshMachines();
        const serverId = getActiveServerSnapshot().serverId;
        const execute = createFrontDoorActionExecute(createDefaultActionExecutor());
        // Substitute only the native confirmation renderer: this facade is the
        // fixture's explicit person choosing Confirm on the carried review.
        const confirmed = createFrontDoorActionExecute(createDefaultActionExecutor({
            presentUserActionConfirmation: async () => true,
        }));
        return {
            serverId,
            execute,
            // The composed fixture supplies the designed user's explicit Confirm.
            executeConfirmed: confirmed.confirmed,
            async executeVoiceSpawn(input: unknown, effectId: string) {
                const [{ createVoiceToolHandlers }, { VOICE_ACTION_EXECUTE_TOOL_NAME }, voiceSession] = await Promise.all([
                    import('@/voice/tools/handlers'), import('@/voice/tools/voiceActionExecution'),
                    import('@/voice/session/voiceSessionStore'),
                ]);
                voiceSession.setVoiceSessionSnapshot({ adapterId: 'local_conversation', sessionId: effectId,
                    status: 'connected', mode: 'listening', canStop: true });
                try {
                    const tools = createVoiceToolHandlers({ resolveSessionId: () => null, currentServerId: serverId });
                    return await tools[VOICE_ACTION_EXECUTE_TOOL_NAME]!({ actionId: 'session.spawn_new', input },
                        { serverId, effectId, turnOrigin: 'person' });
                } finally { voiceSession.resetVoiceSessionStoreForTests(); }
            },
            isAccountReady: () => Boolean(getActiveServerAccountScope()),
            isMachineActive: (machineId: string) => {
                const machine = storage.getState().machines[machineId];
                return machine ? readMachineActivity(machine).active === true : false;
            },
            close,
        };
    } catch (error) {
        await close();
        throw error;
    }
}

/** Sign in as the person through the UI's Account flow, never a terminal bearer. */
export async function connectUiPersonActionClient(params: Readonly<{
    serverUrl: string;
    addressAnchorUrl?: string;
    accountSecret: Uint8Array;
}>): ReturnType<typeof connectUiActionClient> {
    const credentials = await authGetTokenAtEndpoint({
        endpointUrl: params.serverUrl,
        addressAnchorUrl: params.addressAnchorUrl,
        secret: params.accountSecret,
        requireKeyChallengeV2: true,
        requireExistingAccount: true,
    });
    const client = await connectUiActionClient({ serverUrl: params.serverUrl, addressAnchorUrl: params.addressAnchorUrl,
        credentials: { ...credentials, secret: encodeBase64(params.accountSecret) } });
    let unmount: (() => Promise<void>) | undefined;
    try {
        const [{ renderHook }, { createMountedCurrentUiContextWrapper }, { createElement, Fragment },
            { PluginSurfaceProjectionDemand }, { REGISTRY_SOURCE_PROJECTION_SECTIONS },
            { useRegistryListSourceSelection }, { REGISTRY_ACTION_IDS_V1, RegistryKindV1Schema }, { waitForTestEvent },
            { useAppShellPluginUiProjection }, { usePluginUiProjectionCurrentness }] = await Promise.all([
            import('./hooks/renderHook'), import('./harness/mountedCurrentUiContext'),
            import('react'), import('@/components/plugins/surfaces/PluginSurfaceProjectionDemand'),
            import('@/sync/domains/plugins/ui/projectionSections'), import('@/registries/useRegistrySourceRevision'),
            import('@happier-dev/protocol/registries'), import('./hooks/waitForTestEvent'),
            import('@/components/appShell/plugins/AppShellPluginUiProjection'),
            import('@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness'),
        ]);
        const AppShell = await createMountedCurrentUiContextWrapper({ withAppShellActions: true });
        const scope = getActiveServerAccountScope();
        const shell = await renderHook((kind: RegistryKindV1 | undefined) => {
            const projection = useAppShellPluginUiProjection();
            const currentness = usePluginUiProjectionCurrentness({ machineId: projection.machineId,
                serverId: projection.serverId, load: false });
            return { selection: useRegistryListSourceSelection(kind), hasMachine: projection.machineId !== null,
                currentness: { phase: currentness.phase,
                registrySourcesCurrent: currentness.registrySourcesCurrent, unavailableReasonCode: currentness.unavailableReasonCode } };
        }, {
            wrapper: ({ children }) => createElement(AppShell, null, createElement(Fragment, null,
                createElement(PluginSurfaceProjectionDemand, { accountScope: scope,
                    presents: 'allInstallations', sections: REGISTRY_SOURCE_PROJECTION_SECTIONS }), children)),
        });
        unmount = shell.unmount;
        const waitForRegistry = async (actionId: string, input: unknown) => {
            if (REGISTRY_ACTION_IDS_V1.some(id => id === actionId)) {
                // Foreground bootstrap need not acquire optional Availability;
                // this presented registry surface joins its real producer.
                await getSyncSingleton().refreshPluginAccountAvailability();
                const kind = RegistryKindV1Schema.safeParse(input && typeof input === 'object' && 'kind' in input ? input.kind : undefined);
                await shell.rerender(kind.success ? kind.data : undefined);
                const settled = await waitForTestEvent(shell.subscribe, shell.getCurrent, value => !value.selection.resolving
                    && (!value.hasMachine || value.currentness.registrySourcesCurrent === true || value.currentness.phase !== 'establishing'));
                if (settled.hasMachine && settled.currentness.registrySourcesCurrent !== true && settled.currentness.phase !== 'current') {
                    throw new Error(`Person registry fixture projection ${settled.currentness.phase}: ${settled.currentness.unavailableReasonCode}`);
                }
            }
        };
        const execute: typeof client.execute = async (...args) => {
            await waitForRegistry(args[0], args[1]);
            return client.execute(...args);
        };
        const executeConfirmed: typeof client.executeConfirmed = async (...args) => {
            await waitForRegistry(args[0], args[1]);
            return client.executeConfirmed(...args);
        };
        return { ...client, execute, executeConfirmed, async close() {
            try { await unmount?.(); } finally { await client.close(); }
        } };
    } catch (error) {
        try { await unmount?.(); } finally { await client.close(); }
        throw error;
    }
}
