import * as React from 'react';
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createMachineFixture, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { HubSetupSection } from './HubSetupSection';
import { AddPhoneSettingsView } from '@/components/settings/account/AddPhoneSettingsView';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { discardMachineAddFlowDraft } from '@/components/machines/add/machineAddFlowStore';
import { getActiveServerId, removeServerProfile, resolveServerProfileScopeIdForIdentifier, setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import type { HomeHubLayoutValue } from './layout/homeHubLayout';
import type { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { AppShellPluginUiProjectionValueProvider } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import type { FetchedMachineRow } from '@/sync/engine/machines/syncMachines';
import { WorkspaceNavigationContext, type WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { createWorkspaceState } from '@/components/appShell/workspace/workspaceState';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
    machines: [] as Machine[],
    machineListSettled: true,
    dismissed: false,
    show: null as null | ((options: unknown) => void),
    window: { width: 1600, height: 900 },
    phone: false,
    push: null as null | ((href: unknown) => void),
    params: {} as { setupStep?: string },
    layout: { order: [], hidden: [] } as Pick<HomeHubLayoutValue, 'order' | 'hidden'> & Partial<Pick<HomeHubLayoutValue, 'sections' | 'instances'>>,
    authenticated: true,
    featureSnapshot: vi.fn<typeof getServerFeaturesSnapshot>(async () => ({ status: 'error', reason: 'network' })),
    pairingCredentials: null as null | { token: string },
    request: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
}));
installDisconnectedServerSocketBoundary();
let artifact = createHomeHubArtifactHttpBoundary('account-setup');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let restoreActionLoader: (() => void) | undefined;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    // The window size decides computer vs phone-sized web.
    return createReactNativeWebMock({
        useWindowDimensions: () => ({ ...state.window, scale: 2, fontScale: 1 }),
    });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const router = createExpoRouterMock({ params: () => state.params });
    router.spies.push.mockImplementation((href: unknown) => { state.push?.(href); });
    return router.module;
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    // The modal boundary: the test captures what the step asked it to show.
    const show = ((options: unknown) => {
        state.show?.(options);
        return 'modal-id';
    }) as never;
    return createModalModuleMock({ spies: { show } }).module;
});
// Pairing HTTP and persisted credentials are system boundaries; the real QR lifecycle runs below them.
vi.mock('@/sync/http/client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/http/client')>();
    return { ...actual, createServerFetchAtEndpoint: (...args: Parameters<typeof actual.createServerFetchAtEndpoint>) => {
        const request = actual.createServerFetchAtEndpoint(...args);
        return async (...requestArgs: Parameters<typeof request>) => {
            if (requestArgs[0] === '/v1/features' || requestArgs[0] === '/v1/features/authenticated') {
                const snapshot = await state.featureSnapshot({});
                if (snapshot.status !== 'ready') throw new Error('Test Home feature HTTP unavailable');
                return Response.json(snapshot.features);
            }
            return requestArgs[0].startsWith('/v1/auth/pairing/') || requestArgs[0] === '/v1/auth/account/response'
                ? state.request(requestArgs[0], requestArgs[1]) : request(...requestArgs);
        };
    } };
});
// Device storage for the recovery-key flag, and the server's feature answer (HTTP).
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/auth/storage/tokenStorage')>();
    return {
        ...actual,
        TokenStorage: {
            ...actual.TokenStorage,
            getRecoveryKeyReminderDismissed: async () => state.dismissed,
            setRecoveryKeyReminderDismissed: async (value: boolean) => { state.dismissed = value; return true; },
            getCachedRecoveryKeyReminderDismissed: () => null,
            getCredentialsForServerUrl: async () => state.pairingCredentials,
        },
    };
});
// The plugins machine's cached answer (none in this launch).
vi.mock('@/components/settings/plugins/model/pluginAdministrationSummary', () => ({
    usePluginAdministrationSummary: () => ({ known: false, awaitingDecision: 0, userInstalled: 0 }),
}));
// The Homes journeys' steps (their own owner and suite, `components/homes/journeys/**`) lead this row
// through the same morph; their account-service discovery is network-backed, so this suite leaves them
// out and covers Get set up's own items.
vi.mock('@/components/homes/journeys/useHomesJourneySetupItems', () => ({
    useHomesJourneySetupItems: () => [],
}));
// Connected services own their block (its suite is theirs); this suite covers Get set up's own items.
vi.mock('@/components/settings/connectedServices/home/useConnectServicesSetupItem', () => ({
    useConnectServicesSetupItem: () => null,
}));
vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: () => ({ connectTerminal: vi.fn(), isLoading: false }),
}));
vi.mock('@/hooks/auth/useScannedAuthUrlProcessor', () => ({
    useScannedAuthUrlProcessor: () => ({ processAuthUrl: vi.fn() }),
}));

