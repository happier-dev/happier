import { vi } from 'vitest';
import { Modal } from '@/modal';
import { createModalModuleMock } from './mocks/modal';
import * as nativeTransfer from '@/utils/platform/tauri/transferFetch';
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
import { selectHomeQualifiedSession } from '@/sync/domains/session/selectHomeQualifiedSession';
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
export { mountUiRetainedProjectTerminal } from './projectTerminalPresentationIntegrationTestkit';
export { installBundledPluginUiArtifactsForTests, installBundledPluginUiDeclarationsForTests } from './mocks/bundledPluginUiAssets';
export { prepareAuthenticationInventory } from './fixtures/connectedAccountAuthentication';
export type { BundledPluginUiAppArtifactInventory, PluginHostBundledUiDeclaration } from '@/sync/domains/plugins/availability/bundledPluginUiArtifactInventory';

/** Native desktop HTTP and the person's answer are physical platform boundaries. */
export function installPersonTransientConfirmationBoundary(): () => void {
    const boundary = createModalModuleMock({ confirmResult: true });
    const show = vi.spyOn(Modal, 'show').mockImplementation(boundary.module.Modal.show);
    const transfer = vi.spyOn(nativeTransfer, 'resolveTauriRuntimeFetch').mockResolvedValue(
        (input, init) => globalThis.fetch(input, init),
    );
    return () => { transfer.mockRestore(); show.mockRestore(); };
}

