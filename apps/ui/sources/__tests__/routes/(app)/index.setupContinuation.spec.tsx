import React from 'react';
import { Pressable, View } from 'react-native';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import type { PendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent.shared';
import { SystemTaskResultSchema, SystemTaskSpecSchema } from '@happier-dev/protocol/system/tasks/spec';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';

vi.mock('@/assets/images/logotype-light.png', () => ({ default: 'logotype-light' }));
vi.mock('@/assets/images/logotype-dark.png', () => ({ default: 'logotype-dark' }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' } });
});

const expoRouterMock = createExpoRouterMock({
    router: { push: vi.fn(), replace: vi.fn() },
});
const routeParamsState = vi.hoisted(() => ({
    value: {} as Record<string, string>,
}));
vi.mock('expo-router', () => ({
    ...expoRouterMock.module,
    useLocalSearchParams: () => ({ ...expoRouterMock.module.useLocalSearchParams(), ...routeParamsState.value }),
    useGlobalSearchParams: () => ({ ...expoRouterMock.module.useGlobalSearchParams(), ...routeParamsState.value }),
}));

vi.mock('@tauri-apps/api/window', async (importOriginal) => ({
    ...await importOriginal<typeof import('@tauri-apps/api/window')>(),
    getCurrentWindow: () => ({ label: 'main' }),
}));

let isAuthenticated = true;

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const HOME_A_URL = 'https://relay.example.test';
const HOME_A_ID = 'srv_setup_home_a';
const HOME_B_URL = 'https://setup-home-b.test';
const PERSONAL_HOME_URL = 'http://127.0.0.1:43123';
const PERSONAL_HOME_ID = 'srv_setup_personal_home';
let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>> | null = null;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let homeBId = '';
let profileStorage: Storage | null = null;
let nextNativeTaskId = 0;
let relayStatus: Readonly<Record<string, unknown>>;
let nativeBridge: Readonly<{ invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>; transformCallback: () => number; unregisterCallback: () => void }>;

function setDesktop(enabled: boolean) {
    const bridge = enabled ? nativeBridge : undefined;
    vi.stubGlobal('__TAURI_INTERNALS__', bridge);
    // Tauri's real event SDK reads Window, while the shared desktop adapter
    // also accepts globalThis. Both must address the same native transport.
    if (browser) {
        Reflect.set(browser.window, '__TAURI_INTERNALS__', bridge);
        // Snapshot replies deliver this fixture's native task results; the
        // genuine event SDK still unregisters its native listener bookkeeping.
        Reflect.set(browser.window, '__TAURI_EVENT_PLUGIN_INTERNALS__', enabled ? { unregisterListener: () => {} } : undefined);
    }
}

let AuthProvider: typeof import('@/auth/context/AuthContext')['AuthProvider'];
let useAuth: typeof import('@/auth/context/AuthContext')['useAuth'];
let RootLayoutRouteContexts: typeof import('./rootLayoutRouteContexts')['RootLayoutRouteContexts'];
let MainView: typeof import('@/components/navigation/shell/MainView')['MainView'];
let AppPaneProvider: typeof import('@/components/appShell/panes/AppPaneProvider')['AppPaneProvider'];
let BaseModal: typeof import('@/modal/components/BaseModal')['BaseModal'];
let PreAuthOnboardingWizardEntry: typeof import('@/components/onboarding/preAuth/PreAuthOnboardingWizardEntry')['PreAuthOnboardingWizardEntry'];
let pendingSetup: typeof import('@/sync/domains/pending/pendingSetupIntent');
let pendingTerminal: typeof import('@/sync/domains/pending/pendingTerminalConnect');
let clearPendingSetupIntentMock: MockInstance<() => void>;
let setPendingSetupIntentMock: MockInstance<(value: PendingSetupIntent) => void>;

function seedSetupIntent(value: PendingSetupIntent | null) {
    pendingSetup.clearPendingSetupIntent();
    if (value) pendingSetup.setPendingSetupIntent(value);
    clearPendingSetupIntentMock.mockClear();
    setPendingSetupIntentMock.mockClear();
}

function RouteProviders(props: React.PropsWithChildren) {
    return <AuthProvider initialCredentials={isAuthenticated ? connection!.credentials : null}>
        <RootLayoutRouteContexts><AppPaneProvider>{props.children}</AppPaneProvider></RootLayoutRouteContexts>
    </AuthProvider>;
}

const renderRoute: typeof renderScreen = (element, options) => renderScreen(element, { ...options, wrapper: RouteProviders });

/** The navigator boundary mounts what the real Home route requests. */
function LandingRouter({ Screen, children, destinations }: React.PropsWithChildren<{
    Screen: React.ComponentType;
    destinations?: Readonly<Record<string, React.ComponentType>>;
}>) {
    const [pathname, setPathname] = React.useState('/');
    expoRouterMock.spies.replace.mockImplementation(destination => {
        if (typeof destination === 'string') {
            setPathname(destination);
        } else if (destination && typeof destination === 'object' && 'pathname' in destination && typeof destination.pathname === 'string') {
            setPathname(destination.pathname);
        } else {
            throw new TypeError('The mounted navigator requires a route pathname');
        }
    });
    const [route = pathname, query] = pathname.split('?');
    const Destination = destinations?.[route];
    if (Destination && query) routeParamsState.value = Object.fromEntries(new URLSearchParams(query));
    return <>
        {children}
        {pathname === '/' ? <Screen /> : Destination ? <Destination /> : <View testID={pathname} />}
    </>;
}

function SignInAtCredentialBoundary() {
    const { isAuthenticated: signedIn, loginWithCredentials } = useAuth();
    if (signedIn) return null;
    return <Pressable testID="complete-interactive-sign-in" onPress={() => loginWithCredentials(connection!.credentials)} />;
}

async function restoreHome(serverUrl: string, serverIdentityId?: string) {
    await connection?.dispose();
    const issuer = homes.findByServerUrl(serverUrl);
    if (!issuer?.token) throw new Error('Setup fixture Home issuer is unavailable');
    connection = await restoreServerAccountForTest({ serverUrl, serverIdentityId, accountId: 'setup-account',
        credentials: { token: issuer.token }, request: async (url, init) => {
        const path = new URL(String(url)).pathname;
        return createEmptyAccountBootstrapHttpResponse(path, init) ?? homes.request(url, init);
    } });
    const { storage } = await import('@/sync/domains/state/storage');
    await waitForHomeGovernance(() => expect(storage.getState().profileScope?.accountId).toBe('setup-account'));
}

// The browser persistence port must exist before the real profile owner captures it.
// Keep that same port for the suite, including the adoption-write failure case.
browser = await installBrowserRuntimeForTests({ url: 'https://setup-route.test/' });
profileStorage = browser.storage;
afterAll(() => { browser?.restore(); browser = null; });
// Cold source transformation is setup work, not part of Account restoration's hook deadline.
await (await import('@/dev/testkit/harness/syncSingletonLoader')).loadSyncSingletonForTests();
({ AuthProvider, useAuth } = await import('@/auth/context/AuthContext'));
({ RootLayoutRouteContexts } = await import('./rootLayoutRouteContexts'));
({ MainView } = await import('@/components/navigation/shell/MainView'));
({ AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider'));
({ BaseModal } = await import('@/modal/components/BaseModal'));
({ PreAuthOnboardingWizardEntry } = await import('@/components/onboarding/preAuth/PreAuthOnboardingWizardEntry'));
pendingSetup = await import('@/sync/domains/pending/pendingSetupIntent');
pendingTerminal = await import('@/sync/domains/pending/pendingTerminalConnect');

describe('/ (welcome) setup continuation', () => {
    beforeEach(async () => {
        browser!.activate();
        browser!.reconfigureUrl('https://setup-route.test/');
        relayStatus = { installed: false, healthy: false, dataPresent: false, relayUrl: PERSONAL_HOME_URL, service: { active: false, enabled: false } };
        const secureStorage = createDesktopSecureStorageBoundary();
        const tasks = new Map<string, ReturnType<typeof SystemTaskSpecSchema.parse>>();
        let callbackId = 0;
        nativeBridge = {
            transformCallback: () => ++callbackId,
            unregisterCallback: () => {},
            async invoke(command, args) {
                if (command.startsWith('desktop_secure_storage_')) return secureStorage.invoke(command, args);
                if (command === 'plugin:event|listen') return ++callbackId;
                if (command === 'plugin:event|unlisten' || command === 'cancel_system_task' || command === 'desktop_set_window_mode') return undefined;
                if (command === 'start_system_task') {
                    const spec = SystemTaskSpecSchema.parse(JSON.parse(String(args?.specJson)));
                    const taskId = `setup-route-task-${++nextNativeTaskId}`;
                    tasks.set(taskId, spec);
                    return { taskId };
                }
                if (command === 'get_system_task_snapshot') {
                    const taskId = String(args?.taskId);
                    const spec = tasks.get(taskId);
                    if (!spec) throw new Error('Unknown setup route native task');
                    if (spec.kind !== 'daemon.service.status.v1' && spec.kind !== 'relay.runtime.status.v1') {
                        return { events: [], result: { protocolVersion: 1, taskId, ok: false,
                            error: { code: 'unsupported_task', message: 'This fixture serves status reads only' } } };
                    }
                    const result = SystemTaskResultSchema.parse({ protocolVersion: 1, taskId, ok: true, data: spec.kind === 'daemon.service.status.v1'
                        ? { serviceInstalled: false, daemonRunning: false, needsAuth: true, machineId: null }
                        : relayStatus });
                    return { events: [], result };
                }
                throw new Error(`Unexpected desktop route command: ${command}`);
            },
        };
        setDesktop(true);
    await initializeRealAppRuntimeForTests();
    await homes.reset();
        await homes.addHome({ name: 'Setup Home A', serverUrl: HOME_A_URL, serverIdentityId: HOME_A_ID, accountId: 'setup-account' });
        homeBId = await homes.addHome({ name: 'Setup Home B', serverUrl: HOME_B_URL, accountId: 'setup-account', active: false });
    await restoreHome(HOME_A_URL);
        clearPendingSetupIntentMock = vi.spyOn(pendingSetup, 'clearPendingSetupIntent');
        setPendingSetupIntentMock = vi.spyOn(pendingSetup, 'setPendingSetupIntent');
        isAuthenticated = true;
        routeParamsState.value = {};
        expoRouterMock.resetParams();
        pendingTerminal.clearPendingTerminalConnect();
        seedSetupIntent({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
        });
        expoRouterMock.spies.replace.mockReset();
        expoRouterMock.spies.push.mockReset();
    });

    afterEach(async () => {
        standardCleanup();
        globalThis.localStorage?.removeItem('happier.voice.e2e.fixture');
        pendingSetup?.clearPendingSetupIntent();
        pendingTerminal?.clearPendingTerminalConnect();
        clearPendingSetupIntentMock?.mockRestore();
        setPendingSetupIntentMock?.mockRestore();
        try { await connection?.dispose(); connection = null; await homes.reset(); }
        finally { vi.unstubAllGlobals(); }
    });

    it.each([
        ['thisComputer', 'awaiting_auth', 'thisComputer'],
        ['remoteMachine', 'post_auth', 'ssh'],
    ] as const)('routes an explicit %s intent once to the draft', async (branch, phase, path) => {
        isAuthenticated = false;
        seedSetupIntent(branch === 'remoteMachine'
            ? { branch, phase, relayUrl: 'https://relay.example.test', machineId: null, remoteSetupIntent: 'remoteMachine' }
            : { branch, phase, relayUrl: 'https://relay.example.test' });
        const Screen = (await import('@/app/(app)/index')).Home;
        const { WorkspaceRouteBody: MachineAddDraft } = await import('@/app/(app)/settings/machines/add');
        const screen = await renderRoute(
            <React.StrictMode><LandingRouter Screen={Screen} destinations={{ '/settings/machines/add': MachineAddDraft }}>
                <SignInAtCredentialBoundary />
            </LandingRouter></React.StrictMode>,
        );
        expect(expoRouterMock.spies.replace).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('complete-interactive-sign-in');
        await vi.waitFor(() => expect(screen.findByTestId('settings.machines.draft.form')).not.toBeNull());
        expect(expoRouterMock.spies.replace.mock.calls).toEqual([[`/settings/machines/add?path=${path}`]]);
        expect(clearPendingSetupIntentMock).toHaveBeenCalled();
        expect(pendingSetup.getPendingSetupIntent()).toBeNull();
        expect(screen.findAllByType(MainView)).toHaveLength(0);
        expect(screen.findAllByType(BaseModal)).toHaveLength(0);
    });

    it('reveals Home once after interactive sign-in with no continuation', async () => {
        isAuthenticated = false;
        seedSetupIntent(null);
        const { Home } = await import('@/app/(app)/index');
        const screen = await renderRoute(<><SignInAtCredentialBoundary /><Home /></>);
        expect(screen.findAllByType(MainView)).toHaveLength(0);
        await screen.pressByTestIdAsync('complete-interactive-sign-in');
        await vi.waitFor(() => expect(screen.findAllByType(MainView)).toHaveLength(1));
        expect(expoRouterMock.spies.replace).not.toHaveBeenCalled();
    });

    it.each(['pre_auth', 'dismissed'] as const)('leaves a %s intent alone', async (phase) => {
        seedSetupIntent({ branch: 'thisComputer', phase, relayUrl: null });
        const Screen = (await import('@/app/(app)/index')).Home;
        await renderRoute(<Screen />);
        await flushHookEffects({ cycles: 1, turns: 2 });
        expect(expoRouterMock.spies.replace).not.toHaveBeenCalled();
        expect(clearPendingSetupIntentMock).not.toHaveBeenCalled();
        expect(pendingSetup.getPendingSetupIntent()?.phase).toBe(phase);
    });

    it.each([true, false])('does not seed automatic setup on desktop=%s', async (desktop) => {
        setDesktop(desktop);
        if (!desktop) await restoreHome(HOME_A_URL);
        seedSetupIntent(null);
        const Screen = (await import('@/app/(app)/index')).Home;
        const screen = await renderRoute(<Screen />);
        await flushHookEffects({ cycles: 1, turns: 2 });
        expect(screen.findAllByType(MainView)).toHaveLength(1);
        expect(expoRouterMock.spies.replace).not.toHaveBeenCalled();
        expect(setPendingSetupIntentMock).not.toHaveBeenCalled();
        expect(pendingSetup.getPendingSetupIntent()).toBeNull();
    });

    it('gives a session deep link precedence without consuming setup', async () => {
        routeParamsState.value = { id: 'session-1' };
        const Screen = (await import('@/app/(app)/index')).Home;
        const screen = await renderRoute(<LandingRouter Screen={Screen} />);
        await flushHookEffects({ cycles: 1, turns: 2 });
        expect(expoRouterMock.spies.replace.mock.calls).toEqual([['/session/session-1']]);
        expect(screen.findByTestId('/session/session-1')).not.toBeNull();
        expect(screen.findAllByType(MainView)).toHaveLength(0);
        expect(clearPendingSetupIntentMock).not.toHaveBeenCalled();
    });

    it('resumes a signed-out explicit Home new-session continuation after that Home authenticates', async () => {
        seedSetupIntent(null);
        await restoreHome(HOME_B_URL);
        routeParamsState.value = {
            newSessionAuthContinuation: '1',
            spawnServerId: homeBId,
            draftId: 'draft-1',
        };

        const Screen = (await import('@/app/(app)/index')).Home;
        const screen = await renderRoute(<LandingRouter Screen={Screen} />);
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(expoRouterMock.spies.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: expect.objectContaining({
                spawnServerId: homeBId,
                draftId: 'draft-1',
            }),
        });
        expect(expoRouterMock.spies.replace).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('/new')).not.toBeNull();
        expect(screen.findAllByType(MainView)).toHaveLength(0);
    });

    it('does not resume an explicit Home continuation against a different active Home', async () => {
        seedSetupIntent(null);
        routeParamsState.value = {
            newSessionAuthContinuation: '1',
            spawnServerId: homeBId,
            draftId: 'draft-1',
        };

        const Screen = (await import('@/app/(app)/index')).Home;
        await renderRoute(React.createElement(Screen));
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(expoRouterMock.spies.replace).not.toHaveBeenCalledWith(expect.objectContaining({
            pathname: '/new',
        }));
    });

    it('shows pre-auth on Desktop when no Personal Home bootstrap provider owns the signed-out route', async () => {
        isAuthenticated = false;
        seedSetupIntent(null);

        const Screen = (await import('@/app/(app)/index')).Home;
        const screen = await renderRoute(React.createElement(Screen));
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(screen.findAllByType(MainView)).toHaveLength(0);
        expect(screen.findAllByType(PreAuthOnboardingWizardEntry)).toHaveLength(1);
    });

    it('keeps verified Home plus profile-adoption retry in the real provider/index shell', async () => {
        isAuthenticated = true;
        seedSetupIntent(null);
        const localId = await homes.addHome({ name: 'Personal Home', serverUrl: PERSONAL_HOME_URL,
            serverIdentityId: PERSONAL_HOME_ID, accountId: 'setup-account', currentAccount: true });
        // Only the managed Personal Home belongs to bootstrap/adoption recovery.
        const { upsertServerProfileOnly } = await import('@/sync/domains/server/serverRuntime');
        await upsertServerProfileOnly({ serverUrl: PERSONAL_HOME_URL, source: 'desktop-personal-home' });
        const features = createRootLayoutFeaturesResponse({ homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({
            v: 1, homeServerIdentityId: PERSONAL_HOME_ID, canonicalServerUrl: PERSONAL_HOME_URL, revision: 1,
            endpoints: [{ kind: 'https', url: PERSONAL_HOME_URL }],
        }), capabilities: {
            serverIdentity: { serverIdentityId: PERSONAL_HOME_ID },
            auth: { signup: { methods: [{ id: 'anonymous', enabled: false }] }, keyChallenge: { v2: true } },
            encryption: { storagePolicy: 'plaintext_only' },
        } });
        homes.answer(localId, '/v1/features', { body: features });
        homes.answer(localId, '/v1/features/authenticated', { body: features });
        homes.answer(localId, '/v1/auth/challenge', { body: {
            challengeId: 'setup-personal-home-challenge', nonce: 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM',
            issuedAt: new Date(0).toISOString(), expiresAt: new Date(60_000).toISOString(),
            audience: { origin: PERSONAL_HOME_URL, serverIdentityId: PERSONAL_HOME_ID },
        } });
        homes.answer(localId, '/v1/auth', { status: 403, body: { error: 'signup-disabled' } });
        await restoreHome(PERSONAL_HOME_URL, PERSONAL_HOME_ID);
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        expect(Boolean(await TokenStorage.getCredentialsForServerUrl(PERSONAL_HOME_URL, { serverId: PERSONAL_HOME_ID }))).toBe(true);
        relayStatus = { installed: true, healthy: true, dataPresent: true, relayUrl: PERSONAL_HOME_URL,
            service: { active: true, enabled: true }, purpose: { kind: 'personal-home', canonicalServerUrl: PERSONAL_HOME_URL },
            anonymousSignupEnabled: false };
        // The browser persistence adapter rejects only this Home's completion write.
        // Profile adoption and its retry classification remain real.
        let adoptionRejected = false;
        const { readStorageScopeFromEnv, scopedStorageId } = await import('@/utils/system/storageScope');
        const profileKeyPrefix = `${scopedStorageId('server-profiles', readStorageScopeFromEnv())}:`;
        // Prove this is the browser port retained by the real profile owner,
        // not the fresh per-case DOM's unrelated Storage instance.
        expect(profileStorage!.getItem(`${profileKeyPrefix}server-state-v1`)).toContain(PERSONAL_HOME_ID);
        const storagePrototype = Object.getPrototypeOf(profileStorage!) as Storage;
        const write = storagePrototype.setItem;
        const persistenceFailure = vi.spyOn(storagePrototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
            if (key.startsWith(profileKeyPrefix) && value.includes(PERSONAL_HOME_ID)
                && value.includes('"personalHomeBootstrapCompleted":true')) {
                adoptionRejected = true;
                throw new DOMException('Profile storage unavailable', 'QuotaExceededError');
            }
            return write.call(this, key, value);
        });
        const Screen = (await import('@/app/(app)/index')).Home;
        const { PersonalHomeBootstrapGate } = await import('@/components/personalHome/bootstrap/PersonalHomeBootstrapGate');
        const { usePersonalHomeBootstrapRuntime } = await import('@/components/personalHome/bootstrap/usePersonalHomeBootstrapRuntime');
        // Prove the actual event SDK can reach this fixture's native transport
        // before interpreting a failed task subscription as unavailable runtime.
        const unlisten = await (await import('@/utils/platform/desktopHost')).listenDesktopHostEvent('setup-fixture-readiness', () => {});
        await unlisten();
        function RuntimeGate() {
            const runtime = usePersonalHomeBootstrapRuntime();
            return <PersonalHomeBootstrapGate readFacts={runtime.readFacts} operations={runtime.operations} activeTask={runtime.activeTask}>
                <Screen />
            </PersonalHomeBootstrapGate>;
        }
        try {
            const screen = await renderRoute(<RuntimeGate />);
            await waitForHomeGovernance(() => {
                expect(adoptionRejected).toBe(true);
                expect(screen.findAllByType(MainView)).toHaveLength(1);
                expect(screen.findAllByType(PreAuthOnboardingWizardEntry)).toHaveLength(0);
                expect(screen.findByTestId('personal-home-recovery-strip')).not.toBeNull();
            });
        } finally { persistenceFailure.mockRestore(); }
    });

    it.each([
        ['query', true], ['query', false], ['persisted', true], ['persisted', false],
    ] as const)('ignores voice fixture markers from %s with debug runtime %s when continuing setup', async (marker, debugRuntime) => {
        const previousDev = (globalThis as { __DEV__?: boolean }).__DEV__;
        const previousDebug = process.env.EXPO_PUBLIC_DEBUG;
        (globalThis as { __DEV__?: boolean }).__DEV__ = debugRuntime;
        process.env.EXPO_PUBLIC_DEBUG = debugRuntime ? '1' : '0';
        setDesktop(false);
        if (marker === 'query') {
            expoRouterMock.state.router.setParams({ happier_voice_e2e_fixture: 'local_auto_return_listening' });
        } else {
            globalThis.localStorage?.setItem('happier.voice.e2e.fixture', 'local_auto_return_listening');
        }
        try {
            const Screen = (await import('@/app/(app)/index')).Home;
            await renderRoute(<Screen />);
            await flushHookEffects({ cycles: 1, turns: 3 });
            expect(expoRouterMock.spies.replace).toHaveBeenCalledWith('/settings/machines/add?path=thisComputer');
            expect(setPendingSetupIntentMock).not.toHaveBeenCalledWith(expect.objectContaining({ phase: 'dismissed' }));
            expect(pendingSetup.getPendingSetupIntent()).toBeNull();
        } finally {
            (globalThis as { __DEV__?: boolean }).__DEV__ = previousDev;
            if (previousDebug === undefined) delete process.env.EXPO_PUBLIC_DEBUG;
            else process.env.EXPO_PUBLIC_DEBUG = previousDebug;
        }
    });

    it('mounts terminal approval once when a terminal receipt, session link, and setup are present', async () => {
        isAuthenticated = false;
        const Screen = (await import('@/app/(app)/index')).Home;
        const { RootLayoutNavigationEffects } = await import('@/components/navigation/root/RootLayoutNavigationEffects');
        const { default: TerminalConnect } = await import('@/app/(app)/terminal/connect');
        seedSetupIntent({ branch: 'thisComputer', phase: 'awaiting_auth', relayUrl: HOME_A_URL });
        expect(pendingSetup.getPendingSetupIntent()?.phase).toBe('awaiting_auth');
        expoRouterMock.spies.replace.mockClear();
        pendingTerminal.setPendingTerminalConnect({
            publicKeyB64Url: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            serverUrl: HOME_A_URL,
            serverIdentityId: HOME_A_ID,
        });
        expect(pendingTerminal.getPendingTerminalConnect()).not.toBeNull();
        routeParamsState.value = { id: 'session-1' };
        const screen = await renderRoute(
            <LandingRouter Screen={Screen} destinations={{ '/terminal/connect': TerminalConnect }}>
                <SignInAtCredentialBoundary />
                <RootLayoutNavigationEffects />
            </LandingRouter>,
        );
        expect(expoRouterMock.spies.replace).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('complete-interactive-sign-in');
        await vi.waitFor(() => expect(screen.findByTestId('terminal-connect-approve')).not.toBeNull());

        expect(screen.findAllByType(MainView)).toHaveLength(0);
        expect(expoRouterMock.spies.replace.mock.calls).toEqual([['/terminal/connect']]);
        expect(pendingSetup.getPendingSetupIntent()?.phase).toBe('awaiting_auth');
        expect(setPendingSetupIntentMock).not.toHaveBeenCalledWith(expect.objectContaining({ phase: 'post_auth' }));
    });
});
