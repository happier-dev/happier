import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let sessionMock: any = { id: 'session-1', metadata: { agent: 'claude', permissionMode: 'default' } };
let machineCapabilitiesStateMock: any = { status: 'idle' };

const startRunSpy = vi.fn(async (_sessionId: string, _request: any) => ({
    runId: 'run_1',
    callId: 'call_1',
    sidechainId: 'call_1',
}));

const routerPushSpy = vi.fn();
const stackScreenSpy = vi.fn((_props: any) => null);

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
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
    useLocalSearchParams: () => ({ id: 'session-1', intent: 'review' }),
    useRouter: () => ({ push: routerPushSpy, back: vi.fn() }),
    Stack: { Screen: (props: any) => stackScreenSpy(props) },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));
vi.mock('@/components/ui/layout/layout', () => ({ layout: { maxWidth: 999 } }));

vi.mock('@/sync/domains/state/storage', () => ({
    useSession: () => sessionMock,
    useSettings: () => ({
        executionRunsGuidanceEnabled: false,
        executionRunsGuidanceMaxChars: 4_000,
        executionRunsGuidanceEntries: [],
    }),
    storage: { getState: () => ({ sessionListViewDataByServerId: {} }) },
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => ['claude', 'codex'],
}));
vi.mock('@/hooks/server/useExecutionRunsBackendsForSession', () => ({
    useExecutionRunsBackendsForSession: () => ({
        claude: { available: true, intents: ['review', 'plan', 'delegate', 'voice_agent'] },
        codex: { available: true, intents: ['review', 'plan', 'delegate', 'voice_agent'] },
        coderabbit: { available: true, intents: ['review'] },
    }),
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
            const intent = actionId === 'review.start' ? 'review' : actionId === 'plan.start' ? 'plan' : 'delegate';
            const backendId = intent === 'review'
                ? request?.engineIds?.[0]
                : request?.backendIds?.[0];
            await startRunSpy(request?.sessionId, {
                ...request,
                intent,
                backendId,
            });
            return {
                ok: true,
                result: { results: [{ ok: true }] },
            };
        },
    }),
}));

vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({
    useMachineCapabilitiesCache: () => ({ state: machineCapabilitiesStateMock, refresh: vi.fn() }),
}));

describe('Session New Run Screen', () => {
    it('configures the header title and constrains form content width', async () => {
        stackScreenSpy.mockClear();
        const NewRunScreen = (await import('./new')).default;

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

    it('starts a review run for the default backend', async () => {
        startRunSpy.mockClear();
        routerPushSpy.mockClear();

        const NewRunScreen = (await import('./new')).default;

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
                permissionMode: 'read_only',
                changeType: 'committed',
            }),
        );
    });

    it('surfaces CodeRabbit as a backend option when the machine capability reports it available', async () => {
        sessionMock = { id: 'session-1', metadata: { agent: 'claude', permissionMode: 'default', machineId: 'machine-1' } };
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

        const NewRunScreen = (await import('./new')).default;

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

        const NewRunScreen = (await import('./new')).default;

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
            }),
        );
    });

    it('allows overriding the permission mode before starting', async () => {
        startRunSpy.mockClear();

        const NewRunScreen = (await import('./new')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(NewRunScreen));
        });

        const buttons = tree!.root.findAllByType('Pressable');
        const selectDefault = buttons.find((b: any) => b.props.accessibilityLabel === 'Select permissionMode default');
        expect(selectDefault).toBeDefined();

        await act(async () => {
            selectDefault!.props.onPress?.();
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
                permissionMode: 'default',
            }),
        );
    });
});