afterEach(async () => {
    standardCleanup();
    vi.useRealTimers();
    await connection?.dispose();
    connection = undefined;
    restoreActionLoader?.();
    restoreActionLoader = undefined;
    artifact = createHomeHubArtifactHttpBoundary('account-setup');
    discardMachineAddFlowDraft();
    state.authenticated = true;
    state.machines = [];
    state.machineListSettled = true;
    state.dismissed = false;
    state.window = { width: 1600, height: 900 };
    state.phone = false;
    state.push = null;
    state.params = {};
    state.layout = { order: [], hidden: [] };
    state.featureSnapshot.mockReset();
    state.featureSnapshot.mockResolvedValue({ status: 'error', reason: 'network' });
    state.pairingCredentials = null;
    state.request.mockReset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    // No `vi.resetModules()`: re-importing the section's module graph for every case kept each
    // previous graph alive and ran the worker out of memory (about 1 GB per case). The device facts
    // it depended on are read at call time (window size, `navigator`), and the recovery-key reminder's
    // one shared state is driven through its storage boundary (`state.dismissed`) in case order.
});

async function renderSection(presentation?: 'tiles' | 'checklist') {
    if (!connection) {
        artifact.seed({ v: 1, instances: [], ...state.layout });
        await loadSyncSingletonForTests();
        const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
        await prepareSessionDraftPersistenceStorage();
        restoreActionLoader = await installRealActionExecutorModuleLoader();
        const snapshot = getActiveServerSnapshot();
        connection = await restoreServerAccountForTest({ serverUrl: snapshot.serverUrl || 'https://setup-layout.test', accountId: 'account-setup', request: (url, init) => {
            if (new URL(String(url)).pathname === '/v1/machines') return Promise.resolve(Response.json(state.machines.map(machine => ({
                ...machine, metadata: encodePlainMachineStoredContent(machine.metadata), daemonState: encodePlainMachineStoredContent(machine.daemonState),
                dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            } satisfies FetchedMachineRow))));
            return artifact.request(url, init);
        } });
    }
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(connection.home.id), accountId: 'account-setup' };
    storage.setState({ isDataReady: true, profileScope: scope, settingsScope: scope, machines: Object.fromEntries(state.machines.map(machine => [machine.id, machine])),
        machineListByServerId: { [scope.serverId]: state.machines }, machineListStatusByServerId: { [scope.serverId]: state.machineListSettled ? 'idle' : 'loading' } });
    // Both hubs are pages: the checklist's progress lives in the page section header.
    const screen = await renderScreen(
        <AccountShell><ListPresentationProvider value="page"><HubSetupSection presentation={presentation} /></ListPresentationProvider></AccountShell>,
    );
    await flushHookEffects({ cycles: 3 });
    return screen;
}

