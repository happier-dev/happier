import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    flushHookEffects,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installSessionRouteCommonModuleMocks } from '../sessionRouteTestHelpers';
import type { Session } from '@/sync/domains/state/storageTypes';

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
const routerReplaceSpy = vi.fn();
const navigateWithBlurOnWebSpy = vi.hoisted(() => vi.fn((action: () => void) => action()));
const navigationCanGoBackSpy = vi.fn(() => true);
let localSearchParamsMock: Record<string, unknown> = { id: 'session-1', runId: 'run_1' };
let hydrateReady = true;
let SessionRunDetailsScreen: typeof import('@/app/(app)/session/[id]/runs/[runId]').default;
const sessionFixture: Session = {
    id: 'session-1',
    seq: 0,
    createdAt: 0,
    updatedAt: 0,
    active: false,
    activeAt: 0,
    metadata: { flavor: 'codex' } as Session['metadata'],
    metadataVersion: 0,
    agentState: null,
    agentStateVersion: 0,
    thinking: false,
    thinkingAt: 0,
    presence: 'online',
    accessLevel: 'edit',
    canApprovePermissions: true,
};

vi.mock('@/utils/platform/navigateWithBlurOnWeb', () => ({
    navigateWithBlurOnWeb: navigateWithBlurOnWebSpy,
}));

installSessionRouteCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
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
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    surface: '#111',
                    surfaceHigh: '#222',
                    divider: '#333',
                    text: '#eee',
                    textSecondary: '#aaa',
                    textLink: '#06f',
                    textDestructive: '#f00',
                    accent: { indigo: '#33f' },
                    groupped: { sectionTitle: '#888' },
                    shadow: { color: '#000' },
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
                back: routerBackSpy,
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
        return createTextModuleMock({
            translate: (key: string, vars?: any) => {
                if (key === 'runs.detail.pid') return `pid ${vars?.pid ?? ''}`.trim();
                if (key === 'runs.detail.cpu') return `cpu ${vars?.percent ?? ''}`.trim();
                if (key === 'runs.detail.memory') return `memory ${vars?.megabytes ?? ''}`.trim();
                return key;
            },
        });
    },
    storageModule: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                storage: {
                    getState: () => ({
                        sessions: {
                            'session-1': {
                                id: 'session-1',
                                active: false,
                                updatedAt: 0,
                                metadata: {
                                    machineId: 'machine-stale',
                                    path: '/Users/leeroy/repo',
                                    homeDir: '/Users/leeroy',
                                },
                            },
                        },
                        machines: {
                            'machine-target': {
                                id: 'machine-target',
                                active: true,
                                activeAt: 10,
                                metadata: { host: 'workstation.local' },
                            },
                        },
                        getProjectForSession: (sessionId: string) =>
                            sessionId === 'session-1'
                                ? {
                                    key: {
                                        machineId: 'machine-target',
                                        path: '/Users/leeroy/repo',
                                    },
                                }
                                : null,
                        sessionMessages: {
                            'session-1': {
                                reducerState: {
                                    toolIdToMessageId: new Map<string, string>([['side_1', 'message-side-1']]),
                                },
                            },
                        },
                    }),
                } as any,
                useSession: () => sessionFixture,
                useSessionMessages: () => ({ messages: [], isLoaded: true }),
                useResolvedSessionMessageRouteId: () => null,
                useMessage: () => null,
            },
        });
    },
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: () => hydrateReady,
}));

