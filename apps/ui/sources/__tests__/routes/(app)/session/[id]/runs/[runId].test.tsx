import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type ExecutionRunGetArgs = [string, Record<string, unknown>];
type ExecutionRunSendArgs = [string, Record<string, unknown>];
type ExecutionRunStopArgs = [string, Record<string, unknown>];

type MachineExecutionRunsListArgs = [string, Record<string, unknown>?];

const getRunSpy = vi.fn<(...args: ExecutionRunGetArgs) => Promise<any>>(async (_sessionId: string, _params: Record<string, unknown>) => ({
    run: {
        runId: 'run_1',
        callId: 'call_1',
        sidechainId: 'side_1',
        intent: 'review',
        backendId: 'claude',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
        status: 'succeeded',
        startedAtMs: 1,
        finishedAtMs: 2,
    },
}));
const sendRunSpy = vi.fn<(...args: ExecutionRunSendArgs) => Promise<any>>(async (_sessionId: string, _params: Record<string, unknown>) => ({ ok: true }));
const stopRunSpy = vi.fn<(...args: ExecutionRunStopArgs) => Promise<any>>(async (_sessionId: string, _params: Record<string, unknown>) => ({ ok: true }));
const machineExecutionRunsListSpy = vi.fn(async (_machineId: string, _opts?: Record<string, unknown>) => ({
    ok: true,
    runs: [
        {
            happyHomeDir: '/tmp/happy',
            pid: 123,
            happySessionId: 'session-1',
            runId: 'run_1',
            callId: 'call_1',
            sidechainId: 'side_1',
            intent: 'review',
            backendId: 'claude',
            runClass: 'bounded',
            ioMode: 'request_response',
            retentionPolicy: 'ephemeral',
            status: 'succeeded',
            startedAtMs: 1,
            updatedAtMs: 2,
            finishedAtMs: 2,
            process: { pid: 123, cpu: 12.5, memory: 1048576 },
        },
    ],
}));
const stackScreenSpy = vi.fn((_props: any) => null);
const routerPushSpy = vi.fn();
const routerBackSpy = vi.fn();
let localSearchParamsMock: Record<string, unknown> = { id: 'session-1', runId: 'run_1' };
let hydrateReady = true;
let SessionRunDetailsScreen: typeof import('@/app/(app)/session/[id]/runs/[runId]').default;

vi.mock('react-native', () => ({
    Platform: {
        OS: 'web',
        select: (values: any) => values?.web ?? values?.default,
    },
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    ActivityIndicator: 'ActivityIndicator',
    TextInput: 'TextInput',
    AppState: {
        currentState: 'active',
        addEventListener: () => ({ remove: () => {} }),
    },
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                surface: '#111',
                surfaceHigh: '#222',
                divider: '#333',
                text: '#eee',
                textSecondary: '#aaa',
                textLink: '#06f',
                textDestructive: '#f00',
                groupped: { sectionTitle: '#888' },
                shadow: { color: '#000' },
            },
        },
    }),
    StyleSheet: {
        create: (input: any) => {
            const theme = {
                colors: {
                    surface: '#111',
                    surfaceHigh: '#222',
                    divider: '#333',
                    text: '#eee',
                    textSecondary: '#aaa',
                    surfaceHighest: '#222',
                    link: '#06f',
                    textLink: '#06f',
                    textDestructive: '#f00',
                    groupped: { sectionTitle: '#888' },
                    shadow: { color: '#000' },
                },
            };
            return typeof input === 'function' ? input(theme, {}) : input;
        },
    },
}));

vi.mock('expo-router', () => ({
    useLocalSearchParams: () => localSearchParamsMock,
    useRouter: () => ({ push: routerPushSpy, back: routerBackSpy }),
    Stack: { Screen: (props: any) => stackScreenSpy(props) },
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: () => hydrateReady,
}));

vi.mock('@/components/sessions/shell/SessionInvalidLinkFallback', () => ({
    SessionInvalidLinkFallback: () => React.createElement('SessionInvalidLinkFallback', { testID: 'session-invalid-link' }),
}));

vi.mock('@/text', () => ({
    t: (key: string, vars?: any) => {
        if (key === 'runs.detail.pid') return `pid ${vars?.pid ?? ''}`.trim();
        if (key === 'runs.detail.cpu') return `cpu ${vars?.percent ?? ''}`.trim();
        if (key === 'runs.detail.memory') return `memory ${vars?.megabytes ?? ''}`.trim();
        return key;
    },
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        sendMessage: vi.fn(async () => undefined),
        submitMessage: vi.fn(),
    },
}));

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunGet: (...args: ExecutionRunGetArgs) => getRunSpy(...args),
    sessionExecutionRunSend: (...args: ExecutionRunSendArgs) => sendRunSpy(...args),
    sessionExecutionRunStop: (...args: ExecutionRunStopArgs) => stopRunSpy(...args),
}));

