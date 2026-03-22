import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    flushHookEffects,
    renderScreen,
    pressTestInstance,
    standardCleanup,
} from '@/dev/testkit';
import {
    createExpoRouterMock,
    createStackOptionsCapture,
} from '@/dev/testkit/mocks/router';
import type { Session } from '@/sync/domains/state/storageTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let hydrateReady = true;
const hydrateSpy = vi.fn((sessionId: string, tag: string) => {
    void sessionId;
    void tag;
    return hydrateReady;
});
const useSessionSpy = vi.fn<(sessionId: string) => Session | null>(() => null);
const useExecutionRunsBackendsForSessionSpy = vi.fn<(sessionId: string) => Record<string, { available?: boolean; intents?: string[] }> | null>(() => executionRunsBackendsMock);
const useSessionExecutionRunLaunchabilitySpy = vi.fn<(sessionId: string, session: unknown) => {
    canLaunchExecutionRuns: boolean;
    executionRunsBackends: Record<string, { available?: boolean; intents?: string[] }> | null;
    executionRunsSupported: boolean;
}>(() => ({
    canLaunchExecutionRuns: canLaunchExecutionRunsMock,
    executionRunsBackends: executionRunsBackendsMock,
    executionRunsSupported: canLaunchExecutionRunsMock,
}));

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

function createDeferredExecutionRunListResult(): {
    promise: Promise<ExecutionRunListResult>;
    resolve: (value: ExecutionRunListResult) => void;
} {
    let resolve!: (value: ExecutionRunListResult) => void;
    const promise = new Promise<ExecutionRunListResult>((nextResolve) => {
        resolve = nextResolve;
    });
    return { promise, resolve };
}

const listRunsSpy = vi.fn<(...args: ExecutionRunListArgs) => Promise<ExecutionRunListResult>>(
    async (_sessionId: string, _params: Record<string, unknown>) => ({
        runs: [] as const,
    }),
);

const routerPushSpy = vi.fn();
const routerBackSpy = vi.fn();
const routerReplaceSpy = vi.fn();
const stackOptionsCapture = createStackOptionsCapture();
let focusEffectHandler: (() => void | (() => void)) | null = null;
let executionRunsBackendsMock: Record<string, { available?: boolean; intents?: string[] }> | null = {
    claude: { available: true, intents: ['review', 'plan', 'delegate', 'voice_agent'] },
    codex: { available: true, intents: ['review', 'plan', 'delegate', 'voice_agent'] },
};
let canLaunchExecutionRunsMock = true;

const routerMock = createExpoRouterMock({
    params: { id: 'session-1' },
    router: {
        push: routerPushSpy,
        back: routerBackSpy,
        replace: routerReplaceSpy,
        setParams: vi.fn(),
    },
    stackOptionsCapture,
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

vi.mock('expo-router', () => ({
    ...routerMock.module,
    useFocusEffect: (handler: () => void | (() => void)) => {
        focusEffectHandler = handler;
    },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

vi.mock('@/react-native-unistyles', () => ({}));

vi.mock('@/components/ui/layout/ConstrainedScreenContent', () => ({
    ConstrainedScreenContent: (props: any) => React.createElement('ConstrainedScreenContent', props, props.children),
}));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string, tag: string) => hydrateSpy(sessionId, tag),
}));

vi.mock('@/hooks/server/useExecutionRunsBackendsForSession', () => ({
    useExecutionRunsBackendsForSession: (sessionId: string) => useExecutionRunsBackendsForSessionSpy(sessionId),
}));

vi.mock('@/hooks/session/useSessionExecutionRunLaunchability', () => ({
    useSessionExecutionRunLaunchability: (sessionId: string, session: any) =>
        useSessionExecutionRunLaunchabilitySpy(sessionId, session),
}));

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
                    {
                        key: run.runId,
                        onPress: () => onPressRun?.(run),
                        accessibilityLabel: `run:${run.runId}`,
                        testID: `run:${run.runId}`,
                    },
                    React.createElement('Text', null, run.runId),
                ))
                : []),
        )
    ),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {
        useSession: (sessionId: string) => useSessionSpy(sessionId),
    });
});

const Screen = (await import('@/app/(app)/session/[id]/runs')).default;