vi.mock('@/components/sessions/shell/SessionInvalidLinkFallback', () => ({
    SessionInvalidLinkFallback: () => React.createElement('SessionInvalidLinkFallback', { testID: 'session-invalid-link' }),
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

vi.mock('@/components/ui/layout/layout', () => ({ layout: { maxWidth: 999 } }));
vi.mock('@/components/sessions/transcript/details/SessionMessageDetailsView', () => ({
    SessionMessageDetailsView: () => React.createElement('SessionMessageDetailsView'),
}));
vi.mock('@/components/sessions/runs/details/SessionExecutionRunInfoCard', () => ({
    SessionExecutionRunInfoCard: (props: any) => React.createElement('SessionExecutionRunInfoCard', props),
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
        routerReplaceSpy.mockReset();
        navigateWithBlurOnWebSpy.mockClear();
        navigationCanGoBackSpy.mockReturnValue(true);
        localSearchParamsMock = { id: 'session-1', runId: 'run_1' };
        hydrateReady = true;
    });

    afterEach(() => {
        standardCleanup();
    });

    async function renderRunDetailsScreen() {
        const screen = await renderScreen(React.createElement(SessionRunDetailsScreen));
        await flushHookEffects();
        return screen;
    }

    it('configures the run details header and constrains the content width', async () => {
        const screen = await renderRunDetailsScreen();

        expect(stackScreenSpy).toHaveBeenCalled();
        const stackOptions = stackScreenSpy.mock.calls.at(-1)?.[0]?.options;
        expect(stackOptions?.headerTitle).toBe('runs.runLabel');
        expect(typeof stackOptions?.headerLeft).toBe('function');
        expect(typeof stackOptions?.headerRight).toBe('function');

        const headerLeftScreen = await renderScreen(React.createElement(stackOptions.headerLeft));
        await headerLeftScreen.pressByTestIdAsync('session-run-details-back');
        expect(routerBackSpy).toHaveBeenCalledTimes(1);

        const headerRightScreen = await renderScreen(React.createElement(stackOptions.headerRight));
        expect(headerRightScreen.findByTestId('session-run-details-refresh')).toBeTruthy();

        const constrainedContainer = screen.findAllByType('View').find((node: any) => {
            const raw = node.props.style;
            const styles = Array.isArray(raw) ? raw : [raw];
            return styles.some((entry: any) => {
                if (!entry || typeof entry !== 'object') return false;
                return entry.maxWidth === 999 && entry.width === '100%' && entry.alignSelf === 'center';
            });
        });

        expect(constrainedContainer).toBeTruthy();
    });

    it('falls back to the parent session route when the run details screen has no back history', async () => {
        navigationCanGoBackSpy.mockReturnValue(false);
        const screen = await renderRunDetailsScreen();

        const stackOptions = stackScreenSpy.mock.calls.at(-1)?.[0]?.options;
        expect(typeof stackOptions?.headerLeft).toBe('function');

        const headerLeftScreen = await renderScreen(React.createElement(stackOptions.headerLeft));
        await headerLeftScreen.pressByTestIdAsync('session-run-details-back');

        expect(routerBackSpy).not.toHaveBeenCalled();
        expect(routerReplaceSpy).toHaveBeenCalledWith('/session/session-1');
    });

    it('renders invalid-link fallback when the run id param is missing', async () => {
        localSearchParamsMock = { id: 'session-1' };
        const screen = await renderRunDetailsScreen();
        expect(screen.findAllByType('ActivityIndicator')).toHaveLength(0);
        expect(screen.findByTestId('session-invalid-link')).toBeTruthy();
    });

    it('does not load run details until route hydration is ready', async () => {
        hydrateReady = false;
        const screen = await renderRunDetailsScreen();
        expect(screen.findAllByType('ActivityIndicator')).toHaveLength(1);
        expect(getRunSpy).not.toHaveBeenCalled();
    });

    it('keeps the loading state visible while route hydration is pending even if params are not ready yet', async () => {
        hydrateReady = false;
        localSearchParamsMock = {};
        const screen = await renderRunDetailsScreen();
        expect(screen.findAllByType('ActivityIndicator')).toHaveLength(1);
        expect(screen.findAllByTestId('session-invalid-link')).toHaveLength(0);
    });

    it('loads run details via session execution run get', async () => {
        const screen = await renderRunDetailsScreen();
        expect(getRunSpy).toHaveBeenCalledWith('session-1', expect.objectContaining({ runId: 'run_1' }));
        expect(screen.findByType('SessionExecutionRunInfoCard' as any).props.run?.runId).toBe('run_1');
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

        const screen = await renderRunDetailsScreen();
        expect(getRunSpy).toHaveBeenCalledTimes(2);
        expect(screen.findByType('SessionExecutionRunInfoCard' as any).props.run?.runId).toBe('run_1');
    });

    it('renders daemon process stats when machine execution runs list includes the run', async () => {
        const screen = await renderRunDetailsScreen();
        expect(machineExecutionRunsListSpy).toHaveBeenCalledTimes(1);
        const machineIdArg = machineExecutionRunsListSpy.mock.calls[0]?.[0];
        expect(typeof machineIdArg).toBe('string');
        expect(machineIdArg.length).toBeGreaterThan(0);
        expect(screen.findByType('SessionExecutionRunInfoCard' as any).props.daemonProcessLine).toContain('pid 123');
        expect(screen.findByType('SessionExecutionRunInfoCard' as any).props.daemonProcessLine).toContain('cpu 12.5');
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

        const screen = await renderRunDetailsScreen();
        // The structured renderer should render the card, not the raw JSON "structured" debug block.
        expect(screen.getTextContent()).not.toContain('structured');
    });

    it('opens the owning tool details when the run sidechain maps to a transcript tool message', async () => {
        const screen = await renderRunDetailsScreen();
        expect(screen.findByTestId('session-run-details-open-tool-message')).toBeTruthy();

        await screen.pressByTestIdAsync('session-run-details-open-tool-message');

        expect(navigateWithBlurOnWebSpy).toHaveBeenCalledTimes(1);
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

        const screen = await renderRunDetailsScreen();
        expect(screen.findByTestId('session-run-details-send-input')).toBeTruthy();
        await act(async () => {
            screen.changeTextByTestId('session-run-details-send-input', 'hello');
        });

        expect(screen.findByTestId('session-run-details-send')).toBeTruthy();
        await screen.pressByTestIdAsync('session-run-details-send');
        expect(sendRunSpy).toHaveBeenCalledWith('session-1', expect.objectContaining({ runId: 'run_1', message: 'hello' }));

        expect(screen.findByTestId('session-run-details-stop')).toBeTruthy();
        await screen.pressByTestIdAsync('session-run-details-stop');
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

        const screen = await renderRunDetailsScreen();
        expect(screen.findAllByTestId('session-run-details-send-input')).toHaveLength(0);
        expect(screen.findAllByTestId('session-run-details-send')).toHaveLength(0);
        expect(sendRunSpy).not.toHaveBeenCalled();
    });
});
