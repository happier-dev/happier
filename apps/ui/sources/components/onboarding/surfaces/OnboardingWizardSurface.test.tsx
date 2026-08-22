import React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import type { AuthCredentialLifecycleResult } from '@/auth/context/AuthContext';
import type { AccountEncryptionFirstKeyRecoveryHandle } from '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth';
import type { PendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent.shared';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';

import { WizardModalShell } from '../ui/WizardModalShell';
import { WizardChoiceRow } from '../ui/WizardChoiceRow';

const reactNativeMockState = vi.hoisted(() => ({
    os: 'web' as 'web' | 'ios' | 'android',
}));

const configuredServerUrlEnvMockState = vi.hoisted(() => ({
    value: null as string | null,
}));

const runtimeActiveMockState = vi.hoisted(() => ({
    value: true,
}));

const syncStoreHooksMockState = vi.hoisted(() => ({
    sessions: [] as Array<Record<string, unknown>>,
    machines: {} as Record<string, Record<string, unknown>>,
}));

const relayAccessWizardMockState = vi.hoisted(() => ({
    providerId: 'lan' as 'lan' | 'cloudflareNamed' | 'tailscaleServe' | 'tailscaleFunnel',
    latestProps: null as Record<string, unknown> | null,
    renderedDetailsStep: null as null | 'lan' | 'cloudflareNamed' | 'tailscaleServe' | 'tailscaleFunnel',
    emitSelectedProviderFromEffect: false,
    effectSelectionProviderId: 'lan' as 'lan' | 'cloudflareNamed' | 'tailscaleServe' | 'tailscaleFunnel',
    effectSelectionNotificationCount: 0,
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
    return screen.findByTestId('onboarding-wizard-body-transition-current-layer')?.findAllByType(type)
        ?? screen.findAllByType(type);
}

vi.mock('@/components/onboarding/steps/relayAccess/RelayAccessLanUrlStep', () => ({
    RelayAccessLanUrlStep: (_props: Record<string, unknown>) => {
        relayAccessWizardMockState.renderedDetailsStep = 'lan';
        return null;
    },
}));

vi.mock('@/components/onboarding/steps/relayAccess/RelayAccessCloudflareNamedTunnelStep', () => ({
    RelayAccessCloudflareNamedTunnelStep: (_props: Record<string, unknown>) => {
        relayAccessWizardMockState.renderedDetailsStep = 'cloudflareNamed';
        return null;
    },
}));

vi.mock('@/components/onboarding/steps/relayAccess/RelayAccessTailscalePrerequisitesStep', () => ({
    RelayAccessTailscalePrerequisitesStep: (props: Record<string, unknown>) => {
        const providerId = props.providerId;
        relayAccessWizardMockState.renderedDetailsStep = providerId === 'tailscaleFunnel' ? 'tailscaleFunnel' : 'tailscaleServe';
        return null;
    },
}));

const expoRouterMock = createExpoRouterMock({
    params: {},
    router: {
        push: vi.fn(),
        replace: vi.fn(),
    },
});

const setPendingSetupIntentMock = vi.hoisted(() => vi.fn<(value: PendingSetupIntent) => void>());
const getPendingSetupIntentMock = vi.hoisted(() => vi.fn<() => PendingSetupIntent | null>(() => null));
const clearPendingSetupIntentMock = vi.hoisted(() => vi.fn());
const activeServerSnapshotMock = vi.hoisted(() => ({
    serverId: 'relay-profile',
    serverUrl: 'https://relay.example.test',
    activeLocalRelayUrl: null as string | null,
    generation: 1,
}));
const activeServerSubscriptionMock = vi.hoisted(() => {
    const listeners = new Set<(snapshot: typeof activeServerSnapshotMock) => void>();
    return {
        reset: () => listeners.clear(),
        getListenerCount: () => listeners.size,
        emit: () => {
            const snapshot = { ...activeServerSnapshotMock };
            for (const listener of listeners) listener(snapshot);
        },
        subscribe: (listener: (snapshot: typeof activeServerSnapshotMock) => void) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
});
const listServerProfilesMock = vi.hoisted(() => vi.fn<() => ServerProfile[]>(() => []));
const removeServerProfileUiActionMock = vi.hoisted(() => vi.fn<
    (_params: unknown) => Promise<AuthCredentialLifecycleResult>
>(async () => ({ kind: 'completed' })));
const presentFirstKeyCredentialLifecycleMock = vi.hoisted(() => vi.fn(async (params: {
    run: () => Promise<AuthCredentialLifecycleResult>;
    onCompleted?: () => void | Promise<void>;
}) => {
    const result = await params.run();
    if (result.kind === 'completed') {
        await params.onCompleted?.();
    }
}));
const serverProfilesSubscriptionMock = vi.hoisted(() => {
    let generation = 0;
    const listeners = new Set<(generation: number) => void>();
    return {
        getGeneration: () => generation,
        reset: () => {
            generation = 0;
            listeners.clear();
        },
        bump: () => {
            generation += 1;
            for (const listener of listeners) listener(generation);
        },
        subscribe: (listener: (generation: number) => void) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
});
const modalConfirmMock = vi.hoisted(() => vi.fn(async (_title?: string, _message?: string, _options?: unknown) => true));
const webQrScannerSupportedMock = vi.hoisted(() => ({ value: false }));
const webMobileLikeQrScannerHostMock = vi.hoisted(() => ({
    value: false,
    lastArgs: null as null | { width: number; height: number },
}));
const setActiveServerAndSwitchMock = vi.hoisted(() => vi.fn(async () => true));
const upsertActivateAndSwitchServerMock = vi.hoisted(() => vi.fn(async () => true));
const getResetToDefaultServerIdMock = vi.hoisted(() => vi.fn(() => 'cloud-profile'));
const getServerProfileByIdMock = vi.hoisted(() => vi.fn<(serverId: string) => ServerProfile | null>((serverId: string) => (
    serverId === 'cloud-profile'
        ? {
            id: 'cloud-profile',
            name: 'Happier Cloud',
            serverUrl: 'https://api.happier.dev',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: 0,
            source: 'preconfigured' as const,
        }
        : null
)));
const getOrCreateHappierCloudServerProfileMock = vi.hoisted(() => vi.fn(() => ({
    id: 'cloud-profile',
    name: 'Happier Cloud',
    serverUrl: 'https://api.happier.dev',
    createdAt: 0,
    updatedAt: 0,
    lastUsedAt: 0,
    source: 'preconfigured' as const,
})));
const runtimeFetchMock = vi.hoisted(() => vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (
        url.includes('https://unreachable-relay.example.test')
        && url.endsWith('/health')
    ) {
        return new Response(JSON.stringify({ ok: false }), { status: 404, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
}));
const systemTaskRunnerState = vi.hoisted(() => {
    const state = {
        nextResult: null as import('@happier-dev/protocol').SystemTaskResult | null,
        startMock: vi.fn(async (_spec: unknown) => 'task_prepare_tailscale_1'),
        cancelMock: vi.fn(async () => {}),
        respondMock: vi.fn(async () => {}),
        getSnapshotMock: vi.fn((taskId: string) => {
            const result = state.nextResult;
            if (!result || result.taskId !== taskId) {
                return null;
            }
            return {
                taskId,
                status: result.ok ? 'succeeded' : 'failed',
                currentStepId: null,
                latestMessage: result.ok ? null : result.error.message,
                awaitingInput: false,
                cancelRequested: false,
                events: [],
                result,
            };
        }),
        subscribeMock: vi.fn((taskId: string, _listenerOrOnEvent?: unknown, onResult?: (result: import('@happier-dev/protocol').SystemTaskResult) => void) => {
            const result = state.nextResult;
            if (result && typeof onResult === 'function') {
                queueMicrotask(() => {
                    onResult({ ...result, taskId });
                });
            }
            return () => {};
        }),
    };
    return state;
});

const remoteSshChecklistMock = vi.hoisted(() => {
    const spy = vi.fn();
    return {
        spy,
        module: {
            RemoteSshChecklistStep: (props: any) => {
                spy(props);
                React.useEffect(() => {
                    props.onWizardPrimaryChange?.({
                        label: 'Run remote setup',
                        disabled: false,
                        onPress: () => undefined,
                    });
                    return () => props.onWizardPrimaryChange?.(null);
                }, [props.onWizardPrimaryChange]);

                return React.createElement('View' as any, { testID: props.testID ?? 'remote-ssh-checklist-mock' });
            },
        },
    };
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
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
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('expo-router', () => expoRouterMock.module);
vi.mock('@/sync/domains/server/readConfiguredServerUrlEnv', () => ({
    readConfiguredServerUrlEnv: () => configuredServerUrlEnvMockState.value,
}));
vi.mock('@/sync/domains/pending/pendingSetupIntent', () => ({
    setPendingSetupIntent: (value: PendingSetupIntent) => setPendingSetupIntentMock(value),
    getPendingSetupIntent: () => getPendingSetupIntentMock(),
    clearPendingSetupIntent: () => clearPendingSetupIntentMock(),
}));
vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => false,
}));
vi.mock('@/utils/platform/platform', () => ({
    isRunningOnMac: () => false,
}));
vi.mock('@/utils/runtime/isRuntimeActive', () => ({
    isRuntimeActive: () => runtimeActiveMockState.value,
}));
vi.mock('@/utils/platform/qrScannerSupport', () => ({
    isWebQrScannerSupported: () => webQrScannerSupportedMock.value,
}));
vi.mock('@/utils/platform/webMobileHeuristics', () => ({
    isWebMobileLikeQrScannerHost: (args: { width: number; height: number }) => {
        webMobileLikeQrScannerHostMock.lastArgs = args;
        return webMobileLikeQrScannerHostMock.value;
    },
}));
vi.mock('../checklists/remoteSsh/RemoteSshChecklistStep', () => remoteSshChecklistMock.module);
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: false }),
}));
vi.mock('@/auth/providers/registry', () => ({
    getAuthProvider: () => null,
}));
vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerSnapshotMock,
    subscribeActiveServer: (listener: (snapshot: typeof activeServerSnapshotMock) => void) => activeServerSubscriptionMock.subscribe(listener),
    isActiveServerSelectionExplicit: () => false,
    upsertServerProfileOnly: (profile: { serverUrl: string }) => ({
        id: `profile:${profile.serverUrl}`,
        name: profile.serverUrl,
        serverUrl: profile.serverUrl,
    }),
}));
vi.mock('@/sync/domains/server/serverProfiles', () => ({
    HAPPIER_CLOUD_SERVER_URL: 'https://api.happier.dev',
    getResetToDefaultServerId: () => getResetToDefaultServerIdMock(),
    getServerProfileById: (serverId: string) => getServerProfileByIdMock(serverId),
    listServerProfiles: () => listServerProfilesMock(),
    getOrCreateHappierCloudServerProfile: () => getOrCreateHappierCloudServerProfileMock(),
    getServerProfilesGeneration: () => serverProfilesSubscriptionMock.getGeneration(),
    subscribeServerProfiles: (listener: (generation: number) => void) => serverProfilesSubscriptionMock.subscribe(listener),
}));
vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (input: RequestInfo | URL, init?: RequestInit) => runtimeFetchMock(input, init),
}));
vi.mock('@/components/systemTasks', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/systemTasks')>();
    return {
        ...actual,
        getDefaultSystemTaskRunner: () => ({
            mode: 'tauri' as const,
            start: systemTaskRunnerState.startMock,
            cancel: systemTaskRunnerState.cancelMock,
            respond: systemTaskRunnerState.respondMock,
            getSnapshot: systemTaskRunnerState.getSnapshotMock,
            subscribe: systemTaskRunnerState.subscribeMock,
        }),
        useSystemTaskSnapshot: (runner: {
            subscribe: (taskId: string, onEvent?: ((event: unknown) => void) | undefined, onResult?: ((result: import('@happier-dev/protocol').SystemTaskResult) => void) | undefined) => () => void;
        }, taskId: string | null) => {
            const [snapshot, setSnapshot] = React.useState<import('@/components/systemTasks/types').SystemTaskRunState | null>(null);

            React.useEffect(() => {
                if (!taskId) {
                    setSnapshot(null);
                    return;
                }

                let disposed = false;
                setSnapshot({
                    taskId,
                    status: 'running',
                    currentStepId: null,
                    latestMessage: null,
                    awaitingInput: false,
                    cancelRequested: false,
                    events: [],
                    result: null,
                });

                const unsubscribe = runner.subscribe(taskId, undefined, (result) => {
                    if (disposed) return;
                    setSnapshot({
                        taskId,
                        status: result.ok ? 'succeeded' : 'failed',
                        currentStepId: null,
                        latestMessage: result.ok ? null : result.error.message,
                        awaitingInput: false,
                        cancelRequested: false,
                        events: [],
                        result,
                    });
                });

                return () => {
                    disposed = true;
                    unsubscribe();
                };
            }, [runner, taskId]);

            return snapshot;
        },
    };
});
vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    isSameServerUrl: (left: string, right: string) => left === right,
    normalizeServerUrl: (value: string) => String(value).trim() === 'not a url' ? null : value,
    upsertActivateAndSwitchServer: upsertActivateAndSwitchServerMock,
    setActiveServerAndSwitch: setActiveServerAndSwitchMock,
}));
vi.mock('@/sync/store/hooks', () => {
    const localSettings: Record<string, unknown> = {
        hasCompletedAuthOnce: false,
        uiBackdropBlurEnabled: false,
        uiFontScale: 1,
    };
    return {
        useAllSessions: () => syncStoreHooksMockState.sessions,
        useSetting: (key: string) => localSettings[key] ?? null,
        useLocalSetting: (key: string) => localSettings[key] ?? null,
        useMachine: (machineId: string) => syncStoreHooksMockState.machines[machineId] ?? null,
    };
});
vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getServerFeaturesSnapshot: vi.fn(async () => ({ status: 'ready', features: { capabilities: { auth: { methods: [] } } } })),
    getCachedServerFeaturesSnapshot: () => null,
}));
vi.mock('@/components/onboarding/restore/RestoreIndexEmbedded', () => ({
    RestoreIndexEmbedded: (props: Record<string, unknown>) => React.createElement('RestoreIndexEmbedded', props),
}));
vi.mock('@/components/onboarding/restore/SecretKeyLoginEmbedded', () => ({
    SecretKeyLoginEmbedded: (props: Record<string, unknown>) => React.createElement('SecretKeyLoginEmbedded', props),
}));
vi.mock('@/components/onboarding/restore/LostAccessEmbedded', () => ({
    LostAccessEmbedded: () => null,
}));
vi.mock('@/components/onboarding/steps/webDesktop/WebDesktopRelayHostHandoffContent', () => ({
    WebDesktopRelayHostHandoffContent: (props: Record<string, unknown>) => React.createElement('WebDesktopRelayHostHandoffContent', props),
}));
vi.mock('@/components/onboarding/steps/webDesktop/WebDesktopBackgroundServiceHandoffContent', () => ({
    WebDesktopBackgroundServiceHandoffContent: (props: Record<string, unknown>) => React.createElement('WebDesktopBackgroundServiceHandoffContent', props),
}));
vi.mock('@/components/account/auth/AuthEntryView', () => ({
    AuthEntryView: (props: Record<string, unknown>) => React.createElement('AuthEntryView', props),
}));
vi.mock('../checklists/relayHostLocal/RelayHostLocalChecklistStep', () => ({
    RelayHostLocalChecklistStep: (props: Record<string, unknown>) => {
        React.useEffect(() => {
            (props.onStatusChange as ((status: { relayUrl: string | null }) => void) | undefined)?.({ relayUrl: 'http://localhost:31337' });
        }, [props.onStatusChange]);
        return React.createElement('RelayHostLocalChecklistStep', props);
    },
}));
vi.mock('@/components/settings/server/localControl/LocalRelayAccessControlSection', () => ({
    LocalRelayAccessControlSection: (props: Record<string, unknown>) => {
        relayAccessWizardMockState.latestProps = props;
        const selectedProviderId = (
            (props.wizardSelectedProviderId as 'lan' | 'cloudflareNamed' | 'tailscaleServe' | 'tailscaleFunnel' | null | undefined)
            ?? relayAccessWizardMockState.effectSelectionProviderId
        );
        React.useEffect(() => {
            if (!relayAccessWizardMockState.emitSelectedProviderFromEffect) {
                return;
            }
            relayAccessWizardMockState.effectSelectionNotificationCount += 1;
            (props.onWizardSelectedProviderIdChange as ((
                providerId: 'lan' | 'cloudflareNamed' | 'tailscaleServe' | 'tailscaleFunnel'
            ) => void) | undefined)?.(selectedProviderId);
        }, [props.onWizardSelectedProviderIdChange, selectedProviderId]);
        return React.createElement('LocalRelayAccessControlSection', props);
    },
}));
vi.mock('@/components/ui/lists/SelectableRow', () => ({
    SelectableRow: (props: Record<string, unknown>) => React.createElement('SelectableRow', props),
}));
vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));
vi.mock('@expo/vector-icons/Ionicons', () => ({
    default: 'Ionicons',
    Ionicons: 'Ionicons',
}));
vi.mock('@/components/qr/QrCodeScannerView', () => ({
    QrCodeScannerView: (props: Record<string, unknown>) => React.createElement('QrCodeScannerView', props),
}));
const modalMock = createModalModuleMock({
    spies: {
        confirm: (title: string, message?: string, options?: unknown) => modalConfirmMock(title, message, options),
        alert: () => undefined,
    },
});