vi.mock('@/sync/ops/machineExecutionRuns', () => ({
    machineExecutionRunsList: (...args: MachineExecutionRunsListArgs) => machineExecutionRunsListSpy(...args),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/state/storage')>();
    return {
        ...actual,
        storage: {
            getState: () => ({
                sessions: {
                    'session-1': { id: 'session-1', updatedAt: 0, metadata: { machineId: 'machine-1' } },
                },
                sessionMessages: {
                    'session-1': {
                        reducerState: {
                            toolIdToMessageId: new Map<string, string>([['side_1', 'message-side-1']]),
                        },
                    },
                },
            }),
        },
        useSession: () => ({ id: 'session-1', metadata: { flavor: 'codex' }, accessLevel: 'edit', canApprovePermissions: true }),
        useSessionMessages: () => ({ messages: [], isLoaded: true }),
        useResolvedSessionMessageRouteId: () => null,
        useMessage: () => null,
    };
});
vi.mock('@/components/ui/layout/layout', () => ({ layout: { maxWidth: 999 } }));
vi.mock('@/components/sessions/transcript/details/SessionMessageDetailsView', () => ({
    SessionMessageDetailsView: () => React.createElement('SessionMessageDetailsView'),
}));
vi.mock('@/components/sessions/runs/details/SessionExecutionRunInfoCard', () => ({
    SessionExecutionRunInfoCard: (props: any) => React.createElement(
        'View',
        null,
        React.createElement('Text', null, props.run?.runId),
        React.createElement('Text', null, props.daemonProcessLine ?? ''),
    ),
}));

describe('Session Run Details Screen', () => {
    beforeAll(async () => {
        ({ default: SessionRunDetailsScreen } = await import('@/app/(app)/session/[id]/runs/[runId]'));
    }, 60_000);

    beforeEach(() => {
        getRunSpy.mockClear();
        sendRunSpy.mockClear();
        stopRunSpy.mockClear();
        machineExecutionRunsListSpy.mockClear();
        stackScreenSpy.mockClear();
        routerPushSpy.mockReset();
        routerBackSpy.mockReset();
        localSearchParamsMock = { id: 'session-1', runId: 'run_1' };
        hydrateReady = true;
    });

    it('configures the run details header and constrains the content width', async () => {
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(SessionRunDetailsScreen));
            await Promise.resolve();
        });

        expect(stackScreenSpy).toHaveBeenCalled();
        const stackOptions = stackScreenSpy.mock.calls.at(-1)?.[0]?.options;
        expect(stackOptions?.headerTitle).toBe('runs.runLabel');
        expect(typeof stackOptions?.headerLeft).toBe('function');
        expect(typeof stackOptions?.headerRight).toBe('function');

        let headerLeftTree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            headerLeftTree = renderer.create(React.createElement(stackOptions.headerLeft));
        });
        const backButton = headerLeftTree!.root.findByType('Pressable');
        await act(async () => {
            backButton.props.onPress();
        });
        expect(routerBackSpy).toHaveBeenCalledTimes(1);

        let headerRightTree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            headerRightTree = renderer.create(React.createElement(stackOptions.headerRight));
        });
        const refreshButton = headerRightTree!.root.findAllByType('Pressable')
            .find((node: any) => node.props.accessibilityLabel === 'runs.runDetails.a11y.refreshRun');
        expect(refreshButton).toBeDefined();

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

    it('renders invalid-link fallback when the run id param is missing', async () => {
        localSearchParamsMock = { id: 'session-1' };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(SessionRunDetailsScreen));
            await Promise.resolve();
        });

        expect(tree!.root.findAllByType('ActivityIndicator')).toHaveLength(0);
        expect(tree!.root.findByProps({ testID: 'session-invalid-link' })).toBeTruthy();
    });

    it('still loads run details while hydration is pending so deleted-session recovery is not blocked', async () => {
        hydrateReady = false;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(SessionRunDetailsScreen));
            await Promise.resolve();
        });

        expect(tree).not.toBeNull();
        expect(getRunSpy).toHaveBeenCalledWith('session-1', expect.objectContaining({ runId: 'run_1' }));
    });

    it('loads run details via session execution run get', async () => {
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(SessionRunDetailsScreen));
            await Promise.resolve();
        });

        expect(getRunSpy).toHaveBeenCalledWith('session-1', expect.objectContaining({ runId: 'run_1' }));
        const textNodes = tree!.root.findAllByType('Text');
        expect(textNodes.some((n: any) => String(n.props.children).includes('run_1'))).toBe(true);
    });

    it('retries run details load once when session encryption is not yet available', async () => {
        getRunSpy.mockClear();
        getRunSpy.mockResolvedValueOnce({
            ok: false,
            error: 'Session encryption not found for session-1',
            errorCode: 'session_encryption_not_found',
        });
        getRunSpy.mockResolvedValueOnce({
            run: {
                runId: 'run_1',
                callId: 'call_1',
                sidechainId: 'side_1',
                intent: 'review',
                backendId: 'claude',
                permissionMode: 'read_only',
                retentionPolicy: 'ephemeral',
                runClass: 'bounded',
                ioMode: 'request_response',
                status: 'succeeded',
                startedAtMs: 1,
                finishedAtMs: 2,
            },
        });

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(SessionRunDetailsScreen));
            await Promise.resolve();
        });

        expect(getRunSpy).toHaveBeenCalledTimes(2);
        const textNodes = tree!.root.findAllByType('Text');
        expect(textNodes.some((n: any) => String(n.props.children).includes('run_1'))).toBe(true);
    });

    it('renders daemon process stats when machine execution runs list includes the run', async () => {
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(SessionRunDetailsScreen));
            await Promise.resolve();
        });

        expect(machineExecutionRunsListSpy).toHaveBeenCalledWith('machine-1', expect.anything());
        const textNodes = tree!.root.findAllByType('Text');
        const joined = textNodes.map((n: any) => String(n.props.children)).join('\n');
        expect(joined).toContain('pid 123');
        expect(joined).toContain('cpu 12.5');
    });

    it('renders structured meta using the structured message registry when available', async () => {
        getRunSpy.mockResolvedValueOnce({
            run: {
                runId: 'run_1',
                callId: 'call_1',
                sidechainId: 'side_1',
                intent: 'delegate',
                backendId: 'claude',
                status: 'succeeded',
                startedAtMs: 1,
                finishedAtMs: 2,
            },
            structuredMeta: {
                kind: 'delegate_output.v1',
                payload: {
                    runRef: { runId: 'run_1', callId: 'call_1', backendId: 'claude' },
                    summary: 'Delegation summary.',
                    deliverables: [{ id: 'd1', title: 'Deliverable 1' }],
                    generatedAtMs: 2,
                },
            },
        });

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(SessionRunDetailsScreen));
            await Promise.resolve();
        });

        const textNodes = tree!.root.findAllByType('Text');
        // The structured renderer should render the card, not the raw JSON "structured" debug block.
        expect(textNodes.some((n: any) => String(n.props.children).includes('structured'))).toBe(false);
    });

    it('opens the owning tool details when the run sidechain maps to a transcript tool message', async () => {
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(SessionRunDetailsScreen));
            await Promise.resolve();
        });

        const openDetailsButtons = tree!.root.findAll((node) => {
            if ((node as any).type !== 'Pressable') return false;
            return String((node as any).props?.accessibilityLabel ?? '') === 'toolView.open';
        });
        expect(openDetailsButtons).toHaveLength(1);

        await act(async () => {
            await openDetailsButtons[0]!.props.onPress();
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/session/session-1/message/tool%3Aside_1');
    });

    it('can stop and send to running bounded backend runs', async () => {
        getRunSpy.mockResolvedValueOnce({
            run: {
                runId: 'run_1',
                callId: 'call_1',
                sidechainId: 'side_1',
                intent: 'review',
                backendId: 'claude',
                permissionMode: 'read_write',
                retentionPolicy: 'resumable',
                runClass: 'bounded',
                ioMode: 'request_response',
                status: 'running',
                startedAtMs: 1,
            },
        });

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(SessionRunDetailsScreen));
            await Promise.resolve();
        });

        const inputs = tree!.root.findAllByType('TextInput');
        expect(inputs).toHaveLength(1);
        await act(async () => {
            inputs[0]!.props.onChangeText('hello');
        });

        const sendButtons = tree!.root.findAll((node) => {
            if ((node as any).type !== 'Pressable') return false;
            return String((node as any).props?.accessibilityLabel ?? '') === 'runs.send.a11y.sendToRun';
        });
        expect(sendButtons).toHaveLength(1);
        await act(async () => {
            await sendButtons[0]!.props.onPress();
        });
        expect(sendRunSpy).toHaveBeenCalledWith('session-1', expect.objectContaining({ runId: 'run_1', message: 'hello' }));

        const stopButtons = tree!.root.findAll((node) => {
            if ((node as any).type !== 'Pressable') return false;
            return String((node as any).props?.accessibilityLabel ?? '') === 'runs.stop.stopRunA11y';
        });
        expect(stopButtons).toHaveLength(1);
        await act(async () => {
            await stopButtons[0]!.props.onPress();
        });
        expect(stopRunSpy).toHaveBeenCalledWith('session-1', expect.objectContaining({ runId: 'run_1' }));
    });

    it('hides the send composer for running voice-agent runs', async () => {
        getRunSpy.mockResolvedValueOnce({
            run: {
                runId: 'run_1',
                callId: 'call_1',
                sidechainId: 'side_1',
                intent: 'voice_agent',
                backendId: 'codex',
                permissionMode: 'read_write',
                retentionPolicy: 'resumable',
                runClass: 'long_lived',
                ioMode: 'streaming',
                status: 'running',
                startedAtMs: 1,
            },
        });

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(SessionRunDetailsScreen));
            await Promise.resolve();
        });

        expect(tree!.root.findAllByType('TextInput')).toHaveLength(0);
        const sendButtons = tree!.root.findAll((node) => {
            if ((node as any).type !== 'Pressable') return false;
            return String((node as any).props?.accessibilityLabel ?? '') === 'runs.send.a11y.sendToRun';
        });
        expect(sendButtons).toHaveLength(0);
        expect(sendRunSpy).not.toHaveBeenCalled();
    });
});
