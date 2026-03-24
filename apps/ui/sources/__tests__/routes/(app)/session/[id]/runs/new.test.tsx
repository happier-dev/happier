import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
    createDeferred,
    changeTextTestInstance,
    findTestInstanceByTypeContainingText,
    pressTestInstanceAsync,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installSessionRouteCommonModuleMocks } from '../sessionRouteTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let sessionMock: any = { id: 'session-1', metadata: { agent: 'claude', permissionMode: 'default' } };
let machineCapabilitiesStateMock: any = { status: 'idle' };
let hydrateReady = true;
let enabledAgentIdsMock: string[] = ['claude', 'codex'];
let localSearchParamsMock: any = { id: 'session-1', intent: 'review' };
let sessionExecutionRunsSupportedMock = true;
let settingsMock: any = {
    executionRunsGuidanceEnabled: false,
    executionRunsGuidanceMaxChars: 4_000,
    executionRunsGuidanceEntries: [],
    acpCatalogSettingsV1: { v: 2, backends: [] },
};
let actionExecutorExecuteResultMock: any = {
    ok: true,
    result: { results: [{ ok: true }] },
};
let directSessionRuntimeMock: any = {
    directSessionLink: null,
    status: null,
    refreshNow: vi.fn(async () => null),
};
let sessionMachineReachabilityMock: any = {
    machineReachable: true,
    machineOnline: true,
    machineRpcTargetAvailable: true,
};
let resumeCapabilityOptionsMock: any = {};
const resumeSessionSpy = vi.fn(async () => ({ type: 'success', sessionId: 'session-1' }));
let activeServerSnapshotMock: any = { serverId: 'server-active', serverUrl: 'http://server-active.test' };
const useMachineCapabilitiesCacheSpy = vi.fn<(params: any) => { state: any; refresh: any }>();
const sessionServerIdStore = {
    value: null as string | null,
    listeners: new Set<() => void>(),
    getSnapshot() {
        return sessionServerIdStore.value;
    },
    set(next: string | null) {
        sessionServerIdStore.value = next;
        for (const listener of Array.from(sessionServerIdStore.listeners)) listener();
    },
    reset(next: string | null = null) {
        sessionServerIdStore.value = next;
        sessionServerIdStore.listeners.clear();
    },
    subscribe(listener: () => void) {
        sessionServerIdStore.listeners.add(listener);
        return () => {
            sessionServerIdStore.listeners.delete(listener);
        };
    },
};
let executionRunsBackendsMock: Record<string, { available?: boolean; intents?: string[] }> | null = {
    claude: { available: true, intents: ['review', 'plan', 'delegate', 'voice_agent'] },
    codex: { available: true, intents: ['review', 'plan', 'delegate', 'voice_agent'] },
    coderabbit: { available: true, intents: ['review'] },
};

const startRunSpy = vi.fn(async (_sessionId: string, _request: any) => ({
    runId: 'run_1',
    callId: 'call_1',
    sidechainId: 'call_1',
}));

const routerPushSpy = vi.fn();
const routerReplaceSpy = vi.fn();
const navigationCanGoBackSpy = vi.fn(() => true);
const stackScreenSpy = vi.fn((_props: any) => null);
let NewRunScreen: typeof import('@/app/(app)/session/[id]/runs/new').default;

type RenderedNewRunScreen = Awaited<ReturnType<typeof renderScreen>>;

async function renderNewRunScreen(): Promise<RenderedNewRunScreen> {
    return renderScreen(React.createElement(NewRunScreen));
}

function findInstructionsInput(screen: RenderedNewRunScreen) {
    const input = screen.findByTestId('execution-run-new-instructions-input');
    expect(input).toBeTruthy();
    return input!;
}

function findStartButton(screen: RenderedNewRunScreen) {
    const button = screen.findByTestId('execution-run-new-start-button');
    expect(button).toBeTruthy();
    return button!;
}

