import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

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

const listRunsSpy = vi.fn(async (_sessionId: string, _params: Record<string, unknown>) => ({
    runs: [] as ExecutionRunSummary[],
}));

const routerPushSpy = vi.fn();
const stackScreenSpy = vi.fn((_props: any) => null);

vi.mock('react-native', async () => await import('@/dev/reactNativeStub'));

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

vi.mock('expo-router', () => ({
    useLocalSearchParams: () => ({ id: 'session-1' }),
    useRouter: () => ({ push: routerPushSpy, back: vi.fn() }),
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
    it('configures a runs header and navigates when Run review is pressed', async () => {
        routerPushSpy.mockClear();
        stackScreenSpy.mockClear();
        listRunsSpy.mockResolvedValueOnce({ runs: [] });

        const RunsScreen = (await import('./runs')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(RunsScreen));
        });

        const stackOptions = stackScreenSpy.mock.calls.at(-1)?.[0]?.options;
        expect(stackOptions?.headerTitle).toBe('Runs');
        expect(typeof stackOptions?.headerRight).toBe('function');
        let headerRightTree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            headerRightTree = renderer.create(React.createElement(stackOptions.headerRight));
        });
        const buttons = headerRightTree!.root.findAllByType('Pressable');
        const runReview = buttons.find((b: any) => b.props.accessibilityLabel === 'Run review');
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

        const RunsScreen = (await import('./runs')).default;

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
        const delegate = buttons.find((b: any) => b.props.accessibilityLabel === 'Delegate task');
        expect(delegate).toBeDefined();

        await act(async () => {
            delegate!.props.onPress?.();
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/session/session-1/runs/new?intent=delegate');
    });

    it('constrains content to the shared max width', async () => {
        listRunsSpy.mockResolvedValueOnce({ runs: [] });
        const RunsScreen = (await import('./runs')).default;

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

        const RunsScreen = (await import('./runs')).default;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(RunsScreen));
        });

        expect(listRunsSpy).toHaveBeenCalledWith('session-1', {});
        expect(tree).not.toBeNull();
        const textNodes = tree!.root.findAllByType('Text');
        expect(textNodes.some((n: any) => String(n.props.children).includes('run_1'))).toBe(true);
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

        const RunsScreen = (await import('./runs')).default;

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
