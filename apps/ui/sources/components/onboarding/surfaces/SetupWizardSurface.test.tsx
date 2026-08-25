import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { installReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { storage } from '@/sync/domains/state/storageStore';

import { WizardModalShell } from '../ui/WizardModalShell';

const routerMock = vi.hoisted(() => ({
    spies: {
        push: vi.fn(),
        replace: vi.fn(),
        back: vi.fn(),
        setParams: vi.fn(),
    },
    module: null as unknown,
}));
const activeServerSnapshotMock = vi.hoisted(() => ({
    serverId: 'relay-profile',
    serverUrl: 'https://relay.example.test',
    activeLocalRelayUrl: null as string | null,
    generation: 1,
}));
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
const machineCapabilitiesDetectMock = vi.hoisted(() => vi.fn(async () => ({
    supported: true,
    response: {
        protocolVersion: 1,
        results: {},
    },
})));
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

const setupThisComputerWizardStepMock = vi.hoisted(() => ({
    forceBackHidden: false,
}));
const emptyMachineListByServerId = vi.hoisted(() => ({} as Record<string, never>));

const syncStoreHooksMockState = vi.hoisted(() => ({
    sessions: [] as Array<Record<string, unknown>>,
    machines: {} as Record<string, Record<string, unknown>>,
}));
const nativeSshAvailabilityMock = vi.hoisted(() => ({
    available: false,
}));

vi.mock('@happier-dev/ssh-native', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@happier-dev/ssh-native')>();
    return {
        ...actual,
        getNativeSshAvailability: () => nativeSshAvailabilityMock.available
            ? {
                available: true as const,
                platform: 'ios' as const,
                engine: 'libssh2' as const,
                moduleVersion: 'test',
                supportsLoopbackTunnel: true,
                supportsPersistentHostKeyStorage: true,
            }
            : {
                available: false as const,
                reason: 'native-module-missing' as const,
            },
    };
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const mock = createExpoRouterMock({
        router: routerMock.spies,
    });
    routerMock.module = mock.module;
    return mock.module;
});
vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerSnapshotMock,
    subscribeActiveServer: () => () => {},
    upsertServerProfileOnly: (profile: { serverUrl: string }) => ({
        id: `profile:${profile.serverUrl}`,
        name: profile.serverUrl,
        serverUrl: profile.serverUrl,
    }),
}));
vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: (input: RequestInfo | URL, init?: RequestInit) => runtimeFetchMock(input, init),
}));
vi.mock('@/sync/ops', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/ops')>();
    return {
        ...actual,
        machineCapabilitiesDetect: machineCapabilitiesDetectMock,
    };
});
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
            subscribe: (
                taskId: string,
                onEvent?: ((event: unknown) => void) | undefined,
                onResult?: ((result: import('@happier-dev/protocol').SystemTaskResult) => void) | undefined,
            ) => () => void;
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

                return runner.subscribe(
                    taskId,
                    undefined,
                    (result) => {
                        if (disposed) {
                            return;
                        }
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
                    },
                );
            }, [runner, taskId]);

            return snapshot;
        },
    };
});
vi.mock('../steps/SetupThisComputerWizardStep', () => ({
    SetupThisComputerWizardStep: (props: Record<string, unknown>) => {
        React.useEffect(() => {
            if (!setupThisComputerWizardStepMock.forceBackHidden) return;
            const onWizardBackChange = props.onWizardBackChange as undefined | ((next: { hidden?: boolean }) => void);
            onWizardBackChange?.({ hidden: true });
        }, [props]);
        return React.createElement('SetupThisComputerWizardStep', props);
    },
}));
vi.mock('@/components/settings/machines/localControl/LocalDaemonControlSection', () => ({
    LocalDaemonControlSection: (props: Record<string, unknown>) => React.createElement('LocalDaemonControlSection', props),
}));
vi.mock('../checklists/relayHostLocal/RelayHostLocalChecklistStep', () => ({
    RelayHostLocalChecklistStep: (props: Record<string, unknown>) => React.createElement('RelayHostLocalChecklistStep', props),
}));
vi.mock('../checklists/remoteSsh/RemoteSshChecklistStep', () => ({
    RemoteSshChecklistStep: (props: Record<string, unknown>) => React.createElement('RemoteSshChecklistStep', props),
}));
vi.mock('../ui/WizardTerminalHandoff', () => ({
    WizardTerminalHandoff: (props: Record<string, unknown>) => React.createElement('WizardTerminalHandoff', props),
}));
vi.mock('../steps/AgentsLogoMultiSelect', () => ({
    AgentsLogoMultiSelect: (props: Record<string, unknown>) => React.createElement('AgentsLogoMultiSelect', props),
}));
vi.mock('../steps/relayAccess/RelayAccessPrerequisitesStep', () => ({
    RelayAccessPrerequisitesStep: (props: Record<string, unknown>) => React.createElement('RelayAccessPrerequisitesStep', props),
}));
vi.mock('../steps/WizardAgentSetupStep', () => ({
    WizardAgentSetupStep: (props: Record<string, unknown>) => React.createElement('WizardAgentSetupStep', props),
}));
vi.mock('@/components/settings/agents/setup/AgentSetupFlow', () => ({
    AgentSetupFlow: (props: Record<string, unknown>) => React.createElement('AgentSetupFlow', props),
}));
vi.mock('@/modal/portal/ModalPortalTarget', () => ({
    ModalPortalTargetProvider: (props: Record<string, unknown>) =>
        React.createElement(React.Fragment, null, props.children as React.ReactNode),
    useModalPortalTarget: () => null,
    useHasModalPortalTargetProvider: () => false,
}));
const relayDriftBannerMock = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('@/components/settings/server/useRelayDriftBanner', () => ({
    useRelayDriftBanner: () => relayDriftBannerMock.value,
}));
vi.mock('@/components/settings/server/RelayDriftActionCard', () => ({
    RelayDriftActionCard: (props: Record<string, unknown>) => React.createElement('RelayDriftActionCard', props),
}));
vi.mock('@/components/settings/server/localControl/LocalRelayAccessControlSection', () => ({
    LocalRelayAccessControlSection: (props: Record<string, unknown>) => React.createElement('LocalRelayAccessControlSection', props),
}));
const activeServerSwitchMocks = vi.hoisted(() => ({
    upsertActivateAndSwitchServer: vi.fn(async () => true),
    normalizeServerUrl: (value: string) => String(value).trim() === 'not a url' ? null : value,
}));
vi.mock('@/sync/domains/server/activeServerSwitch', () => activeServerSwitchMocks);
vi.mock('@/sync/store/hooks', () => ({
    useAllSessions: () => syncStoreHooksMockState.sessions,
    useAllMachines: () => {
        const machines = storage((state) => state.machines);
        return React.useMemo(() => Object.values(machines), [machines]);
    },
    useMachineCliDetectionTarget: (machineId: string | null) => {
        const normalized = typeof machineId === 'string' ? machineId.trim() : '';
        const machine = storage((state) => normalized ? (state.machines[normalized] ?? null) : null);
        const daemonStateVersion = typeof machine?.daemonStateVersion === 'number' ? machine.daemonStateVersion : 0;
        const isOnline = Boolean(machine);
        return React.useMemo(() => ({
            daemonStateVersion: typeof machine?.daemonStateVersion === 'number' ? machine.daemonStateVersion : 0,
            isOnline,
        }), [daemonStateVersion, isOnline]);
    },
    useMachineListByServerId: () => storage((state) => state.machineListByServerId ?? emptyMachineListByServerId),
    useSetting: (_key: string) => null,
    useLocalSetting: (key: string) => key === 'uiFontScale' ? 1 : null,
    useMachine: (machineId: string) => syncStoreHooksMockState.machines[machineId] ?? null,
}));

