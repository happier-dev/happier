import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let sessionMock: any = { id: 'session-1', metadata: { agent: 'claude', permissionMode: 'default' } };
let machineCapabilitiesStateMock: any = { status: 'idle' };
let hydrateReady = true;
let enabledAgentIdsMock: string[] = ['claude', 'codex'];
let localSearchParamsMock: any = { id: 'session-1', intent: 'review' };
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
const stackScreenSpy = vi.fn((_props: any) => null);
let NewRunScreen: typeof import('@/app/(app)/session/[id]/runs/new').default;

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    ActivityIndicator: 'ActivityIndicator',
    TextInput: 'TextInput',
    Platform: { OS: 'web', select: (spec: any) => spec?.web ?? spec?.default },
    AppState: { currentState: 'active', addEventListener: vi.fn(), removeEventListener: vi.fn() },
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                surface: '#111',
                text: '#eee',
                textSecondary: '#aaa',
                divider: '#333',
            },
        },
    }),
    StyleSheet: { create: (v: any) => v, absoluteFillObject: {} },
}));

vi.mock('expo-router', () => ({
    useLocalSearchParams: () => localSearchParamsMock,
    useRouter: () => ({ push: routerPushSpy, back: vi.fn() }),
    Stack: { Screen: (props: any) => stackScreenSpy(props) },
}));

vi.mock('@/text', () => ({
    t: (key: string, params?: any) => {
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
        if (key === 'common.unavailable') return 'Not available';
        if (key === 'executionRuns.newRun.a11y.startRun') return 'Start run';
        if (key === 'executionRuns.newRun.a11y.cancel') return 'Cancel';
        if (key === 'executionRuns.newRun.a11y.selectIntent') return `Select intent ${String(params?.intent ?? '')}`;
        if (key === 'executionRuns.newRun.a11y.selectPermissionMode') return `Select permissionMode ${String(params?.mode ?? '')}`;
        if (key === 'executionRuns.newRun.a11y.toggleBackend') return `Toggle backend ${String(params?.backendId ?? '')}`;
        return key;
    },
}));
vi.mock('@/components/ui/layout/layout', () => ({ layout: { maxWidth: 999 } }));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: () => hydrateReady,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSession: () => sessionMock,
    useSettings: () => settingsMock,
    storage: { getState: () => ({ sessionListViewDataByServerId: {} }) },
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => enabledAgentIdsMock,
}));
vi.mock('@/hooks/server/useExecutionRunsBackendsForSession', () => ({
    useExecutionRunsBackendsForSession: () => executionRunsBackendsMock,
}));
vi.mock('@/hooks/server/useSessionExecutionRunsSupported', () => ({
    useSessionExecutionRunsSupported: () => true,
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
}));

vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({
    useMachineCapabilitiesCache: () => ({ state: machineCapabilitiesStateMock, refresh: vi.fn() }),
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
        startRunSpy.mockClear();
        routerPushSpy.mockClear();
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
        sessionMachineReachabilityMock = {
            machineReachable: true,
            machineOnline: true,
            machineRpcTargetAvailable: true,
        };
        resumeCapabilityOptionsMock = {};
        resumeSessionSpy.mockClear();
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
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(NewRunScreen));
        });
        expect(tree).not.toBeNull();
        const nodes = tree!.root.findAllByType('ActivityIndicator');
        expect(nodes.length).toBeGreaterThan(0);
        hydrateReady = true;
    });

    it('does not crash when hydration flips from pending to ready', async () => {
        hydrateReady = false;
        localSearchParamsMock = { id: 'session-1', intent: 'review' };
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(NewRunScreen));
        });

        hydrateReady = true;
        await act(async () => {
            tree!.update(React.createElement(NewRunScreen));
        });
    });

    it('shows unavailable state when the session has no live execution-run backends', async () => {
        executionRunsBackendsMock = null;
        enabledAgentIdsMock = ['claude', 'codex'];
        localSearchParamsMock = { id: 'session-1', intent: 'delegate' };
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(NewRunScreen));
        });

        const buttons = tree!.root.findAllByType('Pressable');
        const startButton = buttons.find((b: any) => b.props.accessibilityLabel === 'Start run');
        expect(startButton).toBeUndefined();
        expect(tree!.root.findAllByType('TextInput')).toHaveLength(0);

        executionRunsBackendsMock = {
            claude: { available: true, intents: ['review', 'plan', 'delegate', 'voice_agent'] },
            codex: { available: true, intents: ['review', 'plan', 'delegate', 'voice_agent'] },
            coderabbit: { available: true, intents: ['review'] },
        };
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
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(NewRunScreen));
        });

        expect(tree!.root.findAllByType('TextInput')).toHaveLength(0);
        const buttons = tree!.root.findAllByType('Pressable');
        const startButton = buttons.find((b: any) => b.props.accessibilityLabel === 'Start run');
        expect(startButton).toBeUndefined();
    });

    it('resumes an inactive resumable session before starting a Happier subagent', async () => {
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
        localSearchParamsMock = { id: 'session-1', intent: 'review' };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(NewRunScreen));
        });

        const input = tree!.root.findByType('TextInput');
        await act(async () => {
            input.props.onChangeText?.('please review this');
        });

        const startButton = tree!.root.findAllByType('Pressable').find((b: any) => b.props.accessibilityLabel === 'Start run');
        expect(startButton).toBeDefined();

        await act(async () => {
            await startButton!.props.onPress?.();
        });

        expect(resumeSessionSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            serverId: 'server-active',
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

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(NewRunScreen));
        });

        expect(tree!.root.findAllByType('TextInput')).toHaveLength(0);
        const buttons = tree!.root.findAllByType('Pressable');
        const startButton = buttons.find((b: any) => b.props.accessibilityLabel === 'Start run');
        expect(startButton).toBeUndefined();
    });

    it('configures the header title and constrains form content width', async () => {
        stackScreenSpy.mockClear();
        localSearchParamsMock = { id: 'session-1', intent: 'review' };
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(NewRunScreen));
        });

        const stackOptions = stackScreenSpy.mock.calls.at(-1)?.[0]?.options;
        expect(stackOptions?.headerTitle).toBe('Start run');

        const views = tree!.root.findAllByType('View');
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

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(NewRunScreen));
        });

        const textNodes = tree!.root.findAllByType('Text');
        expect(textNodes.some((n: any) => String(n.props.children).includes('Guidance preview'))).toBe(true);
        expect(textNodes.some((n: any) => String(n.props.children).includes('Prefer Claude for UI changes'))).toBe(true);
    });

    it('starts a review run for the default backend', async () => {
        startRunSpy.mockClear();
        routerPushSpy.mockClear();
        actionExecutorExecuteResultMock = {
            ok: true,
            result: { results: [{ ok: true }] },
        };
        enabledAgentIdsMock = ['claude', 'codex'];
        localSearchParamsMock = { id: 'session-1', intent: 'review' };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(NewRunScreen));
        });

        const input = tree!.root.findByType('TextInput');
        await act(async () => {
            input.props.onChangeText?.('please review this');
        });

        const buttons = tree!.root.findAllByType('Pressable');
        const startButton = buttons.find((b: any) => b.props.accessibilityLabel === 'Start run');
        expect(startButton).toBeDefined();

        await act(async () => {
            await startButton!.props.onPress?.();
        });

        expect(startRunSpy).toHaveBeenCalledWith(
            'session-1',
            expect.objectContaining({
                intent: 'review',
                backendId: 'claude',
                instructions: 'please review this',
                permissionMode: 'read-only',
                changeType: 'committed',
            }),
        );
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

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(NewRunScreen));
        });

        const input = tree!.root.findByType('TextInput');
        await act(async () => {
            input.props.onChangeText?.('please review this');
        });

        const startButton = tree!.root.findAllByType('Pressable').find((b: any) => b.props.accessibilityLabel === 'Start run');
        expect(startButton).toBeDefined();

        await act(async () => {
            await startButton!.props.onPress?.();
        });

        const texts = tree!.root.findAllByType('Text');
        expect(texts.some((node: any) => node.props?.children === 'backend_unavailable')).toBe(true);
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

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(NewRunScreen));
        });

        const buttons = tree!.root.findAllByType('Pressable');
        const toggleCodeRabbit = buttons.find((b: any) => b.props.accessibilityLabel === 'Toggle backend coderabbit');
        expect(toggleCodeRabbit).toBeDefined();
    });

    it('allows selecting a different intent before starting', async () => {
        startRunSpy.mockClear();
        enabledAgentIdsMock = ['claude', 'codex'];
        localSearchParamsMock = { id: 'session-1', intent: 'review' };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(NewRunScreen));
        });

        const buttons = tree!.root.findAllByType('Pressable');
        const selectDelegate = buttons.find((b: any) => b.props.accessibilityLabel === 'Select intent delegate');
        expect(selectDelegate).toBeDefined();

        await act(async () => {
            selectDelegate!.props.onPress?.();
        });

        const input = tree!.root.findByType('TextInput');
        await act(async () => {
            input.props.onChangeText?.('do the task');
        });

        const startButton = tree!.root.findAllByType('Pressable').find((b: any) => b.props.accessibilityLabel === 'Start run');
        expect(startButton).toBeDefined();

        await act(async () => {
            await startButton!.props.onPress?.();
        });

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

    it('allows overriding the permission mode before starting', async () => {
        startRunSpy.mockClear();
        enabledAgentIdsMock = ['claude', 'codex'];
        localSearchParamsMock = { id: 'session-1', intent: 'review' };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(NewRunScreen));
        });

        const buttons = tree!.root.findAllByType('Pressable');
        const selectYolo = buttons.find((b: any) => b.props.accessibilityLabel === 'Select permissionMode yolo');
        expect(selectYolo).toBeDefined();

        await act(async () => {
            selectYolo!.props.onPress?.();
        });

        const input = tree!.root.findByType('TextInput');
        await act(async () => {
            input.props.onChangeText?.('review with default permissions');
        });

        const startButton = tree!.root.findAllByType('Pressable').find((b: any) => b.props.accessibilityLabel === 'Start run');
        await act(async () => {
            await startButton!.props.onPress?.();
        });

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

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(NewRunScreen));
        });

        const input = tree!.root.findByType('TextInput');
        await act(async () => {
            input.props.onChangeText?.('do the thing');
        });

        const startButton = tree!.root.findAllByType('Pressable').find((b: any) => b.props.accessibilityLabel === 'Start run');
        expect(startButton).toBeDefined();
        expect(startButton!.props.disabled).toBe(false);
    });

    it('treats non-review backend selection as single-select (last choice wins)', async () => {
        startRunSpy.mockClear();
        enabledAgentIdsMock = ['claude', 'codex'];
        sessionMock = { id: 'session-1', metadata: { agent: 'codex', permissionMode: 'default' } };
        localSearchParamsMock = { id: 'session-1', intent: 'delegate' };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(NewRunScreen));
        });

        const buttons = tree!.root.findAllByType('Pressable');
        const toggleClaude = buttons.find((b: any) => b.props.accessibilityLabel === 'Toggle backend claude');
        expect(toggleClaude).toBeDefined();

        await act(async () => {
            toggleClaude!.props.onPress?.();
        });

        const input = tree!.root.findByType('TextInput');
        await act(async () => {
            input.props.onChangeText?.('do the task');
        });

        const startButton = tree!.root.findAllByType('Pressable').find((b: any) => b.props.accessibilityLabel === 'Start run');
        expect(startButton).toBeDefined();

        await act(async () => {
            await startButton!.props.onPress?.();
        });

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

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(NewRunScreen));
            await Promise.resolve();
        });

        const buttons = tree!.root.findAllByType('Pressable');
        const togglePi = buttons.find((b: any) => b.props.accessibilityLabel === 'Toggle backend pi');
        expect(togglePi).toBeDefined();
        expect(togglePi!.props.disabled).toBe(true);
        expect(togglePi!.props.onPress).toBeUndefined();
        const disabledStyle = togglePi!.props.style({ pressed: false });
        expect(Array.isArray(disabledStyle) ? disabledStyle : [disabledStyle]).toContainEqual(expect.objectContaining({ opacity: 0.4 }));
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

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(NewRunScreen));
            await Promise.resolve();
        });

        const buttons = tree!.root.findAllByType('Pressable');
        const togglePreset = buttons.find((b: any) => b.props.accessibilityLabel === 'Toggle backend Review Bot');
        expect(togglePreset).toBeDefined();

        await act(async () => {
            togglePreset!.props.onPress?.();
        });

        const input = tree!.root.findByType('TextInput');
        await act(async () => {
            input.props.onChangeText?.('delegate to the custom ACP backend');
        });

        const startButton = tree!.root.findAllByType('Pressable').find((b: any) => b.props.accessibilityLabel === 'Start run');
        expect(startButton).toBeDefined();

        await act(async () => {
            await startButton!.props.onPress?.();
        });

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

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(NewRunScreen));
            await Promise.resolve();
        });

        const input = tree!.root.findByType('TextInput');
        await act(async () => {
            input.props.onChangeText?.('do the task');
        });

        const startButton = tree!.root.findAllByType('Pressable').find((b: any) => b.props.accessibilityLabel === 'Start run');
        expect(startButton).toBeDefined();
        expect(startButton!.props.disabled).toBe(false);

        await act(async () => {
            await startButton!.props.onPress?.();
        });

        expect(startRunSpy).toHaveBeenCalledWith(
            'session-1',
            expect.objectContaining({
                intent: 'delegate',
                backendId: 'claude',
            }),
        );
    });
});