function AccountShell({ children }: React.PropsWithChildren) {
    const workspace: WorkspaceNavigationContextValue = {
        active: true,
        state: createWorkspaceState({ id: 'home', target: { kind: 'home', params: {} }, pinned: false, preview: true }),
        phone: state.phone ? { catalog: [], onTab: true, openHref: () => true, activateTab: () => {}, closeTab: () => {} } : null,
        canGoBack: false, canGoForward: false, openHref: () => true,
        activateTab: () => {}, closeTab: () => {}, closeTabs: () => {}, dispatch: () => {},
        navigationForTab: () => { throw new Error('Unexpected tab navigation'); },
        registerBackStep: () => () => {}, back: () => {}, forward: () => {},
    };
    return <InjectedAuthProvider credentials={state.authenticated ? connection!.credentials : null}>
        <AppShellPluginUiProjectionValueProvider value={{ pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null,
            phase: 'current', interactionEnabled: true, machineId: null, serverId: resolveServerProfileScopeIdForIdentifier(connection!.home.id), platform: 'web',
            clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {} }}>
            <WorkspaceNavigationContext.Provider value={workspace}>{children}</WorkspaceNavigationContext.Provider>
        </AppShellPluginUiProjectionValueProvider>
    </InjectedAuthProvider>;
}