vi.mock('@/modal', () => modalMock.module);
vi.mock('@/components/serverProfiles/removeServerProfileUiAction', () => ({
    removeServerProfileUiAction: (params: unknown) => removeServerProfileUiActionMock(params),
}));
vi.mock('@/components/account/presentFirstKeyCredentialLifecycle', () => ({
    presentFirstKeyCredentialLifecycle: presentFirstKeyCredentialLifecycleMock,
}));
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

const baseAuthOptions = {
    serverAvailability: 'ready' as const,
    serverUrlForCopy: 'https://relay.example.test',
    showAuthActions: true,
    showProviderSignup: false,
    showAnonymousSignup: true,
    showMtlsLogin: false,
    showKeylessProviderLogin: false,
    providerId: null,
    keylessProviderId: null,
    providerSignupTitle: '',
    providerKeylessTitle: '',
    anonymousSignupTitle: 'Create account',
    mtlsTitle: 'Sign in with certificate',
    primaryAction: {
        kind: 'anonymous' as const,
        title: 'Create account',
    },
    mtlsPrimary: false,
    keylessPrimary: false,
    autoRedirect: {
        enabled: false,
        providerId: null,
        toKeyedProvision: false,
        toKeylessLogin: false,
        toMtls: false,
        toLegacySignupProvider: false,
    },
    retryServerCheck: vi.fn(),
};