/** Mount the actual managed detail surface after restoring the journey's Account. */
export async function mountUiManagedMachineDetail(params: Readonly<{ serverId: string; managedId: string }>) {
    const [{ createElement }, { ManagedMachineDetail }, { renderMountedCurrentUiContext }] = await Promise.all([
        import('react'), import('@/components/settings/machines/managed/ManagedMachineDetail'),
        import('./harness/mountedCurrentUiContext'),
    ]);
    const screen = await renderMountedCurrentUiContext(createElement(ManagedMachineDetail, params));
    return {
        readControls: () => ({
            delete: screen.findByTestId('managed-machine.delete') !== null,
            stop: screen.findByTestId('managed-machine.stop') !== null,
            remove: screen.findByTestId('managed-machine.remove') !== null,
        }),
        close: screen.unmount,
    };
}

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
        await setActiveServerId(configuredServerId, { scope: 'device' });
        const discovery = await getServerFeaturesSnapshot({ serverId: configuredServerId, force: true });
        if (discovery.status !== 'ready') {
            throw new Error(`UI Home discovery did not become ready (${discovery.status}: ${discovery.reason}${
                discovery.status === 'error' && discovery.httpStatus !== undefined ? `, HTTP ${discovery.httpStatus}` : ''})`);
        }
        // Discovery learns the Home's stable credential scope before this sign-in
        // replaces it. Device reset can remove profiles while native credentials remain.
        if (!await TokenStorage.setCredentialsForServerUrl(profileUrl, { serverId: configuredServerId }, params.credentials)) {
            throw new Error('UI credential storage failed');
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
            // An initial press lets the receiving owner supply its exact review
            // before the fixture's person confirms through the real UI executor.
            executePresented: confirmed,
            async submitSessionMessage(sessionId: string, text: string) {
                const [{ submitAppSessionComposerMessage }, { createSyncBackedSubmitPort },
                    { captureActiveServerAccountScopeLifetime }, { getPermissionModeOverrideForSpawn }] = await Promise.all([
                    import('@/components/sessions/transcript/source/appSessionTranscriptActions'),
                    import('@/sync/domains/session/input/syncBackedSubmitPort'),
                    import('@/sync/domains/scope/activeServerAccountScope'),
                    import('@/sync/domains/permissions/permissionModeOverride'),
                ]);
                const visible = await getSyncSingleton().ensureSessionVisibleForMessageRoute(sessionId,
                    { serverId, forceRefresh: true, hydrateMessages: false });
                const session = selectHomeQualifiedSession(storage.getState(), sessionId, serverId, serverId);
                const accountLifetime = captureActiveServerAccountScopeLifetime();
                if (visible.kind !== 'available' || !session || !accountLifetime) {
                    throw new Error('Composer Session Account unavailable');
                }
                const settings = storage.getState().settings;
                return await submitAppSessionComposerMessage(createSyncBackedSubmitPort(), {
                    sessionId, session, text, serverId, accountLifetime,
                    configuredMode: settings.sessionMessageSendMode,
                    busySteerSendPolicy: settings.sessionBusySteerSendPolicy,
                    sessionInactiveResumePolicy: settings.sessionInactiveResumePolicy,
                    resumeCapabilityOptions: { accountSettings: settings },
                    permissionOverride: getPermissionModeOverrideForSpawn(session),
                    callerSurface: 'session_composer',
                });
            },
            async readDeploymentReceipt(environmentId: string, deploymentId: string) {
                const [{ captureLazyActionAccountContext }, { createDeploymentReadTransport }] = await Promise.all([
                    import('@/sync/ops/actions/actionAccountContext'),
                    import('@/components/projects/deployments/deploymentReadTransport'),
                ]);
                const account = await captureLazyActionAccountContext(serverId);
                try {
                    return await createDeploymentReadTransport(account.accountLifetime).readReceipt(
                        account.accountLifetime.scope, environmentId, deploymentId, { signal: new AbortController().signal });
                } finally { account.dispose(); }
            },
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
            readSessionAgentState: (sessionId: string) => selectHomeQualifiedSession(storage.getState(),
                sessionId, serverId, serverId)?.agentState ?? null,
            isMachineActive: (machineId: string) => {
                const machine = storage.getState().machines[machineId];
                return machine ? readMachineActivity(machine).active === true : false;
            },
            // ApiMachine publishes running only after core registration ACKs
            // and its operation-capability publication have completed.
            isMachineControlReady: (machineId: string) => {
                const machine = storage.getState().machines[machineId];
                return Boolean(machine && readMachineActivity(machine).active === true && machine.daemonState?.status === 'running');
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
        const AppShell = await createMountedCurrentUiContextWrapper({ withAppShellActions: true, withAccountLifecycle: true });
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
        const execute: typeof client.execute = Object.assign(async (...args: Parameters<typeof client.execute>) => {
            await waitForRegistry(args[0], args[1]);
            return client.execute(...args);
        }, { prepare: client.execute.prepare, confirmed: client.execute.confirmed });
        const executeConfirmed: typeof client.executeConfirmed = async (...args) => {
            await waitForRegistry(args[0], args[1]);
            return client.executeConfirmed(...args);
        };
        const executePresented: typeof client.executePresented = Object.assign(async (...args: Parameters<typeof client.executePresented>) => {
            await waitForRegistry(args[0], args[1]);
            return client.executePresented(...args);
        }, { prepare: client.executePresented.prepare, confirmed: client.executePresented.confirmed });
        return { ...client, execute, executeConfirmed, executePresented, async close() {
            try { await unmount?.(); } finally { await client.close(); }
        } };
    } catch (error) {
        try { await unmount?.(); } finally { await client.close(); }
        throw error;
    }
}