const pendingSetupIntentMocks = vi.hoisted(() => ({
    getPendingSetupIntent: vi.fn(),
    setPendingSetupIntent: vi.fn(),
}));
vi.mock('@/sync/domains/pending/pendingSetupIntent', async () => {
    const actual = await vi.importActual<typeof import('@/sync/domains/pending/pendingSetupIntent')>(
        '@/sync/domains/pending/pendingSetupIntent',
    );
    return {
        ...actual,
        getPendingSetupIntent: pendingSetupIntentMocks.getPendingSetupIntent,
        setPendingSetupIntent: pendingSetupIntentMocks.setPendingSetupIntent,
    };
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

vi.mock('react-native-safe-area-context', () => ({
    SafeAreaInsetsContext: React.createContext({ top: 0, bottom: 0, left: 0, right: 0 }),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: {
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, bottom: 0, left: 0, right: 0 },
    },
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

async function applyConnectedMachine(machineId: string, host: string): Promise<void> {
    const activeAt = Date.now() + 1_000;
    syncStoreHooksMockState.machines[machineId] = {
        id: machineId,
        metadata: { host },
    };
    await act(async () => {
        storage.getState().applyMachines([
            createMachineFixture({
                id: machineId,
                active: true,
                activeAt,
                updatedAt: activeAt,
                metadata: {
                    host,
                    platform: 'darwin',
                    happyCliVersion: '0.0.0-test',
                    happyHomeDir: '/Users/tester/.happy-dev',
                    homeDir: '/Users/tester',
                },
            }),
        ]);
    });
    await act(async () => {
        await flushHookEffects({ cycles: 8, turns: 8 });
    });
}

describe('SetupWizardSurface', () => {
    beforeEach(() => {
        routerMock.spies.push.mockReset();
        routerMock.spies.replace.mockReset();
        activeServerSnapshotMock.serverUrl = 'https://relay.example.test';
        activeServerSwitchMocks.upsertActivateAndSwitchServer.mockClear();
        pendingSetupIntentMocks.getPendingSetupIntent.mockReset();
        pendingSetupIntentMocks.setPendingSetupIntent.mockClear();
        relayDriftBannerMock.value = null;
        setupThisComputerWizardStepMock.forceBackHidden = false;
        syncStoreHooksMockState.sessions = [];
        syncStoreHooksMockState.machines = {};
        nativeSshAvailabilityMock.available = false;
        machineCapabilitiesDetectMock.mockReset();
        machineCapabilitiesDetectMock.mockImplementation(async () => ({
            supported: true,
            response: {
                protocolVersion: 1,
                results: {},
            },
        }));
        systemTaskRunnerState.nextResult = null;
        systemTaskRunnerState.startMock.mockReset();
        systemTaskRunnerState.cancelMock.mockReset();
        systemTaskRunnerState.respondMock.mockReset();
        systemTaskRunnerState.getSnapshotMock.mockReset();
        systemTaskRunnerState.subscribeMock.mockReset();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('shows a back button on the first step and returns to /setup', async () => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const backButton = screen.findByTestId('setupWizard.surface-back');
        expect(backButton).toBeTruthy();

        await act(async () => {
            const handler = backButton?.props.action ?? backButton?.props.onPress;
            await handler?.();
        });

        expect(routerMock.spies.replace).toHaveBeenCalledWith('/setup');
    });

    it('hides the back button when the active step requests it', async () => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const remoteBranch = screen.findByTestId('setupWizard-branch:remote');
        expect(remoteBranch).toBeTruthy();
        await act(async () => {
            const handler = remoteBranch?.props.action ?? remoteBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        expect(screen.findByType('RemoteSshChecklistStep' as never)).toBeTruthy();
        await act(async () => {
            const step = screen.findByType('RemoteSshChecklistStep' as never) as unknown as {
                props: { onWizardBackChange?: (next: { hidden?: boolean }) => void };
            };
            step.props.onWizardBackChange?.({ hidden: true });
            await flushHookEffects();
        });
        expect(screen.findByTestId('setupWizard.surface-back')).toBeFalsy();
    });

    it('hides local relay hosting when setup surface policy denies it', async () => {
        const previousDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'setup.relay.allowLocalRelayHost';
        try {
            const { SetupWizardSurface } = await import('./SetupWizardSurface');
            const screen = await renderScreen(React.createElement(SetupWizardSurface, { isDesktopShell: true }));

            expect(screen.findByTestId('setupWizard-branch:relayLocal')).toBeNull();
        } finally {
            if (previousDeny === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
            else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousDeny;
        }
    });

    it('hides remote SSH setup when setup surface policy denies it', async () => {
        const previousDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY =
            'setup.relay.allowRemoteSshRelayHost,setup.machine.allowRemoteSshMachineSetup';
        try {
            const { SetupWizardSurface } = await import('./SetupWizardSurface');
            const screen = await renderScreen(React.createElement(SetupWizardSurface, { isDesktopShell: true }));

            expect(screen.findByTestId('setupWizard-branch:remote')).toBeNull();
            expect(screen.findByTestId('setupWizard-branch:remoteRelay')).toBeNull();
        } finally {
            if (previousDeny === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
            else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousDeny;
        }
    });

    it('persists the remote machine branch as soon as it is selected', async () => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const remoteBranch = screen.findByTestId('setupWizard-branch:remote');
        await act(async () => {
            const handler = remoteBranch?.props.action ?? remoteBranch?.props.onPress;
            await handler?.();
        });

        expect(pendingSetupIntentMocks.setPendingSetupIntent).toHaveBeenCalledWith(expect.objectContaining({
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
            machineId: null,
            remoteSetupIntent: 'remoteMachine',
        }));
    });

    it('persists the remote relay-host branch as soon as it is selected', async () => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const remoteRelayBranch = screen.findByTestId('setupWizard-branch:remoteRelay');
        await act(async () => {
            const handler = remoteRelayBranch?.props.action ?? remoteRelayBranch?.props.onPress;
            await handler?.();
        });

        expect(pendingSetupIntentMocks.setPendingSetupIntent).toHaveBeenCalledWith(expect.objectContaining({
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
            machineId: null,
            remoteSetupIntent: 'remoteRelayHost',
        }));
    });

    it('surfaces a relay drift repair banner inside the wizard chooser when present', async () => {
        relayDriftBannerMock.value = { title: 'Drift', description: 'd', actionLabel: 'Repair' };

        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        expect(screen.findByType('RelayDriftActionCard' as never)).toBeTruthy();
    });

    it('filters the chooser to relay-related options when scope=relay', async () => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
            scope: 'relay',
        }));

        expect(screen.findByTestId('setupWizard-branch:local')).toBeFalsy();
        expect(screen.findByTestId('setupWizard-branch:remote')).toBeFalsy();
    });

    it('guides the user from branch selection into the local setup step', async () => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const localBranch = screen.findByTestId('setupWizard-branch:local');
        expect(localBranch).toBeTruthy();

        await act(async () => {
            const handler = localBranch?.props.action ?? localBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        expect(continueButton).toBeTruthy();

        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        const localSetup = screen.findByType('SetupThisComputerWizardStep' as never);
        expect(localSetup).toBeTruthy();
        expect((localSetup.props as { autoStart?: unknown }).autoStart).toBeUndefined();

        await act(async () => {
            await (localSetup.props.onSucceeded as any)?.('machine-1');
        });

        const continueFromLocalSetup = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueFromLocalSetup?.props.action ?? continueFromLocalSetup?.props.onPress;
            await handler?.();
        });

        expect(screen.findByType('WizardAgentSetupStep' as never)).toBeTruthy();
        expect(screen.findAllByType('LocalRelayRuntimeControlSection' as never)).toHaveLength(0);
    });

    it('passes backward transition direction when returning from the local setup step', async () => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const localBranch = screen.findByTestId('setupWizard-branch:local');
        await act(async () => {
            const handler = localBranch?.props.action ?? localBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByType(WizardModalShell as never).props.contentTransitionDirection).toBe('forward');

        const backButton = screen.findByTestId('setupWizard.surface-back');
        await act(async () => {
            const handler = backButton?.props.action ?? backButton?.props.onPress;
            await handler?.();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByType(WizardModalShell as never).props.contentTransitionDirection).toBe('backward');
    });

    it('propagates the local machine id to the providers wizard step after local setup completes', async () => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const localBranch = screen.findByTestId('setupWizard-branch:local');
        await act(async () => {
            const handler = localBranch?.props.action ?? localBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        const localSetup = screen.findByType('SetupThisComputerWizardStep' as never) as unknown as {
            props: { onSucceeded?: (machineId: string | null) => void };
        };
        await act(async () => {
            localSetup.props.onSucceeded?.('mach-local');
        });

        const continueFromLocalSetup = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueFromLocalSetup?.props.action ?? continueFromLocalSetup?.props.onPress;
            await handler?.();
        });

        const providersStep = screen.findByType('WizardAgentSetupStep' as never);
        expect(providersStep.props.machineId).toBe('mach-local');
    });

    it('guides the user from relay hosting branch into the relay runtime step', async () => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const relayBranch = screen.findByTestId('setupWizard-branch:relayLocal');
        expect(relayBranch).toBeTruthy();

        await act(async () => {
            const handler = relayBranch?.props.action ?? relayBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        expect(screen.findByType('RelayHostLocalChecklistStep' as never)).toBeTruthy();
    });

    it('guides web users through live machine arrival before provider setup', async () => {
        vi.resetModules();
        vi.doMock('react-native', installReactNativeWebMock({ Platform: { OS: 'web' } }));
        const previousStorageState = storage.getState();

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                machines: {},
                machineListByServerId: {},
            }));
            const { SetupWizardSurface } = await import('./SetupWizardSurface');
            const screen = await renderScreen(React.createElement(SetupWizardSurface, {
                isDesktopShell: false,
            }));

            const localBranch = screen.findByTestId('setupWizard-branch:local');
            expect(localBranch).toBeTruthy();

            await act(async () => {
                const handler = localBranch?.props.action ?? localBranch?.props.onPress;
                await handler?.();
            });

            const continueButton = screen.findByTestId('setupWizard.surface-primary');
            expect(continueButton).toBeTruthy();

            await act(async () => {
                const handler = continueButton?.props.action ?? continueButton?.props.onPress;
                await handler?.();
            });

            const stack = screen.findByTestId('setupWizard-machine-arrival-stack');
            expect(stack).toBeTruthy();
            expect(directChildTestIDs(stack).slice(0, 2)).toEqual([
                'setupWizard-machine-arrival',
                'setupWizard-machine-arrival-desktop-app-download-cta',
            ]);
            expect(screen.findByTestId('setupWizard-machine-arrival')).toBeTruthy();
            expect(screen.findByTestId('machine-arrival-card-status:variant:neutral')).toBeTruthy();
            expect(screen.findByTestId('setupWizard-machine-arrival-desktop-app-download-cta')).toBeTruthy();
            expect(screen.findAllByType('WizardTerminalHandoff' as never)).toHaveLength(0);
            expect(screen.findAllByType('LocalDaemonControlSection' as never)).toHaveLength(0);
            expect(screen.findByTestId('setupWizard.surface-primary')?.props.disabled).toBe(true);
            expect(screen.getTextContent()).toContain('setupOnboarding.setupThisComputerConnectHonesty');

            machineCapabilitiesDetectMock.mockImplementation(async () => ({
                supported: true,
                response: {
                    protocolVersion: 1,
                    results: {
                        'cli.claude': { ok: true, checkedAt: Date.now(), data: { available: true } },
                        'cli.codex': { ok: true, checkedAt: Date.now(), data: { available: false } },
                    },
                },
            }));
            await applyConnectedMachine('mach-web-arrival', 'web-arrival.test');

            expect(screen.findByTestId('setupWizard-web-providers-handoff')).toBeTruthy();
            // D22 (r2 user decision): readiness is merged INTO the selection grid — no
            // standalone readiness row. Detected providers flow into the grid as
            // readyAgentIds (locked-selected + green dot, asserted in the grid's own
            // unit tests); undetected ones stay plain selectable tiles.
            expect(screen.findAllByTestId('setupWizard-provider-readiness')).toHaveLength(0);
            const providersSelect = screen.findByType('AgentsLogoMultiSelect' as never) as unknown as {
                props: { readyAgentIds?: readonly string[]; agentIds?: readonly string[] };
            } | null;
            expect(providersSelect).toBeTruthy();
            expect(providersSelect?.props.readyAgentIds).toEqual(['claude']);
            expect(providersSelect?.props.agentIds).toContain('codex');
            // The old text-label / variant-marker badges are gone.
            expect(screen.findAllByTestId('setupWizard-provider-readiness:claude:label')).toHaveLength(0);
            expect(screen.findAllByTestId('setupWizard-provider-readiness:claude:variant:success')).toHaveLength(0);
        } finally {
            storage.setState(previousStorageState);
            vi.resetModules();
        }
    });

    it('keeps web users on the connected-machine step after backing up from providers', async () => {
        vi.resetModules();
        vi.doMock('react-native', installReactNativeWebMock({ Platform: { OS: 'web' } }));
        const previousStorageState = storage.getState();

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                machines: {},
                machineListByServerId: {},
            }));
            const { SetupWizardSurface } = await import('./SetupWizardSurface');
            const screen = await renderScreen(React.createElement(SetupWizardSurface, {
                isDesktopShell: false,
            }));

            const localBranch = screen.findByTestId('setupWizard-branch:local');
            await act(async () => {
                const handler = localBranch?.props.action ?? localBranch?.props.onPress;
                await handler?.();
            });

            const continueButton = screen.findByTestId('setupWizard.surface-primary');
            await act(async () => {
                const handler = continueButton?.props.action ?? continueButton?.props.onPress;
                await handler?.();
            });

            expect(screen.findByTestId('setupWizard-machine-arrival')).toBeTruthy();
            expect(screen.findByTestId('setupWizard.surface-primary')?.props.disabled).toBe(true);

            await applyConnectedMachine('mach-web-back-arrival', 'web-back-arrival.test');

            expect(screen.findByTestId('setupWizard-web-providers-handoff')).toBeTruthy();

            const backButton = screen.findByTestId('setupWizard.surface-back');
            await act(async () => {
                const handler = backButton?.props.action ?? backButton?.props.onPress;
                await handler?.();
            });
            await flushHookEffects({ cycles: 8, turns: 8 });

            expect(screen.findByTestId('setupWizard-machine-arrival')).toBeTruthy();
            expect(screen.findByTestId('machine-arrival-card-status:variant:success')).toBeTruthy();
            expect(screen.findByTestId('setupWizard.surface-progress')?.props.children).toBe('setupOnboarding.progressQuietLabel 2 4');
            expect(screen.findByTestId('setupWizard.surface-primary')?.props.disabled).toBe(false);

            vi.resetModules();
        } finally {
            storage.setState(previousStorageState);
            vi.resetModules();
        }
    });

    it('guides native users to continue setup on a desktop instead of starting system tasks locally', async () => {
        vi.resetModules();
        vi.doMock('react-native', installReactNativeWebMock({ Platform: { OS: 'ios' } }));

        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: false,
        }));

        const localBranch = screen.findByTestId('setupWizard-branch:local');
        expect(localBranch).toBeTruthy();

        await act(async () => {
            const handler = localBranch?.props.action ?? localBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        expect(continueButton).toBeTruthy();

        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        const stack = screen.findByTestId('setupWizard-machine-arrival-stack');
        expect(stack).toBeTruthy();
        expect(directChildTestIDs(stack).slice(0, 2)).toEqual([
            'setupWizard-machine-arrival',
            'setupWizard-machine-arrival-desktop-app-download-cta',
        ]);
        expect(screen.findByTestId('setupWizard-machine-arrival')).toBeTruthy();
        expect(screen.findByTestId('machine-arrival-card-status:variant:neutral')).toBeTruthy();
        expect(screen.findByTestId('setupWizard.surface-primary')?.props.disabled).toBe(true);
        expect(screen.findAllByType('SetupThisComputerWizardStep' as never)).toHaveLength(0);

        vi.resetModules();
    });

    it('guides web users selecting remote setup to run the SSH flow from the CLI', async () => {
        vi.resetModules();
        vi.doMock('react-native', installReactNativeWebMock({ Platform: { OS: 'web' } }));

        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: false,
        }));

        const remoteBranch = screen.findByTestId('setupWizard-branch:remote');
        expect(remoteBranch).toBeTruthy();

        await act(async () => {
            const handler = remoteBranch?.props.action ?? remoteBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        expect(screen.findByTestId('setupWizard-terminal-handoff')).toBeTruthy();
        expect(screen.findAllByType('RemoteSshChecklistStep' as never)).toHaveLength(0);

        const handoff = screen.findByType('WizardTerminalHandoff' as never) as unknown as {
            props: { steps?: Array<{ code?: unknown }> };
        };
        const sshStep = handoff.props.steps?.find((step) => typeof step.code === 'string' && step.code.includes('happier machine setup --ssh'));
        expect(sshStep).toBeTruthy();
        expect(String(sshStep?.code)).not.toContain('--install-relay-runtime');

        const setupPrereqStep = handoff.props.steps?.find((step) => typeof step.code === 'string' && String(step.code).includes('&& happier setup')) as
            | { code?: unknown; windowsCode?: unknown }
            | undefined;
        expect(setupPrereqStep).toBeTruthy();
        expect(String(setupPrereqStep?.windowsCode ?? '')).toContain('install.ps1');
        expect(String(setupPrereqStep?.code)).not.toContain('--skip-daemon');

        vi.resetModules();
    });

    it('guides web users selecting remote relay hosting to include relay runtime install in the SSH command', async () => {
        vi.resetModules();
        vi.doMock('react-native', installReactNativeWebMock({ Platform: { OS: 'web' } }));

        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: false,
        }));

        const remoteRelayBranch = screen.findByTestId('setupWizard-branch:remoteRelay');
        expect(remoteRelayBranch).toBeTruthy();

        await act(async () => {
            const handler = remoteRelayBranch?.props.action ?? remoteRelayBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        expect(screen.findByTestId('setupWizard-terminal-handoff')).toBeTruthy();

        const handoff = screen.findByType('WizardTerminalHandoff' as never) as unknown as {
            props: { steps?: Array<{ code?: unknown }> };
        };
        const sshStep = handoff.props.steps?.find((step) => typeof step.code === 'string' && step.code.includes('happier machine setup --ssh'));
        expect(sshStep).toBeTruthy();
        expect(String(sshStep?.code)).toContain('--install-relay-runtime');

        vi.resetModules();
    });

    it('allows web users to fill SSH credentials and reflects them in the CLI handoff command', async () => {
        vi.resetModules();
        vi.doMock('react-native', installReactNativeWebMock({ Platform: { OS: 'web' } }));

        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: false,
        }));

        const remoteRelayBranch = screen.findByTestId('setupWizard-branch:remoteRelay');
        await act(async () => {
            const handler = remoteRelayBranch?.props.action ?? remoteRelayBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        const usernameInput = screen.findByTestId('setupWizard-web-remote-ssh-sshUsernameInput');
        const hostInput = screen.findByTestId('setupWizard-web-remote-ssh-sshHostInput');
        const portInput = screen.findByTestId('setupWizard-web-remote-ssh-sshPortInput');
        if (!usernameInput || !hostInput || !portInput) {
            throw new Error('Expected SSH fields to be rendered for the remote setup handoff.');
        }

        await act(async () => {
            usernameInput.props.onChangeText?.('dev');
            hostInput.props.onChangeText?.('example.test');
            portInput.props.onChangeText?.('2222');
        });

        const handoff = screen.findByType('WizardTerminalHandoff' as never) as unknown as {
            props: { steps?: Array<{ code?: unknown }> };
        };
        const sshStep = handoff.props.steps?.find((step) => typeof step.code === 'string' && step.code.includes('happier machine setup'));
        expect(sshStep).toBeTruthy();
        expect(String(sshStep?.code)).toContain('--ssh-user dev');
        expect(String(sshStep?.code)).toContain('--ssh-host example.test');
        expect(String(sshStep?.code)).toContain('--ssh-port 2222');
        expect(String(sshStep?.code)).toContain('--ssh-auth agent');

        vi.resetModules();
    });

    it('preserves the web remote SSH password while navigating within the same wizard mount', async () => {
        vi.resetModules();
        vi.doMock('react-native', installReactNativeWebMock({ Platform: { OS: 'web' } }));

        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: false,
        }));

        const remoteRelayBranch = screen.findByTestId('setupWizard-branch:remoteRelay');
        await act(async () => {
            const handler = remoteRelayBranch?.props.action ?? remoteRelayBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        await act(async () => {
            screen.changeTextByTestId('setupWizard-web-remote-ssh-sshUsernameInput', 'dev');
            screen.changeTextByTestId('setupWizard-web-remote-ssh-sshHostInput', 'relay.example.test');
            screen.changeTextByTestId('setupWizard-web-remote-ssh-sshPortInput', '2222');
        });

        const passwordAuth = screen.findByTestId('setupWizard-web-remote-ssh-sshAuthMethod:password')!;
        await act(async () => {
            await passwordAuth.props.onPress?.();
        });

        await act(async () => {
            screen.changeTextByTestId('setupWizard-web-remote-ssh-sshPasswordInput', 'super-secret');
        });

        const handoff = screen.findByType('WizardTerminalHandoff' as never) as unknown as {
            props: { steps?: Array<{ code?: unknown }> };
        };
        const sshStep = handoff.props.steps?.find((step) => typeof step.code === 'string' && step.code.includes('happier machine setup'));
        expect(sshStep).toBeTruthy();
        expect(String(sshStep?.code)).toContain('--ssh-user dev');
        expect(String(sshStep?.code)).toContain('--ssh-host relay.example.test');
        expect(String(sshStep?.code)).toContain('--ssh-port 2222');
        expect(String(sshStep?.code)).toContain('--ssh-auth password');
        expect(String(sshStep?.code)).not.toContain('--identity-file');

        const backButton = screen.findByTestId('setupWizard.back') ?? screen.findByTestId('setupWizard.surface-back');
        await act(async () => {
            await backButton?.props.action?.();
            await backButton?.props.onPress?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const remoteRelayBranchAgain = screen.findByTestId('setupWizard-branch:remoteRelay');
        await act(async () => {
            const handler = remoteRelayBranchAgain?.props.action ?? remoteRelayBranchAgain?.props.onPress;
            await handler?.();
        });
        const continueAgain = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueAgain?.props.action ?? continueAgain?.props.onPress;
            await handler?.();
        });

        expect(screen.findByTestId('setupWizard-web-remote-ssh-sshPasswordInput')?.props.value).toBe('super-secret');

        vi.resetModules();
    });

    it('guides web users to continue provider setup in the terminal or desktop app', async () => {
        vi.resetModules();
        vi.doMock('react-native', installReactNativeWebMock({ Platform: { OS: 'web' } }));
        const previousStorageState = storage.getState();

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                machines: {},
                machineListByServerId: {},
            }));
            const { SetupWizardSurface } = await import('./SetupWizardSurface');
            const screen = await renderScreen(React.createElement(SetupWizardSurface, {
                isDesktopShell: false,
            }));

            const localBranch = screen.findByTestId('setupWizard-branch:local');
            await act(async () => {
                const handler = localBranch?.props.action ?? localBranch?.props.onPress;
                await handler?.();
            });

            const continueButton = screen.findByTestId('setupWizard.surface-primary');
            await act(async () => {
                const handler = continueButton?.props.action ?? continueButton?.props.onPress;
                await handler?.();
            });

            // setup_this_computer live arrival (covered in detail elsewhere)
            expect(screen.findByTestId('setupWizard-machine-arrival')).toBeTruthy();

            await applyConnectedMachine('mach-web-provider', 'web-provider.test');

            expect(screen.findByTestId('setupWizard-web-providers-handoff')).toBeTruthy();
            expect(screen.findAllByType('AgentSetupFlow' as never)).toHaveLength(0);
            const providersHandoff = screen.findByType('WizardTerminalHandoff' as never) as unknown as {
                props: { steps?: Array<{ code?: unknown }> };
            };
            const codes = (providersHandoff.props.steps ?? [])
                .map((step) => (typeof step.code === 'string' ? step.code : ''))
                .join('\n');
            expect(codes).toContain('curl -fsSL https://happier.dev/install | bash');
            expect(codes).toContain('&& happier providers setup');
            expect(codes).not.toContain('happier auth login');
            expect(codes).not.toContain('--run providers-setup');

            const providersSelect = screen.findByType('AgentsLogoMultiSelect' as never) as unknown as {
                props: { providerIds?: readonly string[]; onToggleAgent?: (providerId: string) => void };
            };
            await act(async () => {
                providersSelect.props.onToggleAgent?.('claude');
                providersSelect.props.onToggleAgent?.('codex');
            });

            const updatedProvidersHandoff = screen.findByType('WizardTerminalHandoff' as never) as unknown as {
                props: { steps?: Array<{ code?: unknown }> };
            };
            const updatedCodes = (updatedProvidersHandoff.props.steps ?? [])
                .map((step) => (typeof step.code === 'string' ? step.code : ''))
                .join('\n');
            expect(updatedCodes).toContain('&& happier providers setup');
            expect(updatedCodes).toContain('--providers claude,codex');

            vi.resetModules();
        } finally {
            storage.setState(previousStorageState);
            vi.resetModules();
        }
    });

    it('shows only setup-supported providers in the web provider selector', async () => {
        vi.resetModules();
        vi.doMock('react-native', installReactNativeWebMock({ Platform: { OS: 'web' } }));
        const previousStorageState = storage.getState();

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                machines: {},
                machineListByServerId: {},
            }));
            const { SetupWizardSurface } = await import('./SetupWizardSurface');
            const screen = await renderScreen(React.createElement(SetupWizardSurface, {
                isDesktopShell: false,
            }));

            const localBranch = screen.findByTestId('setupWizard-branch:local');
            await act(async () => {
                const handler = localBranch?.props.action ?? localBranch?.props.onPress;
                await handler?.();
            });

            const continueButton = screen.findByTestId('setupWizard.surface-primary');
            await act(async () => {
                const handler = continueButton?.props.action ?? continueButton?.props.onPress;
                await handler?.();
            });

            await applyConnectedMachine('mach-web-provider-select', 'web-provider-select.test');

            const providersSelect = screen.findByType('AgentsLogoMultiSelect' as never) as unknown as {
                props: { agentIds?: readonly string[] };
            };
            expect(providersSelect.props.agentIds).toContain('claude');
            expect(providersSelect.props.agentIds).toContain('codex');
            expect(providersSelect.props.agentIds).not.toContain('customAcp');

            vi.resetModules();
        } finally {
            storage.setState(previousStorageState);
            vi.resetModules();
        }
    });

    it('allows users to skip the setup-this-computer step after authentication', async () => {
        vi.resetModules();
        vi.doMock('react-native', installReactNativeWebMock({ Platform: { OS: 'web' } }));

        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: false,
        }));

        const localBranch = screen.findByTestId('setupWizard-branch:local');
        await act(async () => {
            const handler = localBranch?.props.action ?? localBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        expect(screen.findByTestId('setupWizard.surface-skip')).toBeTruthy();
        expect(screen.getTextContent()).toContain('setupOnboarding.setupThisComputerSkipLabel');
        expect(screen.getTextContent()).toContain('setupOnboarding.setupThisComputerConnectHonesty');

        vi.resetModules();
    });

    it('preselects relay runtime install when remote relay hosting is chosen on desktop', async () => {
        vi.resetModules();

        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const remoteRelayBranch = screen.findByTestId('setupWizard-branch:remoteRelay');
        await act(async () => {
            const handler = remoteRelayBranch?.props.action ?? remoteRelayBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        const remoteSshSection = screen.findByType('RemoteSshChecklistStep' as never) as unknown as {
            props: { initialInstallRelayRuntime?: unknown };
        };
        expect(remoteSshSection.props.initialInstallRelayRuntime).toBe(true);

        vi.resetModules();
    });

    it('guides web users through local relay hosting via terminal handoff and verified relay URL paste', async () => {
        vi.resetModules();
        vi.doMock('react-native', installReactNativeWebMock({ Platform: { OS: 'web' } }));
        const previousFetchImpl = runtimeFetchMock.getMockImplementation();
        let webRelayReachable = false;
        runtimeFetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (
                url.includes('https://web-relay.example.ts.net')
                && url.endsWith('/health')
            ) {
                return webRelayReachable
                    ? new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
                    : new Response(JSON.stringify({ ok: false }), { status: 404, headers: { 'content-type': 'application/json' } });
            }
            return previousFetchImpl
                ? previousFetchImpl(input, init)
                : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
        });

        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: false,
        }));

        const localBranch = screen.findByTestId('setupWizard-branch:relayLocal');
        await act(async () => {
            const handler = localBranch?.props.action ?? localBranch?.props.onPress;
            await handler?.();
        });

        const continueIntoSetup = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueIntoSetup?.props.action ?? continueIntoSetup?.props.onPress;
            await handler?.();
        });

        expect(screen.findByTestId('setupWizard-web-relay-host-handoff')).toBeTruthy();
        expect(screen.findByTestId('setupWizard-web-relay-download-desktop')).toBeTruthy();
        expect(screen.findAllByType('LocalRelayRuntimeControlSection' as never)).toHaveLength(0);
        expect(screen.findByTestId('setupWizard.surface-primary')?.props.disabled).toBe(true);

        const relayUrlInput = screen.findByTestId('setupWizard-relay-url-input');
        if (!relayUrlInput) {
            throw new Error('Expected relay url input to be present.');
        }
        await act(async () => {
            relayUrlInput.props.onChangeText?.('not a url');
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByTestId('setupWizard.surface-primary')?.props.disabled).toBe(true);
        expect(screen.getTextContent()).toContain('setupOnboarding.webRelayHostInvalidUrl');

        await act(async () => {
            relayUrlInput.props.onChangeText?.('https://web-relay.example.ts.net');
        });
        await flushHookEffects({ cycles: 4, turns: 4 });

        expect(screen.findByTestId('server-settings-add-reachability-remediation')).toBeTruthy();
        expect(screen.findByTestId('setupWizard.surface-primary')?.props.disabled).toBe(true);

        webRelayReachable = true;
        await act(async () => {
            relayUrlInput.props.onChangeText?.('https://local-relay.example.test');
        });
        await flushHookEffects({ cycles: 6, turns: 6 });
        expect(screen.findByTestId('setupWizard.surface-primary')?.props.disabled).toBe(false);

        const continueAfterRelayHost = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueAfterRelayHost?.props.action ?? continueAfterRelayHost?.props.onPress;
            await handler?.();
        });

        expect(screen.findByTestId('setupWizard-web-relay-access-handoff')).toBeTruthy();

        const continueAfterRelayAccess = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueAfterRelayAccess?.props.action ?? continueAfterRelayAccess?.props.onPress;
            await handler?.();
        });

        expect(screen.findByTestId('setupWizard-confirmSwitchRelay')).toBeTruthy();

        runtimeFetchMock.mockImplementation(
            previousFetchImpl
            ?? (async (input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })),
        );
        vi.resetModules();
    });

    it('requires an explicit relay switch confirmation when local relay hosting reports a relay url', async () => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const localBranch = screen.findByTestId('setupWizard-branch:relayLocal');
        await act(async () => {
            const handler = localBranch?.props.action ?? localBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        const localRelaySection = screen.findByType('RelayHostLocalChecklistStep' as never) as unknown as {
            props: { onStatusChange?: (status: unknown) => void };
        };

        await act(async () => {
            localRelaySection.props.onStatusChange?.({
                relayUrl: 'https://local-relay.example.test',
            });
        });

        const proceedAfterRelayHosting = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = proceedAfterRelayHosting?.props.action ?? proceedAfterRelayHosting?.props.onPress;
            await handler?.();
        });

        expect(screen.findByType('LocalRelayAccessControlSection' as never)).toBeTruthy();

        const continueAfterRelayAccess = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueAfterRelayAccess?.props.action ?? continueAfterRelayAccess?.props.onPress;
            await handler?.();
        });

        expect(screen.findByTestId('setupWizard-confirmSwitchRelay')).toBeTruthy();
    });

    it('advances existing local relay hosting directly to relay access when the active relay is already known', async () => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const localBranch = screen.findByTestId('setupWizard-branch:relayLocal');
        await act(async () => {
            const handler = localBranch?.props.action ?? localBranch?.props.onPress;
            await handler?.();
        });

        const continueToHost = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueToHost?.props.action ?? continueToHost?.props.onPress;
            await handler?.();
        });

        expect(screen.findByType('RelayHostLocalChecklistStep' as never)).toBeTruthy();

        const continueAfterHosted = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueAfterHosted?.props.action ?? continueAfterHosted?.props.onPress;
            await handler?.();
        });

        expect(screen.findByType('LocalRelayAccessControlSection' as never)).toBeTruthy();
    });

    it('inserts a relay access step before switching to a newly hosted relay', async () => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const relayBranch = screen.findByTestId('setupWizard-branch:relayLocal');
        await act(async () => {
            const handler = relayBranch?.props.action ?? relayBranch?.props.onPress;
            await handler?.();
        });

        const continueToHost = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueToHost?.props.action ?? continueToHost?.props.onPress;
            await handler?.();
        });

        const localRelaySection = screen.findByType('RelayHostLocalChecklistStep' as never) as unknown as {
            props: { onStatusChange?: (status: unknown) => void };
        };
        await act(async () => {
            localRelaySection.props.onStatusChange?.({
                relayUrl: 'https://local-relay.example.test',
            });
        });

        const continueAfterHosted = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueAfterHosted?.props.action ?? continueAfterHosted?.props.onPress;
            await handler?.();
        });

        const relayAccessSection = screen.findByType('LocalRelayAccessControlSection' as never) as unknown as {
            props: Record<string, unknown>;
        };
        expect(relayAccessSection).toBeTruthy();
        expect(relayAccessSection.props.presentation).toBe('wizard');
        expect(relayAccessSection.props.serverProfileId).toEqual(expect.any(String));
        expect(typeof relayAccessSection.props.onWizardPrimaryChange).toBe('function');
        expect(typeof relayAccessSection.props.onRequestAdvance).toBe('function');
        expect(screen.findByTestId('setupWizard-confirmSwitchRelay')).toBeNull();

        const continueAfterAccess = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueAfterAccess?.props.action ?? continueAfterAccess?.props.onPress;
            await handler?.();
        });

        expect(screen.findByTestId('setupWizard-confirmSwitchRelay')).toBeTruthy();
    });

    it.each([
        ['lan', 'https://local-relay.example.test'],
        ['cloudflareNamed', 'https://local-relay.example.test'],
        ['tailscaleServe', 'https://local-relay.example.test'],
        ['tailscaleFunnel', 'https://local-relay.example.test'],
    ] as const)('routes %s relay access requests to the prerequisites step', async (providerId, relayUrl) => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const relayBranch = screen.findByTestId('setupWizard-branch:relayLocal');
        await act(async () => {
            const handler = relayBranch?.props.action ?? relayBranch?.props.onPress;
            await handler?.();
        });

        const continueToHost = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueToHost?.props.action ?? continueToHost?.props.onPress;
            await handler?.();
        });

        const localRelaySection = screen.findByType('RelayHostLocalChecklistStep' as never) as unknown as {
            props: { onStatusChange?: (status: unknown) => void };
        };
        await act(async () => {
            localRelaySection.props.onStatusChange?.({
                relayUrl,
            });
        });

        const continueAfterHosted = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueAfterHosted?.props.action ?? continueAfterHosted?.props.onPress;
            await handler?.();
        });

        const relayAccessSection = screen.findByType('LocalRelayAccessControlSection' as never) as unknown as {
            props: {
                onWizardRequestProviderDetails?: (
                    nextProviderId: 'lan' | 'cloudflareNamed' | 'tailscaleServe' | 'tailscaleFunnel'
                ) => void;
                target?: Readonly<{ kind: 'local' }> | Readonly<{
                    kind: 'ssh';
                    ssh: Readonly<{
                        target: string;
                        auth: 'agent' | 'keyfile' | 'password';
                    }>;
                }>;
            };
        };
        expect(relayAccessSection.props.target).toEqual({ kind: 'local' });
        await act(async () => {
            relayAccessSection.props.onWizardRequestProviderDetails?.(providerId);
        });

        const prereqsStep = screen.findByType('RelayAccessPrerequisitesStep' as never) as unknown as {
            props: {
                providerId?: string;
                upstreamUrl?: string | null;
                target?: Readonly<{ kind: 'local' }> | Readonly<{
                    kind: 'ssh';
                    ssh: Readonly<{
                        target: string;
                        auth: 'agent' | 'keyfile' | 'password';
                    }>;
                }>;
            };
        };
        expect(prereqsStep.props.providerId).toBe(providerId);
        expect(prereqsStep.props.upstreamUrl).toBe(relayUrl);
        expect(prereqsStep.props.target).toEqual({ kind: 'local' });
    });

    it('keeps the current relay by default on the confirmation step', async () => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const localBranch = screen.findByTestId('setupWizard-branch:relayLocal');
        await act(async () => {
            const handler = localBranch?.props.action ?? localBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        const localRelaySection = screen.findByType('RelayHostLocalChecklistStep' as never) as unknown as {
            props: { onStatusChange?: (status: unknown) => void };
        };

        await act(async () => {
            localRelaySection.props.onStatusChange?.({
                relayUrl: 'https://local-relay.example.test',
            });
        });

        const proceedAfterRelayHosting = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = proceedAfterRelayHosting?.props.action ?? proceedAfterRelayHosting?.props.onPress;
            await handler?.();
        });

        const continueAfterRelayAccess = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueAfterRelayAccess?.props.action ?? continueAfterRelayAccess?.props.onPress;
            await handler?.();
        });

        expect(screen.findByTestId('setupWizard-confirmSwitchRelay')).toBeTruthy();
        expect(screen.findByTestId('setupWizard-confirmSwitchRelay.choice:keep')).toBeTruthy();
        expect(screen.findByTestId('setupWizard-confirmSwitchRelay.choice:switch')).toBeTruthy();

        const confirmButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = confirmButton?.props.action ?? confirmButton?.props.onPress;
            await handler?.();
        });

        expect(activeServerSwitchMocks.upsertActivateAndSwitchServer).toHaveBeenCalledTimes(0);
        expect(pendingSetupIntentMocks.setPendingSetupIntent).toHaveBeenCalledTimes(0);
        expect(routerMock.spies.replace).toHaveBeenCalledTimes(0);

        expect(screen.findByType('WizardAgentSetupStep' as never)).toBeTruthy();
    });

    it('switches to the hosted relay when the user confirms switching', async () => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const localBranch = screen.findByTestId('setupWizard-branch:relayLocal');
        await act(async () => {
            const handler = localBranch?.props.action ?? localBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        const localRelaySection = screen.findByType('RelayHostLocalChecklistStep' as never) as unknown as {
            props: { onStatusChange?: (status: unknown) => void };
        };

        await act(async () => {
            localRelaySection.props.onStatusChange?.({
                relayUrl: 'https://local-relay.example.test',
            });
        });

        const proceedAfterRelayHosting = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = proceedAfterRelayHosting?.props.action ?? proceedAfterRelayHosting?.props.onPress;
            await handler?.();
        });

        const continueAfterRelayAccess = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueAfterRelayAccess?.props.action ?? continueAfterRelayAccess?.props.onPress;
            await handler?.();
        });

        const switchChoice = screen.findByTestId('setupWizard-confirmSwitchRelay.choice:switch');
        await act(async () => {
            const handler = switchChoice?.props.action ?? switchChoice?.props.onPress;
            await handler?.();
        });

        const confirmButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = confirmButton?.props.action ?? confirmButton?.props.onPress;
            await handler?.();
        });

        expect(activeServerSwitchMocks.upsertActivateAndSwitchServer).toHaveBeenCalledTimes(1);
        expect(pendingSetupIntentMocks.setPendingSetupIntent).toHaveBeenCalledTimes(1);
        expect(routerMock.spies.replace).toHaveBeenCalledWith('/');
    });

    it('guides the user from remote setup into the remote SSH step', async () => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const remoteBranch = screen.findByTestId('setupWizard-branch:remote');
        expect(remoteBranch).toBeTruthy();

        await act(async () => {
            const handler = remoteBranch?.props.action ?? remoteBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        expect(screen.findByType('RemoteSshChecklistStep' as never)).toBeTruthy();
    });

    it('requires an explicit relay switch confirmation when remote relay hosting completes', async () => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const remoteBranch = screen.findByTestId('setupWizard-branch:remote');
        await act(async () => {
            const handler = remoteBranch?.props.action ?? remoteBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        const remoteSection = screen.findByType('RemoteSshChecklistStep' as never) as unknown as {
            props: {
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
            };
        };

        await act(async () => {
            remoteSection.props.onCompleted?.({
                machineId: 'mach-1',
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

        const proceedAfterRemote = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = proceedAfterRemote?.props.action ?? proceedAfterRemote?.props.onPress;
            await handler?.();
        });

        const relayAccessSection = screen.findByType('LocalRelayAccessControlSection' as never) as unknown as {
            props: {
                target?: Readonly<{ kind: 'local' }> | Readonly<{
                    kind: 'ssh';
                    ssh: Readonly<{
                        target: string;
                        auth: 'agent' | 'keyfile' | 'password';
                    }>;
                }>;
            };
        };
        expect(relayAccessSection.props.target).toEqual({
            kind: 'ssh',
            ssh: {
                target: 'root@remote.example.test',
                auth: 'agent',
            },
        });

        const continueAfterRelayAccess = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueAfterRelayAccess?.props.action ?? continueAfterRelayAccess?.props.onPress;
            await handler?.();
        });

        expect(screen.findByTestId('setupWizard-confirmSwitchRelay')).toBeTruthy();

        const switchChoice = screen.findByTestId('setupWizard-confirmSwitchRelay.choice:switch');
        await act(async () => {
            const handler = switchChoice?.props.action ?? switchChoice?.props.onPress;
            await handler?.();
        });

        const confirmButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = confirmButton?.props.action ?? confirmButton?.props.onPress;
            await handler?.();
        });

        expect(activeServerSwitchMocks.upsertActivateAndSwitchServer).toHaveBeenCalledTimes(1);
        expect(pendingSetupIntentMocks.setPendingSetupIntent).toHaveBeenCalledWith(expect.objectContaining({
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: 'https://remote-relay.example.test',
            machineId: 'mach-1',
            remoteSetupIntent: 'remoteRelayHost',
        }));
        expect(routerMock.spies.replace).toHaveBeenCalledWith('/');
    });

    it('switches remote relay hosting through the configured share URL once relay access provides one', async () => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const remoteBranch = screen.findByTestId('setupWizard-branch:remoteRelay');
        await act(async () => {
            const handler = remoteBranch?.props.action ?? remoteBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        const remoteSection = screen.findByType('RemoteSshChecklistStep' as never) as unknown as {
            props: {
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
            };
        };

        await act(async () => {
            remoteSection.props.onCompleted?.({
                machineId: 'mach-1',
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

        const proceedAfterRemote = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = proceedAfterRemote?.props.action ?? proceedAfterRemote?.props.onPress;
            await handler?.();
        });

        const relayAccessSection = screen.findByType('LocalRelayAccessControlSection' as never) as unknown as {
            props: {
                onShareUrlChange?: (value: string | null) => void;
            };
        };
        await act(async () => {
            relayAccessSection.props.onShareUrlChange?.('https://remote-share.example.test');
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        const continueAfterRelayAccess = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueAfterRelayAccess?.props.action ?? continueAfterRelayAccess?.props.onPress;
            await handler?.();
        });

        expect(screen.getTextContent()).toContain('https://remote-share.example.test');

        const switchChoice = screen.findByTestId('setupWizard-confirmSwitchRelay.choice:switch');
        await act(async () => {
            const handler = switchChoice?.props.action ?? switchChoice?.props.onPress;
            await handler?.();
        });

        const confirmButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = confirmButton?.props.action ?? confirmButton?.props.onPress;
            await handler?.();
        });

        expect(activeServerSwitchMocks.upsertActivateAndSwitchServer).toHaveBeenCalledWith(expect.objectContaining({
            serverUrl: 'https://remote-share.example.test',
        }));
        expect(pendingSetupIntentMocks.setPendingSetupIntent).toHaveBeenCalledWith(expect.objectContaining({
            relayUrl: 'https://remote-share.example.test',
            machineId: 'mach-1',
            remoteSetupIntent: 'remoteRelayHost',
        }));
    });

    it('preserves the remote relay share URL when relay access finishes and advances in the same pass', async () => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const remoteBranch = screen.findByTestId('setupWizard-branch:remoteRelay');
        await act(async () => {
            const handler = remoteBranch?.props.action ?? remoteBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        const remoteSection = screen.findByType('RemoteSshChecklistStep' as never) as unknown as {
            props: {
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
            };
        };

        await act(async () => {
            remoteSection.props.onCompleted?.({
                machineId: 'mach-1',
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

        const proceedAfterRemote = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = proceedAfterRemote?.props.action ?? proceedAfterRemote?.props.onPress;
            await handler?.();
        });

        const relayAccessSection = screen.findByType('LocalRelayAccessControlSection' as never) as unknown as {
            props: {
                onShareUrlChange?: (value: string | null) => void;
                onRequestAdvance?: () => void;
            };
        };

        await act(async () => {
            relayAccessSection.props.onShareUrlChange?.('https://remote-share.example.test');
            relayAccessSection.props.onRequestAdvance?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.getTextContent()).toContain('https://remote-share.example.test');
    });

    it('threads remote relay-access share URLs through the prerequisites step before confirming the switch', async () => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const remoteBranch = screen.findByTestId('setupWizard-branch:remoteRelay');
        await act(async () => {
            const handler = remoteBranch?.props.action ?? remoteBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        const remoteSection = screen.findByType('RemoteSshChecklistStep' as never) as unknown as {
            props: {
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
            };
        };

        await act(async () => {
            remoteSection.props.onCompleted?.({
                machineId: 'mach-1',
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

        const proceedAfterRemote = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = proceedAfterRemote?.props.action ?? proceedAfterRemote?.props.onPress;
            await handler?.();
        });

        const relayAccessSection = screen.findByType('LocalRelayAccessControlSection' as never) as unknown as {
            props: {
                onWizardRequestProviderDetails?: (providerId: 'tailscaleServe') => void;
            };
        };
        await act(async () => {
            relayAccessSection.props.onWizardRequestProviderDetails?.('tailscaleServe');
        });

        const prereqsSection = screen.findByType('RelayAccessPrerequisitesStep' as never) as unknown as {
            props: {
                onShareUrlChange?: (value: string | null) => void;
                onRequestAdvance?: () => void;
            };
        };

        expect(typeof prereqsSection.props.onShareUrlChange).toBe('function');
        await act(async () => {
            prereqsSection.props.onShareUrlChange?.('https://remote-share.example.test');
            prereqsSection.props.onRequestAdvance?.();
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(screen.getTextContent()).toContain('https://remote-share.example.test');
    });

    it('blocks switching to an unreachable tailscale relay until desktop remediation succeeds during setup', async () => {
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

        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const remoteBranch = screen.findByTestId('setupWizard-branch:remoteRelay');
        await act(async () => {
            const handler = remoteBranch?.props.action ?? remoteBranch?.props.onPress;
            await handler?.();
        });

        const continueToRemoteChecklist = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueToRemoteChecklist?.props.action ?? continueToRemoteChecklist?.props.onPress;
            await handler?.();
        });

        const remoteSection = screen.findByType('RemoteSshChecklistStep' as never) as unknown as {
            props: {
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
            };
        };

        await act(async () => {
            remoteSection.props.onCompleted?.({
                machineId: 'mach-1',
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

        const proceedAfterRemote = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = proceedAfterRemote?.props.action ?? proceedAfterRemote?.props.onPress;
            await handler?.();
        });

        const continueAfterRelayAccess = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueAfterRelayAccess?.props.action ?? continueAfterRelayAccess?.props.onPress;
            await handler?.();
        });
        await flushHookEffects({ cycles: 4, turns: 4 });

        expect(screen.findByTestId('setupWizard-confirmSwitchRelay')).toBeTruthy();
        const switchChoice = screen.findByTestId('setupWizard-confirmSwitchRelay.choice:switch');
        await act(async () => {
            const handler = switchChoice?.props.action ?? switchChoice?.props.onPress;
            await handler?.();
        });
        await flushHookEffects({ cycles: 4, turns: 4 });

        expect(screen.findByTestId('server-settings-add-reachability-remediation')).toBeTruthy();
        expect(screen.findByTestId('setupWizard.surface-primary')?.props.disabled).toBe(true);

        relayReachable = true;
        const remediationButton = screen.findByTestId('server-settings-add-remediation-action-prepare_tailscale');
        await act(async () => {
            const handler = remediationButton?.props.action ?? remediationButton?.props.onPress;
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
        expect(screen.findByTestId('setupWizard.surface-primary')?.props.disabled).toBe(false);

        runtimeFetchMock.mockImplementation(
            previousFetchImpl
            ?? (async (input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })),
        );
    });

    it('restores the remote relay-host branch when resuming from a pending intent', async () => {
        pendingSetupIntentMocks.setPendingSetupIntent.mockImplementation(() => undefined);
        pendingSetupIntentMocks.getPendingSetupIntent.mockReturnValue({
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: 'https://remote-relay.example.test',
            machineId: 'mach-1',
            remoteSetupIntent: 'remoteRelayHost',
        });

        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByType('RemoteSshChecklistStep' as never)).toBeTruthy();
        const remoteSection = screen.findByType('RemoteSshChecklistStep' as never) as unknown as {
            props: { initialInstallRelayRuntime?: unknown };
        };
        expect(remoteSection.props.initialInstallRelayRuntime).toBe(true);
        expect(pendingSetupIntentMocks.setPendingSetupIntent).not.toHaveBeenCalledWith(expect.objectContaining({
            phase: 'post_auth',
        }));
    });

    it('propagates the remote machine id to the providers wizard step after remote SSH bootstrap completes', async () => {
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const remoteBranch = screen.findByTestId('setupWizard-branch:remote');
        await act(async () => {
            const handler = remoteBranch?.props.action ?? remoteBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        const remoteSection = screen.findByType('RemoteSshChecklistStep' as never) as unknown as {
            props: {
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
            };
        };

        await act(async () => {
            remoteSection.props.onCompleted?.({
                machineId: 'mach-remote',
                relayRuntimeUrl: null,
                relayAccessTarget: null,
                mode: 'remoteMachine',
            });
        });

        const proceedAfterRemote = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = proceedAfterRemote?.props.action ?? proceedAfterRemote?.props.onPress;
            await handler?.();
        });

        const providersStep = screen.findByType('WizardAgentSetupStep' as never);
        expect(providersStep).toBeTruthy();
        expect(providersStep.props.machineId).toBe('mach-remote');
    });

    it('finishes setup with a connected-machine summary and starts a preselected new session', async () => {
        syncStoreHooksMockState.sessions = [{ id: 'session-existing' }];
        syncStoreHooksMockState.machines = {
            'mach-remote': {
                id: 'mach-remote',
                metadata: { host: 'remote-host.test' },
            },
        };

        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        const screen = await renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: true,
        }));

        const remoteBranch = screen.findByTestId('setupWizard-branch:remote');
        await act(async () => {
            const handler = remoteBranch?.props.action ?? remoteBranch?.props.onPress;
            await handler?.();
        });

        const continueButton = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueButton?.props.action ?? continueButton?.props.onPress;
            await handler?.();
        });

        const remoteSection = screen.findByType('RemoteSshChecklistStep' as never) as unknown as {
            props: {
                onCompleted?: (payload: {
                    machineId: string | null;
                    relayRuntimeUrl: string | null;
                    relayAccessTarget: null;
                    mode: string;
                }) => void;
            };
        };
        await act(async () => {
            remoteSection.props.onCompleted?.({
                machineId: 'mach-remote',
                relayRuntimeUrl: null,
                relayAccessTarget: null,
                mode: 'remoteMachine',
            });
        });

        const proceedAfterRemote = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = proceedAfterRemote?.props.action ?? proceedAfterRemote?.props.onPress;
            await handler?.();
        });

        const continueAfterProviders = screen.findByTestId('setupWizard.surface-primary');
        await act(async () => {
            const handler = continueAfterProviders?.props.action ?? continueAfterProviders?.props.onPress;
            await handler?.();
        });

        expect(screen.findByTestId('setupWizard-done-machine-summary')).toBeTruthy();
        expect(screen.getTextContent()).toContain('setupOnboarding.doneConnectedMachineSummary');
        expect(screen.getTextContent()).toContain('remote-host.test');
        expect(screen.findByTestId('setupWizard-done-existing-sessions')).toBeTruthy();
        expect(screen.getTextContent()).toContain('setupOnboarding.doneStartFirstSession');

        await act(async () => {
            const startButton = screen.findByTestId('setupWizard.surface-primary');
            const handler = startButton?.props.action ?? startButton?.props.onPress;
            await handler?.();
        });

        expect(routerMock.spies.push).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                draftId: expect.any(String),
                machineId: 'mach-remote',
                spawnServerId: 'relay-profile',
            },
        });
    });

    it('finishes web setup with the arrived-machine summary and live existing-session count', async () => {
        vi.resetModules();
        vi.doMock('react-native', installReactNativeWebMock({ Platform: { OS: 'web' } }));
        const previousStorageState = storage.getState();
        syncStoreHooksMockState.sessions = [
            {
                id: 'voice-history',
                metadata: {
                    systemSessionV1: {
                        v: 1,
                        key: 'voice_transcript_history',
                        hidden: true,
                    },
                },
            },
            { id: 'session-existing' },
        ];

        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                machines: {},
                machineListByServerId: {},
            }));
            const { SetupWizardSurface } = await import('./SetupWizardSurface');
            const screen = await renderScreen(React.createElement(SetupWizardSurface, {
                isDesktopShell: false,
            }));

            const localBranch = screen.findByTestId('setupWizard-branch:local');
            await act(async () => {
                const handler = localBranch?.props.action ?? localBranch?.props.onPress;
                await handler?.();
            });

            const continueToSetup = screen.findByTestId('setupWizard.surface-primary');
            await act(async () => {
                const handler = continueToSetup?.props.action ?? continueToSetup?.props.onPress;
                await handler?.();
            });

            expect(screen.findByTestId('setupWizard.surface-primary')?.props.disabled).toBe(true);
            await applyConnectedMachine('mach-web-finale', 'web-finale.test');

            expect(screen.findByTestId('setupWizard-web-providers-handoff')).toBeTruthy();

            const continueAfterProviders = screen.findByTestId('setupWizard.surface-primary');
            await act(async () => {
                const handler = continueAfterProviders?.props.action ?? continueAfterProviders?.props.onPress;
                await handler?.();
            });

            expect(screen.findByTestId('setupWizard-done-machine-summary')).toBeTruthy();
            expect(screen.getTextContent()).toContain('setupOnboarding.doneConnectedMachineSummary');
            expect(screen.getTextContent()).toContain('web-finale.test');
            expect(screen.findByTestId('setupWizard-done-existing-sessions')).toBeTruthy();
            expect(screen.getTextContent()).toContain('setupOnboarding.doneExistingSessionsLine 1');

            await act(async () => {
                const startButton = screen.findByTestId('setupWizard.surface-primary');
                const handler = startButton?.props.action ?? startButton?.props.onPress;
                await handler?.();
            });

            expect(routerMock.spies.push).toHaveBeenCalledWith({
                pathname: '/new',
                params: {
                    draftId: expect.any(String),
                    machineId: 'mach-web-finale',
                    spawnServerId: 'relay-profile',
                },
            });
        } finally {
            storage.setState(previousStorageState);
            vi.resetModules();
        }
    });

    type SetupMatrixPlatform = 'desktop' | 'web' | 'native';
    type SetupMatrixScope = 'all' | 'machine' | 'relay';
    type SetupMatrixStep =
        | 'setup_chooser'
        | 'setup_this_computer'
        | 'host_relay_local'
        | 'remote_ssh_setup'
        | 'relay_access'
        | 'confirm_switch_relay'
        | 'providers_optional';
    type RenderedSetupScreen = Awaited<ReturnType<typeof renderScreen>>;

    const renderSetupMatrix = async (
        platform: SetupMatrixPlatform,
        props: Partial<import('./SetupWizardSurface').SetupWizardSurfaceProps> = {},
    ) => {
        vi.resetModules();
        vi.doMock('react-native', installReactNativeWebMock({
            Platform: { OS: platform === 'native' ? 'ios' : 'web' },
        }));
        const { SetupWizardSurface } = await import('./SetupWizardSurface');
        return renderScreen(React.createElement(SetupWizardSurface, {
            isDesktopShell: platform === 'desktop',
            ...props,
        }));
    };

    const pressSetup = async (screen: RenderedSetupScreen, testID: string) => {
        const node = screen.findByTestId(testID);
        expect(node).toBeTruthy();
        await act(async () => {
            const handler = node?.props.action ?? node?.props.onPress;
            await handler?.();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });
    };

    const expectSetupStep = (screen: RenderedSetupScreen, stepId: SetupMatrixStep) => {
        switch (stepId) {
            case 'setup_chooser':
                expect(screen.findByTestId('setupWizard-branch:local') ?? screen.findByTestId('setupWizard-branch:relayLocal')).toBeTruthy();
                return;
            case 'setup_this_computer':
                expect(
                    screen.findByTestId('setupWizard-setup-this-computer')
                    ?? screen.findByTestId('setupWizard-machine-arrival'),
                ).toBeTruthy();
                return;
            case 'host_relay_local':
                expect(
                    screen.findByTestId('setupWizard-relay-host-local')
                    ?? screen.findByTestId('setupWizard-web-relay-host-handoff'),
                ).toBeTruthy();
                return;
            case 'remote_ssh_setup':
                expect(
                    screen.findByTestId('setupWizard-terminal-handoff')
                    ?? (screen.findAllByType('RemoteSshChecklistStep' as never)[0] ?? null),
                ).toBeTruthy();
                return;
            case 'relay_access':
                expect(
                    screen.findAllByType('LocalRelayAccessControlSection' as never)[0]
                    ?? screen.findByTestId('setupWizard-web-relay-access-handoff'),
                ).toBeTruthy();
                return;
            case 'confirm_switch_relay':
                expect(screen.findByTestId('setupWizard-confirmSwitchRelay')).toBeTruthy();
                return;
            case 'providers_optional':
                expect(
                    screen.findAllByType('WizardAgentSetupStep' as never)[0]
                    ?? screen.findByTestId('setupWizard-web-providers-handoff'),
                ).toBeTruthy();
                return;
        }
    };

    const enterDesktopRelaySwitchConfirmation = async (props: Partial<import('./SetupWizardSurface').SetupWizardSurfaceProps> = {}) => {
        const screen = await renderSetupMatrix('desktop', props);

        await pressSetup(screen, 'setupWizard-branch:relayLocal');
        await pressSetup(screen, 'setupWizard.surface-primary');

        const localRelaySection = screen.findByType('RelayHostLocalChecklistStep' as never) as unknown as {
            props: { onStatusChange?: (status: unknown) => void };
        };
        await act(async () => {
            localRelaySection.props.onStatusChange?.({
                relayUrl: 'https://local-relay.example.test',
            });
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        await pressSetup(screen, 'setupWizard.surface-primary');
        expectSetupStep(screen, 'relay_access');

        await pressSetup(screen, 'setupWizard.surface-primary');
        expectSetupStep(screen, 'confirm_switch_relay');

        return screen;
    };

    it('hides native remote-machine setup when the native SSH runtime is unavailable', async () => {
        nativeSshAvailabilityMock.available = false;
        const screen = await renderSetupMatrix('native', { scope: 'machine' });

        expect(screen.findByTestId('setupWizard-branch:local')).toBeTruthy();
        expect(screen.findAllByTestId('setupWizard-branch:remote')).toHaveLength(0);
    });

    it('routes native remote-machine setup through the existing SSH checklist when runtime availability allows it', async () => {
        nativeSshAvailabilityMock.available = true;
        const screen = await renderSetupMatrix('native', { scope: 'machine' });

        await pressSetup(screen, 'setupWizard-branch:remote');
        await pressSetup(screen, 'setupWizard.surface-primary');

        const nativeChecklist = screen.findByType('RemoteSshChecklistStep' as never) as unknown as {
            props: { runner?: unknown };
        };
        expect(nativeChecklist).toBeTruthy();
        expect(nativeChecklist.props.runner).toBeUndefined();
        expect(screen.findAllByTestId('setupWizard-terminal-handoff')).toHaveLength(0);
    });

    it.each([
        { platform: 'desktop', scope: 'all', local: true, relayLocal: true, remote: true, remoteRelay: true },
        { platform: 'web', scope: 'all', local: true, relayLocal: true, remote: true, remoteRelay: true },
        { platform: 'native', scope: 'all', local: true, relayLocal: true, remote: true, remoteRelay: true },
        { platform: 'desktop', scope: 'machine', local: true, relayLocal: false, remote: true, remoteRelay: false },
        { platform: 'web', scope: 'machine', local: true, relayLocal: false, remote: true, remoteRelay: false },
        { platform: 'native', scope: 'machine', local: true, relayLocal: false, remote: true, remoteRelay: false },
        { platform: 'desktop', scope: 'relay', local: false, relayLocal: true, remote: false, remoteRelay: true },
        { platform: 'web', scope: 'relay', local: false, relayLocal: true, remote: false, remoteRelay: true },
        { platform: 'native', scope: 'relay', local: false, relayLocal: true, remote: false, remoteRelay: true },
    ] as const)('characterizes setup chooser scope=$scope on $platform', async (row) => {
        nativeSshAvailabilityMock.available = row.platform === 'native';
        const screen = await renderSetupMatrix(row.platform, { scope: row.scope as SetupMatrixScope });

        expect(Boolean(screen.findByTestId('setupWizard-branch:local'))).toBe(row.local);
        expect(Boolean(screen.findByTestId('setupWizard-branch:relayLocal'))).toBe(row.relayLocal);
        expect(Boolean(screen.findByTestId('setupWizard-branch:remote'))).toBe(row.remote);
        expect(Boolean(screen.findByTestId('setupWizard-branch:remoteRelay'))).toBe(row.remoteRelay);
        expectSetupStep(screen, 'setup_chooser');

        vi.resetModules();
    });

    it.each([
        { branch: 'local', platform: 'desktop', rowTestID: 'setupWizard-branch:local', expectedStepId: 'setup_this_computer' },
        { branch: 'local', platform: 'web', rowTestID: 'setupWizard-branch:local', expectedStepId: 'setup_this_computer' },
        { branch: 'local', platform: 'native', rowTestID: 'setupWizard-branch:local', expectedStepId: 'setup_this_computer' },
        { branch: 'relayLocal', platform: 'desktop', rowTestID: 'setupWizard-branch:relayLocal', expectedStepId: 'host_relay_local' },
        { branch: 'relayLocal', platform: 'web', rowTestID: 'setupWizard-branch:relayLocal', expectedStepId: 'host_relay_local' },
        { branch: 'relayLocal', platform: 'native', rowTestID: 'setupWizard-branch:relayLocal', expectedStepId: 'host_relay_local' },
        { branch: 'remote', platform: 'desktop', rowTestID: 'setupWizard-branch:remote', expectedStepId: 'remote_ssh_setup' },
        { branch: 'remote', platform: 'web', rowTestID: 'setupWizard-branch:remote', expectedStepId: 'remote_ssh_setup' },
        { branch: 'remote', platform: 'native', rowTestID: 'setupWizard-branch:remote', expectedStepId: 'remote_ssh_setup' },
        { branch: 'remoteRelay', platform: 'desktop', rowTestID: 'setupWizard-branch:remoteRelay', expectedStepId: 'remote_ssh_setup' },
        { branch: 'remoteRelay', platform: 'web', rowTestID: 'setupWizard-branch:remoteRelay', expectedStepId: 'remote_ssh_setup' },
        { branch: 'remoteRelay', platform: 'native', rowTestID: 'setupWizard-branch:remoteRelay', expectedStepId: 'remote_ssh_setup' },
    ] as const)('characterizes setup chooser branch advance: $branch on $platform', async (row) => {
        nativeSshAvailabilityMock.available = row.platform === 'native';
        const screen = await renderSetupMatrix(row.platform);

        await pressSetup(screen, row.rowTestID);
        await pressSetup(screen, 'setupWizard.surface-primary');

        expectSetupStep(screen, row.expectedStepId);

        vi.resetModules();
    });

    it.each([
        { platform: 'desktop', primaryDisabledBeforeSignal: true, advancesWithoutSignal: false },
        { platform: 'web', primaryDisabledBeforeSignal: true, advancesWithoutSignal: false },
        { platform: 'native', primaryDisabledBeforeSignal: true, advancesWithoutSignal: false },
    ] as const)('characterizes setup-this-computer current gating on $platform', async (row) => {
        const screen = await renderSetupMatrix(row.platform, {
            initialSetupAction: 'local',
            initialStepId: 'setup_this_computer',
        });

        expectSetupStep(screen, 'setup_this_computer');
        expect(screen.findByTestId('setupWizard.surface-primary')?.props.disabled).toBe(row.primaryDisabledBeforeSignal);

        if (row.advancesWithoutSignal) {
            await pressSetup(screen, 'setupWizard.surface-primary');
            expectSetupStep(screen, 'providers_optional');
        } else if (row.platform === 'desktop') {
            const localSetup = screen.findByType('SetupThisComputerWizardStep' as never) as unknown as {
                props: { onSucceeded?: (machineId: string | null) => void };
            };
            await act(async () => {
                localSetup.props.onSucceeded?.('mach-local');
            });
            await pressSetup(screen, 'setupWizard.surface-primary');
            expectSetupStep(screen, 'providers_optional');
        } else {
            expectSetupStep(screen, 'setup_this_computer');
        }

        vi.resetModules();
    });

    it.each([
        ['web', 'web'],
        ['native', 'native'],
    ] as const)('characterizes relay-local URL unset/set advance on %s', async (_label, platform) => {
        const screen = await renderSetupMatrix(platform, {
            initialSetupAction: 'relayLocal',
            initialStepId: 'host_relay_local',
        });

        expect(screen.findByTestId('setupWizard.surface-primary')?.props.disabled).toBe(true);

        const relayUrlInput = screen.findByTestId('setupWizard-relay-url-input');
        expect(relayUrlInput).toBeTruthy();
        await act(async () => {
            relayUrlInput?.props.onChangeText?.(`https://${platform}.relay-local.example.test`);
        });
        await flushHookEffects({ cycles: 6, turns: 6 });
        expect(screen.findByTestId('setupWizard.surface-primary')?.props.disabled).toBe(false);

        await pressSetup(screen, 'setupWizard.surface-primary');
        expectSetupStep(screen, 'relay_access');

        await pressSetup(screen, 'setupWizard.surface-primary');
        expectSetupStep(screen, 'confirm_switch_relay');

        vi.resetModules();
    });

    it('characterizes relay switch keep vs switch effects', async () => {
        const onExit = vi.fn();
        const screen = await enterDesktopRelaySwitchConfirmation({ onExit });

        expectSetupStep(screen, 'confirm_switch_relay');

        await pressSetup(screen, 'setupWizard.surface-primary');
        expectSetupStep(screen, 'providers_optional');
        expect(activeServerSwitchMocks.upsertActivateAndSwitchServer).not.toHaveBeenCalled();
        expect(pendingSetupIntentMocks.setPendingSetupIntent).not.toHaveBeenCalled();
        expect(onExit).not.toHaveBeenCalled();

        const switchScreen = await enterDesktopRelaySwitchConfirmation({ onExit });
        const switchChoice = switchScreen.findByTestId('setupWizard-confirmSwitchRelay.choice:switch');
        expect(switchChoice).toBeTruthy();
        await act(async () => {
            await switchChoice?.props.onPress?.();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        await pressSetup(switchScreen, 'setupWizard.surface-primary');

        expect(activeServerSwitchMocks.upsertActivateAndSwitchServer).toHaveBeenLastCalledWith({
            serverUrl: 'https://local-relay.example.test',
            source: 'url',
            scope: 'device',
        });
        expect(pendingSetupIntentMocks.setPendingSetupIntent).toHaveBeenLastCalledWith({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://local-relay.example.test',
        });
        expect(onExit).toHaveBeenCalledTimes(1);
        expect(routerMock.spies.replace).toHaveBeenLastCalledWith('/');

        vi.resetModules();
    });
});