describe('OnboardingWizardSurface', () => {
    beforeEach(() => {
        try {
            Object.defineProperty(globalThis.document, 'visibilityState', { value: 'visible', configurable: true });
        } catch {
            // ignore
        }
        setPendingSetupIntentMock.mockReset();
        getPendingSetupIntentMock.mockReset();
        clearPendingSetupIntentMock.mockReset();
        setActiveServerAndSwitchMock.mockReset();
        upsertActivateAndSwitchServerMock.mockReset();
        systemTaskRunnerState.nextResult = null;
        systemTaskRunnerState.startMock.mockReset();
        systemTaskRunnerState.cancelMock.mockReset();
        systemTaskRunnerState.respondMock.mockReset();
        systemTaskRunnerState.getSnapshotMock.mockReset();
        systemTaskRunnerState.subscribeMock.mockReset();
        getOrCreateHappierCloudServerProfileMock.mockReset();
        expoRouterMock.spies.push.mockReset();
        expoRouterMock.spies.replace.mockReset();
        webQrScannerSupportedMock.value = false;
        webMobileLikeQrScannerHostMock.value = false;
        webMobileLikeQrScannerHostMock.lastArgs = null;
        reactNativeMockState.os = 'web';
        configuredServerUrlEnvMockState.value = null;
        runtimeActiveMockState.value = true;
        activeServerSnapshotMock.serverId = 'relay-profile';
        activeServerSnapshotMock.serverUrl = '';
        activeServerSnapshotMock.activeLocalRelayUrl = null;
        getResetToDefaultServerIdMock.mockReturnValue('cloud-profile');
        listServerProfilesMock.mockReturnValue([]);
        modalConfirmMock.mockReset();
        modalConfirmMock.mockImplementation(async () => true);
        removeServerProfileUiActionMock.mockReset();
        removeServerProfileUiActionMock.mockResolvedValue({ kind: 'completed' });
        presentFirstKeyCredentialLifecycleMock.mockClear();
        serverProfilesSubscriptionMock.reset();
        relayAccessWizardMockState.emitSelectedProviderFromEffect = false;
        relayAccessWizardMockState.effectSelectionProviderId = 'lan';
        relayAccessWizardMockState.effectSelectionNotificationCount = 0;
        syncStoreHooksMockState.sessions = [];
        syncStoreHooksMockState.machines = {};
    });

    it('exposes wizard state and navigation through the controller hook', async () => {
        const { useOnboardingWizardController } = await import('./useOnboardingWizardController');
        const hook = await renderHook(() => useOnboardingWizardController({
            layout: 'portrait',
            isDesktopShell: true,
            authEntryOptions: baseAuthOptions,
            onCreateAccount: vi.fn(),
            onCreateAccountViaProvider: vi.fn(),
            onLoginWithKeylessProvider: vi.fn(),
            onLoginWithMtls: vi.fn(),
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
        expect(controller.skipLabel).toBe('common.next');

        await act(async () => {
            controller.onBack?.();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        controller = hook.getCurrent();
        expect(controller.stepId).toBe('welcome');
        expect(controller.contentTransitionDirection).toBe('backward');
    });

    it('labels the welcome action as start and the relay selection action as next', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        expect(screen.findByType(WizardModalShell as never).props.skipLabel).toBe('common.start');

        const startButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await startButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByType(WizardModalShell as never).props.skipLabel).toBe('common.next');
    });

    it('passes backward transition direction when returning to an earlier wizard step', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
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
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
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
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
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
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        expect(screen.findAllByType(WizardModalShell as never)).toHaveLength(0);
        expect(screen.findByTestId('onboarding-wizard-bare-title')).toBeTruthy();
        expect(screen.getTextContent()).toContain('setupOnboarding.preAuthTitle');
        expect(screen.findByTestId('onboarding-wizard-primary')).toBeTruthy();
    });

    it('renders bare skip affordance when the controller exposes skip for a non-welcome step', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                wizardChromeMode: 'bare',
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        expect(screen.findByTestId('onboarding-wizard-skip')).toBeTruthy();
    });

    it('uses the physical screen size (not the window size) for web QR-scanner heuristics on desktop shells', async () => {
        const originalScreen = (globalThis as unknown as { screen?: unknown }).screen;
        Object.defineProperty(globalThis, 'screen', {
            value: { width: 1440, height: 900, availWidth: 1440, availHeight: 900 },
            configurable: true,
        });

        webQrScannerSupportedMock.value = true;

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'auth',
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        expect(webMobileLikeQrScannerHostMock.lastArgs).toEqual({ width: 1440, height: 900 });

        Object.defineProperty(globalThis, 'screen', { value: originalScreen, configurable: true });
    });

    it('routes relay access LAN choice to the shared prereqs step', async () => {
        relayAccessWizardMockState.providerId = 'lan';
        relayAccessWizardMockState.renderedDetailsStep = null;
        relayAccessWizardMockState.latestProps = null;

        const relaySelectionHelpers = await import('./relaySelection/relaySelectionHelpers');
        const selectionSpy = vi.spyOn(relaySelectionHelpers, 'buildDefaultRelaySelection').mockReturnValue({
            choiceId: 'thisComputer',
            serverUrl: 'http://127.0.0.1:3005',
            relayProfileId: null,
            locked: false,
        });

        try {
            const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
            const screen = await renderScreen(
                React.createElement(OnboardingWizardSurface, {
                    layout: 'portrait',
                    isDesktopShell: true,
                    initialStepId: 'relay_access',
                    authEntryOptions: baseAuthOptions,
                    onCreateAccount: vi.fn(),
                    onCreateAccountViaProvider: vi.fn(),
                    onLoginWithKeylessProvider: vi.fn(),
                    onLoginWithMtls: vi.fn(),
                }),
            );

            await flushHookEffects({ cycles: 2, turns: 2 });
            expect(screen.findByType(WizardModalShell as never).props.title).toBe('setupOnboarding.relayAccessWizardTitle');
            expect(relayAccessWizardMockState.latestProps).toBeTruthy();
            expect(typeof (relayAccessWizardMockState.latestProps as any)?.onWizardRequestProviderDetails).toBe('function');

            await act(async () => {
                (relayAccessWizardMockState.latestProps as any)?.onWizardRequestProviderDetails?.('lan');
            });
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(screen.findByType(WizardModalShell as never).props.title).toBe('setupOnboarding.relayAccessWizardTitle');
            expect(relayAccessWizardMockState.renderedDetailsStep).toBe('lan');
        } finally {
            selectionSpy.mockRestore();
        }
    });

    it('keeps relay access wizard callbacks stable across parent rerenders', async () => {
        activeServerSnapshotMock.serverUrl = 'https://api.happier.dev';
        activeServerSnapshotMock.activeLocalRelayUrl = 'http://localhost:53288';

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
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

        const continueAfterRelayHosting = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueAfterRelayHosting.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const firstProps = relayAccessWizardMockState.latestProps as {
            onWizardSelectedProviderIdChange: unknown;
            onWizardRequestProviderDetails: unknown;
        } | null;
        expect(firstProps).toBeTruthy();

        await act(async () => {
            (firstProps?.onWizardSelectedProviderIdChange as ((providerId: 'lan' | 'cloudflareNamed') => void) | undefined)?.('cloudflareNamed');
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const nextProps = relayAccessWizardMockState.latestProps as {
            onWizardSelectedProviderIdChange: unknown;
            onWizardRequestProviderDetails: unknown;
        } | null;
        expect(nextProps).toBeTruthy();
        expect(nextProps?.onWizardSelectedProviderIdChange).toBe(firstProps?.onWizardSelectedProviderIdChange);
        expect(nextProps?.onWizardRequestProviderDetails).toBe(firstProps?.onWizardRequestProviderDetails);
        expect((nextProps as { serverProfileId?: unknown } | null)?.serverProfileId).toEqual(expect.any(String));

        const localRelayAccessSection = screen.findByType('LocalRelayAccessControlSection' as never) as unknown as {
            props: { target?: { kind: 'local' } | { kind: 'ssh'; ssh: { target: string; auth: 'agent' | 'keyfile' | 'password' } } };
        };
        expect(localRelayAccessSection).toBeTruthy();
        expect(localRelayAccessSection.props.target).toEqual({ kind: 'local' });
    });

    it('settles after a single relay access provider sync effect', async () => {
        activeServerSnapshotMock.serverUrl = 'https://api.happier.dev';
        activeServerSnapshotMock.activeLocalRelayUrl = 'http://localhost:53288';
        relayAccessWizardMockState.emitSelectedProviderFromEffect = true;
        relayAccessWizardMockState.effectSelectionProviderId = 'lan';

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
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
        await flushHookEffects({ cycles: 3, turns: 3 });

        const continueAfterRelayHosting = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueAfterRelayHosting.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const localRelayAccessSection = screen.findByType('LocalRelayAccessControlSection' as never) as unknown as {
            props: { target?: { kind: 'local' } | { kind: 'ssh'; ssh: { target: string; auth: 'agent' | 'keyfile' | 'password' } } };
        };
        expect(localRelayAccessSection).toBeTruthy();
        expect(localRelayAccessSection.props.target).toEqual({ kind: 'local' });
        expect(relayAccessWizardMockState.effectSelectionNotificationCount).toBe(1);
    });

    it('routes relay access Cloudflare choice to the shared prereqs step', async () => {
        relayAccessWizardMockState.providerId = 'cloudflareNamed';
        relayAccessWizardMockState.renderedDetailsStep = null;
        relayAccessWizardMockState.latestProps = null;

        const relaySelectionHelpers = await import('./relaySelection/relaySelectionHelpers');
        const selectionSpy = vi.spyOn(relaySelectionHelpers, 'buildDefaultRelaySelection').mockReturnValue({
            choiceId: 'thisComputer',
            serverUrl: 'http://127.0.0.1:3005',
            relayProfileId: null,
            locked: false,
        });

        try {
            const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
            const screen = await renderScreen(
                React.createElement(OnboardingWizardSurface, {
                    layout: 'portrait',
                    isDesktopShell: true,
                    initialStepId: 'relay_access',
                    authEntryOptions: baseAuthOptions,
                    onCreateAccount: vi.fn(),
                    onCreateAccountViaProvider: vi.fn(),
                    onLoginWithKeylessProvider: vi.fn(),
                    onLoginWithMtls: vi.fn(),
                }),
            );

            await flushHookEffects({ cycles: 2, turns: 2 });
            expect(screen.findByType(WizardModalShell as never).props.title).toBe('setupOnboarding.relayAccessWizardTitle');
            expect(relayAccessWizardMockState.latestProps).toBeTruthy();
            expect(typeof (relayAccessWizardMockState.latestProps as any)?.onWizardRequestProviderDetails).toBe('function');

            await act(async () => {
                (relayAccessWizardMockState.latestProps as any)?.onWizardRequestProviderDetails?.('cloudflareNamed');
            });
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(screen.findByType(WizardModalShell as never).props.title).toBe('setupOnboarding.relayAccessWizardTitle');
            expect(relayAccessWizardMockState.renderedDetailsStep).toBe('cloudflareNamed');
        } finally {
            selectionSpy.mockRestore();
        }
    });

    it.each([
        'tailscaleServe',
        'tailscaleFunnel',
    ] as const)('routes relay access %s choice to the shared prereqs step', async (providerId) => {
        relayAccessWizardMockState.providerId = providerId;
        relayAccessWizardMockState.renderedDetailsStep = null;
        relayAccessWizardMockState.latestProps = null;

        const relaySelectionHelpers = await import('./relaySelection/relaySelectionHelpers');
        const selectionSpy = vi.spyOn(relaySelectionHelpers, 'buildDefaultRelaySelection').mockReturnValue({
            choiceId: 'thisComputer',
            serverUrl: 'http://127.0.0.1:3005',
            relayProfileId: null,
            locked: false,
        });

        try {
            const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
            const screen = await renderScreen(
                React.createElement(OnboardingWizardSurface, {
                    layout: 'portrait',
                    isDesktopShell: true,
                    initialStepId: 'relay_access',
                    authEntryOptions: baseAuthOptions,
                    onCreateAccount: vi.fn(),
                    onCreateAccountViaProvider: vi.fn(),
                    onLoginWithKeylessProvider: vi.fn(),
                    onLoginWithMtls: vi.fn(),
                }),
            );

            await flushHookEffects({ cycles: 2, turns: 2 });
            expect(screen.findByType(WizardModalShell as never).props.title).toBe('setupOnboarding.relayAccessWizardTitle');
            expect(relayAccessWizardMockState.latestProps).toBeTruthy();
            expect(typeof (relayAccessWizardMockState.latestProps as any)?.onWizardRequestProviderDetails).toBe('function');

            await act(async () => {
                (relayAccessWizardMockState.latestProps as any)?.onWizardRequestProviderDetails?.(providerId);
            });
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(screen.findByType(WizardModalShell as never).props.title).toBe('setupOnboarding.relayAccessWizardTitle');
            expect(relayAccessWizardMockState.renderedDetailsStep).toBe(providerId);
        } finally {
            selectionSpy.mockRestore();
        }
    });

    it('only marks Happier Cloud as recommended in the relay selection list', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
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
                    onCreateAccount: vi.fn(),
                    onCreateAccountViaProvider: vi.fn(),
                    onLoginWithKeylessProvider: vi.fn(),
                    onLoginWithMtls: vi.fn(),
                }),
            );

            expect(getOrCreateHappierCloudServerProfileMock).not.toHaveBeenCalled();
            expect(screen.findByTestId('onboarding-wizard-relay:cloud')).toBeNull();
        } finally {
            if (previousDeny === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
            else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousDeny;
        }
    });

    it('shows Happier Cloud when allowed without creating a server profile during render', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        expect(screen.findByTestId('onboarding-wizard-relay:cloud')).toBeTruthy();
        expect(getOrCreateHappierCloudServerProfileMock).not.toHaveBeenCalled();
    });

    it('creates the canonical cloud profile from welcome auth actions only after user intent', async () => {
        listServerProfilesMock.mockReturnValue([]);
        activeServerSnapshotMock.serverUrl = '';

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        expect(getOrCreateHappierCloudServerProfileMock).not.toHaveBeenCalled();

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
            await screen.findByTestId('welcome-secondary-login')!.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(getOrCreateHappierCloudServerProfileMock).toHaveBeenCalledTimes(1);
        expect(setActiveServerAndSwitchMock).toHaveBeenCalledWith({
            serverId: 'cloud-profile',
            scope: 'device',
        });
        expect(upsertActivateAndSwitchServerMock).not.toHaveBeenCalled();
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
                    onCreateAccount: vi.fn(),
                    onCreateAccountViaProvider: vi.fn(),
                    onLoginWithKeylessProvider: vi.fn(),
                    onLoginWithMtls: vi.fn(),
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
                    onCreateAccount: vi.fn(),
                    onCreateAccountViaProvider: vi.fn(),
                    onLoginWithKeylessProvider: vi.fn(),
                    onLoginWithMtls: vi.fn(),
                }),
            );

            expect(screen.findByTestId('onboarding-wizard-relay:thisComputer')).toBeNull();
        } finally {
            if (previousDeny === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
            else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousDeny;
        }
    });

    it('navigates to secret key login within the onboarding wizard from the restore step', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'auth_restore',
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        const restoreStep = screen.findByType('RestoreIndexEmbedded' as never) as unknown as ReactTestInstance;
        await act(async () => {
            (restoreStep.props as any).onOpenSecretKeyLogin?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findAllByType('SecretKeyLoginEmbedded' as never)).toHaveLength(1);
    });

    it('navigates back to the auth step from the restore step', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'auth_restore',
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        expect(screen.findAllByType('RestoreIndexEmbedded' as never)).toHaveLength(1);

        const backButton = screen.findByTestId('onboarding-wizard-back')!;
        await act(async () => {
            await backButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(findAllInCurrentWizardBodyByType(screen, 'RestoreIndexEmbedded' as never)).toHaveLength(0);
        expect(screen.findAllByTestId('onboarding-wizard-welcome-auth')).toHaveLength(0);
        expect(screen.findByType('AuthEntryView' as never)).toBeTruthy();
        expect(screen.findByTestId('onboarding-wizard-lost-access')).toBeTruthy();
    });

    it('treats skip on the restore QR step as an escape hatch back to auth', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'auth_restore',
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        expect(screen.findAllByType('RestoreIndexEmbedded' as never)).toHaveLength(1);

        const skipButton = screen.findByTestId('onboarding-wizard-skip')!;
        await act(async () => {
            await skipButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(findAllInCurrentWizardBodyByType(screen, 'RestoreIndexEmbedded' as never)).toHaveLength(0);
        expect(findAllInCurrentWizardBodyByType(screen, 'SecretKeyLoginEmbedded' as never)).toHaveLength(0);
        expect(screen.findByType('AuthEntryView' as never)).toBeTruthy();
    });

    it('activates the selected relay before running auth actions from the welcome screen', async () => {
        activeServerSnapshotMock.serverUrl = 'https://api.happier.dev';
        getResetToDefaultServerIdMock.mockReturnValue('cloud-profile');
        listServerProfilesMock.mockReturnValue([
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

        const callTrace: string[] = [];
        upsertActivateAndSwitchServerMock.mockImplementation(async () => {
            callTrace.push('switch');
            activeServerSnapshotMock.serverUrl = 'https://relay-b.example.test';
            return true;
        });
        const onCreateAccount = vi.fn(async () => {
            callTrace.push('create');
        });

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount,
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        const startButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await startButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const relayRow = screen.findByTestId('onboarding-wizard-relay:profile:relay-b')!;
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
            await screen.findByTestId('welcome-primary-start')?.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(upsertActivateAndSwitchServerMock).toHaveBeenCalledWith(expect.objectContaining({
            serverUrl: 'https://relay-b.example.test',
        }));
        expect(onCreateAccount).toHaveBeenCalledTimes(1);
        expect(callTrace).toEqual(['switch', 'create']);
    });

    it('keeps welcome auth actions pinned to the explicit active relay instead of the configured default relay', async () => {
        configuredServerUrlEnvMockState.value = 'http://127.0.0.1:3009';

        activeServerSnapshotMock.serverId = 'relay-override';
        activeServerSnapshotMock.serverUrl = 'https://relay-override.example.test';
        activeServerSnapshotMock.activeLocalRelayUrl = null;

        const onCreateAccount = vi.fn(async () => undefined);

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount,
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        const relayLine = screen.findByTestId('onboarding-wizard-relay-hint-line')!;
        expect(String(relayLine.props.children)).toContain('relay-override.example.test');
        expect(String(relayLine.props.children)).not.toContain('127.0.0.1:3009');

        await act(async () => {
            await screen.findByTestId('welcome-primary-start')?.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(upsertActivateAndSwitchServerMock).not.toHaveBeenCalledWith(expect.objectContaining({
            serverUrl: 'http://127.0.0.1:3009',
        }));
        expect(onCreateAccount).toHaveBeenCalledTimes(1);
    });

    it('keeps the welcome relay hint visible when the active relay supplies the URL', async () => {
        activeServerSnapshotMock.serverUrl = 'https://relay.example.test';

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        expect(screen.findAllByTestId('onboarding-wizard-relay-hint')).toHaveLength(1);
    });

    it('updates the active relay footer hint when the active server snapshot changes', async () => {
        activeServerSnapshotMock.serverUrl = 'https://relay.example.test';

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );
        await flushHookEffects({ cycles: 1, turns: 1 });
        expect(activeServerSubscriptionMock.getListenerCount()).toBeGreaterThan(0);

        const relayLine = screen.findByTestId('onboarding-wizard-relay-hint-line')!;
        expect(String(relayLine.props.children)).toContain('relay.example.test');

        activeServerSnapshotMock.serverUrl = 'https://relay-other.example.test';
        await act(async () => {
            activeServerSubscriptionMock.emit();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const updatedRelayLine = screen.findByTestId('onboarding-wizard-relay-hint-line')!;
        expect(String(updatedRelayLine.props.children)).toContain('relay-other.example.test');
    });

    it('does not render a duplicate relay selection action inside the welcome body', async () => {
        activeServerSnapshotMock.serverUrl = 'https://relay.example.test';

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        expect(screen.findByTestId('welcome-decision-panel')).toBeTruthy();
        expect(screen.findAllByTestId('onboarding-wizard-change-relay')).toHaveLength(0);
    });

    afterEach(() => {
        standardCleanup();
    });

    it('can start on relay selection when initialStepId is provided', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                initialStepId: 'relay_select',
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        expect(screen.findByTestId('onboarding-wizard-relay:cloud')).toBeTruthy();
        expect(screen.findAllByTestId('onboarding-wizard-welcome-body')).toHaveLength(0);
    });

    it('updates the active relay row when the active server changes', async () => {
        activeServerSnapshotMock.serverUrl = 'https://relay.example.test';
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                initialStepId: 'relay_select',
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        const before = screen.findByTestId('onboarding-wizard-relay:profile:active')!;
        expect(before.props.subtitle).toBe('https://relay.example.test');

        await act(async () => {
            activeServerSnapshotMock.serverUrl = 'https://relay-other.example.test';
            activeServerSubscriptionMock.emit();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const after = screen.findByTestId('onboarding-wizard-relay:profile:active')!;
        expect(after.props.subtitle).toBe('https://relay-other.example.test');
    });

    it('stores an awaiting-auth resume intent when continuing past relay selection', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
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

        expect(setPendingSetupIntentMock).toHaveBeenCalledWith({
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
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        const skipButton = screen.findByTestId('onboarding-wizard-skip')!;

        await act(async () => {
            await skipButton.props.onPress?.();
        });

        expect(setPendingSetupIntentMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('onboarding-wizard-relay:cloud')).toBeTruthy();
    });

    it('fast-paths from welcome to the restore login screen when a non-cloud relay is already selected', async () => {
        activeServerSnapshotMock.serverUrl = 'https://relay.example.test';

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        expect(screen.findAllByTestId('onboarding-wizard-primary')).toHaveLength(0);
        expect(screen.findByTestId('onboarding-wizard-relay-hint')).toBeTruthy();
        expect(screen.findByType(WizardModalShell as never).props.skipLabel).toBe('common.login');

        const loginButton = screen.findByTestId('onboarding-wizard-skip')!;
        await act(async () => {
            await loginButton.props.onPress?.();
        });

        expect(screen.findAllByType('RestoreIndexEmbedded' as never)).toHaveLength(1);
        expect(setPendingSetupIntentMock).toHaveBeenCalledWith({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
        });

        const backButton = screen.findByTestId('onboarding-wizard-back')!;
        await act(async () => {
            await backButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(findAllInCurrentWizardBodyByType(screen, 'RestoreIndexEmbedded' as never)).toHaveLength(0);
        expect(screen.findByTestId('welcome-decision-panel')).toBeTruthy();
        expect(screen.findByTestId('onboarding-wizard-relay-hint')).toBeTruthy();
    });

    it('hides duplicate relay escape-hatch actions when the selected relay is unreachable on the welcome step', async () => {
        activeServerSnapshotMock.serverUrl = 'https://relay.example.test';

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
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        expect(screen.findAllByTestId('onboarding-wizard-primary')).toHaveLength(0);
        expect(screen.findAllByTestId('onboarding-wizard-change-relay')).toHaveLength(0);
        expect(screen.findByTestId('welcome-auth-blocked')).toBeTruthy();
    });

    it('renders the welcome body block and selected server hint with clear back navigation', async () => {
        activeServerSnapshotMock.serverUrl = '';
        activeServerSnapshotMock.activeLocalRelayUrl = 'http://localhost:31337';
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        expect(screen.findByTestId('welcome-decision-panel')).toBeTruthy();
        expect(screen.findByTestId('onboarding-wizard-logotype')).toBeTruthy();
        expect(screen.findAllByTestId('onboarding-wizard-welcome-showcase')).toHaveLength(0);

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

        expect(screen.findByTestId('onboarding-wizard-relay-hint')).toBeTruthy();

        const continueToChecklistButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueToChecklistButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-back')).toBeTruthy();
    });

    it('runs anonymous account creation from the welcome decision primary action', async () => {
        activeServerSnapshotMock.serverUrl = 'https://relay.example.test';
        const onCreateAccount = vi.fn();

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount,
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        await act(async () => {
            await screen.findByTestId('welcome-primary-start')?.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(onCreateAccount).toHaveBeenCalledTimes(1);
    });

    it('uses a provider-specific primary action when anonymous signup is unavailable', async () => {
        activeServerSnapshotMock.serverUrl = 'https://relay.example.test';
        const onCreateAccountViaProvider = vi.fn();

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: {
                    ...baseAuthOptions,
                    showAnonymousSignup: false,
                    showProviderSignup: true,
                    providerId: 'github',
                    providerSignupTitle: 'Continue with GitHub',
                    primaryAction: {
                        kind: 'provider-keyed',
                        title: 'Continue with GitHub',
                    },
                },
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider,
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        expect(screen.findAllByTestId('welcome-primary-start')).toHaveLength(0);
        await act(async () => {
            await screen.findByTestId('welcome-provider-primary')?.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(onCreateAccountViaProvider).toHaveBeenCalledWith('github');
    });

    it('uses the mTLS primary action for managed certificate login states', async () => {
        activeServerSnapshotMock.serverUrl = 'https://relay.example.test';
        const onLoginWithMtls = vi.fn();

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: {
                    ...baseAuthOptions,
                    showAnonymousSignup: false,
                    showMtlsLogin: true,
                    mtlsPrimary: true,
                    primaryAction: {
                        kind: 'mtls',
                        title: 'Sign in with certificate',
                    },
                },
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls,
            }),
        );

        expect(screen.findAllByTestId('welcome-primary-start')).toHaveLength(0);
        await act(async () => {
            await screen.findByTestId('welcome-mtls-primary')?.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(onLoginWithMtls).toHaveBeenCalledTimes(1);
    });

    it('does not render welcome decision actions while auth capability loading is unresolved', async () => {
        activeServerSnapshotMock.serverUrl = 'https://relay.example.test';

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: {
                    ...baseAuthOptions,
                    serverAvailability: 'loading',
                    showAuthActions: false,
                    showAnonymousSignup: false,
                },
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        expect(screen.findByTestId('welcome-auth-loading')).toBeTruthy();
        expect(screen.findAllByTestId('welcome-primary-start')).toHaveLength(0);
        expect(screen.findAllByTestId('welcome-secondary-login')).toHaveLength(0);
    });

    it('shows welcome decision actions when the relay is already known', async () => {
        activeServerSnapshotMock.serverUrl = 'https://relay.example.test';
        listServerProfilesMock.mockReturnValue([
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
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        expect(screen.findByTestId('welcome-decision-panel')).toBeTruthy();
        expect(screen.findByType(WizardModalShell as never).props.skipLabel).toBe('common.login');
        expect(screen.findAllByTestId('onboarding-wizard-primary')).toHaveLength(0);
        expect(screen.findByTestId('onboarding-wizard-relay-hint')).toBeTruthy();
        expect(screen.findAllByTestId('onboarding-wizard-change-relay')).toHaveLength(0);
    });

    it('leaves relay selection on the shell footer instead of rendering a duplicate welcome body action', async () => {
        activeServerSnapshotMock.serverUrl = 'https://relay.example.test';
        listServerProfilesMock.mockReturnValue([
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
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        expect(screen.findByTestId('welcome-decision-panel')).toBeTruthy();
        expect(screen.findAllByTestId('onboarding-wizard-change-relay')).toHaveLength(0);
    });

    it('shows auth actions on welcome after the user picks a saved relay and returns back to the intro', async () => {
        activeServerSnapshotMock.serverUrl = '';
        getResetToDefaultServerIdMock.mockReturnValue('');
        listServerProfilesMock.mockReturnValue([
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
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        const startButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await startButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const relayRow = screen.findByTestId('onboarding-wizard-relay:profile:relay-b')!;
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
        activeServerSnapshotMock.serverUrl = '';
        getResetToDefaultServerIdMock.mockReturnValue('');
        listServerProfilesMock.mockReturnValue([
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
        upsertActivateAndSwitchServerMock
            .mockResolvedValueOnce(true)
            .mockImplementationOnce(async () => {
                await new Promise<void>((resolve) => setTimeout(resolve, 50));
                return true;
            });

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        const startButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await startButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const relayRow = screen.findByTestId('onboarding-wizard-relay:profile:relay-b')!;
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
            await screen.findByTestId('welcome-secondary-login')?.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const restoreStep = screen.findByType('RestoreIndexEmbedded' as never) as unknown as ReactTestInstance;
        act(() => {
            void (restoreStep.props as any).onOpenSecretKeyLogin?.();
        });
        expect(screen.findAllByType('SecretKeyLoginEmbedded' as never)).toHaveLength(1);

        const backFromSecretKey = screen.findByTestId('onboarding-wizard-back')!;
        await act(async () => {
            await backFromSecretKey.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(findAllInCurrentWizardBodyByType(screen, 'SecretKeyLoginEmbedded' as never)).toHaveLength(0);
        expect(findAllInCurrentWizardBodyByType(screen, 'RestoreIndexEmbedded' as never)).toHaveLength(1);

        const backFromRestore = screen.findByTestId('onboarding-wizard-back')!;
        await act(async () => {
            await backFromRestore.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(findAllInCurrentWizardBodyByType(screen, 'RestoreIndexEmbedded' as never)).toHaveLength(0);
        expect(screen.findByTestId('welcome-decision-panel')).toBeTruthy();
    });

    it('opens lost access without waiting for a redundant active-server switch', async () => {
        activeServerSnapshotMock.serverUrl = '';
        getResetToDefaultServerIdMock.mockReturnValue('');
        listServerProfilesMock.mockReturnValue([
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
        upsertActivateAndSwitchServerMock
            .mockResolvedValueOnce(true)
            .mockImplementationOnce(async () => {
                await new Promise<void>((resolve) => setTimeout(resolve, 50));
                return true;
            });

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        await pressOnboarding(screen, 'onboarding-wizard-primary');
        const relayRow = screen.findByTestId('onboarding-wizard-relay:profile:relay-b')!;
        await act(async () => {
            await relayRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });
        await pressOnboarding(screen, 'onboarding-wizard-primary');

        expect(getOnboardingStepId(screen)).toBe('auth');
        const lostAccess = screen.findByTestId('onboarding-wizard-lost-access')!;
        act(() => {
            void lostAccess.props.onPress?.();
        });

        expect(getOnboardingStepId(screen)).toBe('auth_lost_access');
    });

    it('only advances to relay URL entry after pressing Continue when selecting the custom relay option', async () => {
        activeServerSnapshotMock.serverUrl = 'https://api.happier.dev';

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                initialStepId: 'relay_select',
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
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
        activeServerSnapshotMock.serverUrl = 'https://prefilled.relay.test';

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                initialStepId: 'relay_select',
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
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
    });

    it('routes the auth view change-relay action back to the wizard relay selection step', async () => {
        activeServerSnapshotMock.serverUrl = 'https://relay.example.test';

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'auth',
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        const authEntry = screen.findByType('AuthEntryView' as never) as unknown as {
            props: { onChangeRelay?: () => void };
        };

        await act(async () => {
            await authEntry.props.onChangeRelay?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-relay:cloud')).toBeTruthy();
    });

    it('threads desktop shell status to auth but suppresses the setup affordance before auth', async () => {
        activeServerSnapshotMock.serverUrl = 'https://relay.example.test';

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'auth',
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        const authEntry = screen.findByType('AuthEntryView' as never) as unknown as {
            props: { isDesktopShell?: boolean; showOpenSetupAction?: boolean; onOpenSetup?: () => void };
        };
        expect(authEntry.props.isDesktopShell).toBe(true);
        expect(authEntry.props.showOpenSetupAction).toBe(false);
        expect(authEntry.props.onOpenSetup).toEqual(expect.any(Function));

        expect(expoRouterMock.spies.push).not.toHaveBeenCalledWith('/setup');
    });

    type PreAuthMatrixPlatform = 'desktop' | 'web' | 'native';
    type RenderedOnboardingScreen = Awaited<ReturnType<typeof renderScreen>>;

    const setPreAuthMatrixPlatform = (platform: PreAuthMatrixPlatform) => {
        reactNativeMockState.os = platform === 'native' ? 'ios' : 'web';
        activeServerSnapshotMock.serverUrl = 'https://api.happier.dev';
        activeServerSnapshotMock.activeLocalRelayUrl = null;
    };

    const renderPreAuthRelayMatrix = async (platform: PreAuthMatrixPlatform) => {
        setPreAuthMatrixPlatform(platform);
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        return renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: platform === 'desktop',
                authEntryOptions: baseAuthOptions,
                initialStepId: 'relay_select',
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );
    };

    const pressOnboarding = async (screen: RenderedOnboardingScreen, testID: string) => {
        const node = screen.findByTestId(testID);
        expect(node).toBeTruthy();
        await act(async () => {
            await node?.props.onPress?.();
        });
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

        expect(getOnboardingStepId(screen)).toBe('auth');
        expect(upsertActivateAndSwitchServerMock).toHaveBeenLastCalledWith({
            serverUrl: `https://${platform}.custom-relay.example.test`,
            source: 'url',
            scope: 'device',
        });
    });

    it.each([
        ['desktop', 'desktop'],
        ['web', 'web'],
        ['native', 'native'],
    ] as const)('characterizes saved relay profile selection on %s', async (_label, platform) => {
        listServerProfilesMock.mockReturnValue([
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

        await pressOnboarding(screen, `onboarding-wizard-relay:profile:saved-${platform}`);
        await pressOnboarding(screen, 'onboarding-wizard-primary');

        expect(getOnboardingStepId(screen)).toBe('auth');
        expect(upsertActivateAndSwitchServerMock).toHaveBeenLastCalledWith({
            serverUrl: `https://${platform}.saved-relay.example.test`,
            source: 'url',
            scope: 'device',
        });
    });

    it('continues from the default active saved relay without reactivating it', async () => {
        const activeRelayUrl = 'http://happier-repo-dev-a1cc5e0671.localhost:53288';
        setPreAuthMatrixPlatform('web');
        activeServerSnapshotMock.serverUrl = activeRelayUrl;
        listServerProfilesMock.mockReturnValue([
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

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            <OnboardingWizardSurface
                layout="portrait"
                isDesktopShell={false}
                authEntryOptions={baseAuthOptions}
                initialStepId="relay_select"
                onCreateAccount={vi.fn()}
                onCreateAccountViaProvider={vi.fn()}
                onLoginWithKeylessProvider={vi.fn()}
                onLoginWithMtls={vi.fn()}
            />,
        );

        await pressOnboarding(screen, 'onboarding-wizard-primary');

        expect(getOnboardingStepId(screen)).toBe('auth');
        expect(upsertActivateAndSwitchServerMock).not.toHaveBeenCalled();
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

        expect(getOnboardingStepId(screen)).toBe('background_service_handoff');

        await pressOnboarding(screen, 'onboarding-wizard-primary');
        expect(getOnboardingStepId(screen)).toBe('auth');
    });

    it('guides web users to continue on desktop when selecting "On this computer"', async () => {
        activeServerSnapshotMock.serverUrl = 'https://api.happier.dev';
        activeServerSnapshotMock.activeLocalRelayUrl = null;

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: false,
                authEntryOptions: baseAuthOptions,
                initialStepId: 'relay_select',
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        const thisComputerRow = screen.findByTestId('onboarding-wizard-relay:thisComputer')!;
        await act(async () => {
            await thisComputerRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const continueAfterCredentials = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueAfterCredentials.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-desktop-handoff')).toBeTruthy();

        const handoffContinueButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await handoffContinueButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-relay-url-input')).toBeTruthy();
    });

    it('routes desktop users to the local relay hosting checklist when selecting "On this computer" and the local relay bind URL is unreachable', async () => {
        activeServerSnapshotMock.serverUrl = 'https://api.happier.dev';
        activeServerSnapshotMock.activeLocalRelayUrl = 'http://localhost:53288';

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

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                initialStepId: 'relay_select',
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        const thisComputerRow = screen.findByTestId('onboarding-wizard-relay:thisComputer')!;
        await act(async () => {
            await thisComputerRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const continueButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-relay-host-local')).toBeTruthy();

        runtimeFetchMock.mockImplementation(previousFetchImpl ?? (async (input: RequestInfo | URL, init?: RequestInit) => (
            new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
        )));
    });

    it('still routes desktop users to the local relay hosting checklist when selecting "On this computer" and the local relay bind URL is reachable', async () => {
        activeServerSnapshotMock.serverUrl = 'https://api.happier.dev';
        activeServerSnapshotMock.activeLocalRelayUrl = 'http://localhost:53288';

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                initialStepId: 'relay_select',
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
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
        expect(screen.findAllByType('LocalRelayAccessControlSection' as never)).toHaveLength(0);
    });

    it('does not treat *.localhost URLs as a true local relay runtime bind URL for the "On this computer" fast-path', async () => {
        activeServerSnapshotMock.serverUrl = 'https://api.happier.dev';
        activeServerSnapshotMock.activeLocalRelayUrl = 'http://happier-repo-dev-a1cc5e0671.localhost:19364';

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                initialStepId: 'relay_select',
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
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
    });

    it('treats native as a handoff flow: enables "On your computer" and routes to the handoff step', async () => {
        reactNativeMockState.os = 'ios';
        vi.resetModules();

        activeServerSnapshotMock.serverUrl = 'https://api.happier.dev';
        activeServerSnapshotMock.activeLocalRelayUrl = null;

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: false,
                authEntryOptions: baseAuthOptions,
                initialStepId: 'relay_select',
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        const thisComputerRow = screen.findByTestId('onboarding-wizard-relay:thisComputer')!;
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
        vi.resetModules();

        activeServerSnapshotMock.serverUrl = 'https://api.happier.dev';
        activeServerSnapshotMock.activeLocalRelayUrl = null;

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: false,
                authEntryOptions: baseAuthOptions,
                initialStepId: 'relay_select',
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
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
        activeServerSnapshotMock.serverUrl = 'https://api.happier.dev';

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                initialStepId: 'relay_select',
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
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

        expect(screen.findByTestId('onboarding-wizard-lost-access')).not.toBeNull();

        const backButton = screen.findByTestId('onboarding-wizard-back')!;
        await act(async () => {
            await backButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-relay:customUrl')).not.toBeNull();

        const activeRelayRow = screen.findByProps({ testID: 'onboarding-wizard-relay:profile:active' } as never);
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

    it('routes through local relay hosting on desktop when "On this computer" is selected', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        const startButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await startButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const localRelayRow = screen.findByTestId('onboarding-wizard-relay:thisComputer')!;
        await act(async () => {
            await localRelayRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const continueToPlanButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueToPlanButton.props.onPress?.();
        });

        expect(screen.findByType('RelayHostLocalChecklistStep' as never)).toBeTruthy();
    });

    it('requires explicit relay switch confirmation after hosting a local relay', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
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

        expect(screen.findByType('RelayHostLocalChecklistStep' as never)).toBeTruthy();

        const continueAfterHosted = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueAfterHosted.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(upsertActivateAndSwitchServerMock).not.toHaveBeenCalled();
        expect(screen.findByType('LocalRelayAccessControlSection' as never)).toBeTruthy();

        const continueAfterAccess = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueAfterAccess.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-confirmSwitchRelay')).toBeTruthy();

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

        expect(upsertActivateAndSwitchServerMock).toHaveBeenCalledWith(expect.objectContaining({ serverUrl: 'http://localhost:31337' }));
        expect(screen.findByTestId('onboarding-wizard-lost-access')).not.toBeNull();
    });

    it('shows relay access configuration before prompting to switch to the hosted relay', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
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

        expect(screen.findByType('RelayHostLocalChecklistStep' as never)).toBeTruthy();

        const continueAfterHosted = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueAfterHosted.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByType('LocalRelayAccessControlSection' as never)).toBeTruthy();
        expect(screen.findByTestId('onboarding-wizard-confirmSwitchRelay')).toBeNull();

        const continueAfterAccess = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueAfterAccess.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-confirmSwitchRelay')).toBeTruthy();
    });

    it('routes web users selecting "On this computer" to the desktop handoff guidance step', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: false,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
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

    it('renders a desktop-only remote computer relay option', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        const startButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await startButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-relay:remoteComputer')).toBeTruthy();
    });

    it('branches remote relay hosting into the shared SSH checklist instead of continuing to auth immediately', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
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

        expect(screen.findByTestId('onboarding-wizard-remote-ssh')).toBeTruthy();
    });

    it('lets the remote relay host step override the wizard primary CTA via the wizard chrome (no embedded buttons)', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
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

        const primaryOnRemote = screen.findByTestId('onboarding-wizard-primary')!;
        const textNodes: string[] = [];
        const visit = (node: ReactTestInstance) => {
            const children = node.props?.children;
            if (typeof children === 'string') {
                textNodes.push(children);
            } else if (Array.isArray(children)) {
                for (const child of children) {
                    if (typeof child === 'string') {
                        textNodes.push(child);
                    }
                }
            }
            for (const child of node.children) {
                if (typeof child !== 'string') {
                    visit(child);
                } else {
                    textNodes.push(child);
                }
            }
        };
        visit(primaryOnRemote);
        expect(textNodes.join(' ')).toContain('Run remote setup');
    });

    it('routes remote relay hosting through relay access before prompting to switch', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
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

        const remoteChecklistProps = remoteSshChecklistMock.spy.mock.calls.at(-1)?.[0] as {
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
            remoteChecklistProps?.onRequestAdvance?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByType('LocalRelayAccessControlSection' as never)).toBeTruthy();
        expect((screen.findByType('LocalRelayAccessControlSection' as never) as unknown as {
            props: { target?: { kind: 'local' } | { kind: 'ssh'; ssh: { target: string; auth: 'agent' | 'keyfile' | 'password' } } };
        }).props.target).toEqual({
            kind: 'ssh',
            ssh: {
                target: 'root@remote.example.test',
                auth: 'agent',
            },
        });
        expect(screen.findByTestId('onboarding-wizard-confirmSwitchRelay')).toBeNull();

        const continueAfterRelayAccess = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueAfterRelayAccess.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-confirmSwitchRelay')).toBeTruthy();
    });

    it('switches remote relay hosting through the configured share URL once relay access provides one', async () => {
        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
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

        const remoteChecklistProps = remoteSshChecklistMock.spy.mock.calls.at(-1)?.[0] as {
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
            remoteChecklistProps?.onRequestAdvance?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        await act(async () => {
            (relayAccessWizardMockState.latestProps as { onShareUrlChange?: (value: string | null) => void } | null)
                ?.onShareUrlChange?.('https://remote-share.example.test');
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const continueAfterRelayAccess = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueAfterRelayAccess.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const confirmBody = screen.findByTestId('onboarding-wizard-confirmSwitchRelay')!;
        expect(String(confirmBody.props.relayUrl ?? screen.getTextContent())).toContain('remote-share.example.test');

        const confirmButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await confirmButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(upsertActivateAndSwitchServerMock).toHaveBeenCalledWith(expect.objectContaining({
            serverUrl: 'https://remote-share.example.test',
        }));
        expect(setPendingSetupIntentMock).toHaveBeenCalledWith(expect.objectContaining({
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
        systemTaskRunnerState.startMock.mockResolvedValueOnce('task_prepare_tailscale_1');
        systemTaskRunnerState.nextResult = {
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
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
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

        const remoteChecklistProps = remoteSshChecklistMock.spy.mock.calls.at(-1)?.[0] as {
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
            remoteChecklistProps?.onRequestAdvance?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const continueAfterRelayAccess = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await continueAfterRelayAccess.props.onPress?.();
        });
        await flushHookEffects({ cycles: 4, turns: 4 });

        expect(screen.findByTestId('onboarding-wizard-confirmSwitchRelay')).toBeTruthy();
        expect(screen.findByTestId('server-settings-add-reachability-remediation')).toBeTruthy();
        expect(screen.findByTestId('onboarding-wizard-primary')?.props.disabled).toBe(true);

        relayReachable = true;
        const remediationButton = screen.findByTestId('server-settings-add-remediation-action-prepare_tailscale')!;
        await act(async () => {
            const handler = remediationButton.props.action ?? remediationButton.props.onPress;
            await handler?.();
        });
        await flushHookEffects({ cycles: 6, turns: 6 });

        expect(systemTaskRunnerState.startMock).toHaveBeenCalledWith({
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
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
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
        activeServerSnapshotMock.serverUrl = 'https://relay-b.example.test';
        listServerProfilesMock.mockReturnValue([
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
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByProps({ testID: 'onboarding-wizard-relay:profile:relay-a' } as never)).toBeTruthy();
        const relayRow = screen.findByProps({ testID: 'onboarding-wizard-relay:profile:relay-b' } as never);
        expect(relayRow).toBeTruthy();
        expect(relayRow?.props.selected).toBe(true);
        expect(screen.findByTestId('onboarding-wizard-relay:customUrl')).toBeTruthy();
        expect(screen.findByProps({ testID: 'onboarding-wizard-relay:cloud' } as never)?.props.selected).toBe(false);
    });

    it('continues from the default active saved relay without requiring the user to reselect it', async () => {
        activeServerSnapshotMock.serverId = 'relay-real';
        activeServerSnapshotMock.serverUrl = 'http://localhost:53288';
        listServerProfilesMock.mockReturnValue([
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

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByProps({
            testID: 'onboarding-wizard-relay:profile:relay-real',
        } as never)?.props.selected).toBe(true);

        await pressOnboarding(screen, 'onboarding-wizard-primary');

        expect(screen.findByType('AuthEntryView' as never)).toBeTruthy();
        expect(screen.findByTestId('onboarding-wizard-relay-url-input')).toBeNull();
        expect(upsertActivateAndSwitchServerMock).not.toHaveBeenCalled();
    });

    it('marks an unreachable saved relay as unavailable and offers a retry action', async () => {
        listServerProfilesMock.mockReturnValue([
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
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        await flushHookEffects({ cycles: 2, turns: 2 });

        const relayRow = screen.findByProps({ testID: 'onboarding-wizard-relay:profile:relay-offline' } as never);
        expect(relayRow?.props.disabled).toBe(false);
        expect(relayRow?.props.dimmed).toBe(true);
        expect(relayRow?.props.menuActions?.some((action: any) => action.id === 'retry')).toBe(true);
        const selectableRow = screen.findByProps({
            testID: 'onboarding-wizard-relay:profile:relay-offline',
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
        activeServerSnapshotMock.serverUrl = 'https://relay-a.example.test';
        listServerProfilesMock.mockReturnValue([
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
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        await flushHookEffects({ cycles: 2, turns: 2 });

        const relayRow = screen.findByProps({ testID: 'onboarding-wizard-relay:profile:relay-a' } as never);
        expect(relayRow?.props.selected).toBe(true);

        await act(async () => {
            const removeAction = relayRow?.props.menuActions?.find((action: any) => action.id === 'remove');
            await removeAction?.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(removeServerProfileUiActionMock).toHaveBeenCalled();

        const relayARowAfter = screen.findByProps({ testID: 'onboarding-wizard-relay:profile:relay-a' } as never);
        const relayBRowAfter = screen.findByProps({ testID: 'onboarding-wizard-relay:profile:relay-b' } as never);
        expect(relayARowAfter?.props.selected).toBe(false);
        expect(relayBRowAfter?.props.selected).toBe(false);
        expect(screen.findByTestId('onboarding-wizard-primary')!.props.disabled).toBe(true);
    });

    it('keeps the selected saved relay when marked custody blocks profile removal', async () => {
        activeServerSnapshotMock.serverUrl = 'https://relay-a.example.test';
        listServerProfilesMock.mockReturnValue([
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
        removeServerProfileUiActionMock.mockResolvedValueOnce({
            kind: 'finish_encryption_setup',
            recovery: {} as AccountEncryptionFirstKeyRecoveryHandle,
        });

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        await flushHookEffects({ cycles: 2, turns: 2 });

        const relayRow = screen.findByProps({ testID: 'onboarding-wizard-relay:profile:relay-a' } as never);
        await act(async () => {
            const removeAction = relayRow?.props.menuActions?.find((action: any) => action.id === 'remove');
            await removeAction?.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(presentFirstKeyCredentialLifecycleMock).toHaveBeenCalledTimes(1);
        const relayRowAfter = screen.findByProps({
            testID: 'onboarding-wizard-relay:profile:relay-a',
        } as never);
        expect(relayRowAfter?.props.selected).toBe(true);
        expect(screen.findByTestId('onboarding-wizard-primary')!.props.disabled).toBe(false);
    });

    it('removes a saved relay even when modal confirm is unavailable', async () => {
        modalConfirmMock.mockImplementation(async () => false);
        activeServerSnapshotMock.serverUrl = 'https://relay-a.example.test';
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
        listServerProfilesMock.mockImplementation(() => profilesState.slice());
        removeServerProfileUiActionMock.mockImplementation(async (params: any) => {
            const id = String(params?.profileId ?? '').trim();
            const index = profilesState.findIndex((profile) => profile.id === id);
            if (index >= 0) {
                profilesState.splice(index, 1);
                serverProfilesSubscriptionMock.bump();
            }
            return { kind: 'completed' };
        });

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        await flushHookEffects({ cycles: 2, turns: 2 });

        const relayRow = screen.findByProps({ testID: 'onboarding-wizard-relay:profile:relay-a' } as never);
        expect(relayRow?.props.selected).toBe(true);

        const callCountBefore = removeServerProfileUiActionMock.mock.calls.length;
        await act(async () => {
            const removeAction = relayRow?.props.menuActions?.find((action: any) => action.id === 'remove');
            await removeAction?.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(removeServerProfileUiActionMock.mock.calls.length).toBeGreaterThan(callCountBefore);
        const relayARowAfter = screen.findAll((node) => node.props?.testID === 'onboarding-wizard-relay:profile:relay-a');
        const relayBRowAfter = screen.findAll((node) => node.props?.testID === 'onboarding-wizard-relay:profile:relay-b');
        expect(relayARowAfter).toHaveLength(0);
        expect(relayBRowAfter.length).toBeGreaterThan(0);
        expect(screen.findByTestId('onboarding-wizard-primary')!.props.disabled).toBe(true);
    });

    it('does not show a saved relay row as selected when the user selected the “On this computer” option', async () => {
        activeServerSnapshotMock.activeLocalRelayUrl = 'http://localhost:53288';
        listServerProfilesMock.mockReturnValue([
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
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        await flushHookEffects({ cycles: 2, turns: 2 });

        const thisComputerRow = screen.findByTestId('onboarding-wizard-relay:thisComputer')!;
        await act(async () => {
            await thisComputerRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const localRelayRow = screen.findByProps({ testID: 'onboarding-wizard-relay:profile:local-relay' } as never);
        expect(screen.findByProps({ testID: 'onboarding-wizard-relay:thisComputer' } as never)?.props.selected).toBe(true);
        expect(localRelayRow?.props.selected).toBe(false);
    });

    it('renders a single-line relay footer and keeps Cloud from showing a custom URL footer', async () => {
        activeServerSnapshotMock.serverUrl = 'https://relay-b.example.test';
        listServerProfilesMock.mockReturnValue([
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
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        const cloudRow = screen.findByTestId('onboarding-wizard-relay:cloud')!;
        await act(async () => {
            await cloudRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-relay-hint')).toBeTruthy();
        expect(screen.findByTestId('onboarding-wizard-relay-hint-line')).toBeTruthy();
        expect(screen.findByTestId('onboarding-wizard-relay-hint-label')).toBeNull();
        expect(screen.findByTestId('onboarding-wizard-relay-hint-value')).toBeNull();
        expect(screen.findByTestId('onboarding-wizard-relay-hint-url')).toBeNull();
    });

    it('keeps an unreachable preselected relay selected and disables continue until a reachable relay is selected', async () => {
        activeServerSnapshotMock.serverUrl = 'https://unreachable-relay.example.test';
        listServerProfilesMock.mockReturnValue([
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
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        await flushHookEffects({ cycles: 2, turns: 2 });

        const offlineRow = screen.findByProps({ testID: 'onboarding-wizard-relay:profile:relay-offline' } as never);
        expect(offlineRow?.props.selected).toBe(true);
        expect(offlineRow?.props.disabled).toBe(false);

        const continueButton = screen.findByTestId('onboarding-wizard-primary')!;
        expect(continueButton.props.disabled).toBe(true);

        const cloudRow = screen.findByProps({ testID: 'onboarding-wizard-relay:cloud' } as never);
        expect(cloudRow?.props.selected).toBe(false);

        const okRow = screen.findByProps({ testID: 'onboarding-wizard-relay:profile:relay-ok' } as never);
        await act(async () => {
            await okRow?.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const continueButtonAfter = screen.findByTestId('onboarding-wizard-primary')!;
        expect(continueButtonAfter.props.disabled).toBe(false);
    });

    it('probes a manually entered custom relay url and disables continue when it is unreachable', async () => {
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

        activeServerSnapshotMock.serverUrl = '';
        activeServerSnapshotMock.activeLocalRelayUrl = null;
        listServerProfilesMock.mockReturnValue([]);

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
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

        const authEntry = screen.findByType('AuthEntryView' as never) as unknown as {
            props: { onChangeRelay?: () => void };
        };
        await act(async () => {
            await authEntry.props.onChangeRelay?.();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        const typedRelayRow = screen.findByProps({ testID: 'onboarding-wizard-relay:profile:active' } as never);
        expect(typedRelayRow?.props.selected).toBe(true);
        expect(typedRelayRow?.props.badge).toBe('common.unreachable');
        expect(typedRelayRow?.props.menuActions?.some((action: any) => action.id === 'retry')).toBe(true);
        expect(screen.findByProps({ testID: 'onboarding-wizard-relay:customUrl' } as never)?.props.selected).toBe(false);
        expect(screen.findByTestId('onboarding-wizard-primary')?.props.disabled).toBe(true);

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
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
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
        vi.resetModules();
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
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
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
        vi.resetModules();
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
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
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
            vi.resetModules();
            reactNativeMockState.os = 'web';
            runtimeActiveMockState.value = true;
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

            activeServerSnapshotMock.serverUrl = '';
            activeServerSnapshotMock.activeLocalRelayUrl = null;
            listServerProfilesMock.mockReturnValue([
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
                    onCreateAccount: vi.fn(),
                    onCreateAccountViaProvider: vi.fn(),
                    onLoginWithKeylessProvider: vi.fn(),
                    onLoginWithMtls: vi.fn(),
                }),
            );

            await flushHookEffects({ cycles: 4, turns: 4 });

            const localRow = screen.findByTestId('onboarding-wizard-relay:profile:local-http')!;
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
        activeServerSnapshotMock.serverUrl = 'http://localhost:53288';
        activeServerSnapshotMock.activeLocalRelayUrl = 'http://localhost:53288';
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
        listServerProfilesMock.mockReturnValue([]);

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        await flushHookEffects({ cycles: 2, turns: 2 });

        const localRelayRow = screen.findByProps({ testID: 'onboarding-wizard-relay:profile:active' } as never);
        expect(localRelayRow?.props.selected).toBe(true);
        expect(localRelayRow?.props.disabled).toBe(false);
        expect(screen.findByProps({ testID: 'onboarding-wizard-relay:thisComputer' } as never)?.props.selected).toBe(false);
        expect(screen.findByTestId('onboarding-wizard-primary')?.props.disabled).toBe(true);
        expect(screen.getTextContent()).toContain('setupOnboarding.currentRelayDescription');

        runtimeFetchMock.mockImplementation(previousFetchImpl ?? (async (input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })));
    });

    it('keeps the active local relay selected instead of auto-switching to This computer when it is unreachable', async () => {
        activeServerSnapshotMock.serverUrl = 'http://localhost:53288';
        activeServerSnapshotMock.activeLocalRelayUrl = 'http://localhost:53288';
        listServerProfilesMock.mockReturnValue([
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
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByProps({ testID: 'onboarding-wizard-relay:profile:local-relay' } as never)?.props.selected).toBe(true);
        expect(screen.findByProps({ testID: 'onboarding-wizard-relay:thisComputer' } as never)?.props.selected).toBe(false);
        expect(screen.getTextContent()).toContain('http://localhost:53288');
    });

    it('selects a single saved relay row when multiple profiles share the same server URL', async () => {
        activeServerSnapshotMock.serverUrl = 'https://duplicate-relay.example.test';
        activeServerSnapshotMock.activeLocalRelayUrl = null;
        listServerProfilesMock.mockReturnValue([
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
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        await flushHookEffects({ cycles: 2, turns: 2 });

        const first = screen.findByProps({ testID: 'onboarding-wizard-relay:profile:dup-1' } as never);
        const second = screen.findByProps({ testID: 'onboarding-wizard-relay:profile:dup-2' } as never);

        expect(first?.props.selected).toBe(true);
        expect(second?.props.selected).toBe(false);
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

        activeServerSnapshotMock.serverUrl = '';
        listServerProfilesMock.mockReturnValue([]);

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        await flushHookEffects({ cycles: 2, turns: 2 });

        const cloudRow = screen.findByTestId('onboarding-wizard-relay:cloud')!;
        await act(async () => {
            await cloudRow.props.onPress?.();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByTestId('onboarding-wizard-primary')?.props.disabled).toBe(true);
        expect(screen.findByTestId('onboarding-wizard-skip')?.props.disabled).toBe(true);

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

        activeServerSnapshotMock.serverUrl = 'http://localhost:59331';
        listServerProfilesMock.mockReturnValue([]);

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                initialStepId: 'relay_select',
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
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
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
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

        expect(setActiveServerAndSwitchMock).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'cloud-profile' }));
        expect(upsertActivateAndSwitchServerMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('onboarding-wizard-lost-access')).not.toBeNull();
    });

    it('treats Happier Cloud as https://api.happier.dev even when the reset-to-default server differs', async () => {
        getResetToDefaultServerIdMock.mockImplementation(() => 'selfhost-profile');
        getServerProfileByIdMock.mockImplementation((serverId: string) => (
            serverId === 'selfhost-profile'
                ? {
                    id: 'selfhost-profile',
                    name: 'Self hosted',
                    serverUrl: 'https://selfhosted.example.test',
                    createdAt: 0,
                    updatedAt: 0,
                    lastUsedAt: 0,
                    source: 'url' as const,
                }
                : serverId === 'cloud-profile'
                    ? {
                        id: 'cloud-profile',
                        name: 'Happier Cloud',
                        serverUrl: 'https://api.happier.dev',
                        createdAt: 0,
                        updatedAt: 0,
                        lastUsedAt: 0,
                        source: 'preconfigured' as const,
                    }
                    : null
        ));
        setActiveServerAndSwitchMock.mockClear();

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                initialStepId: 'relay_select',
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
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

        expect(setActiveServerAndSwitchMock).toHaveBeenCalledWith({
            serverId: 'cloud-profile',
            scope: 'device',
        });
    });

    it('routes a scanned pairing link without an embedded server url to relay URL entry', async () => {
        webQrScannerSupportedMock.value = true;
        webMobileLikeQrScannerHostMock.value = true;

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        const loginButton = screen.findByTestId('welcome-secondary-login')!;
        await act(async () => {
            await loginButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const scanner = screen.findByType('QrCodeScannerView')!;

        await act(async () => {
            await scanner.props.onScan?.('happier:///pair?v=1&pairId=pair_1&secret=sec_1');
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-relay-url-input')).not.toBeNull();
    });

    it('clears scan-step opt-in after backing out of the QR scanner', async () => {
        webQrScannerSupportedMock.value = true;
        webMobileLikeQrScannerHostMock.value = true;

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        const loginButton = screen.findByTestId('welcome-secondary-login')!;
        await act(async () => {
            await loginButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByType('QrCodeScannerView')).toBeTruthy();

        const backButton = screen.findByTestId('onboarding-wizard-back')!;
        await act(async () => {
            await backButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('welcome-decision-panel')).toBeTruthy();

        const startButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await startButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-relay:cloud')).toBeTruthy();
        expect(screen.findAllByType('QrCodeScannerView')).toHaveLength(0);
    });

    it('requires explicit confirmation before locking in a scanned relay url', async () => {
        webQrScannerSupportedMock.value = true;
        webMobileLikeQrScannerHostMock.value = true;

        const { OnboardingWizardSurface } = await import('./OnboardingWizardSurface');
        const screen = await renderScreen(
            React.createElement(OnboardingWizardSurface, {
                layout: 'portrait',
                isDesktopShell: true,
                authEntryOptions: baseAuthOptions,
                onCreateAccount: vi.fn(),
                onCreateAccountViaProvider: vi.fn(),
                onLoginWithKeylessProvider: vi.fn(),
                onLoginWithMtls: vi.fn(),
            }),
        );

        const loginButton = screen.findByTestId('welcome-secondary-login')!;
        await act(async () => {
            await loginButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const scanner = screen.findByType('QrCodeScannerView')!;

        await act(async () => {
            await scanner.props.onScan?.('https://relay.example.com');
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-confirm-relay-lock')).not.toBeNull();

        const confirmButton = screen.findByTestId('onboarding-wizard-primary')!;
        await act(async () => {
            await confirmButton.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.findByTestId('onboarding-wizard-lost-access')).not.toBeNull();
    });
});