describe('Session Runs Screen', () => {
    beforeEach(() => {
        hydrateReady = true;
        hydrateSpy.mockClear();
        useSessionSpy.mockClear();
        useExecutionRunsBackendsForSessionSpy.mockClear();
        useSessionExecutionRunLaunchabilitySpy.mockClear();
        listRunsSpy.mockReset();
        listRunsSpy.mockResolvedValue({ runs: [] });
        executionRunsBackendsMock = {
            claude: { available: true, intents: ['review', 'plan', 'delegate', 'voice_agent'] },
            codex: { available: true, intents: ['review', 'plan', 'delegate', 'voice_agent'] },
        };
        canLaunchExecutionRunsMock = true;
        focusEffectHandler = null;
        routerPushSpy.mockClear();
        routerBackSpy.mockClear();
        routerReplaceSpy.mockClear();
        stackOptionsCapture.reset();
        routerMock.state.params = { id: 'session-1' };
    });

    afterEach(() => {
        standardCleanup();
    });

    async function renderRunsScreen() {
        const screen = await renderScreen(<Screen />);
        await flushHookEffects({ cycles: 3 });
        return screen;
    }

    async function renderHeaderRight() {
        const options = stackOptionsCapture.getResolved();
        expect(options?.headerTitle).toBe('runs.title');
        expect(typeof options?.headerRight).toBe('function');
        return renderScreen(React.createElement(options!.headerRight as React.ComponentType));
    }

    function findHeaderAction(screen: Awaited<ReturnType<typeof renderScreen>>, label: string) {
        return screen.findByProps({ accessibilityLabel: label });
    }

    it('waits for session hydration before listing runs', async () => {
        hydrateReady = false;
        listRunsSpy.mockClear();

        await renderRunsScreen();

        expect(hydrateSpy).toHaveBeenCalled();
        expect(listRunsSpy).toHaveBeenCalledTimes(0);
    });

    it('does not invoke session-dependent launchability hooks before hydration settles', async () => {
        hydrateReady = false;

        await renderRunsScreen();

        expect(useSessionSpy).not.toHaveBeenCalled();
        expect(useExecutionRunsBackendsForSessionSpy).not.toHaveBeenCalled();
        expect(useSessionExecutionRunLaunchabilitySpy).not.toHaveBeenCalled();
    });

    it('reloads runs when the screen regains focus', async () => {
        await renderRunsScreen();

        expect(listRunsSpy).toHaveBeenCalledTimes(1);
        expect(typeof focusEffectHandler).toBe('function');

        await act(async () => {
            focusEffectHandler?.();
        });
        await flushHookEffects({ cycles: 2 });

        expect(listRunsSpy).toHaveBeenCalledTimes(2);
    });

    it('keeps the newest run-list result when overlapping loads resolve out of order', async () => {
        const first = createDeferredExecutionRunListResult();
        const second = createDeferredExecutionRunListResult();

        listRunsSpy
            .mockImplementationOnce(() => first.promise)
            .mockImplementationOnce(() => second.promise);

        const screen = await renderScreen(<Screen />);
        await flushHookEffects({ cycles: 2 });

        expect(listRunsSpy).toHaveBeenCalledTimes(1);
        expect(typeof focusEffectHandler).toBe('function');

        await act(async () => {
            focusEffectHandler?.();
            await flushHookEffects({ cycles: 1 });
        });

        expect(listRunsSpy).toHaveBeenCalledTimes(2);

        await act(async () => {
            second.resolve({
                runs: [
                    {
                        runId: 'run_new',
                        callId: 'call_new',
                        sidechainId: 'call_new',
                        intent: 'review',
                        backendId: 'claude',
                        status: 'running',
                        startedAtMs: 2,
                        finishedAtMs: 0,
                    },
                ],
            });
            await flushHookEffects({ cycles: 2 });
        });

        expect(screen.getTextContent()).toContain('run_new');

        await act(async () => {
            first.resolve({
                runs: [
                    {
                        runId: 'run_old',
                        callId: 'call_old',
                        sidechainId: 'call_old',
                        intent: 'review',
                        backendId: 'claude',
                        status: 'succeeded',
                        startedAtMs: 1,
                        finishedAtMs: 2,
                    },
                ],
            });
            await flushHookEffects({ cycles: 2 });
        });

        expect(screen.getTextContent()).toContain('run_new');
        expect(screen.getTextContent()).not.toContain('run_old');
    });

    it('configures a runs header and navigates when Run review is pressed', async () => {
        await renderRunsScreen();
        const headerRightScreen = await renderHeaderRight();
        const runReview = findHeaderAction(headerRightScreen, 'executionRuns.newRun.intents.review');

        expect(runReview).toBeTruthy();

        act(() => {
            pressTestInstance(runReview, 'executionRuns.newRun.intents.review');
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/session/session-1/runs/new?intent=review');
    });

    it('navigates to the new run screen when Delegate task is pressed', async () => {
        await renderRunsScreen();
        const headerRightScreen = await renderHeaderRight();
        const delegate = findHeaderAction(headerRightScreen, 'executionRuns.newRun.intents.delegate');

        expect(delegate).toBeTruthy();

        act(() => {
            pressTestInstance(delegate, 'executionRuns.newRun.intents.delegate');
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/session/session-1/runs/new?intent=delegate');
    });

    it('shows only launch intents that the session backends actually support', async () => {
        executionRunsBackendsMock = {
            planner: { available: true, intents: ['plan'] },
        };

        await renderRunsScreen();
        const headerRightScreen = await renderHeaderRight();
        expect(headerRightScreen.findAllByProps({ accessibilityLabel: 'executionRuns.newRun.intents.plan' })).toHaveLength(1);
        expect(headerRightScreen.findAllByProps({ accessibilityLabel: 'executionRuns.newRun.intents.review' })).toHaveLength(0);
        expect(headerRightScreen.findAllByProps({ accessibilityLabel: 'executionRuns.newRun.intents.delegate' })).toHaveLength(0);
    });

    it('hides new-run header actions when the session has no live execution-run backends', async () => {
        executionRunsBackendsMock = null;
        canLaunchExecutionRunsMock = false;

        await renderRunsScreen();
        const headerRightScreen = await renderHeaderRight();
        expect(headerRightScreen.findAllByProps({ accessibilityLabel: 'executionRuns.newRun.intents.review' })).toHaveLength(0);
        expect(headerRightScreen.findAllByProps({ accessibilityLabel: 'executionRuns.newRun.intents.delegate' })).toHaveLength(0);
        expect(headerRightScreen.findAllByProps({ accessibilityLabel: 'common.refresh' })).toHaveLength(1);
    });

    it('hides new-run header actions when launchability is disabled even if backend discovery is populated', async () => {
        canLaunchExecutionRunsMock = false;
        executionRunsBackendsMock = {
            claude: { available: true, intents: ['review', 'plan', 'delegate', 'voice_agent'] },
        };

        await renderRunsScreen();
        const headerRightScreen = await renderHeaderRight();
        expect(headerRightScreen.findAllByProps({ accessibilityLabel: 'executionRuns.newRun.intents.review' })).toHaveLength(0);
        expect(headerRightScreen.findAllByProps({ accessibilityLabel: 'executionRuns.newRun.intents.delegate' })).toHaveLength(0);
        expect(headerRightScreen.findAllByProps({ accessibilityLabel: 'common.refresh' })).toHaveLength(1);
    });

    it('renders runs inside the constrained route content wrapper', async () => {
        const screen = await renderRunsScreen();

        expect(screen.findByTestId('session-runs-screen')).toBeTruthy();
        expect(screen.findByType('ConstrainedScreenContent' as any)).toBeTruthy();
    });

    it('lists execution runs for the session', async () => {
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

        const screen = await renderRunsScreen();

        expect(listRunsSpy).toHaveBeenCalledWith('session-1', {});
        expect(screen.getTextContent()).toContain('run_1');
    });

    it('retries once when execution run list returns RPC_METHOD_NOT_AVAILABLE', async () => {
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

        const screen = await renderRunsScreen();

        expect(listRunsSpy).toHaveBeenCalledTimes(2);
        expect(screen.getTextContent()).toContain('run_retry');
    });

    it('shows a daemon-unavailable message when execution run list remains unsupported after retry', async () => {
        listRunsSpy
            .mockResolvedValueOnce({ ok: false, error: 'RPC method not available', errorCode: 'RPC_METHOD_NOT_AVAILABLE' })
            .mockResolvedValueOnce({ ok: false, error: 'RPC method not available', errorCode: 'RPC_METHOD_NOT_AVAILABLE' });

        const screen = await renderRunsScreen();

        expect(screen.getTextContent()).toContain('errors.daemonUnavailableBody');
    });

    it('navigates to the run details screen when a run is pressed', async () => {
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

        const screen = await renderRunsScreen();
        screen.pressByTestId('run:run_2');

        expect(routerPushSpy).toHaveBeenCalledWith('/session/session-1/runs/run_2');
    });
});
