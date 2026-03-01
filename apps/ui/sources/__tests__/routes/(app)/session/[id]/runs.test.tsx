import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type ExecutionRunListArgs = [string, Record<string, unknown>];
type ExecutionRunSummary = Readonly<{
    runId: string;
    callId: string;
    sidechainId: string;
    intent: string;
    backendId: string;
    status: string;
    startedAtMs: number;
    finishedAtMs: number;
}>;

type ExecutionRunListResult =
    | Readonly<{ ok: false; error: string; errorCode?: string }>
    | Readonly<{ runs: readonly ExecutionRunSummary[] }>;

const listRunsSpy = vi.fn<(...args: ExecutionRunListArgs) => Promise<ExecutionRunListResult>>(
    async (_sessionId: string, _params: Record<string, unknown>) => ({
        runs: [] as const,
    }),
);

const routerPushSpy = vi.fn();
const stackScreenSpy = vi.fn((_props: any) => null);
let focusEffectHandler: (() => void | (() => void)) | null = null;

vi.mock('react-native', async () => await import('@/dev/reactNativeStub'));

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

vi.mock('expo-router', () => ({
    useLocalSearchParams: () => ({ id: 'session-1' }),
    useRouter: () => ({ push: routerPushSpy, back: vi.fn() }),
    useFocusEffect: (handler: () => void | (() => void)) => {
        focusEffectHandler = handler;
    },
    Stack: { Screen: (props: any) => stackScreenSpy(props) },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));
vi.mock('@/components/ui/layout/layout', () => ({ layout: { maxWidth: 999 } }));

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunList: (...args: ExecutionRunListArgs) => listRunsSpy(...args),
}));
vi.mock('@/components/sessions/runs/ExecutionRunList', () => ({
    ExecutionRunList: ({ runs, onPressRun }: any) => (
        React.createElement(
            React.Fragment,
            null,
            ...(Array.isArray(runs)
                ? runs.map((run: any) => React.createElement(
                    'Pressable',
                    { key: run.runId, onPress: () => onPressRun?.(run) },
                    React.createElement('Text', null, run.runId),
                ))
                : []),
        )
    ),
}));

