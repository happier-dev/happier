import React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// These scenarios exercise the Cloud distributor; an unconfigured build has no hosted defaults.
vi.hoisted(() => vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_DEFAULT_PROFILE_JSON', JSON.stringify({
    home: { url: 'https://api.happier.dev' },
    accountService: { url: 'https://api.happier.dev' },
})));

import { createRootLayoutFeaturesResponse, flushHookEffects, renderHook, renderScreen as renderScreenWithProviders, standardCleanup } from '@/dev/testkit';
import type { IModal } from '@/modal';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';
import type { AuthEntryOptions } from '@/components/account/auth/useAuthEntryOptions';
import type { HomeAuthenticationAction } from '@/auth/capabilities/authMethodCapabilities';

import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@/utils/web/reactDomCjs', async () =>
    (await import('@/dev/testkit/mocks/reactDomCjs')).createReactDomCjsRendererMock());
installDisconnectedServerSocketBoundary();

const reactNativeMockState = vi.hoisted(() => ({
    os: 'web' as 'web' | 'ios' | 'android',
}));



const desktopHostMockState = vi.hoisted(() => ({
    kind: 'tauri' as 'tauri' | 'electron' | null,
}));

function directChildTestIDs(node: { props: { children?: React.ReactNode } } | null | undefined): string[] {
    return React.Children.toArray(node?.props.children)
        .map((child) => {
            if (!React.isValidElement<{ testID?: string; testIDPrefix?: string }>(child)) {
                return null;
            }
            if (typeof child.props.testID === 'string') {
                return child.props.testID;
            }
            if (typeof child.props.testIDPrefix === 'string') {
                return `${child.props.testIDPrefix}-download-cta`;
            }
            return null;
        })
        .filter((testID): testID is string => typeof testID === 'string');
}

function findAllInCurrentWizardBodyByType(screen: Readonly<{
    findByTestId: (testID: string) => ReactTestInstance | null;
    findAllByType: (type: never) => ReactTestInstance[];
}>, type: never): ReactTestInstance[] {
    const layer = screen.findByTestId('onboarding-wizard-body-transition-current-layer');
    if (!layer) return screen.findAllByType(type);
    // React collapses a simple memo wrapper to its inner component fiber, as the screen queries do.
    const exact = layer.findAllByType(type);
    const memo = type as { $$typeof?: symbol; type?: unknown } | null;
    return exact.length === 0 && memo?.$$typeof === Symbol.for('react.memo') && memo.type
        ? layer.findAllByType(memo.type as never)
        : exact;
}

const expoRouterSpies = vi.hoisted(() => ({
    push: vi.fn(),
    replace: vi.fn(),
}));

const modalConfirmMock = vi.hoisted(() => vi.fn(async (_title?: string, _message?: string, _options?: unknown) => true));
const runtimeFetchMock = vi.hoisted(() => vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>());
const nativeTaskScene = vi.hoisted(() => ({
    nextResult: null as import('@happier-dev/protocol').SystemTaskResult | null,
    specs: [] as Array<import('@happier-dev/protocol').SystemTaskSpec & { taskId: string }>,
    /** The relay access provider the fixture's OS has been configured with (what a configure task persists). */
    relayAccessProviderId: null as string | null,
}));
const nativeSecureStore = vi.hoisted(() => new Map<string, string>());

// The real production singleton constructs its runner over the canonical native process boundary.
vi.mock('@/components/systemTasks/createSystemTaskBridge', () => ({ createSystemTaskBridge: () => nativeTasks.bridge }));

installTokenStorageWebPlatformMocks({
    // This file switches to iOS as well as exercising the browser credential port.
    secureStore: () => ({
        getItemAsync: async (key: string) => nativeSecureStore.get(key) ?? null,
        setItemAsync: async (key: string, value: string) => { nativeSecureStore.set(key, value); },
        deleteItemAsync: async (key: string) => { nativeSecureStore.delete(key); },
    }),
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
            Platform: {
                get OS() {
                    return reactNativeMockState.os;
                },
            },
            AppState: {
                currentState: 'active',
                addEventListener: vi.fn(() => ({ remove: vi.fn() })),
            },
        });
    },
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ params: {}, router: expoRouterSpies }).module;
});
vi.mock('@/utils/platform/desktopHost', async importOriginal => ({
    ...await importOriginal<typeof import('@/utils/platform/desktopHost')>(),
    desktopHostKind: () => desktopHostMockState.kind,
    isDesktopHost: () => desktopHostMockState.kind !== null,
}));
vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));
vi.mock('@expo/vector-icons/Ionicons', () => ({
    default: 'Ionicons',
    Ionicons: 'Ionicons',
}));
const modalShowMock = vi.hoisted(() => vi.fn<IModal['show']>((config) => {
    queueMicrotask(() => config.onRequestClose?.());
    return 'wizard-modal';
}));
const modalAlertAsyncMock = vi.hoisted(() => vi.fn<IModal['alertAsync']>());

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            show: modalShowMock,
            confirm: (title, message, options) => modalConfirmMock(title, message, options),
            alert: () => undefined,
            alertAsync: modalAlertAsyncMock,
        },
    }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => {
            if (!params) return key;
            const values = Object.values(params)
                .map((value) => String(value))
                .join(' ');
            return values ? `${key} ${values}` : key;
        },
    });
});
vi.mock('@/text/i18n', () => ({
    DEFAULT_LANGUAGE: 'en',
    SUPPORTED_LANGUAGE_CODES: ['en'],
    SUPPORTED_LANGUAGES: { en: { code: 'en', nativeName: 'English', englishName: 'English' } },
    getAllTranslationKeys: () => [],
    getLanguageEnglishName: () => 'English',
    getLanguageNativeName: () => 'English',
    getPreferredLanguage: () => 'en',
    getTranslationValue: () => undefined,
    hasTranslation: () => false,
    setPreferredLanguageFromSettings: () => undefined,
    t: (key: string, params?: Record<string, unknown>) => {
        if (!params) return key;
        const values = Object.values(params)
            .map((value) => String(value))
            .join(' ');
        return values ? `${key} ${values}` : key;
    },
    tLoose: (key: string) => key,
}));

const configuredServerEnvKeys = [
    'EXPO_PUBLIC_HAPPIER_SERVER_URL', 'EXPO_PUBLIC_HAPPY_SERVER_URL', 'EXPO_PUBLIC_SERVER_URL',
    'EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS', 'EXPO_PUBLIC_HAPPY_SERVER_CONTEXT',
] as const;
const originalServerEnvironment = new Map(configuredServerEnvKeys.map(key => [key, process.env[key]]));
for (const key of configuredServerEnvKeys) process.env[key] = '';

const { createManualSystemTaskBridge } = await import('@/dev/testkit/harness/manualSystemTaskRunner');
const nativeTasks = createManualSystemTaskBridge();
const startNativeTask = nativeTasks.bridge.start.getMockImplementation()!;
const subscribeNativeTask = nativeTasks.bridge.subscribe.getMockImplementation()!;
nativeTasks.bridge.start.mockImplementation(async (spec) => {
    const taskId = await startNativeTask(spec);
    nativeTaskScene.specs.push({ ...spec, taskId });
    return taskId;
});
const relayAccessSnapshot = (providerId: string | null): import('@happier-dev/protocol').SystemTaskJsonValue => providerId
    ? { configured: true, providerId, status: { state: 'enabled', shareUrl: null } }
    : { configured: false, providerId: null, status: { state: 'disabled', shareUrl: null } };
nativeTasks.bridge.subscribe.mockImplementation(async (taskId, listener) => {
    const dispose = await subscribeNativeTask(taskId, listener);
    const spec = nativeTaskScene.specs.find(entry => entry.taskId === taskId);
    const data: import('@happier-dev/protocol').SystemTaskJsonValue = spec?.kind === 'relay.runtime.status.v1' ? {
        installed: true, dataPresent: true, healthy: true, relayUrl: 'http://localhost:31337',
        service: { active: true, enabled: true },
    } : spec?.kind === 'daemon.service.status.v1' ? {
        serviceInstalled: false, daemonRunning: false, needsAuth: false, machineId: null,
    } : spec?.kind === 'daemon.service.relay.disconnect.v1' ? { outcome: 'no_service' }
        : spec?.kind === 'relay.access.configure.v1' && spec.params && typeof spec.params === 'object' && 'providerId' in spec.params && typeof spec.params.providerId === 'string'
            ? relayAccessSnapshot(nativeTaskScene.relayAccessProviderId = spec.params.providerId)
        : spec?.kind === 'relay.access.status.v1' ? relayAccessSnapshot(nativeTaskScene.relayAccessProviderId)
        : spec?.kind === 'local.ssh.discoverConfiguredHosts.v1' ? { hosts: [] }
        : null;
    const result = spec?.kind === 'tailscale.ensureReady.v1' ? nativeTaskScene.nextResult : null;
    if (result || data) queueMicrotask(() => nativeTasks.emitResult(taskId,
        result ? { ...result, taskId } : { protocolVersion: 1, taskId, ok: true, data },
    ));
    return dispose;
});

// Install transport/platform ports before evaluating the actual Home and UI graph.
const { createHomeGovernanceHarness, installHomeGovernanceBoundaries } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const profiles = await import('@/sync/domains/server/serverProfiles');
const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const { storage } = await import('@/sync/domains/state/storageStore');
const { WizardModalShell } = await import('../ui/WizardModalShell');
const { WizardChoiceRow } = await import('../ui/WizardChoiceRow');
const { clearPendingSetupIntent, getPendingSetupIntent } = await import('@/sync/domains/pending/pendingSetupIntent');
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { RestoreIndexEmbedded } = await import('@/components/onboarding/restore/RestoreIndexEmbedded');
const { SecretKeyLoginEmbedded } = await import('@/components/onboarding/restore/SecretKeyLoginEmbedded');
const { RelayHostLocalChecklistStep } = await import('../checklists/relayHostLocal/RelayHostLocalChecklistStep');
const { RemoteSshChecklistStep } = await import('../checklists/remoteSsh/RemoteSshChecklistStep');
const { LocalRelayAccessControlSection } = await import('@/components/settings/server/localControl/LocalRelayAccessControlSection');
const { RelayAccessLanUrlStep } = await import('@/components/onboarding/steps/relayAccess/RelayAccessLanUrlStep');
const { RelayAccessCloudflareNamedTunnelStep } = await import('@/components/onboarding/steps/relayAccess/RelayAccessCloudflareNamedTunnelStep');
const { RelayAccessTailscalePrerequisitesStep } = await import('@/components/onboarding/steps/relayAccess/RelayAccessTailscalePrerequisitesStep');
await import('./OnboardingWizardSurface');
const initialStorageState = storage.getState();

function SignedOutAuth({ children }: React.PropsWithChildren) {
    return <AuthProvider initialCredentials={null}>{children}</AuthProvider>;
}

function renderScreen(element: React.ReactElement) {
    const props = element.props;
    if (props && typeof props === 'object' && 'isDesktopShell' in props && props.isDesktopShell === false) desktopHostMockState.kind = null;
    return renderScreenWithProviders(element, { wrapper: SignedOutAuth });
}

let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>> | null = null;
const savedHomes = new Map<string, ServerProfile>();
const originalStorageScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;

async function saveHomeProfiles(fixtures: readonly ServerProfile[]) {
    for (const fixture of fixtures) {
        const id = await homes.addHome({ name: fixture.name, serverUrl: fixture.serverUrl, accountId: null, active: false });
        const profile = profiles.getServerProfileById(id);
        if (!profile) throw new Error('The real profile owner did not save the Home');
        savedHomes.set(fixture.id, profile);
    }
}

function homeProfileRef(alias: string): string {
    if (alias === 'active') return profiles.getActiveServerSnapshot().serverId;
    return savedHomes.get(alias)?.id ?? alias;
}

function homeRowTestId(alias: string): string {
    return `onboarding-wizard-relay:profile:${homeProfileRef(alias)}`;
}

async function focusHomeAtAddress(serverUrl: string, name: string = serverUrl) {
    if (!serverUrl) return;
    let profile = profiles.resolveUniqueServerProfileByUrl(serverUrl);
    if (!profile) {
        const id = await homes.addHome({ name, serverUrl, accountId: null, active: false });
        profile = profiles.getServerProfileById(id);
    }
    if (!profile) throw new Error('The real profile owner did not save the focused Home');
    await profiles.setActiveServerId(profile.id, { scope: 'device' });
}

function expectFocusedHome(serverUrl: string) {
    expect(profiles.getActiveServerSnapshot().serverUrl).toBe(serverUrl);
    expect(profiles.resolveUniqueServerProfileByUrl(serverUrl)).not.toBeNull();
}

const baseHomeTarget = { kind: 'saved_profile', profileRef: 'relay-profile' } as const;
const generatedKeyAuthenticationAction = {
    method: { id: 'key_challenge', enabledActions: [{ id: 'provision', mode: 'keyed' }] },
    action: { id: 'provision', mode: 'keyed' },
    execution: { kind: 'generated_key' },
} satisfies HomeAuthenticationAction;
const baseAuthOptions = {
    authenticationCatalog: {
        provenance: 'structured',
        methods: [generatedKeyAuthenticationAction.method],
    },
    authenticationActions: [generatedKeyAuthenticationAction],
    keyChallengeV2Available: true,
    authEntryUnavailable: false,
    homeTarget: baseHomeTarget,
    homeLabel: 'Relay Home',
    observedHomeServerIdentityId: 'relay-profile',
    serverAvailability: 'ready' as const,
    serverUrlForCopy: 'https://relay.example.test',
    showAuthActions: true,
    retryServerCheck: vi.fn(),
} satisfies AuthEntryOptions;