function translateText(key: string, params?: Record<string, unknown>) {
    if (key === 'executionRuns.newRun.headerTitle') return 'Start run';
    if (key === 'executionRuns.newRun.sections.intent') return 'Intent';
    if (key === 'executionRuns.newRun.sections.permissions') return 'Permissions';
    if (key === 'executionRuns.newRun.sections.backends') return 'Backends';
    if (key === 'executionRuns.newRun.sections.instructions') return 'Instructions';
    if (key === 'executionRuns.newRun.intents.review') return 'review';
    if (key === 'executionRuns.newRun.intents.plan') return 'plan';
    if (key === 'executionRuns.newRun.intents.delegate') return 'delegate';
    if (key === 'agentInput.permissionMode.default') return 'default';
    if (key === 'agentInput.permissionMode.readOnly') return 'read-only';
    if (key === 'agentInput.permissionMode.safeYolo') return 'safe-yolo';
    if (key === 'agentInput.permissionMode.yolo') return 'yolo';
    if (key === 'executionRuns.newRun.instructionsPlaceholder') return 'What should the sub-agent do?';
    if (key === 'executionRuns.newRun.actions.start') return 'Start';
    if (key === 'executionRuns.newRun.guidancePreview') return 'Guidance preview';
    if (key === 'session.actionsDraft.validation.requiredField') return `${String(params?.field ?? 'Field')} is required.`;
    if (key === 'common.unavailable') return 'Not available';
    if (key === 'errors.invalidFormat') return 'Invalid format';
    if (key === 'executionRuns.newRun.a11y.startRun') return 'Start run';
    if (key === 'executionRuns.newRun.a11y.cancel') return 'Cancel';
    if (key === 'executionRuns.newRun.a11y.selectIntent') return `Select intent ${String(params?.intent ?? '')}`;
    if (key === 'executionRuns.newRun.a11y.selectPermissionMode') return `Select permissionMode ${String(params?.mode ?? '')}`;
    if (key === 'executionRuns.newRun.a11y.toggleBackend') return `Toggle backend ${String(params?.backendId ?? '')}`;
    return key;
}

installSessionRouteCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Text: 'Text',
            Pressable: 'Pressable',
            ActivityIndicator: 'ActivityIndicator',
            TextInput: 'TextInput',
            AppState: { currentState: 'active', addEventListener: vi.fn(), removeEventListener: vi.fn() },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    surface: '#111',
                    text: '#eee',
                    textSecondary: '#aaa',
                    divider: '#333',
                },
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            navigation: {
                canGoBack: navigationCanGoBackSpy,
            },
            router: {
                push: routerPushSpy,
                back: vi.fn(),
                replace: routerReplaceSpy,
                setParams: vi.fn(),
            },
        });
        return {
            ...routerMock.module,
            useLocalSearchParams: () => localSearchParamsMock,
            Stack: { Screen: (props: any) => stackScreenSpy(props) },
        };
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: translateText });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                show: vi.fn(),
            },
        }).module;
    },
    storageModule: async (importOriginal) => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            importOriginal,
            useSession: () => sessionMock,
            useSettings: () => settingsMock,
            storage: { getState: () => ({ sessionListViewDataByServerId: {} }) },
        });
    },
});

vi.mock('@/components/ui/layout/layout', () => ({ layout: { maxWidth: 999 } }));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: () => hydrateReady,
}));

vi.mock('@/sync/store/hooks', async (importOriginal) => {
    const React = await import('react');
    const actual = await importOriginal<typeof import('@/sync/store/hooks')>();
    return {
        ...actual,
        useSessionServerId: () => React.useSyncExternalStore(
            sessionServerIdStore.subscribe,
            sessionServerIdStore.getSnapshot,
            sessionServerIdStore.getSnapshot,
        ),
    };
});

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => enabledAgentIdsMock,
}));
vi.mock('@/hooks/server/useExecutionRunsBackendsForSession', () => ({
    useExecutionRunsBackendsForSession: () => executionRunsBackendsMock,
}));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));
vi.mock('@/hooks/server/useSessionExecutionRunsSupported', () => ({
    useSessionExecutionRunsSupported: () => sessionExecutionRunsSupportedMock,
}));
vi.mock('@/components/sessions/model/useDirectSessionRuntime', () => ({
    useDirectSessionRuntime: () => directSessionRuntimeMock,
}));
vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
    useSessionMachineReachability: () => sessionMachineReachabilityMock,
}));
vi.mock('@/agents/hooks/useResumeCapabilityOptions', () => ({
    useResumeCapabilityOptions: () => ({ resumeCapabilityOptions: resumeCapabilityOptionsMock }),
}));
vi.mock('@/sync/domains/settings/executionRunsGuidance', () => ({
    coerceExecutionRunsGuidanceEntries: (value: unknown) => (Array.isArray(value) ? value : []),
    buildExecutionRunsGuidanceBlock: ({ entries }: { entries: Array<{ description?: string }> }) => ({
        text: entries.map((entry) => entry.description ?? '').filter(Boolean).join('\n'),
    }),
}));
vi.mock('@/sync/domains/reviews/reviewEngineCatalog', () => ({
    buildAvailableReviewEngineOptions: ({
        enabledAgentIds,
        executionRunsBackends,
    }: {
        enabledAgentIds: string[];
        executionRunsBackends: Record<string, { available?: boolean; intents?: string[] }>;
    }) => {
        const capabilityIds = Object.entries(executionRunsBackends ?? {})
            .filter(([, value]) => value?.available !== false && (value?.intents ?? []).includes('review'))
            .map(([id]) => id);
        const merged = Array.from(new Set([...enabledAgentIds, ...capabilityIds]));
        return merged.map((id) => ({ id }));
    },
}));

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunStart: (sessionId: string, request: any) => startRunSpy(sessionId, request),
    sessionExecutionRunList: vi.fn(),
    sessionExecutionRunGet: vi.fn(),
    sessionExecutionRunSend: vi.fn(),
    sessionExecutionRunStop: vi.fn(),
    sessionExecutionRunAction: vi.fn(),
}));
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({
        execute: async (actionId: string, request: any) => {
            const intent = actionId === 'review.start' ? 'review' : actionId === 'subagents.plan.start' ? 'plan' : 'delegate';
            const firstBackendTargetKey = typeof request?.backendTargetKeys?.[0] === 'string'
                ? String(request.backendTargetKeys[0])
                : undefined;
            const backendTarget = firstBackendTargetKey?.startsWith('agent:')
                ? { kind: 'builtInAgent', agentId: firstBackendTargetKey.slice('agent:'.length) }
                : firstBackendTargetKey?.startsWith('acpBackend:')
                    ? { kind: 'configuredAcpBackend', backendId: firstBackendTargetKey.slice('acpBackend:'.length) }
                    : undefined;
            const backendId = intent === 'review'
                ? request?.engineIds?.[0]
                : backendTarget?.kind === 'builtInAgent'
                    ? backendTarget.agentId
                    : backendTarget?.kind === 'configuredAcpBackend'
                        ? backendTarget.backendId
                        : undefined;
            await startRunSpy(request?.sessionId, {
                ...request,
                intent,
                backendId,
                ...(backendTarget ? { backendTarget } : {}),
            });
            return actionExecutorExecuteResultMock;
        },
    }),
}));
vi.mock('@/sync/ops/sessions', () => ({
    resumeSession: (...args: Parameters<typeof resumeSessionSpy>) => resumeSessionSpy(...args),
}));
vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerSnapshotMock,
    subscribeActiveServer: () => () => {},
}));

vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({
    useMachineCapabilitiesCache: (params: any) => {
        useMachineCapabilitiesCacheSpy(params);
        return { state: machineCapabilitiesStateMock, refresh: vi.fn() };
    },
}));

describe('Session New Run Screen', () => {
    beforeAll(async () => {
        vi.resetModules();
        NewRunScreen = (await import('@/app/(app)/session/[id]/runs/new')).default;
    }, 120_000);

    afterAll(() => {
        vi.resetModules();
    });

    afterEach(() => {
        standardCleanup();
        startRunSpy.mockClear();
        routerPushSpy.mockClear();
        routerReplaceSpy.mockClear();
        navigationCanGoBackSpy.mockReturnValue(true);
        stackScreenSpy.mockClear();
        executionRunsBackendsMock = {
            claude: { available: true, intents: ['review', 'plan', 'delegate', 'voice_agent'] },
            codex: { available: true, intents: ['review', 'plan', 'delegate', 'voice_agent'] },
            coderabbit: { available: true, intents: ['review'] },
        };
        enabledAgentIdsMock = ['claude', 'codex'];
        sessionMock = { id: 'session-1', metadata: { agent: 'claude', permissionMode: 'default' } };
        machineCapabilitiesStateMock = { status: 'idle' };
        hydrateReady = true;
        localSearchParamsMock = { id: 'session-1', intent: 'review' };
        settingsMock = {
            executionRunsGuidanceEnabled: false,
            executionRunsGuidanceMaxChars: 4_000,
            executionRunsGuidanceEntries: [],
            acpCatalogSettingsV1: { v: 2, backends: [] },
        };
        sessionExecutionRunsSupportedMock = true;
        sessionMachineReachabilityMock = {
            machineReachable: true,
            machineOnline: true,
            machineRpcTargetAvailable: true,
        };
        resumeCapabilityOptionsMock = {};
        resumeSessionSpy.mockClear();
        useMachineCapabilitiesCacheSpy.mockClear();
        sessionServerIdStore.reset();
        activeServerSnapshotMock = { serverId: 'server-active', serverUrl: 'http://server-active.test' };
        actionExecutorExecuteResultMock = {
            ok: true,
            result: { results: [{ ok: true }] },
        };
        directSessionRuntimeMock = {
            directSessionLink: null,
            status: null,
            refreshNow: vi.fn(async () => null),
        };
    });

    it('renders a loading state while session hydration is pending', async () => {
        hydrateReady = false;
        localSearchParamsMock = { id: 'session-1', intent: 'review' };
        const screen = await renderNewRunScreen();
        expect(screen.findAllByType('ActivityIndicator').length).toBeGreaterThan(0);
        hydrateReady = true;
    });

    it('does not crash when hydration flips from pending to ready', async () => {
        hydrateReady = false;
        localSearchParamsMock = { id: 'session-1', intent: 'review' };
        const screen = await renderNewRunScreen();

        hydrateReady = true;
        await act(async () => {
            screen.tree.update(React.createElement(NewRunScreen));
        });
    });

    it('shows unavailable state when the session has no live execution-run backends', async () => {
        executionRunsBackendsMock = null;
        machineCapabilitiesStateMock = { status: 'loaded' };
        enabledAgentIdsMock = ['claude', 'codex'];
        localSearchParamsMock = { id: 'session-1', intent: 'delegate' };
        const screen = await renderNewRunScreen();

        expect(screen.findByTestId('execution-run-new-start-button')).toBeNull();
        expect(screen.findAllByType('TextInput')).toHaveLength(0);

        executionRunsBackendsMock = {
            claude: { available: true, intents: ['review', 'plan', 'delegate', 'voice_agent'] },
            codex: { available: true, intents: ['review', 'plan', 'delegate', 'voice_agent'] },
            coderabbit: { available: true, intents: ['review'] },
        };
    });

    it('fails closed when the route intent is valid but unsupported by the launcher', async () => {
        localSearchParamsMock = { id: 'session-1', intent: 'voice_agent' };

        const screen = await renderNewRunScreen();

        expect(screen.findByTestId('execution-run-new-instructions-input')).toBeNull();
        expect(screen.findByTestId('execution-run-new-start-button')).toBeNull();
        expect(screen.getTextContent()).toContain('Invalid format');
    });

    it('keeps showing a loading state while execution-run capabilities are still resolving', async () => {
        executionRunsBackendsMock = null;
        machineCapabilitiesStateMock = { status: 'loading' };
        sessionExecutionRunsSupportedMock = false;
        localSearchParamsMock = { id: 'session-1', intent: 'review' };

        const screen = await renderNewRunScreen();

        expect(screen.findAllByType('ActivityIndicator').length).toBeGreaterThan(0);
        expect(screen.findAllByType('TextInput')).toHaveLength(0);
    });

    it('keeps showing a loading state while live execution-run capabilities are still idle even after prior runs proved support', async () => {
        executionRunsBackendsMock = null;
        machineCapabilitiesStateMock = { status: 'idle' };
        sessionExecutionRunsSupportedMock = true;
        localSearchParamsMock = { id: 'session-1', intent: 'review' };

        const screen = await renderNewRunScreen();

        expect(screen.findAllByType('ActivityIndicator').length).toBeGreaterThan(0);
        expect(screen.findAllByType('TextInput')).toHaveLength(0);
    });

    it('shows unavailable state when the session is inactive and not resumable even if live execution-run backends exist', async () => {
        sessionMock = { id: 'session-1', active: false, metadata: { agent: 'claude', permissionMode: 'default' } };
        sessionMachineReachabilityMock = {
            machineReachable: false,
            machineOnline: false,
            machineRpcTargetAvailable: false,
        };
        executionRunsBackendsMock = {
            claude: { available: true, intents: ['review', 'plan', 'delegate', 'voice_agent'] },
        };
        localSearchParamsMock = { id: 'session-1', intent: 'review' };
        const screen = await renderNewRunScreen();

        expect(screen.findAllByType('TextInput')).toHaveLength(0);
        expect(screen.findByTestId('execution-run-new-start-button')).toBeNull();
    });

    it('falls back to the parent session route when the launcher is closed without back history', async () => {
        navigationCanGoBackSpy.mockReturnValue(false);
        const screen = await renderNewRunScreen();

        await act(async () => {
            await screen.pressByTestIdAsync('execution-run-new-cancel-button');
        });

        expect(routerReplaceSpy).toHaveBeenCalledWith('/session/session-1');
    });

    it('resumes an inactive resumable session before starting a Subagent', async () => {
        sessionMock = {
            id: 'session-1',
            active: false,
            metadata: {
                agent: 'claude',
                flavor: 'claude',
                permissionMode: 'default',
                machineId: 'machine-1',
                path: '/workspace/repo',
                claudeSessionId: 'claude-resume-id',
            },
        };
        executionRunsBackendsMock = {
            claude: { available: true, intents: ['review', 'plan', 'delegate', 'voice_agent'] },
        };
        sessionServerIdStore.set('server-owned');
        localSearchParamsMock = { id: 'session-1', intent: 'review' };

        const screen = await renderNewRunScreen();
        await act(async () => {
            screen.changeTextByTestId('execution-run-new-instructions-input', 'please review this');
        });

        const selectClaude = screen.findByProps({ accessibilityLabel: 'Toggle backend claude' });
        expect(selectClaude).toBeDefined();
        await pressTestInstanceAsync(selectClaude, 'backend claude');

        findStartButton(screen);
        await screen.pressByTestIdAsync('execution-run-new-start-button');

        expect(resumeSessionSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            serverId: 'server-owned',
        }));
        expect(startRunSpy).toHaveBeenCalledWith(
            'session-1',
            expect.objectContaining({
                intent: 'review',
                backendId: 'claude',
                instructions: 'please review this',
            }),
        );
    });

    it('scopes machine execution-run capability lookup to the session-owned server', async () => {
        sessionMock = {
            id: 'session-1',
            active: false,
            metadata: {
                agent: 'claude',
                flavor: 'claude',
                permissionMode: 'default',
                machineId: 'machine-1',
                path: '/workspace/repo',
                claudeSessionId: 'claude-resume-id',
            },
        };
        executionRunsBackendsMock = {
            claude: { available: true, intents: ['review', 'plan', 'delegate', 'voice_agent'] },
        };
        machineCapabilitiesStateMock = { status: 'loaded' };
        sessionServerIdStore.set('server-owned');
        localSearchParamsMock = { id: 'session-1', intent: 'review' };

        await renderNewRunScreen();

        expect(useMachineCapabilitiesCacheSpy).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-owned',
            enabled: true,
        }));
    });

    it('refreshes the machine capability scope when the preferred session server changes', async () => {
        sessionMock = {
            id: 'session-1',
            active: false,
            metadata: {
                agent: 'claude',
                flavor: 'claude',
                permissionMode: 'default',
                machineId: 'machine-1',
                path: '/workspace/repo',
                claudeSessionId: 'claude-resume-id',
            },
        };
        executionRunsBackendsMock = {
            claude: { available: true, intents: ['review', 'plan', 'delegate', 'voice_agent'] },
        };
        machineCapabilitiesStateMock = { status: 'loaded' };
        sessionServerIdStore.set('server-a');
        localSearchParamsMock = { id: 'session-1', intent: 'review' };

        const screen = await renderNewRunScreen();

        expect(useMachineCapabilitiesCacheSpy).toHaveBeenLastCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            enabled: true,
        }));

        await act(async () => {
            sessionServerIdStore.set('server-b');
        });

        expect(useMachineCapabilitiesCacheSpy).toHaveBeenLastCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-b',
            enabled: true,
        }));

        await act(async () => {
            screen.tree.unmount();
        });
    });

    it('shows unavailable state for linked direct sessions until the runner is locally active', async () => {
        sessionMock = {
            id: 'session-1',
            active: true,
            metadata: {
                agent: 'claude',
                permissionMode: 'default',
                directSessionV1: {
                    v: 1,
                    providerId: 'claude',
                    machineId: 'machine-1',
                    remoteSessionId: 'remote-session-1',
                    source: 'provider',
                },
            },
        };
        directSessionRuntimeMock = {
            directSessionLink: {
                v: 1,
                providerId: 'claude',
                machineId: 'machine-1',
                remoteSessionId: 'remote-session-1',
                source: 'provider',
            },
            status: { runnerActive: false },
            refreshNow: vi.fn(async () => null),
        };
        executionRunsBackendsMock = {
            claude: { available: true, intents: ['review', 'plan', 'delegate', 'voice_agent'] },
        };
        localSearchParamsMock = { id: 'session-1', intent: 'review' };

        const screen = await renderNewRunScreen();

        expect(screen.findAllByType('TextInput')).toHaveLength(0);
        expect(screen.findByTestId('execution-run-new-start-button')).toBeNull();
    });

    it('configures the header title and constrains form content width', async () => {
        stackScreenSpy.mockClear();
        localSearchParamsMock = { id: 'session-1', intent: 'review' };
        const screen = await renderNewRunScreen();

        const stackOptions = stackScreenSpy.mock.calls.at(-1)?.[0]?.options;
        expect(stackOptions?.headerTitle).toBe('Start run');

        const views = screen.findAllByType('View');
        const hasConstrainedContainer = views.some((node: any) => {
            const raw = node.props.style;
            const styles = Array.isArray(raw) ? raw : [raw];
            return styles.some((entry: any) => {
                if (!entry || typeof entry !== 'object') return false;
                return entry.maxWidth === 999 && entry.width === '100%' && entry.alignSelf === 'center';
            });
        });
        expect(hasConstrainedContainer).toBe(true);
    });

    it('renders a guidance preview when guidance is enabled and rules exist', async () => {
        settingsMock = {
            executionRunsGuidanceEnabled: true,
            executionRunsGuidanceMaxChars: 10_000,
            executionRunsGuidanceEntries: [{ id: 'g1', description: 'Prefer Claude for UI changes', enabled: true }],
        };
        localSearchParamsMock = { id: 'session-1', intent: 'review' };

        const screen = await renderNewRunScreen();

        expect(screen.getTextContent()).toContain('Guidance preview');
        expect(screen.getTextContent()).toContain('Prefer Claude for UI changes');
    });

    it('exposes the canonical review.start fields and submits advanced review options', async () => {
        startRunSpy.mockClear();
        enabledAgentIdsMock = ['claude', 'codex'];
        executionRunsBackendsMock = {
            claude: { available: true, intents: ['review', 'plan', 'delegate', 'voice_agent'] },
            codex: { available: true, intents: ['review', 'plan', 'delegate', 'voice_agent'] },
            coderabbit: { available: true, intents: ['review'] },
        };
        localSearchParamsMock = { id: 'session-1', intent: 'review' };

        const screen = await renderNewRunScreen();

        expect(screen.getTextContent()).toContain('Change type');
        expect(screen.getTextContent()).toContain('Base selection');

        const selectCoderabbit = screen.findByProps({ accessibilityLabel: 'Toggle backend coderabbit' });
        const selectAllChanges = findTestInstanceByTypeContainingText(screen, 'Pressable', 'All');
        const selectBaseBranch = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Base branch');

        expect(selectCoderabbit).toBeDefined();
        expect(selectAllChanges).toBeDefined();
        expect(selectBaseBranch).toBeDefined();

        await pressTestInstanceAsync(selectCoderabbit, 'backend coderabbit');
        await pressTestInstanceAsync(selectAllChanges, 'review change type all');
        await pressTestInstanceAsync(selectBaseBranch, 'review base branch');

        const textInputs = screen.findAllByType('TextInput');
        expect(textInputs.length).toBeGreaterThanOrEqual(3);

        await act(async () => {
            screen.changeTextByTestId('execution-run-new-instructions-input', 'review everything deeply');
            changeTextTestInstance(textInputs[1], 'main');
            changeTextTestInstance(textInputs[2], '.coderabbit.yaml, .coderabbit.local.yaml');
        });

        findStartButton(screen);
        await screen.pressByTestIdAsync('execution-run-new-start-button');

        expect(startRunSpy).toHaveBeenCalledWith(
            'session-1',
            expect.objectContaining({
                intent: 'review',
                backendId: 'coderabbit',
                instructions: 'review everything deeply',
                changeType: 'all',
                base: { kind: 'branch', baseBranch: 'main' },
                engines: {
                    coderabbit: {
                        configFiles: ['.coderabbit.yaml', '.coderabbit.local.yaml'],
                    },
                },
            }),
        );
    });

    it('requires an explicit review engine selection before starting a review run', async () => {
        startRunSpy.mockClear();
        routerPushSpy.mockClear();
        actionExecutorExecuteResultMock = {
            ok: true,
            result: { results: [{ ok: true }] },
        };
        enabledAgentIdsMock = ['claude', 'codex'];
        localSearchParamsMock = { id: 'session-1', intent: 'review' };

        const screen = await renderNewRunScreen();

        const reviewPermissionOverride = screen.findAllByProps({ accessibilityLabel: 'Select permissionMode yolo' });
        expect(reviewPermissionOverride).toHaveLength(0);

        const input = findInstructionsInput(screen);
        expect(input.props.testID).toBe('execution-run-new-instructions-input');
        await act(async () => {
            screen.changeTextByTestId('execution-run-new-instructions-input', 'please review this');
        });

        const startButton = findStartButton(screen);
        expect(startButton.props.disabled).toBe(true);

        const selectClaude = screen.findByProps({ accessibilityLabel: 'Toggle backend claude' });
        expect(selectClaude).toBeDefined();

        await pressTestInstanceAsync(selectClaude, 'backend claude');

        const enabledStartButton = findStartButton(screen);
        expect(enabledStartButton.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('execution-run-new-start-button');

        expect(startRunSpy).toHaveBeenCalledWith(
            'session-1',
            expect.objectContaining({
                intent: 'review',
                backendId: 'claude',
                instructions: 'please review this',
                permissionMode: 'read-only',
                changeType: 'uncommitted',
            }),
        );
    });

    it('disables start and shows a field-aware validation hint when review instructions are empty', async () => {
        localSearchParamsMock = { id: 'session-1', intent: 'review' };

        const screen = await renderNewRunScreen();

        const selectClaude = screen.findByProps({ accessibilityLabel: 'Toggle backend claude' });
        expect(selectClaude).toBeDefined();
        await pressTestInstanceAsync(selectClaude, 'backend claude');

        const startButton = findStartButton(screen);
        expect(startButton.props.disabled).toBe(true);

        expect(screen.getTextContent()).toContain('Instructions is required.');
        expect(startRunSpy).not.toHaveBeenCalled();
    });

    it('shows an inline error when the execution run start fanout returns a failed result', async () => {
        startRunSpy.mockClear();
        routerPushSpy.mockClear();
        actionExecutorExecuteResultMock = {
            ok: true,
            result: {
                results: [{ ok: false, error: 'backend_unavailable' }],
            },
        };
        enabledAgentIdsMock = ['claude', 'codex'];
        localSearchParamsMock = { id: 'session-1', intent: 'review' };

        const screen = await renderNewRunScreen();

        const input = findInstructionsInput(screen);
        await act(async () => {
            screen.changeTextByTestId('execution-run-new-instructions-input', 'please review this');
        });

        const selectClaude = screen.findByProps({ accessibilityLabel: 'Toggle backend claude' });
        expect(selectClaude).toBeDefined();
        await pressTestInstanceAsync(selectClaude, 'backend claude');

        findStartButton(screen);
        await screen.pressByTestIdAsync('execution-run-new-start-button');

        expect(screen.getTextContent()).toContain('backend_unavailable');
        expect(routerPushSpy).not.toHaveBeenCalled();
    });

    it('surfaces CodeRabbit as a backend option when the machine capability reports it available', async () => {
        sessionMock = { id: 'session-1', metadata: { agent: 'claude', permissionMode: 'default', machineId: 'machine-1' } };
        enabledAgentIdsMock = ['claude', 'codex'];
        localSearchParamsMock = { id: 'session-1', intent: 'review' };
        machineCapabilitiesStateMock = {
            status: 'loaded',
            snapshot: {
                response: {
                    protocolVersion: 1,
                    results: {
                        'tool.executionRuns': {
                            ok: true,
                            data: {
                                available: true,
                                intents: ['review', 'plan', 'delegate', 'voice_agent'],
                                backends: {
                                    claude: { available: true, intents: ['review', 'plan', 'delegate', 'voice_agent'] },
                                    coderabbit: { available: true, intents: ['review'] },
                                },
                            },
                        },
                    },
                },
            },
        };
        executionRunsBackendsMock = {
            claude: { available: true, intents: ['review', 'plan', 'delegate', 'voice_agent'] },
            coderabbit: { available: true, intents: ['review'] },
        };

        const screen = await renderNewRunScreen();

        const toggleCodeRabbit = screen.findByProps({ accessibilityLabel: 'Toggle backend coderabbit' });
        expect(toggleCodeRabbit).toBeDefined();
    });

    it('allows selecting a different intent before starting', async () => {
        startRunSpy.mockClear();
        enabledAgentIdsMock = ['claude', 'codex'];
        localSearchParamsMock = { id: 'session-1', intent: 'review' };

        const screen = await renderNewRunScreen();
        await screen.pressByTestIdAsync('execution-run-launcher-intent:delegate');

        const input = findInstructionsInput(screen);
        await act(async () => {
            screen.changeTextByTestId('execution-run-new-instructions-input', 'do the task');
        });

        findStartButton(screen);
        await screen.pressByTestIdAsync('execution-run-new-start-button');

        expect(startRunSpy).toHaveBeenCalledWith(
            'session-1',
            expect.objectContaining({
                intent: 'delegate',
                backendId: 'claude',
                instructions: 'do the task',
                permissionMode: 'safe-yolo',
            }),
        );
    });

    it('allows overriding the permission mode before starting a delegate run', async () => {
        startRunSpy.mockClear();
        enabledAgentIdsMock = ['claude', 'codex'];
        localSearchParamsMock = { id: 'session-1', intent: 'delegate' };

        const screen = await renderNewRunScreen();

        const selectYolo = screen.findByProps({ accessibilityLabel: 'Select permissionMode yolo' });
        expect(selectYolo).toBeDefined();

        await pressTestInstanceAsync(selectYolo, 'permission mode yolo');

        const input = findInstructionsInput(screen);
        await act(async () => {
            screen.changeTextByTestId('execution-run-new-instructions-input', 'review with default permissions');
        });

        const selectClaude = screen.findByProps({ accessibilityLabel: 'Toggle backend claude' });
        expect(selectClaude).toBeDefined();
        await pressTestInstanceAsync(selectClaude, 'backend claude');

        const startButton = findStartButton(screen);
        expect(startButton.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('execution-run-new-start-button');

        expect(startRunSpy).toHaveBeenCalledWith(
            'session-1',
            expect.objectContaining({
                permissionMode: 'yolo',
            }),
        );
    });

    it('auto-selects a live execution-run backend even before enabled agents hydrate', async () => {
        enabledAgentIdsMock = [];
        localSearchParamsMock = { id: 'session-1', intent: 'delegate' };

        const screen = await renderNewRunScreen();
        const input = findInstructionsInput(screen);
        await act(async () => {
            screen.changeTextByTestId('execution-run-new-instructions-input', 'do the thing');
        });

        const startButton = findStartButton(screen);
        expect(startButton.props.disabled).toBe(false);
    });

    it('treats non-review backend selection as single-select (last choice wins)', async () => {
        startRunSpy.mockClear();
        enabledAgentIdsMock = ['claude', 'codex'];
        sessionMock = { id: 'session-1', metadata: { agent: 'codex', permissionMode: 'default' } };
        localSearchParamsMock = { id: 'session-1', intent: 'delegate' };

        const screen = await renderNewRunScreen();
        const toggleClaude = screen.findByProps({ accessibilityLabel: 'Toggle backend claude' });
        expect(toggleClaude).toBeDefined();

        await pressTestInstanceAsync(toggleClaude, 'backend claude');

        const input = findInstructionsInput(screen);
        await act(async () => {
            screen.changeTextByTestId('execution-run-new-instructions-input', 'do the task');
        });

        findStartButton(screen);
        await screen.pressByTestIdAsync('execution-run-new-start-button');

        expect(startRunSpy).toHaveBeenCalledWith(
            'session-1',
            expect.objectContaining({
                intent: 'delegate',
                backendId: 'claude',
            }),
        );
    });

    it('disables backends that are not execution-run capable for non-review intents', async () => {
        enabledAgentIdsMock = ['claude', 'pi'];
        sessionMock = { id: 'session-1', metadata: { agent: 'claude', permissionMode: 'default', machineId: 'machine-1' } };
        localSearchParamsMock = { id: 'session-1', intent: 'delegate' };
        executionRunsBackendsMock = {
            claude: { available: true, intents: ['review', 'plan', 'delegate', 'voice_agent'] },
        };

        const screen = await renderNewRunScreen();
        const togglePi = screen.findByProps({ accessibilityLabel: 'Toggle backend pi' });
        expect(togglePi).toBeDefined();
        expect(togglePi!.props.disabled).toBe(true);
    });

    it('surfaces configured ACP backends as first-class delegate backends and submits their backend target key', async () => {
        startRunSpy.mockClear();
        enabledAgentIdsMock = ['claude', 'customAcp'];
        sessionMock = { id: 'session-1', metadata: { agent: 'claude', permissionMode: 'default', machineId: 'machine-1' } };
        localSearchParamsMock = { id: 'session-1', intent: 'delegate' };
        executionRunsBackendsMock = {
            claude: { available: true, intents: ['review', 'plan', 'delegate', 'voice_agent'] },
            customAcp: { available: true, intents: ['plan', 'delegate'] },
        };
        settingsMock = {
            ...settingsMock,
            acpCatalogSettingsV1: {
                v: 2,
                backends: [
                    {
                        id: 'review-bot',
                        name: 'review-bot',
                        title: 'Review Bot',
                        command: 'acp',
                        args: [],
                        env: {},
                        transportProfile: 'generic',
                        capabilities: {
                            supportsLoadSession: false,
                            supportsModes: 'unknown',
                            supportsModels: 'unknown',
                            supportsConfigOptions: 'unknown',
                            promptImageSupport: 'unknown',
                        },
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
            },
        };

        const screen = await renderNewRunScreen();
        const togglePreset = screen.findByProps({ accessibilityLabel: 'Toggle backend Review Bot' });
        expect(togglePreset).toBeDefined();

        await pressTestInstanceAsync(togglePreset, 'backend Review Bot');

        const input = findInstructionsInput(screen);
        await act(async () => {
            screen.changeTextByTestId('execution-run-new-instructions-input', 'delegate to the custom ACP backend');
        });

        findStartButton(screen);
        await screen.pressByTestIdAsync('execution-run-new-start-button');

        expect(startRunSpy).toHaveBeenCalledWith(
            'session-1',
            expect.objectContaining({
                intent: 'delegate',
                backendTargetKeys: ['acpBackend:review-bot'],
                backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
                backendId: 'review-bot',
            }),
        );
    });

    it('auto-selects an execution-run capable backend when the session agent is unsupported', async () => {
        startRunSpy.mockClear();
        enabledAgentIdsMock = ['pi', 'claude'];
        sessionMock = { id: 'session-1', metadata: { agent: 'pi', permissionMode: 'default', machineId: 'machine-1' } };
        localSearchParamsMock = { id: 'session-1', intent: 'delegate' };
        executionRunsBackendsMock = {
            claude: { available: true, intents: ['review', 'plan', 'delegate', 'voice_agent'] },
        };

        const screen = await renderNewRunScreen();
        const input = findInstructionsInput(screen);
        await act(async () => {
            screen.changeTextByTestId('execution-run-new-instructions-input', 'do the task');
        });

        const startButton = findStartButton(screen);
        expect(startButton.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('execution-run-new-start-button');

        expect(startRunSpy).toHaveBeenCalledWith(
            'session-1',
            expect.objectContaining({
                intent: 'delegate',
                backendId: 'claude',
            }),
        );
    });
});