/** Press the deployment editor's fresh Connect against the journey's actual Home Account. */
export async function connectFreshVercelThroughDeploymentUi(params: Readonly<{
    serverUrl: string;
    credentials: AuthCredentials;
    teamId: string;
    token: string;
    providerFetch: typeof globalThis.fetch;
}>) {
    const [{ createElement }, { act }, { expect, vi }, { Asset }, { File },
        { prepareAuthenticationInventory }, assets] = await Promise.all([
        import('react'), import('react-test-renderer'), import('vitest'), import('expo-asset'), import('expo-file-system'),
        import('./fixtures/connectedAccountAuthentication'), import('./mocks/bundledPluginUiAssets'),
    ]);
    const packaged = { artifacts: [] as unknown[], declarations: [] as unknown[], files: new Map<number, Uint8Array>(), reads: 0 };
    const [{ PLUGIN_MANIFEST }, { plugin: deploymentPlugin }] = await Promise.all([
        import('../../../../../packages/plugins/machine-vercel/src/manifest'),
        import('../../../../../packages/plugins/deploy-vercel/src/manifest'),
    ]);
    const authentication = PLUGIN_MANIFEST.contributes.connectedAccountDescriptors.find(descriptor => descriptor.id === 'vercel-account')?.authentication.account;
    if (!authentication) throw new Error('Vercel portable Account authentication declaration missing');
    await prepareAuthenticationInventory(packaged, { manifest: PLUGIN_MANIFEST,
        target: authentication, projectPath: 'packages/plugins/machine-vercel',
        entryPath: 'packages/plugins/machine-vercel/src/account.ts', packageName: '@happier-dev/plugins-machine-vercel' });
    await prepareAuthenticationInventory(packaged, { manifest: deploymentPlugin.manifest,
        target: { artifactId: 'account-runtime', exportName: 'activateAccount' }, projectPath: 'packages/plugins/deploy-vercel',
        entryPath: 'packages/plugins/deploy-vercel/src/account.ts', packageName: '@happier-dev/plugins-deploy-vercel' });
    // The compiler fixture's unknown arrays cross only this physical app-package boundary.
    const restoreArtifacts = assets.installBundledPluginUiArtifactsForTests(packaged.artifacts as import('@/sync/domains/plugins/availability/bundledPluginUiArtifactInventory').BundledPluginUiAppArtifactInventory);
    const restoreDeclarations = assets.installBundledPluginUiDeclarationsForTests(packaged.declarations as readonly import('@/sync/domains/plugins/availability/bundledPluginUiArtifactInventory').PluginHostBundledUiDeclaration[]);
    const originalAsset = Asset.fromModule;
    const localFiles = [...packaged.files].map(([id, bytes]) => {
        const file = new File(`file:///deployment-connect-${id}.js`);
        file.write(bytes);
        return file;
    });
    const assetBoundary = vi.spyOn(Asset, 'fromModule').mockImplementation(asset => {
        if (typeof asset !== 'number' || !packaged.files.has(asset)) return originalAsset(asset);
        const uri = `file:///deployment-connect-${asset}.js`;
        const result = Asset.fromURI(uri);
        result.localUri = uri;
        result.downloaded = true;
        return result;
    });
    let closeClient: (() => Promise<void>) | undefined;
    let disposeAccount: (() => void) | undefined;
    let unmountScreen: (() => Promise<void>) | undefined;
    try {
        const client = await connectUiActionClient({ serverUrl: params.serverUrl, credentials: params.credentials });
        closeClient = client.close;
        const nativeFetch = globalThis.fetch.bind(globalThis);
        setRuntimeFetch((input, init) => new URL(input instanceof Request ? input.url : String(input)).hostname === 'api.vercel.com'
            ? params.providerFetch(input, init) : nativeFetch(input, init));
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(client.serverId);
        disposeAccount = account.dispose;
        const [{ renderScreen }, { InjectedAuthProvider }, { AppShellPluginUiProjectionProvider }, { ModalProvider, Modal },
            { showDeploymentPlatformTargetSheet }, { createDeploymentActions }, { ConnectedAccountPurposeTargetChooser }, { waitForTestEvent }, { SurfaceStateCard }] = await Promise.all([
            import('./render/renderScreen'), import('@/auth/context/AuthContext'),
            import('@/components/appShell/plugins/AppShellPluginUiProjection'), import('@/modal'),
            import('@/components/projects/deployments/DeploymentPlatformTargetSheet'),
            import('@/components/projects/deployments/deploymentActions'),
            import('@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser'),
            import('./hooks/waitForTestEvent'),
            import('@/components/ui/surfaces/SurfaceStateCard'),
        ]);
        const screen = await renderScreen(createElement(InjectedAuthProvider, { credentials: params.credentials,
            children: createElement(AppShellPluginUiProjectionProvider, { children: createElement(ModalProvider) }) }));
        unmountScreen = async () => { await act(async () => Modal.hideAll()); await screen.unmount(); };
        await act(async () => showDeploymentPlatformTargetSheet({ name: 'First Vercel app',
            environment: { id: 'fresh-environment', revision: 1, projectSourceId: '' }, ownerAccountId: account.accountId,
            lifetime: account.accountLifetime, actions: createDeploymentActions(account.accountLifetime, ''),
            onApproval: () => {}, initialTargetKey: 'happier.deploy.vercel/runtime' }));
        await waitForTestEvent(screen.subscribe, () => expect(screen.findHostByTestId('project-deployments.platform.connect.add'), screen.getTextContent()).not.toBeNull());
        await screen.pressByTestIdAsync('project-deployments.platform.connect.add');
        await waitForTestEvent(screen.subscribe, () => expect(screen.findHostByTestId('connected-account-configuration:teamId'), screen.getTextContent()).not.toBeNull());
        await act(async () => {
            screen.changeTextByTestId('connected-account-configuration:teamId', params.teamId);
            screen.changeTextByTestId('connected-account-manual:token', params.token);
        });
        await waitForTestEvent(screen.subscribe, () => expect(screen.findHostByTestId('connected-account-manual:submit')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('connected-account-manual:submit');
        const { QualifiedConnectedAccountRefSchema } = await import('@happier-dev/protocol/connect/qualified-connected-account-persistence');
        let connected: import('@happier-dev/protocol/connect/qualified-connected-account-persistence').QualifiedConnectedAccountRef | undefined;
        await waitForTestEvent(screen.subscribe, () => {
            const refusal = screen.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'connected-account:error');
            if (refusal) throw new Error(`Fresh Vercel Connect refused: ${String(refusal.props.diagnosticCode)} (${String(refusal.props.diagnosticDetail ?? 'no requestId')})`);
            const selected = screen.findAllByType(ConnectedAccountPurposeTargetChooser).map(node => node.props.value)
                .find(value => value?.kind === 'account');
            expect(selected, screen.getTextContent()).toBeDefined();
            connected = QualifiedConnectedAccountRefSchema.parse(selected.account);
        });
        expect(screen.findHostByTestId('project-deployments.platform.connect')).toBeNull();
        expect(screen.findHostByTestId('project-deployments.platform.check')).not.toBeNull();
        if (!connected) throw new Error('Platform editor did not retain the connected credential');
        return connected;
    } finally {
        await unmountScreen?.();
        disposeAccount?.();
        await closeClient?.();
        resetRuntimeFetch();
        assetBoundary.mockRestore();
        restoreDeclarations();
        restoreArtifacts();
        for (const file of localFiles) file.delete();
    }
}

/** Submit the mounted New Session action with the same manual custody completion as the UI. */
export async function submitUiSessionSpawnNew(params: Readonly<{
    serverUrl: string;
    addressAnchorUrl?: string;
    accountSecret: Uint8Array;
    input: import('@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2').SessionSpawnNewInputV2;
    machineHomeDir: string;
    userAttemptId: string;
}>) {
    const [{ getActiveServerAccountScope }, {
        buildManualSessionCreationKey, completeManualSessionSpawnNewActionCustody, executeManualSessionSpawnNewAction,
    }] = await Promise.all([
        import('@/sync/domains/scope/activeServerAccountScope'),
        import('@/sync/ops/actions/sessionSpawnNewAction'),
    ]);
    const ui = await connectUiPersonActionClient(params);
    try {
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('New Session Account scope unavailable');
        const result = await executeManualSessionSpawnNewAction({
            ...params.input,
            executionTarget: { ...params.input.executionTarget, serverId: scope.serverId },
            creationKey: buildManualSessionCreationKey(params.userAttemptId),
        }, { surface: 'ui', actionRequestId: params.userAttemptId }, {
            scope, machineHomeDir: params.machineHomeDir, userAttemptId: params.userAttemptId,
        });
        if (result.status !== 'executed') throw new Error(`New Session submission: ${result.reason}`);
        await completeManualSessionSpawnNewActionCustody(result.custody);
        return result.action;
    } finally { await ui.close(); }
}