describe('OnboardingWizardSurface', () => {
    beforeEach(async () => {
        nativeSecureStore.clear();
        browser = await installBrowserRuntimeForTests({ url: 'https://app.happier.dev' });
        // The desktop credential owner uses OS-protected storage even in a web renderer.
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: createDesktopSecureStorageBoundary().invoke });
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `wizard_${Date.now()}_${Math.random()}`;
        reactNativeMockState.os = 'web';
        for (const key of configuredServerEnvKeys) process.env[key] = '';

        desktopHostMockState.kind = 'tauri';
        // The real connection singleton survives each fixture browser/storage replacement.
        profiles.resetServerProfilesRuntimeForTests({ preserveGenerations: true });
        savedHomes.clear();
        await homes.reset();
        installHomeGovernanceBoundaries(homes);
        setRuntimeFetch((input, init) => runtimeFetchMock(input, init));
        runtimeFetchMock.mockReset().mockImplementation(async (input, init) => {
            const url = String(input);
            if (url.includes('https://unreachable-relay.example.test') && url.endsWith('/health')) return new Response(null, { status: 404 });
            if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) return Response.json({ status: 'ok' });
            if (url.endsWith('/v1/features') || url.endsWith('/v1/features/authenticated')) return Response.json(createRootLayoutFeaturesResponse());
            return homes.request(input, init);
        });
        await loadSyncSingletonForTests();
        clearPendingSetupIntent();
        nativeTaskScene.nextResult = null;
        nativeTaskScene.relayAccessProviderId = null;
        nativeTaskScene.specs.length = 0;
        nativeTasks.bridge.start.mockClear();
        nativeTasks.bridge.cancel.mockClear();
        nativeTasks.bridge.respond.mockClear();
        expoRouterSpies.push.mockReset();
        expoRouterSpies.replace.mockReset();



        modalConfirmMock.mockReset().mockResolvedValue(true);
        modalAlertAsyncMock.mockReset().mockResolvedValue();
        modalShowMock.mockClear();
        storage.setState(initialStorageState, true);
    });

    it('exposes wizard state and navigation through the controller hook', async () => {
        const { useOnboardingWizardController } = await import('./useOnboardingWizardController');
        const hook = await renderHook(() => useOnboardingWizardController({
            layout: 'portrait',
            isDesktopShell: true,
            authEntryOptions: baseAuthOptions,
            accountContinuationIntent: { kind: 'enter', target: { kind: 'automatic' } },
            onAccountDirectoryKeyResult: vi.fn(),
        }));

        let controller = hook.getCurrent();
        expect(controller.stepId).toBe('welcome');
        expect(controller.currentStepIndex).toBe(0);
        expect(controller.stepCount).toBeGreaterThan(1);
        expect(controller.title).toBe('setupOnboarding.welcomeTitle');
        expect(controller.showBack).toBe(false);
        expect(controller.onBack).toBeNull();
        expect(controller.skipLabel).toBe('common.start');
        expect(controller.body).toBeTruthy();

        await act(async () => {
            controller.goToStep('relay_select');
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        controller = hook.getCurrent();
        expect(controller.stepId).toBe('relay_select');
        expect(controller.contentTransitionDirection).toBe('forward');
        expect(controller.showBack).toBe(true);
        expect(controller.onBack).toEqual(expect.any(Function));
        expect(controller.skipLabel).toBe('common.skip');

        await act(async () => {
            controller.onBack?.();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        controller = hook.getCurrent();
        expect(controller.stepId).toBe('welcome');
        expect(controller.contentTransitionDirection).toBe('backward');
    });

    it('keeps the shared Open {Home} card when a Home sign-in from the wizard continuation enrolls the Home', async () => {
        const { useOnboardingWizardController } = await import('./useOnboardingWizardController');
        const { WelcomeDecisionPanel } = await import('../preAuth/WelcomeDecisionPanel');
        const { AccountDirectoryKeyLoginForm } = await import('@/components/account/auth/AccountDirectoryKeyLoginForm');
        const { AccountServiceHomeAuthenticationAdapter } = await import('@/components/account/auth/AccountServiceHomeAuthenticationAdapter');
        const { AccountServiceContinuation } = await import('@/components/account/auth/AccountServiceContinuation');
        type ElementWithProps = React.ReactElement<Record<string, unknown>>;
        const findElement = (node: React.ReactNode, type: unknown): ElementWithProps | null => {
            if (Array.isArray(node)) {
                for (const child of node) {
                    const found = findElement(child, type);
                    if (found) return found;
                }
                return null;
            }
            if (!React.isValidElement(node)) return null;
            const element = node as ElementWithProps;
            if (element.type === type) return element;
            return findElement(element.props.children as React.ReactNode, type);
        };
        const onAccountDirectoryKeyResult = vi.fn();
        const hook = await renderHook(() => useOnboardingWizardController({
            layout: 'portrait',
            isDesktopShell: true,
            authEntryOptions: baseAuthOptions,
            accountContinuationIntent: { kind: 'enter', target: { kind: 'automatic' } },
            onAccountDirectoryKeyResult,
        }));
        const welcome = findElement(hook.getCurrent().body, WelcomeDecisionPanel);
        await act(async () => {
            (welcome?.props.onContinueWithAccountServiceKey as (request: unknown) => void)({
                authority: { purpose: 'account_service', service: { endpointUrl: 'https://api.happier.dev', serverIdentityId: 'srv_cloud' } },
                execution: { kind: 'key_challenge' },
            });
        });
        await flushHookEffects({ cycles: 2, turns: 2 });
        const keyForm = findElement(hook.getCurrent().body, AccountDirectoryKeyLoginForm);
        const input = { intent: { kind: 'enter', target: { kind: 'automatic' } } };
        await act(async () => {
            (keyForm?.props.onOpenHomeAuthentication as (input: unknown, homeId: string, previous: unknown) => void)(
                input, 'home-b', { kind: 'explicit_target_not_linked', homeServerIdentityId: 'home-b' },
            );
        });
        await flushHookEffects({ cycles: 2, turns: 2 });
        const adapter = findElement(hook.getCurrent().body, AccountServiceHomeAuthenticationAdapter);
        expect(adapter).not.toBeNull();
        const result = { kind: 'home_enrolled', homeServerIdentityId: 'home-b' };
        await act(async () => {
            await (adapter?.props.onResult as (result: unknown, input?: unknown) => Promise<void>)(result, input);
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(onAccountDirectoryKeyResult).toHaveBeenCalledWith(result);
        // Shared host rule (shouldDismissAccountPostAuthContinuation): the wizard keeps the same
        // Open {Home} / Done card the account-entry route shows for this result.
        expect(findElement(hook.getCurrent().body, AccountServiceContinuation)?.props.result).toEqual(result);
        await hook.unmount();
    });

    it('labels the welcome action as start without retaining a duplicate relay next action', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
            }),
        );

        expect(screen.findByType(WizardModalShell as never).props.skipLabel).toBe('common.start');

        const startButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await startButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByType(WizardModalShell as never).props.skipLabel).toBe('common.skip');
        expect(screen.findByTestId('onboarding-wizard-skip')).toBeNull();
    });

    it('passes backward transition direction when returning to an earlier wizard step', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
            }),
        );

        const startButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await startButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByType(WizardModalShell as never).props.contentTransitionDirection).toBe('forward');

        const backButton = screen.findByTestId('onboarding-wizard-back')!;
        await act(async () => {
            await backButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByType(WizardModalShell as never).props.contentTransitionDirection).toBe('backward');
    });

    it('renders a shell chrome accessory when the pre-auth host provides one', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface as any, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                shellChrome: React.createElement('ShellChrome'),
            }),
        );

        expect(screen.findAllByType('ShellChrome' as never)).toHaveLength(1);
    });

    it('renders the current body without WizardModalShell in bare chrome mode', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                wizardChromeMode: 'bare',
                authEntryOptions: baseAuthOptions,
            }),
        );

        expect(screen.findAllByType(WizardModalShell as never)).toHaveLength(0);
        expect(screen.findByTestId('welcome-decision-panel')).toBeTruthy();
    });

    it('keeps non-welcome bare steps inside the workflow pane with heading plus primary action', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                wizardChromeMode: 'bare',
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
            }),
        );

        expect(screen.findAllByType(WizardModalShell as never)).toHaveLength(0);
        expect(screen.findByTestId('onboarding-wizard-bare-title')).toBeTruthy();
        expect(screen.getTextContent()).toContain('setupOnboarding.preAuthTitle');
        expect(screen.findByTestId('onboarding-wizard-primary')).toBeTruthy();
    });

    it('keeps the primary action as the only relay-selection advance affordance in bare mode', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                wizardChromeMode: 'bare',
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
            }),
        );

        expect(screen.findByTestId('onboarding-wizard-primary')).toBeTruthy();
        expect(screen.findByTestId('onboarding-wizard-skip')).toBeNull();
    });

    it('uses the physical screen size (not the window size) for web QR-scanner heuristics on desktop shells', async () => {
        const originalScreen = (globalThis as unknown as { screen?: unknown }).screen;
        Object.defineProperty(globalThis, 'screen', {
            value: { width: 1440, height: 900, availWidth: 1440, availHeight: 900 },
            configurable: true,
        });

        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn() } });
        Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone' });

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'auth',
                authEntryOptions: baseAuthOptions,
            }),
        );

        const { WelcomeDecisionPanel } = await import('../preAuth/WelcomeDecisionPanel');
        expect(screen.findByType(WelcomeDecisionPanel as never).props.canScanQr).toBe(false);

        Object.defineProperty(globalThis, 'screen', { value: originalScreen, configurable: true });
    });

    it('routes relay access LAN choice to the shared prereqs step', async () => {




        await focusHomeAtAddress('http://127.0.0.1:3005');
        {
            const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
            const screen = await renderScreen(
                React.createElement(OnboardingWizardSurface, {
                    layout: 'portrait',
                    isDesktopShell: true,
                    initialStepId: 'relay_select',
                    authEntryOptions: baseAuthOptions,
                }),
            );

            await pressOnboarding(screen, 'onboarding-wizard-relay:thisComputer');
            await pressOnboarding(screen, 'onboarding-wizard-primary');
            await pressOnboarding(screen, 'onboarding-wizard-primary');
            expect(screen.findByType(WizardModalShell as never).props.title).toBe('setupOnboarding.relayAccessWizardTitle');
            expect(screen.findByType(LocalRelayAccessControlSection as never)?.props).toBeTruthy();
            expect(typeof (screen.findByType(LocalRelayAccessControlSection as never)?.props as any)?.onWizardRequestProviderDetails).toBe('function');

            await act(async () => {
                (screen.findByType(LocalRelayAccessControlSection as never)?.props as any)?.onWizardRequestProviderDetails?.('lan');
            });
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(screen.findByType(WizardModalShell as never).props.title).toBe('setupOnboarding.relayAccessWizardTitle');
            expect(screen.findAllByType(RelayAccessLanUrlStep as never)).toHaveLength(1);
        }
    });

    it('keeps relay access wizard callbacks stable across parent rerenders', async () => {
        await focusHomeAtAddress('https://api.happier.dev');
        browser?.reconfigureUrl('http://localhost:53288');

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
            }),
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        await pressOnboarding(screen, 'onboarding-wizard-relay:thisComputer');
        await pressOnboarding(screen, 'onboarding-wizard-primary');
        await pressOnboarding(screen, 'onboarding-wizard-primary');

        const firstProps = screen.findByType(LocalRelayAccessControlSection as never)?.props as {
            onWizardSelectedProviderIdChange: unknown;
            onWizardRequestProviderDetails: unknown;
        } | null;
        expect(firstProps).toBeTruthy();

        await act(async () => {
            (firstProps?.onWizardSelectedProviderIdChange as ((providerId: 'lan' | 'cloudflareNamed') => void) | undefined)?.('cloudflareNamed');
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const nextProps = screen.findByType(LocalRelayAccessControlSection as never)?.props as {
            onWizardSelectedProviderIdChange: unknown;
            onWizardRequestProviderDetails: unknown;
        } | null;
        expect(nextProps).toBeTruthy();
        expect(nextProps?.onWizardSelectedProviderIdChange).toBe(firstProps?.onWizardSelectedProviderIdChange);
        expect(nextProps?.onWizardRequestProviderDetails).toBe(firstProps?.onWizardRequestProviderDetails);
        expect(screen.findByType(LocalRelayAccessControlSection as never).props.wizardSelectedProviderId).toBe('cloudflareNamed');
        expect((nextProps as { serverProfileId?: unknown } | null)?.serverProfileId).toEqual(expect.any(String));

        const localRelayAccessSection = screen.findByType(LocalRelayAccessControlSection as never) as unknown as {
            props: React.ComponentProps<typeof LocalRelayAccessControlSection>;
        };
        expect(localRelayAccessSection).toBeTruthy();
        expect(localRelayAccessSection.props.target).toEqual({ kind: 'local' });
    });

    it('settles after a single relay access provider sync effect', async () => {
        await focusHomeAtAddress('https://api.happier.dev');
        browser?.reconfigureUrl('http://localhost:53288');



        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
            }),
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        await pressOnboarding(screen, 'onboarding-wizard-relay:thisComputer');
        await pressOnboarding(screen, 'onboarding-wizard-primary');
        await pressOnboarding(screen, 'onboarding-wizard-primary');

        const localRelayAccessSection = screen.findByType(LocalRelayAccessControlSection as never) as unknown as {
            props: React.ComponentProps<typeof LocalRelayAccessControlSection>;
        };
        expect(localRelayAccessSection).toBeTruthy();
        expect(localRelayAccessSection.props.target).toEqual({ kind: 'local' });
        const selectedProvider = localRelayAccessSection.props.wizardSelectedProviderId;
        expect(selectedProvider).toBe('localOnly');
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(screen.findByType(LocalRelayAccessControlSection as never).props.wizardSelectedProviderId).toBe(selectedProvider);
    });

    it('routes relay access Cloudflare choice to the shared prereqs step', async () => {




        await focusHomeAtAddress('http://127.0.0.1:3005');
        {
            const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
            const screen = await renderScreen(
                React.createElement(OnboardingWizardSurface, {
                    layout: 'portrait',
                    isDesktopShell: true,
                    initialStepId: 'relay_select',
                    authEntryOptions: baseAuthOptions,
                }),
            );

            await pressOnboarding(screen, 'onboarding-wizard-relay:thisComputer');
            await pressOnboarding(screen, 'onboarding-wizard-primary');
            await pressOnboarding(screen, 'onboarding-wizard-primary');
            expect(screen.findByType(WizardModalShell as never).props.title).toBe('setupOnboarding.relayAccessWizardTitle');
            expect(screen.findByType(LocalRelayAccessControlSection as never)?.props).toBeTruthy();
            expect(typeof (screen.findByType(LocalRelayAccessControlSection as never)?.props as any)?.onWizardRequestProviderDetails).toBe('function');

            await act(async () => {
                (screen.findByType(LocalRelayAccessControlSection as never)?.props as any)?.onWizardRequestProviderDetails?.('cloudflareNamed');
            });
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(screen.findByType(WizardModalShell as never).props.title).toBe('setupOnboarding.relayAccessWizardTitle');
            expect(screen.findAllByType(RelayAccessCloudflareNamedTunnelStep as never)).toHaveLength(1);
        }
    });

    it.each([
        'tailscaleServe',
        'tailscaleFunnel',
    ] as const)('routes relay access %s choice to the shared prereqs step', async (providerId) => {




        await focusHomeAtAddress('http://127.0.0.1:3005');
        {
            const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
            const screen = await renderScreen(
                React.createElement(OnboardingWizardSurface, {
                    layout: 'portrait',
                    isDesktopShell: true,
                    initialStepId: 'relay_select',
                    authEntryOptions: baseAuthOptions,
                }),
            );

            await pressOnboarding(screen, 'onboarding-wizard-relay:thisComputer');
            await pressOnboarding(screen, 'onboarding-wizard-primary');
            await pressOnboarding(screen, 'onboarding-wizard-primary');
            expect(screen.findByType(WizardModalShell as never).props.title).toBe('setupOnboarding.relayAccessWizardTitle');
            expect(screen.findByType(LocalRelayAccessControlSection as never)?.props).toBeTruthy();
            expect(typeof (screen.findByType(LocalRelayAccessControlSection as never)?.props as any)?.onWizardRequestProviderDetails).toBe('function');

            await act(async () => {
                (screen.findByType(LocalRelayAccessControlSection as never)?.props as any)?.onWizardRequestProviderDetails?.(providerId);
            });
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(screen.findByType(WizardModalShell as never).props.title).toBe('setupOnboarding.relayAccessWizardTitle');
            expect(screen.findByType(RelayAccessTailscalePrerequisitesStep as never).props.providerId).toBe(providerId);
        }
    });

    it('only marks Happier Cloud as recommended in the relay selection list', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
            }),
        );

        const startButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await startButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        const cloud = screen.findByProps({ testID: 'onboarding-wizard-relay:cloud' } as never);
        const thisComputer = screen.findByProps({ testID: 'onboarding-wizard-relay:thisComputer' } as never);
        const customUrl = screen.findByProps({ testID: 'onboarding-wizard-relay:customUrl' } as never);

        expect(cloud?.props.badge).toBe('setupOnboarding.recommendedBadge');
        expect(thisComputer?.props.badge).toBeUndefined();
        expect(customUrl?.props.badge).toBeUndefined();
    });

    it('hides Happier Cloud when setup surface policy denies it (no implicit profile creation)', async () => {
        const profilesBeforeRender = profiles.listServerProfiles();
        const previousDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'setup.relay.allowHappierCloud';
        try {
            const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
            const screen = await renderScreen(
                React.createElement(OnboardingWizardSurface, {
                    layout: 'portrait',
                    isDesktopShell: true,
                    initialStepId: 'relay_select',
                    authEntryOptions: baseAuthOptions,
                }),
            );

            expect(profiles.listServerProfiles()).toEqual(profilesBeforeRender);
            expect(screen.findByTestId('onboarding-wizard-relay:cloud')).toBeNull();
        } finally {
            if (previousDeny === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
            else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousDeny;
        }
    });

    it('shows Happier Cloud when allowed without creating a server profile during render', async () => {
        const profilesBeforeRender = profiles.listServerProfiles();
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
            }),
        );

        expect(screen.findByTestId('onboarding-wizard-relay:cloud')).toBeTruthy();
        expect(profiles.listServerProfiles()).toEqual(profilesBeforeRender);
    });

    it('creates the canonical cloud profile from welcome auth actions only after user intent', async () => {
        const profilesBeforeRender = profiles.listServerProfiles();
        await saveHomeProfiles([]);
        await focusHomeAtAddress('');

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
            }),
        );

        expect(profiles.listServerProfiles()).toEqual(profilesBeforeRender);

        await act(async () => {
            await screen.findByTestId('onboarding-wizard-primary')!.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        await act(async () => {
            await screen.findByTestId('onboarding-wizard-relay:cloud')!.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        await act(async () => {
            await screen.findByTestId('onboarding-wizard-back')!.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('welcome-decision-panel')).toBeTruthy();

        await act(async () => {
            await screen.findByTestId('welcome-scan-existing-home')!.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(profiles.resolveUniqueServerProfileByUrl('https://api.happier.dev')).not.toBeNull();
        expectFocusedHome('https://api.happier.dev');
        const cloud = profiles.resolveUniqueServerProfileByUrl('https://api.happier.dev');
        expect(cloud).not.toBeNull();
        expect(profiles.getActiveServerSnapshot().serverId).toBe(profiles.resolveServerProfileScopeId(cloud!));
        expect(profiles.listServerProfiles().filter(profile => profile.serverUrl === 'https://api.happier.dev')).toHaveLength(1);
    });

    it('hides manual relay URL entry when setup surface policy denies it', async () => {
        const previousDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'setup.relay.allowCustomRelayUrl';
        try {
            const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
            const screen = await renderScreen(
                React.createElement(OnboardingWizardSurface, {
                    layout: 'portrait',
                    isDesktopShell: true,
                    initialStepId: 'relay_select',
                    authEntryOptions: baseAuthOptions,
                }),
            );

            expect(screen.findByTestId('onboarding-wizard-relay:customUrl')).toBeNull();
        } finally {
            if (previousDeny === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
            else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousDeny;
        }
    });

    it('hides "This computer" relay hosting when setup surface policy denies local relay host', async () => {
        const previousDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'setup.relay.allowLocalRelayHost';
        try {
            const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
            const screen = await renderScreen(
                React.createElement(OnboardingWizardSurface, {
                    layout: 'portrait',
                    isDesktopShell: true,
                    initialStepId: 'relay_select',
                    authEntryOptions: baseAuthOptions,
                }),
            );

            expect(screen.findByTestId('onboarding-wizard-relay:thisComputer')).toBeNull();

            const authScreen = await renderScreen(
                React.createElement(OnboardingWizardSurface, {
                    layout: 'portrait',
                    isDesktopShell: true,
                    initialStepId: 'auth',
                    authEntryOptions: baseAuthOptions,
                }),
            );
            expect(authScreen.findByTestId('welcome-create-personal-home')).toBeNull();
        } finally {
            if (previousDeny === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
            else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousDeny;
        }
    });

    it('navigates back to the auth step from the restore step', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'auth_restore',
                authEntryOptions: baseAuthOptions,
            }),
        );

        expect(screen.findAllByType(RestoreIndexEmbedded as never)).toHaveLength(1);

        const backButton = screen.findByTestId('onboarding-wizard-back')!;
        await act(async () => {
            await backButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(findAllInCurrentWizardBodyByType(screen, RestoreIndexEmbedded as never)).toHaveLength(0);
        expect(screen.findByTestId('welcome-decision-panel')).toBeTruthy();
        expect(screen.findByTestId('onboarding-wizard-lost-access')).toBeTruthy();
    });

    it('disables every onboarding escape after the restore request crosses its authority boundary', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'auth_restore',
                authEntryOptions: baseAuthOptions,
            }),
        );

        const restoreStep = screen.findByType(RestoreIndexEmbedded as never) as unknown as ReactTestInstance;
        await act(async () => {
            (restoreStep.props as any).onNavigationLockChange?.(true);
        });

        expect(screen.findByTestId('onboarding-wizard-back')?.props.disabled).toBe(true);
        expect(screen.findByTestId('onboarding-wizard-skip')?.props.disabled).toBe(true);
    });

    it('treats skip on the restore QR step as an escape hatch back to auth', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'auth_restore',
                authEntryOptions: baseAuthOptions,
            }),
        );

        expect(screen.findAllByType(RestoreIndexEmbedded as never)).toHaveLength(1);

        const skipButton = screen.findByTestId('onboarding-wizard-skip')!;
        await act(async () => {
            await skipButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(findAllInCurrentWizardBodyByType(screen, RestoreIndexEmbedded as never)).toHaveLength(0);
        expect(findAllInCurrentWizardBodyByType(screen, SecretKeyLoginEmbedded as never)).toHaveLength(0);
        expect(screen.findByTestId('welcome-decision-panel')).toBeTruthy();
    });

    it('dispatches the exact selected Home authority without switching ambient focus', async () => {
        await focusHomeAtAddress('https://api.happier.dev');

        await saveHomeProfiles([
            {
                id: 'relay-b',
                name: 'Relay B',
                serverUrl: 'https://relay-b.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'manual',
            },
        ]);

        const selectedHomeTarget = { kind: 'saved_profile', profileRef: homeProfileRef('relay-b') } as const;
        const onContinueWithHomeAuthentication = vi.fn(async () => undefined);

        const focusBeforeAction = profiles.getActiveServerSnapshot();
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: {
                    ...baseAuthOptions,
                    homeTarget: selectedHomeTarget,
                    observedHomeServerIdentityId: homeProfileRef('relay-b'),
                },
                onContinueWithHomeAuthentication,
            }),
        );

        const startButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await startButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const relayRow = screen.findByTestId(homeRowTestId('relay-b'))!;
        await act(async () => {
            await relayRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const backButton = screen.findByTestId('onboarding-wizard-back')!;
        await act(async () => {
            await backButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('welcome-decision-panel')).toBeTruthy();

        await pressOnboarding(screen, 'welcome-primary-start');

        expect(profiles.getActiveServerSnapshot()).toMatchObject(focusBeforeAction);
        expect(onContinueWithHomeAuthentication).toHaveBeenCalledWith(
            expect.objectContaining({
                method: generatedKeyAuthenticationAction.method,
                action: generatedKeyAuthenticationAction.action,
                execution: generatedKeyAuthenticationAction.execution,
                authority: { purpose: 'home', target: selectedHomeTarget },
                intendedHome: selectedHomeTarget,
            }),
            expect.objectContaining({
                signal: expect.objectContaining({ aborted: false }),
            }),
        );
    });

    it('keeps welcome auth actions pinned to the explicit active relay instead of the configured default relay', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_SERVER_URL = 'http://127.0.0.1:3009';

        await focusHomeAtAddress('https://relay-override.example.test', 'Override Home');
        browser?.reconfigureUrl('https://app.happier.dev');

        const onContinueWithHomeAuthentication = vi.fn(async () => undefined);

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onContinueWithHomeAuthentication,
            }),
        );

        const relayLine = screen.findByTestId('onboarding-wizard-relay-hint-line')!;
        expect(String(relayLine.props.children)).toContain('Override Home');
        expect(String(relayLine.props.children)).not.toContain('127.0.0.1:3009');

        await act(async () => {
            await screen.findByTestId('welcome-primary-start')?.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expectFocusedHome('https://relay-override.example.test');
        expect(onContinueWithHomeAuthentication).toHaveBeenCalledWith(
            expect.objectContaining({
                execution: { kind: 'generated_key' },
                authority: { purpose: 'home', target: baseHomeTarget },
            }),
            expect.objectContaining({
                signal: expect.objectContaining({ aborted: false }),
            }),
        );
    });

    it('updates the active relay footer hint when the active server snapshot changes', async () => {
        await focusHomeAtAddress('https://relay.example.test', 'First Home');

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
            }),
        );
        await flushHookEffects({ cycles: 1, turns: 1 });
        expect(profiles.getActiveServerSnapshot().serverUrl).toBe('https://relay.example.test');

        const relayLine = screen.findByTestId('onboarding-wizard-relay-hint-line')!;
        expect(String(relayLine.props.children)).toContain('First Home');

        await focusHomeAtAddress('https://relay-other.example.test', 'Other Home');
        await act(async () => {
            // The real profile write above published its subscription.
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const updatedRelayLine = screen.findByTestId('onboarding-wizard-relay-hint-line')!;
        expect(String(updatedRelayLine.props.children)).toContain('Other Home');
    });

    afterEach(async () => {
        standardCleanup();
        await (await import('@/sync/runtime/orchestration/connectionManager')).disconnectActiveServerConnection();
        clearPendingSetupIntent();
        await homes.reset();
        storage.setState(initialStorageState, true);
        browser?.restore();
        browser = null;
        vi.unstubAllGlobals();
        for (const [key, value] of originalServerEnvironment) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        if (originalStorageScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = originalStorageScope;
    });

    it('updates the active relay row when the active server changes', async () => {
        await focusHomeAtAddress('https://relay.example.test');
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                initialStepId: 'relay_select',
            }),
        );

        const before = screen.findByProps({ testID: homeRowTestId('active') });
        expect(before.props.subtitle).toBe('https://relay.example.test');

        await act(async () => {
            await focusHomeAtAddress('https://relay-other.example.test');
            // The real profile write above published its subscription.
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const after = screen.findByProps({ testID: homeRowTestId('active') });
        expect(after.props.subtitle).toBe('https://relay-other.example.test');
    });

    it('stores an awaiting-auth resume intent when continuing past relay selection', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
            }),
        );

        const startButton = screen.findByTestId('onboarding-wizard-primary')!;

        await act(async () => {
            await startButton.props.onPress?.();
        });

        const continueButton = screen.findByTestId('onboarding-wizard-primary')!;

        await act(async () => {
            await continueButton.props.onPress?.();
        });

        expect(getPendingSetupIntent()).toEqual({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://api.happier.dev',
        });
    });

    it('treats the header start action as an alias for the primary welcome action', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
            }),
        );

        const skipButton = screen.findByTestId('onboarding-wizard-skip')!;

        await act(async () => {
            await skipButton.props.onPress?.();
        });

        expect(getPendingSetupIntent()).toBeNull();
        expect(screen.findByTestId('onboarding-wizard-relay:cloud')).toBeTruthy();
    });

    it('fast-paths from welcome to the restore login screen when a non-cloud relay is already selected', async () => {
        await focusHomeAtAddress('https://relay.example.test');

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
            }),
        );

        expect(screen.findAllByTestId('onboarding-wizard-primary')).toHaveLength(0);
        expect(screen.findByTestId('onboarding-wizard-relay-hint')).toBeTruthy();
        expect(screen.findByType(WizardModalShell as never).props.skipLabel).toBe('common.login');

        const loginButton = screen.findByTestId('onboarding-wizard-skip')!;
        await act(async () => {
            await loginButton.props.onPress?.();
        });

        expect(screen.findAllByType(RestoreIndexEmbedded as never)).toHaveLength(1);
        expect(getPendingSetupIntent()).toEqual({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
        });

        const backButton = screen.findByTestId('onboarding-wizard-back')!;
        await act(async () => {
            await backButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(findAllInCurrentWizardBodyByType(screen, RestoreIndexEmbedded as never)).toHaveLength(0);
        expect(screen.findByTestId('welcome-decision-panel')).toBeTruthy();
        expect(screen.findByTestId('onboarding-wizard-relay-hint')).toBeTruthy();
    });

    it('hides duplicate relay escape-hatch actions when the selected relay is unreachable on the welcome step', async () => {
        await focusHomeAtAddress('https://relay.example.test');

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: {
                    ...baseAuthOptions,
                    serverAvailability: 'unavailable',
                    serverUrlForCopy: 'https://relay.example.test',
                },
            }),
        );

        expect(screen.findAllByTestId('onboarding-wizard-primary')).toHaveLength(0);
        expect(screen.findByTestId('welcome-auth-blocked')).toBeTruthy();
    });

    it('renders the welcome body block and selected server hint with clear back navigation', async () => {
        await focusHomeAtAddress('http://localhost:31337');
        browser?.reconfigureUrl('http://localhost:31337');
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
            }),
        );

        expect(screen.findByTestId('welcome-decision-panel')).toBeTruthy();
        expect(screen.findByTestId('onboarding-wizard-logotype')).toBeTruthy();

        const startButton = screen.findByTestId('welcome-use-different-home')!;
        await act(async () => {
            await startButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const onThisComputerRow = screen.findByTestId('onboarding-wizard-relay:thisComputer')!;
        await act(async () => {
            await onThisComputerRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-relay-hint')).toBeTruthy();

        const continueToChecklistButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueToChecklistButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-back')).toBeTruthy();
    });

    it('aborts an admitted Welcome authentication action when the journey leaves', async () => {
        const onContinueWithHomeAuthentication = vi.fn((_request, context: { signal: AbortSignal }) => {
            return new Promise<void>(() => {});
        });
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(React.createElement(OnboardingWizardSurface, {
            layout: 'portrait',
            isDesktopShell: true,
            authEntryOptions: baseAuthOptions,
            onContinueWithHomeAuthentication,
        }));

        await act(async () => {
            void screen.findByTestId('welcome-primary-start')?.props.onPress?.();
            await Promise.resolve();
        });
        const actionSignal = onContinueWithHomeAuthentication.mock.calls[0]?.[1].signal;
        expect(actionSignal?.aborted).toBe(false);

        await screen.unmount();

        expect(actionSignal?.aborted).toBe(true);
    });

    it('uses the provider execution tuple for the New here primary action', async () => {
        await focusHomeAtAddress('https://relay.example.test');
        const onContinueWithHomeAuthentication = vi.fn();
        const providerAction = {
            method: { id: 'github', enabledActions: [{ id: 'provision', mode: 'keyed' }] },
            action: { id: 'provision', mode: 'keyed' },
            execution: { kind: 'oauth', providerId: 'github', mode: 'keyed' },
        } satisfies HomeAuthenticationAction;

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: {
                    ...baseAuthOptions,
                    authenticationCatalog: { provenance: 'structured', methods: [providerAction.method] },
                    authenticationActions: [providerAction],
                },
                onContinueWithHomeAuthentication,
            }),
        );

        await pressOnboarding(screen, 'welcome-primary-start');

        expect(onContinueWithHomeAuthentication).toHaveBeenCalledWith(
            expect.objectContaining({
                method: providerAction.method,
                action: providerAction.action,
                execution: providerAction.execution,
                authority: { purpose: 'home', target: baseHomeTarget },
            }),
            expect.objectContaining({
                signal: expect.objectContaining({ aborted: false }),
            }),
        );
    });

    it('uses the mTLS primary action for managed certificate login states', async () => {
        await focusHomeAtAddress('https://relay.example.test');
        const onContinueWithHomeAuthentication = vi.fn();
        const mtlsAction = {
            method: { id: 'mtls', enabledActions: [{ id: 'login', mode: 'keyless' }] },
            action: { id: 'login', mode: 'keyless' },
            execution: { kind: 'mtls' },
        } satisfies HomeAuthenticationAction;

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: {
                    ...baseAuthOptions,
                    authenticationCatalog: { provenance: 'structured', methods: [mtlsAction.method] },
                    authenticationActions: [mtlsAction],
                },
                onContinueWithHomeAuthentication,
            }),
        );

        expect(screen.findAllByTestId('welcome-primary-start')).toHaveLength(0);
        await act(async () => {
            await screen.findByTestId('welcome-mtls-primary')?.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(onContinueWithHomeAuthentication).toHaveBeenCalledWith(
            expect.objectContaining({
                method: mtlsAction.method,
                action: mtlsAction.action,
                execution: mtlsAction.execution,
                authority: { purpose: 'home', target: baseHomeTarget },
            }),
            expect.objectContaining({
                signal: expect.objectContaining({ aborted: false }),
            }),
        );
    });

    it('keeps restore navigation available while auth capability loading is unresolved', async () => {
        await focusHomeAtAddress('https://relay.example.test');

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: {
                    ...baseAuthOptions,
                    serverAvailability: 'loading',
                    showAuthActions: false,
                },
            }),
        );

        expect(screen.findByTestId('welcome-auth-loading')).toBeTruthy();
        expect(screen.findAllByTestId('welcome-primary-start')).toHaveLength(0);
        expect(screen.findAllByTestId('welcome-scan-existing-home').length).toBeGreaterThan(0);
    });

    it('shows welcome decision actions when the relay is already known', async () => {
        await focusHomeAtAddress('https://relay.example.test');
        await saveHomeProfiles([
            {
                id: 'cloud-profile',
                name: 'Happier Cloud',
                serverUrl: 'https://api.happier.dev',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'preconfigured',
            },
        ]);

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
            }),
        );

        expect(screen.findByTestId('welcome-decision-panel')).toBeTruthy();
        expect(screen.findByType(WizardModalShell as never).props.skipLabel).toBe('common.login');
        expect(screen.findAllByTestId('onboarding-wizard-primary')).toHaveLength(0);
        expect(screen.findByTestId('onboarding-wizard-relay-hint')).toBeTruthy();
    });

    it('shows auth actions on welcome after the user picks a saved relay and returns back to the intro', async () => {
        await focusHomeAtAddress('');

        await saveHomeProfiles([
            {
                id: 'relay-b',
                name: 'Relay B',
                serverUrl: 'https://relay-b.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'manual',
            },
        ]);

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
            }),
        );

        // Saving the first Home makes it the active Home; enter selection through
        // Welcome's actual change-Home action rather than its sign-in primary.
        const startButton = screen.findByTestId('welcome-use-different-home')!;
        await act(async () => {
            await startButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const relayRow = screen.findByTestId(homeRowTestId('relay-b'))!;
        await act(async () => {
            await relayRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const backButton = screen.findByTestId('onboarding-wizard-back')!;
        await act(async () => {
            await backButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('welcome-decision-panel')).toBeTruthy();
        expect(screen.findByTestId('onboarding-wizard-relay-hint')).toBeTruthy();
        expect(screen.findByType(WizardModalShell as never).props.skipLabel).toBe('common.login');
    });

    it('opens secret key login without waiting for a redundant active-server switch, then returns to restore and welcome', async () => {
        await focusHomeAtAddress('');

        await saveHomeProfiles([
            {
                id: 'relay-b',
                name: 'Relay B',
                serverUrl: 'https://relay-b.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'manual',
            },
        ]);


        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
            }),
        );

        const startButton = screen.findByTestId('welcome-use-different-home')!;
        await act(async () => {
            await startButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const relayRow = screen.findByTestId(homeRowTestId('relay-b'))!;
        await act(async () => {
            await relayRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const backButton = screen.findByTestId('onboarding-wizard-back')!;
        await act(async () => {
            await backButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('welcome-decision-panel')).toBeTruthy();

        await act(async () => {
            await screen.findByTestId('welcome-scan-existing-home')?.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const restoreStep = screen.findByType(RestoreIndexEmbedded as never) as unknown as ReactTestInstance;
        act(() => {
            void (restoreStep.props as any).onOpenSecretKeyLogin?.();
        });
        expect(screen.findAllByType(SecretKeyLoginEmbedded as never)).toHaveLength(1);

        const backFromSecretKey = screen.findByTestId('onboarding-wizard-back')!;
        await act(async () => {
            await backFromSecretKey.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(findAllInCurrentWizardBodyByType(screen, SecretKeyLoginEmbedded as never)).toHaveLength(0);
        await vi.waitFor(() => expect(findAllInCurrentWizardBodyByType(screen, RestoreIndexEmbedded as never)).toHaveLength(1));

        const backFromRestore = screen.findByTestId('onboarding-wizard-back')!;
        await act(async () => {
            await backFromRestore.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(findAllInCurrentWizardBodyByType(screen, RestoreIndexEmbedded as never)).toHaveLength(0);
        expect(screen.findByTestId('welcome-decision-panel')).toBeTruthy();
    });

    it('opens lost access without waiting for a redundant active-server switch', async () => {
        await focusHomeAtAddress('');

        await saveHomeProfiles([
            {
                id: 'relay-b',
                name: 'Relay B',
                serverUrl: 'https://relay-b.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'manual',
            },
        ]);


        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
            }),
        );

        await pressOnboarding(screen, 'welcome-use-different-home');
        const relayRow = screen.findByTestId(homeRowTestId('relay-b'))!;
        await act(async () => {
            await relayRow.props.onPress?.();
        });
        await pressOnboarding(screen, 'onboarding-wizard-primary');

        expect(getOnboardingStepId(screen)).toBe('auth');
        const lostAccess = screen.findByTestId('onboarding-wizard-lost-access')!;
        act(() => {
            void lostAccess.props.onPress?.();
        });

        expect(getOnboardingStepId(screen)).toBe('auth_lost_access');
    });

    it('only advances to relay URL entry after pressing Continue when selecting the custom relay option', async () => {
        await focusHomeAtAddress('https://api.happier.dev');

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                initialStepId: 'relay_select',
            }),
        );
        await flushHookEffects({ cycles: 1, turns: 1 });

        const customRelayRow = screen.findByTestId('onboarding-wizard-relay:customUrl')!;

        await act(async () => {
            await customRelayRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-relay-url-input')).toBeNull();

        const continueButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-relay-url-input')).not.toBeNull();
    });

    it('prefills the relay URL entry input with the currently selected relay URL when available', async () => {
        await focusHomeAtAddress('https://prefilled.relay.test');

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                initialStepId: 'relay_select',
            }),
        );
        await flushHookEffects({ cycles: 1, turns: 1 });

        const customRelayRow = screen.findByTestId('onboarding-wizard-relay:customUrl')!;
        await act(async () => {
            await customRelayRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const continueButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const relayInput = screen.findByTestId('onboarding-wizard-relay-url-input')!;
        expect(relayInput.props.value).toBe('https://prefilled.relay.test');
        expect(screen.findByTestId('onboarding-wizard-relay-url-label')?.props.children).toBe('setupOnboarding.customRelayUrlLabel');
        expect(relayInput.props).toMatchObject({
            accessibilityLabel: 'setupOnboarding.customRelayUrlLabel',
            accessibilityLabelledBy: 'onboarding-wizard-relay-url-label',
        });
    });

    it('routes the auth view change-relay action back to the wizard relay selection step', async () => {
        await focusHomeAtAddress('https://relay.example.test');

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'auth',
                authEntryOptions: baseAuthOptions,
            }),
        );

        await pressOnboarding(screen, 'welcome-use-different-home');

        expect(screen.findByTestId('onboarding-wizard-relay:cloud')).toBeTruthy();
    });

    it('threads Tauri Personal Home hosting capability to auth without opening setup', async () => {
        await focusHomeAtAddress('https://relay.example.test');

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'auth',
                authEntryOptions: baseAuthOptions,
            }),
        );

        expect(screen.findByTestId('welcome-create-personal-home')).toBeTruthy();

        expect(expoRouterSpies.push).not.toHaveBeenCalledWith('/setup');
    });

    it('does not advertise Personal Home hosting in the non-hosting Electron desktop shell', async () => {
        desktopHostMockState.kind = 'electron';
        await focusHomeAtAddress('https://relay.example.test');

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'auth',
                authEntryOptions: baseAuthOptions,
            }),
        );

        expect(screen.findByTestId('welcome-create-personal-home')).toBeNull();
    });

    type PreAuthMatrixPlatform = 'desktop' | 'web' | 'native';
    type RenderedOnboardingScreen = Awaited<ReturnType<typeof renderScreen>>;

    const setPreAuthMatrixPlatform = async (platform: PreAuthMatrixPlatform) => {
        desktopHostMockState.kind = platform === 'desktop' ? 'tauri' : null;
        reactNativeMockState.os = platform === 'native' ? 'ios' : 'web';
        await focusHomeAtAddress('https://api.happier.dev');
        browser?.reconfigureUrl('https://app.happier.dev');
    };

    const renderPreAuthRelayMatrix = async (platform: PreAuthMatrixPlatform) => {
        await setPreAuthMatrixPlatform(platform);
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        return renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: platform === 'desktop',
                authEntryOptions: baseAuthOptions,
                initialStepId: 'relay_select',
            }),
        );
    };

    const pressOnboarding = async (screen: RenderedOnboardingScreen, testID: string) => {
        if (testID === 'onboarding-wizard-primary' && screen.findAllByType(RelayHostLocalChecklistStep as never).length > 0) {
            // This fixture's OS status reply is healthy. Observe it before choosing Continue,
            // rather than starting an installation from the initial not-yet-inspected checklist.
            await vi.waitFor(() => expect(screen.getTextContent().match(/common\.done/g)?.length ?? 0).toBeGreaterThanOrEqual(2));
        }
        await vi.waitFor(() => {
            const node = screen.findByTestId(testID);
            expect(node).toBeTruthy();
            expect(node?.props.disabled === true || node?.props.accessibilityState?.disabled === true).toBe(false);
        });
        await screen.pressByTestIdAsync(testID);
        await flushHookEffects({ cycles: 2, turns: 2 });
    };

    const getOnboardingStepId = (screen: RenderedOnboardingScreen) => (
        screen.findByType(WizardModalShell as never).props.contentTransitionKey
    );

    it.each([
        { branch: 'cloud', platform: 'desktop', rowTestID: 'onboarding-wizard-relay:cloud', expectedStepId: 'auth' },
        { branch: 'cloud', platform: 'web', rowTestID: 'onboarding-wizard-relay:cloud', expectedStepId: 'auth' },
        { branch: 'cloud', platform: 'native', rowTestID: 'onboarding-wizard-relay:cloud', expectedStepId: 'auth' },
        { branch: 'local', platform: 'desktop', rowTestID: 'onboarding-wizard-relay:thisComputer', expectedStepId: 'host_relay_local' },
        { branch: 'local', platform: 'web', rowTestID: 'onboarding-wizard-relay:thisComputer', expectedStepId: 'desktop_handoff' },
        { branch: 'local', platform: 'native', rowTestID: 'onboarding-wizard-relay:thisComputer', expectedStepId: 'desktop_handoff' },
        { branch: 'remote', platform: 'desktop', rowTestID: 'onboarding-wizard-relay:remoteComputer', expectedStepId: 'host_relay_remote' },
    ] as const)('characterizes pre-auth relay advance: $branch on $platform', async (row) => {
        const screen = await renderPreAuthRelayMatrix(row.platform);

        await pressOnboarding(screen, row.rowTestID);
        await pressOnboarding(screen, 'onboarding-wizard-primary');

        expect(getOnboardingStepId(screen)).toBe(row.expectedStepId);
    });

    it.each([
        ['web', 'web'],
        ['native', 'native'],
    ] as const)('characterizes pre-auth remote relay hosting as unavailable on %s', async (_label, platform) => {
        const screen = await renderPreAuthRelayMatrix(platform);

        expect(screen.findByTestId('onboarding-wizard-relay:remoteComputer')).toBeNull();
        expect(getOnboardingStepId(screen)).toBe('relay_select');
    });

    it.each([
        ['desktop', 'desktop'],
        ['web', 'web'],
        ['native', 'native'],
    ] as const)('characterizes manual custom relay URL unset vs set on %s', async (_label, platform) => {
        const screen = await renderPreAuthRelayMatrix(platform);

        await pressOnboarding(screen, 'onboarding-wizard-relay:customUrl');
        await pressOnboarding(screen, 'onboarding-wizard-primary');
        expect(getOnboardingStepId(screen)).toBe('relay_enter_url');

        const relayInput = screen.findByTestId('onboarding-wizard-relay-url-input');
        expect(relayInput).toBeTruthy();
        await act(async () => {
            relayInput?.props.onChangeText?.(`https://${platform}.custom-relay.example.test`);
        });
        await pressOnboarding(screen, 'onboarding-wizard-primary');

        // Connecting a typed address probes the Home before the wizard advances.
        await vi.waitFor(() => expect(getOnboardingStepId(screen)).toBe('auth'));
        expectFocusedHome(`https://${platform}.custom-relay.example.test`);
    });

    it.each([
        ['desktop', 'desktop'],
        ['web', 'web'],
        ['native', 'native'],
    ] as const)('characterizes saved relay profile selection on %s', async (_label, platform) => {
        await saveHomeProfiles([
            {
                id: `saved-${platform}`,
                name: `${platform} saved relay`,
                serverUrl: `https://${platform}.saved-relay.example.test`,
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'manual',
            },
        ]);
        const screen = await renderPreAuthRelayMatrix(platform);

        await pressOnboarding(screen, homeRowTestId(`saved-${platform}`));
        await pressOnboarding(screen, 'onboarding-wizard-primary');

        expect(getOnboardingStepId(screen)).toBe('auth');
        expectFocusedHome(`https://${platform}.saved-relay.example.test`);
    });

    it('continues from the default active saved relay without reactivating it', async () => {
        const activeRelayUrl = 'http://happier-repo-dev-a1cc5e0671.localhost:53288';
        await setPreAuthMatrixPlatform('web');
        await focusHomeAtAddress(activeRelayUrl);
        browser?.reconfigureUrl(activeRelayUrl);
        await saveHomeProfiles([
            {
                id: 'active-local-relay',
                name: 'happier-repo-dev-a1cc5e0671',
                serverUrl: activeRelayUrl,
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'manual',
            },
        ]);

        const focusBeforeAction = profiles.getActiveServerSnapshot();
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            <OnboardingWizardSurface
                layout="portrait"
                isDesktopShell={false}
                authEntryOptions={baseAuthOptions}
                initialStepId="relay_select"
            />,
        );

        await pressOnboarding(screen, 'onboarding-wizard-primary');

        expect(getOnboardingStepId(screen)).toBe('auth');
        expect(profiles.getActiveServerSnapshot()).toMatchObject(focusBeforeAction);
    });

    it.each([
        ['web', 'web'],
        ['native', 'native'],
    ] as const)('characterizes Phase-0 fixed %s this-computer URL handoff route', async (_label, platform) => {
        const screen = await renderPreAuthRelayMatrix(platform);

        await pressOnboarding(screen, 'onboarding-wizard-relay:thisComputer');
        await pressOnboarding(screen, 'onboarding-wizard-primary');
        expect(getOnboardingStepId(screen)).toBe('desktop_handoff');

        await pressOnboarding(screen, 'onboarding-wizard-primary');
        expect(getOnboardingStepId(screen)).toBe('relay_enter_url');

        const relayInput = screen.findByTestId('onboarding-wizard-relay-url-input');
        expect(relayInput).toBeTruthy();
        await act(async () => {
            relayInput?.props.onChangeText?.(`https://${platform}.local-relay.example.test`);
        });
        await pressOnboarding(screen, 'onboarding-wizard-primary');

        await vi.waitFor(() => expect(getOnboardingStepId(screen)).toBe('background_service_handoff'));

        await pressOnboarding(screen, 'onboarding-wizard-primary');
        expect(getOnboardingStepId(screen)).toBe('auth');
    });

    it('still routes desktop users to the local relay hosting checklist when selecting "On this computer" and the local relay bind URL is reachable', async () => {
        await focusHomeAtAddress('https://api.happier.dev');
        browser?.reconfigureUrl('http://localhost:53288');

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                initialStepId: 'relay_select',
            }),
        );

        await flushHookEffects({ cycles: 2, turns: 2 });

        const thisComputerRow = screen.findByTestId('onboarding-wizard-relay:thisComputer')!;
        await act(async () => {
            await thisComputerRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        const continueButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-relay-host-local')).toBeTruthy();
        expect(screen.findAllByType(LocalRelayAccessControlSection as never)).toHaveLength(0);
    });

    it('treats native as a handoff flow: enables "On your computer" and routes to the handoff step', async () => {
        reactNativeMockState.os = 'ios';

        await focusHomeAtAddress('https://api.happier.dev');
        browser?.reconfigureUrl('https://app.happier.dev');

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: false,
                authEntryOptions: baseAuthOptions,
                initialStepId: 'relay_select',
            }),
        );

        const thisComputerRow = screen.findByProps({ testID: 'onboarding-wizard-relay:thisComputer' });
        expect(thisComputerRow.props.disabled).toBe(false);
        expect(thisComputerRow.props.title).toBe('setupOnboarding.relayOnYourComputerTitle');

        await act(async () => {
            await thisComputerRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const continueButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-desktop-handoff')).toBeTruthy();
    });

    it.each([
        ['web', 'web' as const],
        ['native', 'ios' as const],
    ])('routes %s users through background service handoff after saving a relay url from the "On this computer" handoff', async (_label, os) => {
        reactNativeMockState.os = os;

        await focusHomeAtAddress('https://api.happier.dev');
        browser?.reconfigureUrl('https://app.happier.dev');

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: false,
                authEntryOptions: baseAuthOptions,
                initialStepId: 'relay_select',
            }),
        );

        const thisComputerRow = screen.findByTestId('onboarding-wizard-relay:thisComputer')!;
        await act(async () => {
            await thisComputerRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const continueToPlanButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueToPlanButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-desktop-handoff')).toBeTruthy();

        const handoffContinueButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await handoffContinueButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const relayInput = screen.findByTestId('onboarding-wizard-relay-url-input')!;
        await act(async () => {
            relayInput.props.onChangeText?.('https://relay.local.test');
        });

        const saveRelayButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await saveRelayButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 4, turns: 4 });

        await vi.waitFor(() => expect(screen.findByTestId('onboarding-wizard-background-service-handoff')).not.toBeNull());
        const backgroundServiceHandoff = screen.findByTestId('onboarding-wizard-background-service-handoff');
        expect(backgroundServiceHandoff).not.toBeNull();
        expect(directChildTestIDs(backgroundServiceHandoff).slice(0, 2)).toEqual([
            'onboarding-wizard-background-service-arrival',
            'onboarding-wizard-background-service-desktop-app-download-cta',
        ]);
        expect(screen.findByTestId('onboarding-wizard-background-service-arrival')).not.toBeNull();
        expect(screen.findByTestId('machine-arrival-card-status')).toBeNull();
        expect(screen.findByTestId('onboarding-wizard-background-service-desktop-app-download-cta')).not.toBeNull();
        expect(screen.getTextContent()).toContain('setupOnboarding.machineArrival.detectedAfterSignIn');
        expect(screen.findByTestId('onboarding-wizard-lost-access')).toBeNull();

        const advanceToAuthButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await advanceToAuthButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-lost-access')).not.toBeNull();
    });

    it('skips relay URL entry when a custom relay has already been resolved', async () => {
        await focusHomeAtAddress('https://api.happier.dev');

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                initialStepId: 'relay_select',
            }),
        );
        await flushHookEffects({ cycles: 1, turns: 1 });

        const customRelayRow = screen.findByTestId('onboarding-wizard-relay:customUrl')!;
        await act(async () => {
            await customRelayRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const continueToUrlEntry = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueToUrlEntry.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const relayInput = screen.findByTestId('onboarding-wizard-relay-url-input')!;
        await act(async () => {
            relayInput.props.onChangeText?.('https://custom.relay.test');
        });

        const saveRelayButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await saveRelayButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        // Connecting the typed address probes the Home before the wizard advances.
        await vi.waitFor(() => expect(screen.findByTestId('onboarding-wizard-lost-access')).not.toBeNull());

        const backButton = screen.findByTestId('onboarding-wizard-back')!;
        await act(async () => {
            await backButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-relay:customUrl')).not.toBeNull();

        const activeRelayRow = screen.findByProps({ testID: homeRowTestId('active') } as never);
        expect(activeRelayRow?.props.selected).toBe(true);
        expect(screen.findByProps({ testID: 'onboarding-wizard-relay:customUrl' } as never)?.props.selected).toBe(false);

        const continueAfterResolved = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueAfterResolved.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-relay-url-input')).toBeNull();
        expect(screen.findByTestId('onboarding-wizard-lost-access')).not.toBeNull();
    });

    it('requires explicit relay switch confirmation after hosting a local relay', async () => {
        const focusBeforeAction = profiles.getActiveServerSnapshot();
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
            }),
        );

        const startButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await startButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const onThisComputerRow = screen.findByTestId('onboarding-wizard-relay:thisComputer')!;
        await act(async () => {
            await onThisComputerRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const continueToHost = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueToHost.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByType(RelayHostLocalChecklistStep as never)).toBeTruthy();

        await pressOnboarding(screen, 'onboarding-wizard-primary');

        // Saving the hosted relay as a Home is not a focus change: no Home is explicitly selected until the switch is confirmed.
        expect(focusBeforeAction.isSelectionExplicit).toBe(false);
        expect(profiles.getActiveServerSnapshot().isSelectionExplicit).toBe(false);
        await vi.waitFor(() => expect(screen.findByType(LocalRelayAccessControlSection as never)).toBeTruthy());
        expect(screen.findByTestId('onboarding-wizard-confirmSwitchRelay')).toBeNull();

        await pressOnboarding(screen, 'onboarding-wizard-primary');

        await vi.waitFor(() => expect(screen.findByTestId('onboarding-wizard-confirmSwitchRelay')).toBeTruthy());

        const switchChoice = screen.findByTestId('onboarding-wizard-confirmSwitchRelay.choice:switch')!;
        await act(async () => {
            await switchChoice.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const confirmButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await confirmButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expectFocusedHome('http://localhost:31337');
        expect(screen.findByTestId('onboarding-wizard-lost-access')).not.toBeNull();
    });

    it('routes web users selecting "On this computer" to the desktop handoff guidance step', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: false,
                authEntryOptions: baseAuthOptions,
            }),
        );

        const startButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await startButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const onThisComputerRow = screen.findByTestId('onboarding-wizard-relay:thisComputer')!;
        expect(onThisComputerRow.props.disabled).toBe(false);

        await act(async () => {
            await onThisComputerRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const continueToChecklistButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueToChecklistButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-desktop-handoff')).toBeTruthy();
    });

    it('lets the remote relay host step override the wizard primary CTA via the wizard chrome (no embedded buttons)', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
            }),
        );

        const startButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await startButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const remoteRow = screen.findByTestId('onboarding-wizard-relay:remoteComputer')!;
        await act(async () => {
            await remoteRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const continueToPlanButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueToPlanButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        // The real remote step publishes its primary through the wizard chrome: Continue stays disabled
        // until the SSH credentials are ready, which the wizard's own default primary would not do.
        expect(screen.findByType(RemoteSshChecklistStep as never)).toBeTruthy();
        await vi.waitFor(() => {
            const primaryOnRemote = screen.findByTestId('onboarding-wizard-primary');
            expect(primaryOnRemote?.props.disabled === true || primaryOnRemote?.props.accessibilityState?.disabled === true).toBe(true);
        });
    });

    it('routes remote relay hosting through relay access before prompting to switch', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
            }),
        );

        const startButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await startButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const remoteRow = screen.findByTestId('onboarding-wizard-relay:remoteComputer')!;
        await act(async () => {
            await remoteRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const continueToPlanButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueToPlanButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const remoteChecklistProps = screen.findByType(RemoteSshChecklistStep as never)?.props as {
            onCompleted?: (payload: {
                machineId: string | null;
                relayRuntimeUrl: string | null;
                relayAccessTarget?: {
                    kind: 'ssh';
                    ssh: {
                        target: string;
                        auth: 'agent' | 'keyfile' | 'password';
                    };
                } | null;
                mode: string;
            }) => void;
            onRequestAdvance?: () => void;
        } | undefined;
        expect(remoteChecklistProps).toBeTruthy();

        await act(async () => {
            remoteChecklistProps?.onCompleted?.({
                machineId: 'mach-remote',
                relayRuntimeUrl: 'https://remote-relay.example.test',
                relayAccessTarget: {
                    kind: 'ssh',
                    ssh: {
                        target: 'root@remote.example.test',
                        auth: 'agent',
                    },
                },
                mode: 'remoteRelayHost',
            });
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        await act(async () => {
            screen.findByType(RemoteSshChecklistStep as never).props.onRequestAdvance?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        await vi.waitFor(() => expect(screen.findByType(LocalRelayAccessControlSection as never)).toBeTruthy());
        expect((screen.findByType(LocalRelayAccessControlSection as never) as unknown as {
            props: { target?: { kind: 'local' } | { kind: 'ssh'; ssh: { target: string; auth: 'agent' | 'keyfile' | 'password' } } };
        }).props.target).toEqual({
            kind: 'ssh',
            ssh: {
                target: 'root@remote.example.test',
                auth: 'agent',
            },
        });
        expect(screen.findByTestId('onboarding-wizard-confirmSwitchRelay')).toBeNull();

        await pressOnboarding(screen, 'onboarding-wizard-primary');

        await vi.waitFor(() => expect(screen.findByTestId('onboarding-wizard-confirmSwitchRelay')).toBeTruthy());
    });

    it('switches remote relay hosting through the configured share URL once relay access provides one', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
            }),
        );

        const startButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await startButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const remoteRow = screen.findByTestId('onboarding-wizard-relay:remoteComputer')!;
        await act(async () => {
            await remoteRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const continueToPlanButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueToPlanButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const remoteChecklistProps = screen.findByType(RemoteSshChecklistStep as never)?.props as {
            onCompleted?: (payload: {
                machineId: string | null;
                relayRuntimeUrl: string | null;
                relayAccessTarget?: {
                    kind: 'ssh';
                    ssh: {
                        target: string;
                        auth: 'agent' | 'keyfile' | 'password';
                    };
                } | null;
                mode: string;
            }) => void;
            onRequestAdvance?: () => void;
        } | undefined;

        await act(async () => {
            remoteChecklistProps?.onCompleted?.({
                machineId: 'mach-remote',
                relayRuntimeUrl: 'https://remote-relay.example.test',
                relayAccessTarget: {
                    kind: 'ssh',
                    ssh: {
                        target: 'root@remote.example.test',
                        auth: 'agent',
                    },
                },
                mode: 'remoteRelayHost',
            });
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        await act(async () => {
            screen.findByType(RemoteSshChecklistStep as never).props.onRequestAdvance?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        await vi.waitFor(() => expect(screen.findByType(LocalRelayAccessControlSection as never)).toBeTruthy());
        await act(async () => {
            (screen.findByType(LocalRelayAccessControlSection as never)?.props as { onShareUrlChange?: (value: string | null) => void } | null)
                ?.onShareUrlChange?.('https://remote-share.example.test');
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        await pressOnboarding(screen, 'onboarding-wizard-primary');

        await vi.waitFor(() => expect(screen.findByTestId('onboarding-wizard-confirmSwitchRelay')).toBeTruthy());
        const confirmBody = screen.findByTestId('onboarding-wizard-confirmSwitchRelay')!;
        expect(String(confirmBody.props.relayUrl ?? screen.getTextContent())).toContain('remote-share.example.test');

        const confirmButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await confirmButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expectFocusedHome('https://remote-share.example.test');
        expect(getPendingSetupIntent()).toEqual(expect.objectContaining({
            relayUrl: 'https://remote-share.example.test',
        }));
    });

    it('blocks switching to an unreachable tailscale relay until desktop remediation succeeds', async () => {
        const previousFetchImpl = runtimeFetchMock.getMockImplementation();
        let relayReachable = false;
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (
                url.includes('https://remote-relay.example.ts.net')
                && url.endsWith('/health')
            ) {
                return relayReachable
                    ? new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
                    : new Response(JSON.stringify({ ok: false }), { status: 404, headers: { 'content-type': 'application/json' } });
            }
            return previousFetchImpl
                ? previousFetchImpl(input, init)
                : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
        });
        nativeTaskScene.nextResult = {
            protocolVersion: 1,
            taskId: 'task_prepare_tailscale_1',
            ok: true,
            data: {
                tailscaleInstalled: true,
                tailscaleLoggedIn: true,
                authUrl: null,
            },
        };

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
            }),
        );

        const startButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await startButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const remoteRow = screen.findByTestId('onboarding-wizard-relay:remoteComputer')!;
        await act(async () => {
            await remoteRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const continueToPlanButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueToPlanButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const remoteChecklistProps = screen.findByType(RemoteSshChecklistStep as never)?.props as {
            onCompleted?: (payload: {
                machineId: string | null;
                relayRuntimeUrl: string | null;
                relayAccessTarget?: {
                    kind: 'ssh';
                    ssh: {
                        target: string;
                        auth: 'agent' | 'keyfile' | 'password';
                    };
                } | null;
                mode: string;
            }) => void;
            onRequestAdvance?: () => void;
        } | undefined;

        await act(async () => {
            remoteChecklistProps?.onCompleted?.({
                machineId: 'mach-remote',
                relayRuntimeUrl: 'https://remote-relay.example.ts.net',
                relayAccessTarget: {
                    kind: 'ssh',
                    ssh: {
                        target: 'root@remote.example.test',
                        auth: 'agent',
                    },
                },
                mode: 'remoteRelayHost',
            });
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        await act(async () => {
            screen.findByType(RemoteSshChecklistStep as never).props.onRequestAdvance?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        await vi.waitFor(() => expect(screen.findByType(LocalRelayAccessControlSection as never)).toBeTruthy());
        await pressOnboarding(screen, 'onboarding-wizard-primary');
        await flushHookEffects({ cycles: 4, turns: 4 });

        await vi.waitFor(() => expect(screen.findByTestId('onboarding-wizard-confirmSwitchRelay')).toBeTruthy());
        expect(screen.findByTestId('server-settings-add-reachability-remediation')).toBeTruthy();
        expect(screen.findByTestId('onboarding-wizard-primary')?.props.disabled).toBe(true);

        relayReachable = true;
        const remediationButton = screen.findByTestId('server-settings-add-remediation-action-prepare_tailscale')!;
        await act(async () => {
            const handler = remediationButton.props.action ?? remediationButton.props.onPress;
            await handler?.();
        });
        await flushHookEffects({ cycles: 6, turns: 6 });

        expect(nativeTasks.bridge.start).toHaveBeenCalledWith({
            protocolVersion: 1,
            kind: 'tailscale.ensureReady.v1',
            params: {
                installPolicy: 'installIfMissing',
                loginPolicy: 'interactive',
                mode: 'normalUser',
            },
        });
        expect(screen.findByTestId('onboarding-wizard-primary')?.props.disabled).toBe(false);

        runtimeFetchMock.mockImplementation(previousFetchImpl ?? (async (input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })));
    });

    it('shows the relay footer hint when Happier Cloud is selected', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
            }),
        );

        const startButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await startButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const cloudRow = screen.findByTestId('onboarding-wizard-relay:cloud')!;
        await act(async () => {
            await cloudRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const continueButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findAllByTestId('onboarding-wizard-relay-hint')).toHaveLength(1);
    });

    it('shows a prefilled relay as a selectable row and selects it by default', async () => {
        await focusHomeAtAddress('https://relay-b.example.test');
        await saveHomeProfiles([
            {
                id: 'relay-a',
                name: 'Relay A',
                serverUrl: 'https://relay-a.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'manual',
            },
            {
                id: 'relay-b',
                name: 'Relay B',
                serverUrl: 'https://relay-b.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'manual',
            },
        ]);

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
            }),
        );
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByProps({ testID: homeRowTestId('relay-a') } as never)).toBeTruthy();
        const relayRow = screen.findByProps({ testID: homeRowTestId('relay-b') } as never);
        expect(relayRow).toBeTruthy();
        expect(relayRow?.props.selected).toBe(true);
        expect(screen.findByTestId('onboarding-wizard-relay:customUrl')).toBeTruthy();
        expect(screen.findByProps({ testID: 'onboarding-wizard-relay:cloud' } as never)?.props.selected).toBe(false);
    });

    it('continues from the default active saved relay without requiring the user to reselect it', async () => {

        await focusHomeAtAddress('http://localhost:53288');
        browser?.reconfigureUrl('http://localhost:53288');
        await saveHomeProfiles([
            {
                id: 'relay-real',
                name: 'Current Relay',
                serverUrl: 'http://localhost:53288',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'manual',
            },
        ]);

        const focusBeforeAction = profiles.getActiveServerSnapshot();
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
            }),
        );
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByProps({
            testID: homeRowTestId('relay-real'),
        } as never)?.props.selected).toBe(true);

        await pressOnboarding(screen, 'onboarding-wizard-primary');

        expect(screen.findByTestId('welcome-decision-panel')).toBeTruthy();
        expect(screen.findByTestId('onboarding-wizard-relay-url-input')).toBeNull();
        expect(profiles.getActiveServerSnapshot()).toMatchObject(focusBeforeAction);
    });

    it('marks an unreachable saved relay as unavailable and offers a retry action', async () => {
        await saveHomeProfiles([
            {
                id: 'relay-offline',
                name: 'Offline Relay',
                serverUrl: 'https://unreachable-relay.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'manual',
            },
        ]);

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
            }),
        );

        await flushHookEffects({ cycles: 2, turns: 2 });

        const relayRow = screen.findByProps({ testID: homeRowTestId('relay-offline') } as never);
        expect(relayRow?.props.disabled).toBe(false);
        expect(relayRow?.props.dimmed).toBe(true);
        expect(relayRow?.props.menuActions?.some((action: any) => action.id === 'retry')).toBe(true);
        const selectableRow = screen.findByProps({
            testID: homeRowTestId('relay-offline'),
            variant: 'selectable',
        } as never);
        expect(selectableRow?.props.title).toBe('Offline Relay');
        expect(selectableRow?.props.disabled).toBe(false);

        const callCountBefore = runtimeFetchMock.mock.calls.length;
        await act(async () => {
            const retryAction = relayRow?.props.menuActions?.find((action: any) => action.id === 'retry');
            retryAction?.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });
        expect(runtimeFetchMock.mock.calls.length).toBeGreaterThan(callCountBefore);
    });

    it('does not auto-select another relay when removing the selected saved relay', async () => {
        await focusHomeAtAddress('https://relay-a.example.test');
        await saveHomeProfiles([
            {
                id: 'relay-a',
                name: 'Relay A',
                serverUrl: 'https://relay-a.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'manual',
            },
            {
                id: 'relay-b',
                name: 'Relay B',
                serverUrl: 'https://relay-b.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'manual',
            },
        ]);

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
            }),
        );

        await flushHookEffects({ cycles: 2, turns: 2 });

        const relayRow = screen.findByProps({ testID: homeRowTestId('relay-a') } as never);
        expect(relayRow?.props.selected).toBe(true);

        await act(async () => {
            const removeAction = relayRow?.props.menuActions?.find((action: any) => action.id === 'remove');
            await removeAction?.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        await vi.waitFor(() => expect(profiles.getServerProfileById(homeProfileRef('relay-a'))).toBeNull());

        const relayARowsAfter = screen.findAllByProps({ testID: homeRowTestId('relay-a') } as never);
        const relayBRowAfter = screen.findByProps({ testID: homeRowTestId('relay-b') } as never);
        expect(relayARowsAfter).toHaveLength(0);
        expect(relayBRowAfter?.props.selected).toBe(false);
        expect(screen.findByTestId('onboarding-wizard-primary')!.props.disabled).toBe(true);
    });

    it('keeps the selected saved relay when marked custody blocks profile removal', async () => {
        await focusHomeAtAddress('https://relay-a.example.test');
        await saveHomeProfiles([
            {
                id: 'relay-a',
                name: 'Relay A',
                serverUrl: 'https://relay-a.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'manual',
            },
        ]);
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const profile = profiles.getServerProfileById(homeProfileRef('relay-a'))!;
        const createdAt = Date.now();
        expect(await TokenStorage.setPendingExternalAuth({
            provider: 'github', proof: 'proof', secret: 'marked-secret',
            serverId: profile.id, serverUrl: profile.serverUrl, returnTo: '/settings/account',
            accountEncryptionFirstKey: {
                accountId: 'account-1', requestDigest: `aemrb1_${'A'.repeat(43)}`,
                requestJson: '{"toMode":"e2ee"}', createdAt, expiresAt: createdAt + 600000,
                pending: 'oauth-pending', migrationSubmissionAttempted: true,
            },
        })).toBe(true);

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
            }),
        );

        await flushHookEffects({ cycles: 2, turns: 2 });

        const relayRow = screen.findByProps({ testID: homeRowTestId('relay-a') } as never);
        await act(async () => {
            const removeAction = relayRow?.props.menuActions?.find((action: any) => action.id === 'remove');
            await removeAction?.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(modalShowMock).toHaveBeenCalledTimes(1);
        expect(profiles.getServerProfileById(profile.id)).not.toBeNull();
        const relayRowAfter = screen.findByProps({
            testID: homeRowTestId('relay-a'),
        } as never);
        expect(relayRowAfter?.props.selected).toBe(true);
        expect(screen.findByTestId('onboarding-wizard-primary')!.props.disabled).toBe(false);
    });

    it('removes a saved relay even when modal confirm is unavailable', async () => {
        modalConfirmMock.mockImplementation(async () => false);
        await focusHomeAtAddress('https://relay-a.example.test');
        const profilesState: ServerProfile[] = [
            {
                id: 'relay-a',
                name: 'Relay A',
                serverUrl: 'https://relay-a.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'manual',
            },
            {
                id: 'relay-b',
                name: 'Relay B',
                serverUrl: 'https://relay-b.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'manual',
            },
        ];
        await saveHomeProfiles(profilesState);

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
            }),
        );

        await flushHookEffects({ cycles: 2, turns: 2 });

        const relayRow = screen.findByProps({ testID: homeRowTestId('relay-a') } as never);
        expect(relayRow?.props.selected).toBe(true);

        expect(profiles.getServerProfileById(homeProfileRef('relay-a'))).not.toBeNull();
        await act(async () => {
            const removeAction = relayRow?.props.menuActions?.find((action: any) => action.id === 'remove');
            await removeAction?.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        await vi.waitFor(() => expect(profiles.getServerProfileById(homeProfileRef('relay-a'))).toBeNull());
        const relayARowAfter = screen.findAll((node) => node.props?.testID === homeRowTestId('relay-a'));
        const relayBRowAfter = screen.findAll((node) => node.props?.testID === homeRowTestId('relay-b'));
        expect(relayARowAfter).toHaveLength(0);
        expect(relayBRowAfter.length).toBeGreaterThan(0);
        expect(screen.findByTestId('onboarding-wizard-primary')!.props.disabled).toBe(true);
    });

    it('does not show a saved relay row as selected when the user selected the “On this computer” option', async () => {
        browser?.reconfigureUrl('http://localhost:53288');
        await saveHomeProfiles([
            {
                id: 'local-relay',
                name: 'Local Relay',
                serverUrl: 'http://localhost:53288',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'manual',
            },
        ]);

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
            }),
        );

        await flushHookEffects({ cycles: 2, turns: 2 });

        const thisComputerRow = screen.findByTestId('onboarding-wizard-relay:thisComputer')!;
        await act(async () => {
            await thisComputerRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const localRelayRow = screen.findByProps({ testID: homeRowTestId('local-relay') } as never);
        expect(screen.findByProps({ testID: 'onboarding-wizard-relay:thisComputer' } as never)?.props.selected).toBe(true);
        expect(localRelayRow?.props.selected).toBe(false);
    });

    it('renders a single-line relay footer and keeps Cloud from showing a custom URL footer', async () => {
        await focusHomeAtAddress('https://relay-b.example.test');
        await saveHomeProfiles([
            {
                id: 'relay-b',
                name: 'Relay B',
                serverUrl: 'https://relay-b.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'manual',
            },
        ]);

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
            }),
        );

        const cloudRow = screen.findByTestId('onboarding-wizard-relay:cloud')!;
        await act(async () => {
            await cloudRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-relay-hint')).toBeTruthy();
        expect(screen.findByTestId('onboarding-wizard-relay-hint-line')).toBeTruthy();
        expect(screen.findByTestId('onboarding-wizard-relay-hint-label')).toBeTruthy();
        expect(screen.getTextContent()).toContain('setupOnboarding.selectedRelaySummaryTitle');
    });

    it('keeps an unreachable preselected relay selected and disables continue until a reachable relay is selected', async () => {
        await focusHomeAtAddress('https://unreachable-relay.example.test');
        await saveHomeProfiles([
            {
                id: 'relay-offline',
                name: 'Offline Relay',
                serverUrl: 'https://unreachable-relay.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'manual',
            },
            {
                id: 'relay-ok',
                name: 'Online Relay',
                serverUrl: 'https://relay-ok.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'manual',
            },
        ]);

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
            }),
        );

        await flushHookEffects({ cycles: 2, turns: 2 });

        const offlineRow = screen.findByProps({ testID: homeRowTestId('relay-offline') } as never);
        expect(offlineRow?.props.selected).toBe(true);
        expect(offlineRow?.props.disabled).toBe(false);

        const continueButton = screen.findByTestId('onboarding-wizard-primary')!;
        expect(continueButton.props.disabled).toBe(true);

        const cloudRow = screen.findByProps({ testID: 'onboarding-wizard-relay:cloud' } as never);
        expect(cloudRow?.props.selected).toBe(false);

        const okRow = screen.findByProps({ testID: homeRowTestId('relay-ok') } as never);
        await act(async () => {
            await okRow?.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const continueButtonAfter = screen.findByTestId('onboarding-wizard-primary')!;
        expect(continueButtonAfter.props.disabled).toBe(false);
    });

    it('keeps a manually entered unreachable Home address in the URL step without saving it', async () => {
        const previousFetchImpl = runtimeFetchMock.getMockImplementation();
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (
                url.includes('https://typed-unreachable-relay.example.test')
                && url.endsWith('/health')
            ) {
                return new Response(JSON.stringify({ ok: false }), { status: 404, headers: { 'content-type': 'application/json' } });
            }
            return previousFetchImpl
                ? previousFetchImpl(input, init)
                : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
        });

        await focusHomeAtAddress('');
        browser?.reconfigureUrl('https://app.happier.dev');
        await saveHomeProfiles([]);

        const focusBeforeAction = profiles.getActiveServerSnapshot();
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
            }),
        );

        await flushHookEffects({ cycles: 1, turns: 1 });

        const customRelayRow = screen.findByTestId('onboarding-wizard-relay:customUrl')!;
        await act(async () => {
            await customRelayRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const continueToUrlEntry = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueToUrlEntry.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const relayInput = screen.findByTestId('onboarding-wizard-relay-url-input')!;
        await act(async () => {
            relayInput.props.onChangeText?.('https://typed-unreachable-relay.example.test');
        });

        const saveButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await saveButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(getOnboardingStepId(screen)).toBe('relay_enter_url');
        expect(screen.findByTestId('onboarding-wizard-relay-url-input')?.props.value).toBe('https://typed-unreachable-relay.example.test');
        expect(profiles.getActiveServerSnapshot()).toMatchObject(focusBeforeAction);

        runtimeFetchMock.mockImplementation(previousFetchImpl ?? (async (input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })));
    });

    it('shows desktop tailscale remediation when a typed tailscale relay is unreachable', async () => {
        const previousFetchImpl = runtimeFetchMock.getMockImplementation();
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (
                url.includes('https://typed-relay.example.ts.net')
                && url.endsWith('/health')
            ) {
                return new Response(JSON.stringify({ ok: false }), { status: 404, headers: { 'content-type': 'application/json' } });
            }
            return previousFetchImpl
                ? previousFetchImpl(input, init)
                : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
        });

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
            }),
        );

        await flushHookEffects({ cycles: 1, turns: 1 });

        const customRelayRow = screen.findByTestId('onboarding-wizard-relay:customUrl')!;
        await act(async () => {
            await customRelayRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const continueToUrlEntry = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueToUrlEntry.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const relayInput = screen.findByTestId('onboarding-wizard-relay-url-input')!;
        await act(async () => {
            relayInput.props.onChangeText?.('https://typed-relay.example.ts.net');
        });
        await flushHookEffects({ cycles: 4, turns: 4 });

        expect(screen.findByTestId('server-settings-add-reachability-remediation')).toBeTruthy();
        expect(screen.findByTestId('server-settings-add-remediation-action-prepare_tailscale')).toBeTruthy();
        expect(screen.findByTestId('onboarding-wizard-primary')?.props.disabled).toBe(true);

        runtimeFetchMock.mockImplementation(previousFetchImpl ?? (async (input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })));
    });

    it('shows web tailscale install guidance when a typed tailscale relay is unreachable', async () => {
        reactNativeMockState.os = 'web';

        const previousFetchImpl = runtimeFetchMock.getMockImplementation();
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (
                url.includes('https://typed-relay.example.ts.net')
                && url.endsWith('/health')
            ) {
                return new Response(JSON.stringify({ ok: false }), { status: 404, headers: { 'content-type': 'application/json' } });
            }
            return previousFetchImpl
                ? previousFetchImpl(input, init)
                : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
        });

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: false,
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
            }),
        );

        await flushHookEffects({ cycles: 1, turns: 1 });

        const customRelayRow = screen.findByTestId('onboarding-wizard-relay:customUrl')!;
        await act(async () => {
            await customRelayRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const continueToUrlEntry = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueToUrlEntry.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const relayInput = screen.findByTestId('onboarding-wizard-relay-url-input')!;
        await act(async () => {
            relayInput.props.onChangeText?.('https://typed-relay.example.ts.net');
        });
        await flushHookEffects({ cycles: 4, turns: 4 });

        expect(screen.findByTestId('server-settings-add-reachability-remediation')).toBeTruthy();
        expect(screen.findByTestId('server-settings-add-remediation-action-install_tailscale')).toBeTruthy();
        expect(screen.findAllByTestId('server-settings-add-remediation-action-prepare_tailscale')).toHaveLength(0);
        expect(screen.findByTestId('onboarding-wizard-primary')?.props.disabled).toBe(true);

        runtimeFetchMock.mockImplementation(previousFetchImpl ?? (async (input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })));
    });

    it('shows native tailscale install guidance when a typed tailscale relay is unreachable', async () => {
        reactNativeMockState.os = 'ios';

        const previousFetchImpl = runtimeFetchMock.getMockImplementation();
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (
                url.includes('https://typed-relay.example.ts.net')
                && url.endsWith('/health')
            ) {
                return new Response(JSON.stringify({ ok: false }), { status: 404, headers: { 'content-type': 'application/json' } });
            }
            return previousFetchImpl
                ? previousFetchImpl(input, init)
                : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
        });

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: false,
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
            }),
        );

        await flushHookEffects({ cycles: 1, turns: 1 });

        const customRelayRow = screen.findByTestId('onboarding-wizard-relay:customUrl')!;
        await act(async () => {
            await customRelayRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const continueToUrlEntry = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueToUrlEntry.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const relayInput = screen.findByTestId('onboarding-wizard-relay-url-input')!;
        await act(async () => {
            relayInput.props.onChangeText?.('https://typed-relay.example.ts.net');
        });
        await flushHookEffects({ cycles: 4, turns: 4 });

        expect(screen.findByTestId('server-settings-add-reachability-remediation')).toBeTruthy();
        expect(screen.findByTestId('server-settings-add-remediation-action-install_tailscale')).toBeTruthy();
        expect(screen.findAllByTestId('server-settings-add-remediation-action-prepare_tailscale')).toHaveLength(0);
        expect(screen.findByTestId('onboarding-wizard-primary')?.props.disabled).toBe(true);

        runtimeFetchMock.mockImplementation(previousFetchImpl ?? (async (input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })));
    });

    it('surfaces mixed-content blocking as a distinct blocked status (not unreachable) on web', async () => {
        const globalWithLocation = globalThis as unknown as { location?: unknown };
        const previousLocation = globalWithLocation.location;
        try {
            reactNativeMockState.os = 'web';

            try {
                Object.defineProperty(globalThis, 'location', { value: { protocol: 'https:' }, configurable: true });
            } catch {
                if (previousLocation && typeof previousLocation === 'object') {
                    try {
                        (previousLocation as any).protocol = 'https:';
                    } catch {
                        // ignore
                    }
                }
            }
            expect((globalThis as any).location?.protocol).toBe('https:');

            await focusHomeAtAddress('');
            browser?.reconfigureUrl('https://app.happier.dev');
            await saveHomeProfiles([
                {
                    id: 'local-http',
                    name: 'Local HTTP',
                    serverUrl: 'http://127.0.0.1:53288',
                    createdAt: 0,
                    updatedAt: 0,
                    lastUsedAt: 0,
                    source: 'manual' as const,
                },
            ]);

            const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
            const screen = await renderScreen(
                React.createElement(OnboardingWizardSurface, {
                    layout: 'portrait',
                    isDesktopShell: true,
                    initialStepId: 'relay_select',
                    authEntryOptions: baseAuthOptions,
                }),
            );

            await flushHookEffects({ cycles: 4, turns: 4 });

            const localRow = screen.findByTestId(homeRowTestId('local-http'))!;
            await act(async () => {
                await localRow.props.onPress?.();
            });
            await flushHookEffects({ cycles: 6, turns: 6 });

            expect(screen.findByTestId('onboarding-wizard-primary')?.props.disabled).toBe(true);
        } finally {
            try {
                Object.defineProperty(globalThis, 'location', { value: previousLocation, configurable: true });
            } catch {
                globalWithLocation.location = previousLocation;
            }
        }
    });

    it('keeps a prefilled local relay selected instead of auto-switching to This computer when it is unreachable', async () => {
        await focusHomeAtAddress('http://localhost:53288');
        browser?.reconfigureUrl('http://localhost:53288');
        const previousFetchImpl = runtimeFetchMock.getMockImplementation();
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (
                url.includes('http://localhost:53288')
                && url.endsWith('/health')
            ) {
                return new Response(JSON.stringify({ ok: false }), { status: 404, headers: { 'content-type': 'application/json' } });
            }
            return previousFetchImpl
                ? previousFetchImpl(input, init)
                : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
        });
        await saveHomeProfiles([]);

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
            }),
        );

        await flushHookEffects({ cycles: 2, turns: 2 });

        const localRelayRow = screen.findByProps({ testID: homeRowTestId('active') } as never);
        expect(localRelayRow?.props.selected).toBe(true);
        expect(localRelayRow?.props.disabled).toBe(false);
        expect(screen.findByProps({ testID: 'onboarding-wizard-relay:thisComputer' } as never)?.props.selected).toBe(false);
        expect(screen.findByTestId('onboarding-wizard-primary')?.props.disabled).toBe(true);
        expect(screen.getTextContent()).toContain('setupOnboarding.activeRelaySummaryTitle');

        runtimeFetchMock.mockImplementation(previousFetchImpl ?? (async (input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })));
    });

    it('keeps the active local relay selected instead of auto-switching to This computer when it is unreachable', async () => {
        await focusHomeAtAddress('http://localhost:53288');
        browser?.reconfigureUrl('http://localhost:53288');
        await saveHomeProfiles([
            {
                id: 'local-relay',
                name: 'Local Relay',
                serverUrl: 'http://localhost:53288',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'manual',
            },
            {
                id: 'relay-ok',
                name: 'Online Relay',
                serverUrl: 'https://relay-ok.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'manual',
            },
        ]);

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
            }),
        );

        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByProps({ testID: homeRowTestId('local-relay') } as never)?.props.selected).toBe(true);
        expect(screen.findByProps({ testID: 'onboarding-wizard-relay:thisComputer' } as never)?.props.selected).toBe(false);
        expect(screen.getTextContent()).toContain('http://localhost:53288');
    });

    it('selects a single saved relay row when multiple profiles share the same server URL', async () => {
        await focusHomeAtAddress('https://duplicate-relay.example.test');
        browser?.reconfigureUrl('https://app.happier.dev');
        await saveHomeProfiles([
            {
                id: 'dup-1',
                name: 'Duplicate One',
                serverUrl: 'https://duplicate-relay.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'manual',
            },
            {
                id: 'dup-2',
                name: 'Duplicate Two',
                serverUrl: 'https://duplicate-relay.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
                source: 'manual',
            },
        ]);

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
            }),
        );

        await flushHookEffects({ cycles: 2, turns: 2 });

        // The profile writer and reader coalesce equivalent unqualified endpoints.
        // A second saved fixture must not create a second selected surface row.
        expect(homeProfileRef('dup-1')).toBe(homeProfileRef('dup-2'));
        const rows = screen.findAllByType(WizardChoiceRow as never)
            .filter(row => row.props.testID === homeRowTestId('dup-1'));
        expect(rows).toHaveLength(1);
        expect(rows[0]?.props.selected).toBe(true);
    });

    it('disables continuing when the canonical cloud relay is unreachable and offers a retry affordance', async () => {
        const previousFetchImpl = runtimeFetchMock.getMockImplementation();
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (
                url.includes('https://api.happier.dev')
                && url.endsWith('/health')
            ) {
                return new Response(JSON.stringify({ ok: false }), { status: 404, headers: { 'content-type': 'application/json' } });
            }
            return previousFetchImpl
                ? previousFetchImpl(input, init)
                : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
        });

        await focusHomeAtAddress('');
        await saveHomeProfiles([]);

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
            }),
        );

        await flushHookEffects({ cycles: 2, turns: 2 });

        const cloudRow = screen.findByTestId('onboarding-wizard-relay:cloud')!;
        await act(async () => {
            await cloudRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByTestId('onboarding-wizard-primary')?.props.disabled).toBe(true);
        expect(screen.findByTestId('onboarding-wizard-skip')).toBeNull();

        const cloudChoice = screen.root.findAll((node) => {
            const props = node.props as Record<string, unknown>;
            return props.testID === 'onboarding-wizard-relay:cloud'
                && typeof props.badge === 'string'
                && props.secondaryAction != null;
        })[0] as unknown as ReactTestInstance | undefined;

        expect(cloudChoice?.props.badge).toBe('common.unreachable');
        expect(cloudChoice?.props.secondaryAction?.testID).toBe('onboarding-wizard-relay:cloud-retry');

        runtimeFetchMock.mockImplementation(
            previousFetchImpl
                ?? (async (input: RequestInfo | URL) => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })),
        );
    });

    it('allows continuing to the web desktop handoff when hosting a relay on this computer, even if the current relay is unreachable', async () => {
        const previousFetchImpl = runtimeFetchMock.getMockImplementation();
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (
                url.includes('http://localhost:59331')
                && url.endsWith('/health')
            ) {
                return new Response(JSON.stringify({ ok: false }), { status: 404, headers: { 'content-type': 'application/json' } });
            }
            return previousFetchImpl ? previousFetchImpl(input, init) : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
        });

        await focusHomeAtAddress('http://localhost:59331');
        await saveHomeProfiles([]);

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
            }),
        );

        await flushHookEffects({ cycles: 2, turns: 2 });

        const hostRow = screen.findByTestId('onboarding-wizard-relay:thisComputer')!;
        await act(async () => {
            await hostRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const continueButtonAfter = screen.findByTestId('onboarding-wizard-primary')!;
        expect(continueButtonAfter.props.disabled).toBe(false);

        runtimeFetchMock.mockImplementation(previousFetchImpl ?? (async (input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })));
    });

    it('switches to the canonical Happier Cloud profile before continuing to auth', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
            }),
        );

        const startButton = screen.findByTestId('onboarding-wizard-primary')!;

        await act(async () => {
            await startButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const cloudRow = screen.findByTestId('onboarding-wizard-relay:cloud')!;

        await act(async () => {
            await cloudRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const primaryButton = screen.findByTestId('onboarding-wizard-primary')!;
        expect(primaryButton.props.disabled).toBe(false);

        await act(async () => {
            await primaryButton.props.onPress?.();
        });

        expectFocusedHome('https://api.happier.dev');
        const cloud = profiles.resolveUniqueServerProfileByUrl('https://api.happier.dev');
        expect(cloud).not.toBeNull();
        expect(profiles.getActiveServerSnapshot().serverId).toBe(profiles.resolveServerProfileScopeId(cloud!));
        expect(profiles.listServerProfiles().filter(profile => profile.serverUrl === 'https://api.happier.dev')).toHaveLength(1);
        expect(screen.findByTestId('onboarding-wizard-lost-access')).not.toBeNull();
    });

    it('treats Happier Cloud as https://api.happier.dev even when the reset-to-default server differs', async () => {
        await focusHomeAtAddress('https://selfhosted.example.test');

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                initialStepId: 'relay_select',
            }),
        );
        await flushHookEffects({ cycles: 1, turns: 1 });

        const cloudRow = screen.findByTestId('onboarding-wizard-relay:cloud')!;
        await act(async () => {
            await cloudRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const nextButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await nextButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expectFocusedHome('https://api.happier.dev');
    });

});