describe('Session Runs Screen', () => {
    afterEach(() => {
        listRunsSpy.mockReset();
        listRunsSpy.mockResolvedValue({ runs: [] });
    });

    it('reloads runs when the screen regains focus', async () => {
        listRunsSpy.mockClear();
        listRunsSpy.mockResolvedValue({ runs: [] });
        focusEffectHandler = null;

        const RunsScreen = (await import('@/app/(app)/session/[id]/runs')).default;

        await act(async () => {
            renderer.create(React.createElement(RunsScreen));
        });

        expect(listRunsSpy).toHaveBeenCalledTimes(1);
        expect(typeof focusEffectHandler).toBe('function');

        await act(async () => {
            focusEffectHandler?.();
        });

        expect(listRunsSpy).toHaveBeenCalledTimes(2);
    });

    it('configures a runs header and navigates when Run review is pressed', async () => {
        routerPushSpy.mockClear();
        stackScreenSpy.mockClear();
        listRunsSpy.mockResolvedValueOnce({ runs: [] });

        const RunsScreen = (await import('@/app/(app)/session/[id]/runs')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(RunsScreen));
        });

        const stackOptions = stackScreenSpy.mock.calls.at(-1)?.[0]?.options;
        expect(stackOptions?.headerTitle).toBe('runs.title');
        expect(typeof stackOptions?.headerRight).toBe('function');
        let headerRightTree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            headerRightTree = renderer.create(React.createElement(stackOptions.headerRight));
        });
        const buttons = headerRightTree!.root.findAllByType('Pressable');
        const runReview = buttons.find((b: any) => b.props.accessibilityLabel === 'executionRuns.newRun.intents.review');
        expect(runReview).toBeDefined();

        await act(async () => {
            runReview!.props.onPress?.();
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/session/session-1/runs/new?intent=review');
    });

    it('navigates to the new run screen when Delegate task is pressed', async () => {
        routerPushSpy.mockClear();
        stackScreenSpy.mockClear();
        listRunsSpy.mockResolvedValueOnce({ runs: [] });

        const RunsScreen = (await import('@/app/(app)/session/[id]/runs')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(RunsScreen));
        });

        const stackOptions = stackScreenSpy.mock.calls.at(-1)?.[0]?.options;
        expect(typeof stackOptions?.headerRight).toBe('function');
        let headerRightTree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            headerRightTree = renderer.create(React.createElement(stackOptions.headerRight));
        });
        const buttons = headerRightTree!.root.findAllByType('Pressable');
        const delegate = buttons.find((b: any) => b.props.accessibilityLabel === 'executionRuns.newRun.intents.delegate');
        expect(delegate).toBeDefined();

        await act(async () => {
            delegate!.props.onPress?.();
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/session/session-1/runs/new?intent=delegate');
    });

    it('constrains content to the shared max width', async () => {
        listRunsSpy.mockResolvedValueOnce({ runs: [] });
        const RunsScreen = (await import('@/app/(app)/session/[id]/runs')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(RunsScreen));
        });

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

    it('lists execution runs for the session', async () => {
        routerPushSpy.mockClear();
        listRunsSpy.mockResolvedValueOnce({
            runs: [
                {
                    runId: 'run_1',
                    callId: 'call_1',
                    sidechainId: 'call_1',
                    intent: 'review',
                    backendId: 'claude',
                    status: 'succeeded',
                    startedAtMs: 1,
                    finishedAtMs: 2,
                },
            ],
        });

        const RunsScreen = (await import('@/app/(app)/session/[id]/runs')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(RunsScreen));
        });

        expect(listRunsSpy).toHaveBeenCalledWith('session-1', {});
        expect(tree).not.toBeNull();
        const textNodes = tree!.root.findAllByType('Text');
        expect(textNodes.some((n: any) => String(n.props.children).includes('run_1'))).toBe(true);
    });

    it('retries once when execution run list returns RPC_METHOD_NOT_AVAILABLE', async () => {
        listRunsSpy.mockReset();
        listRunsSpy
            .mockResolvedValueOnce({ ok: false, error: 'RPC method not available', errorCode: 'RPC_METHOD_NOT_AVAILABLE' })
            .mockResolvedValueOnce({
                runs: [
                    {
                        runId: 'run_retry',
                        callId: 'call_retry',
                        sidechainId: 'call_retry',
                        intent: 'delegate',
                        backendId: 'claude',
                        status: 'running',
                        startedAtMs: 1,
                        finishedAtMs: 0,
                    },
                ],
            });

        const RunsScreen = (await import('@/app/(app)/session/[id]/runs')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(RunsScreen));
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(listRunsSpy).toHaveBeenCalledTimes(2);
        const textNodes = tree!.root.findAllByType('Text');
        expect(textNodes.some((n: any) => String(n.props.children).includes('run_retry'))).toBe(true);
    });

    it('navigates to the run details screen when a run is pressed', async () => {
        routerPushSpy.mockClear();
        listRunsSpy.mockResolvedValueOnce({
            runs: [
                {
                    runId: 'run_2',
                    callId: 'call_2',
                    sidechainId: 'call_2',
                    intent: 'review',
                    backendId: 'claude',
                    status: 'running',
                    startedAtMs: 1,
                    finishedAtMs: 0,
                },
            ],
        });

        const RunsScreen = (await import('@/app/(app)/session/[id]/runs')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(RunsScreen));
        });

        const textNodes = tree!.root.findAllByType('Text');
        const runText = textNodes.find((n: any) => String(n.props.children).includes('run_2'));
        expect(runText).toBeDefined();

        let cursor: any = runText!;
        while (cursor && cursor.type !== 'Pressable') {
            cursor = cursor.parent;
        }
        expect(cursor?.type).toBe('Pressable');
        const target = cursor;

        await act(async () => {
            target.props.onPress?.();
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/session/session-1/runs/run_2');
    });
});