const phoneWindow = () => {
    state.phone = true;
    state.window = { width: 360, height: 800 };
    vi.stubGlobal('navigator', { maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)' });
};

describe('HubSetupSection on Home (tiles)', () => {
    it('does not invent a recovery key for a plaintext Account', async () => {
        const screen = await renderSection();
        expect(screen.findByTestId('hub-setup.recoveryKey')).toBeNull();
        expect(artifact.writes).toEqual([]);
    });
    it.each(['tiles', 'checklist'] as const)('completes phone setup only after successful pairing from %s and keeps completion in the existing synced layout', async (presentation) => {
        vi.useFakeTimers();
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const { computeHomeQrBindingProofV2, FeaturesResponseSchema } = await import('@happier-dev/protocol');
        const { parseHomeQrInviteDeepLink } = await import('@/auth/pairing/pairingUrl');
        const { decodeBase64, encodeBase64 } = await import('@/encryption/base64');
        const previousServerId = getActiveServerId();
        const descriptor = {
            v: 1 as const, homeServerIdentityId: 'srv_phone_setup', canonicalServerUrl: 'https://phone-setup.test',
            revision: 1, endpoints: [{ kind: 'https' as const, url: 'https://phone-setup.test' }],
        };
        const home = await profiles.adoptHomeProfile({ descriptor, source: 'qr', descriptorAuthority: 'current_connection_observation' });
        state.featureSnapshot.mockResolvedValue({
            status: 'ready', serverIdentityId: descriptor.homeServerIdentityId,
            features: FeaturesResponseSchema.parse({ features: { auth: { pairing: { boundQrV2: { enabled: true } } } }, capabilities: {}, homeConnectionDescriptor: descriptor }),
        });
        state.pairingCredentials = { token: 'trusted-home-token' };
        state.dismissed = true;
        state.layout = { order: ['setup', 'future-section'], hidden: ['usage'], sections: { setup: { frameStyle: 'plain' } } };
        const expiresAt = new Date(Date.now() + 60_000).toISOString();
        let requested: Record<string, unknown> | null = null;
        state.request.mockImplementation(async (path) => {
            const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
            if (path === '/v1/auth/pairing/start') return json({ pairId: 'setup-pair', expiresAt });
            if (path.startsWith('/v1/auth/pairing/status?')) return json(requested ?? { state: 'pending', pairId: 'setup-pair', expiresAt });
            if (path === '/v1/auth/account/response' || path === '/v1/auth/pairing/consume') return json({ success: true });
            throw new Error(`Unexpected pairing request: ${path}`);
        });
        try {
            await setActiveServerId(home.id);
            let screen = await renderSection(presentation);
            state.push = (href) => {
                state.params = { setupStep: new URL(String(href), 'https://app.test').searchParams.get('setupStep') ?? undefined };
            };
            await act(async () => { screen.pressByTestId('settings-add-your-phone-shortcut.action'); });
            if (presentation === 'checklist') {
                await screen.unmount();
                screen = await renderScreen(<AccountShell><ListPresentationProvider value="page"><AddPhoneSettingsView /></ListPresentationProvider></AccountShell>);
            }
            await flushHookEffects({ cycles: 3 });
            const code = screen.tree.root.find((node) => typeof node.props.data === 'string' && parseHomeQrInviteDeepLink(node.props.data) !== null);
            const parsed = parseHomeQrInviteDeepLink(code.props.data);
            if (!parsed) throw new Error('Expected the real pairing invite');
            expect(artifact.layout().hidden).toEqual(['usage']);
            // An Account layout update while pairing is pending must not be overwritten by success.
            await act(async () => {
                const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
                const result = await createDefaultActionExecutor().execute('home.hub.layout.update', { intent: { kind: 'visibility', sectionId: 'machines', hidden: true } }, {
                    surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: connection!.home.id, expectedAccountId: 'account-setup',
                });
                expect(result.ok, JSON.stringify(result)).toBe(true);
            });
            const publicKey = new Uint8Array(32).fill(9);
            requested = {
                state: 'requested', pairId: parsed.invite.pairId, expiresAt, requestedPublicKey: encodeBase64(publicKey),
                // Completion does not infer a device type from the label.
                requestedDeviceLabel: 'Another device', homeServerIdentityId: descriptor.homeServerIdentityId,
                bindingProof: computeHomeQrBindingProofV2({
                    direction: parsed.invite.direction, qrSecret: decodeBase64(parsed.invite.qrSecretBase64Url, 'base64url'),
                    pairId: parsed.invite.pairId, homeServerIdentityId: descriptor.homeServerIdentityId,
                    requesterPublicKey: publicKey, expiresAtMs: parsed.invite.expiresAtMs,
                }),
            };
            await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
            await flushHookEffects({ cycles: 3 });
            expect(state.request.mock.calls.some(([path]) => path === '/v1/auth/account/response')).toBe(true);
            expect([...artifact.layout().hidden].sort()).toEqual(['machines', 'setup:addPhone', 'usage']);
            expect(artifact.layout().order.slice(0, 2)).toEqual(['setup', 'future-section']);
            expect(artifact.layout().sections).toEqual({ setup: { frameStyle: 'plain' } });
            expect(screen.findByTestId('settings-add-your-phone-shortcut')).toBeNull();
            await act(async () => { screen.tree.unmount(); });
            const reopened = await renderSection();
            expect(reopened.findByTestId('settings-add-your-phone-shortcut')).toBeNull();
            const checklist = await renderSection('checklist');
            expect(checklist.findByTestId('settings-add-your-phone-shortcut')).toBeNull();
        } finally {
            await act(async () => {
                await setActiveServerId(previousServerId);
                await removeServerProfile(home.id);
            });
        }
    });
    it('removes the first-machine step once the Home has a machine, keeping phone setup available', async () => {
        state.dismissed = true;
        state.machines = [createMachineFixture({ id: 'm1', metadata: null })];
        const screen = await renderSection();

        expect(screen.findByTestId('settings-add-your-phone-shortcut')).toBeTruthy();
        expect(Boolean(screen.findByTestId('hub-setup.installComputer'))).toBe(false);
        expect(screen.findByTestId('hub-setup.addMachine')).toBeNull();
        state.machineListSettled = false;
        const unknown = await renderSection();
        expect(unknown.findByTestId('hub-setup.addMachine')).toBeTruthy();
    });

    it('"Show QR code" grows the pairing panel in place instead of leaving Home', async () => {
        state.dismissed = true;
        const pushed: unknown[] = [];
        state.push = (href) => { pushed.push(href); };
        const screen = await renderSection();
        expect(screen.findByTestId('hub-setup.pairing-panel')).toBeNull();

        await act(async () => { screen.pressByTestId('settings-add-your-phone-shortcut.action'); });
        await flushHookEffects({ cycles: 3 });

        expect(pushed).toEqual([]);
        expect(screen.findByTestId('hub-setup.pairing-panel')).toBeTruthy();
        // This fixture's Home probe fails; opening or closing an unsuccessful flow is not completion.
        expect(artifact.layout().hidden).toEqual([]);
        await screen.unmount();
        expect(artifact.layout().hidden).toEqual([]);
    });

    it('Another computer offers a Home pairing link first and keeps the terminal as an alternative', async () => {
        state.dismissed = true;
        const screen = await renderSection();
        await act(async () => { screen.pressByTestId('hub-setup.addMachine.action'); });
        await act(async () => { screen.pressByTestId('hub-setup.add-machine-panel.path.anotherComputer'); });
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByTestId('hub-setup.add-machine-panel.pane.pairing-panel')).toBeTruthy();
        expect(screen.findByTestId('hub-setup.add-machine-panel.pane.command')).toBeNull();
        await act(async () => { screen.pressByTestId('hub-setup.add-machine-panel.pane.terminal'); });
        expect(screen.findByTestId('hub-setup.add-machine-panel.pane.command')).toBeTruthy();
    });

    it('keeps pairing admission scoped to the draft Home after focus moves to a signed-out Home', async () => {
        const previousServerId = getActiveServerId();
        const home = await upsertServerProfile({ serverUrl: 'https://machine-draft.test', name: 'Draft Home' });
        const other = await upsertServerProfile({ serverUrl: 'https://machine-other.test', name: 'Other Home' });
        state.dismissed = true;
        try {
            await setActiveServerId(home.id);
            const screen = await renderSection();
            await act(async () => { screen.pressByTestId('hub-setup.addMachine.action'); });
            await act(async () => { await setActiveServerId(other.id); });
            state.authenticated = false;
            await act(async () => { screen.pressByTestId('hub-setup.add-machine-panel.path.anotherComputer'); });
            await flushHookEffects({ cycles: 3 });
            // The real pairing owner reports this retained Home's failed HTTP probe, rather than
            // spinning forever because the different, focused Home is signed out.
            expect(screen.findByTestId('hub-setup.add-machine-panel.pane.pairing-invalid-request')).toBeTruthy();
        } finally {
            await setActiveServerId(previousServerId);
            await removeServerProfile(home.id);
            await removeServerProfile(other.id);
        }
    });

    it('a dismissed step leaves Home and is kept on the Account layout', async () => {
        state.dismissed = true;
        const screen = await renderSection();

        await act(async () => { screen.pressByTestId('hub-setup.addMachine.dismiss'); });
        await flushHookEffects({ cycles: 2 });

        expect(screen.findByTestId('hub-setup.addMachine')).toBeNull();
        expect(artifact.layout().hidden).toEqual(['setup:addMachine', 'machines']);
        expect(screen.findByTestId('settings-add-your-phone-shortcut')).toBeTruthy();
        await act(async () => { screen.pressByTestId('settings-add-your-phone-shortcut.dismiss'); });
        await flushHookEffects({ cycles: 3 });
        expect(artifact.layout().hidden).toEqual(['setup:addMachine', 'machines', 'setup:addPhone']);
        expect(screen.findByTestId('settings-add-your-phone-shortcut')).toBeNull();
    });

    it('leaves Home once every step is done or dismissed', async () => {
        state.dismissed = true;
        state.layout = { order: [], hidden: ['setup:addPhone', 'setup:addMachine', 'setup:installComputer', 'setup:personalize'] };
        const screen = await renderSection();

        expect(screen.findByTestId('hub-setup.grid')).toBeNull();
        expect(screen.findByTestId('settings-add-your-phone-shortcut')).toBeNull();
    });

    it('on a phone offers connecting a computer (opening in place) and adding a machine, not the phone QR', async () => {
        state.dismissed = true;
        phoneWindow();
        const screen = await renderSection();

        expect(screen.findByTestId('settings-add-your-phone-shortcut')).toBeNull();
        expect(screen.findByTestId('hub-setup.addMachine')).toBeTruthy();
        expect(screen.findByTestId('hub-setup.connect-computer-panel')).toBeNull();

        await act(async () => { screen.pressByTestId('hub-setup.connectComputer.action'); });
        await flushHookEffects({ cycles: 2 });
        expect(screen.findByTestId('hub-setup.connect-computer-panel')).toBeTruthy();
    });

    describe('Personalize Happier', () => {
        const SETUP_TILE_IDS = ['settings-add-your-phone-shortcut', 'hub-setup.connectComputer', 'hub-setup.addMachine', 'hub-setup.personalize'];
        const tileOrder = (screen: Awaited<ReturnType<typeof renderSection>>) => screen
            .findAll((node) => typeof node.type === 'string' && SETUP_TILE_IDS.includes(node.props?.testID))
            .map((node) => node.props.testID as string)
            .filter((id, index, ids) => ids.indexOf(id) === index);

        afterEach(() => {
            storage.getState().applyLocalSettings({ personalizeProgressV1: { savedSteps: [], resumeAt: null } });
        });

        it('comes after the phone and machine steps on a computer and opens step 1 in place', async () => {
            state.dismissed = true;
            const screen = await renderSection();
            expect(tileOrder(screen)).toEqual(['settings-add-your-phone-shortcut', 'hub-setup.addMachine', 'hub-setup.personalize']);

            await act(async () => { screen.pressByTestId('hub-setup.personalize.action'); });
            await flushHookEffects({ cycles: 2 });
            // Theme and the glass presets, then the rest of the flow: nothing is completed by opening it.
            expect(screen.findByTestId('hub-setup.personalize-panel')).toBeTruthy();
            expect(screen.findByTestId('hub-setup.personalize-panel-theme:dark')).toBeTruthy();
            expect(screen.findByTestId('hub-setup.personalize-panel-glass:everywhere')).toBeTruthy();
            expect(artifact.layout().hidden).toEqual([]);

            await act(async () => { screen.pressByTestId('hub-setup.personalize-panel.not-now'); });
            await flushHookEffects({ cycles: 2 });
            expect(artifact.layout().hidden).toEqual([]);
        });

        it('comes first on a phone and opens the flow sheet', async () => {
            state.dismissed = true;
            phoneWindow();
            const shown: unknown[] = [];
            state.show = (options) => { shown.push(options); };
            const screen = await renderSection();
            expect(tileOrder(screen)[0]).toBe('hub-setup.personalize');

            await act(async () => { screen.pressByTestId('hub-setup.personalize.action'); });
            expect(shown).toEqual([expect.objectContaining({ chrome: expect.objectContaining({ phonePresentation: 'sheet' }) })]);
        });

        it('shows saved progress and picks up where this device left off', async () => {
            state.dismissed = true;
            const pushed: unknown[] = [];
            state.push = (href) => { pushed.push(href); };
            storage.getState().applyLocalSettings({ personalizeProgressV1: { savedSteps: ['look', 'conversation', 'tools'], resumeAt: 'work' } });
            const screen = await renderSection();

            // "3 of 6 choices saved. Pick up at Find your work." and Continue.
            const texts = screen.findAll((node) => typeof node.props?.children === 'string').map((node) => node.props.children as string);
            expect(texts).toContain('personalize.cardProgress(saved=3,total=6,step=personalize.workName)');
            expect(texts).toContain('personalize.cardContinue');
            await act(async () => { screen.pressByTestId('hub-setup.personalize.action'); });
            expect(pushed).toEqual(['/personalize']);
            expect(screen.findByTestId('hub-setup.personalize-panel')).toBeNull();
        });

        it('dismissing hides setup:personalize on the Account layout', async () => {
            state.dismissed = true;
            const screen = await renderSection();
            await act(async () => { screen.pressByTestId('hub-setup.personalize.dismiss'); });
            await flushHookEffects({ cycles: 2 });
            expect(artifact.layout().hidden).toEqual(['setup:personalize', 'machines']);
            expect(screen.findByTestId('hub-setup.personalize')).toBeNull();
        });
    });
});
