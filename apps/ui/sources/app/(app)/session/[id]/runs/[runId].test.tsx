import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

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
                    shadow: { color: '#000' },
                },
            };
            return typeof input === 'function' ? input(theme, {}) : input;
        },
    },
}));

vi.mock('expo-router', () => ({
    useLocalSearchParams: () => ({ id: 'session-1', runId: 'run_1' }),
    useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
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

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => ({
            sessions: {
                'session-1': { id: 'session-1', updatedAt: 0, metadata: { machineId: 'machine-1' } },
            },
        }),
    },
}));

describe('Session Run Details Screen', () => {
    it('loads run details via session execution run get', async () => {
        getRunSpy.mockClear();
        const Screen = (await import('./[runId]')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
            await Promise.resolve();
        });

        expect(getRunSpy).toHaveBeenCalledWith('session-1', expect.objectContaining({ runId: 'run_1' }));
        const textNodes = tree!.root.findAllByType('Text');
        expect(textNodes.some((n: any) => String(n.props.children).includes('run_1'))).toBe(true);
    });

    it('renders daemon process stats when machine execution runs list includes the run', async () => {
        getRunSpy.mockClear();
        machineExecutionRunsListSpy.mockClear();
        const Screen = (await import('./[runId]')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
            await Promise.resolve();
        });

        expect(machineExecutionRunsListSpy).toHaveBeenCalledWith('machine-1', expect.anything());
        const textNodes = tree!.root.findAllByType('Text');
        const joined = textNodes.map((n: any) => String(n.props.children)).join('\n');
        expect(joined).toContain('pid 123');
        expect(joined).toContain('cpu 12.5');
    });

    it('renders structured meta using the structured message registry when available', async () => {
        getRunSpy.mockClear();
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

        const Screen = (await import('./[runId]')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
            await Promise.resolve();
        });

        const textNodes = tree!.root.findAllByType('Text');
        // The structured renderer should render the card, not the raw JSON "structured" debug block.
        expect(textNodes.some((n: any) => String(n.props.children).includes('structured'))).toBe(false);
    });

    it('can stop and send to long-lived running runs', async () => {
        getRunSpy.mockClear();
        sendRunSpy.mockClear();
        stopRunSpy.mockClear();
        getRunSpy.mockResolvedValueOnce({
            run: {
                runId: 'run_1',
                callId: 'call_1',
                sidechainId: 'side_1',
                intent: 'voice_agent',
                backendId: 'claude',
                permissionMode: 'read_write',
                retentionPolicy: 'resumable',
                runClass: 'long_lived',
                ioMode: 'request_response',
                status: 'running',
                startedAtMs: 1,
            },
        });

        const Screen = (await import('./[runId]')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Screen));
            await Promise.resolve();
        });

        const inputs = tree!.root.findAllByType('TextInput');
        expect(inputs).toHaveLength(1);
        await act(async () => {
            inputs[0]!.props.onChangeText('hello');
        });

        const sendButtons = tree!.root.findAll((node) => {
            if ((node as any).type !== 'Pressable') return false;
            return String((node as any).props?.accessibilityLabel ?? '') === 'Send to run';
        });
        expect(sendButtons).toHaveLength(1);
        await act(async () => {
            await sendButtons[0]!.props.onPress();
        });
        expect(sendRunSpy).toHaveBeenCalledWith('session-1', expect.objectContaining({ runId: 'run_1', message: 'hello' }));

        const stopButtons = tree!.root.findAll((node) => {
            if ((node as any).type !== 'Pressable') return false;
            return String((node as any).props?.accessibilityLabel ?? '') === 'Stop run';
        });
        expect(stopButtons).toHaveLength(1);
        await act(async () => {
            await stopButtons[0]!.props.onPress();
        });
        expect(stopRunSpy).toHaveBeenCalledWith('session-1', expect.objectContaining({ runId: 'run_1' }));
    });
});
