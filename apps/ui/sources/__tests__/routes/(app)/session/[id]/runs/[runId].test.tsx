import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionRunGetResponseSchema, ExecutionRunPublicStateSchema, type ExecutionRunPublicState } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createMachineFixture, createSessionFixture, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { withPopoverWebGlobals, reportPopoverContentLayout, flattenTestStyle } from '@/dev/testkit/harness/popoverHarness';

const route = vi.hoisted(() => ({
    params: { id: 'session-1', runId: 'run_1' } as Record<string, string | string[] | undefined>,
    stackScreen: vi.fn(), push: vi.fn(), back: vi.fn(), replace: vi.fn(), canGoBack: vi.fn(() => true),
}));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const boundary = createExpoRouterMock({ params: () => route.params,
        navigation: { canGoBack: route.canGoBack },
        router: { push: route.push, back: route.back, replace: route.replace, setParams: vi.fn() } });
    return { ...boundary.module, Stack: Object.assign(boundary.module.Stack, { Screen: route.stackScreen }) };
});
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key, vars) => {
        if (key === 'runs.detail.pid') return `pid ${vars?.pid ?? ''}`.trim();
        if (key === 'runs.detail.cpu') return `cpu ${vars?.percent ?? ''}`.trim();
        if (key === 'runs.detail.memory') return `memory ${vars?.megabytes ?? ''}`.trim();
        return key;
    },
}));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

let hydrateReady = true;
let hydratedServerId: string | undefined;
// A Run whose tool marker is not in the loaded transcript window offers a route to it instead of rendering it inline.
let transcriptHoldsToolMarker = true;
// Observe both released and current run-input ports at the Socket boundary.
const sendRunSpy = vi.fn();
const pendingHydrationReads = new Set<() => void>();
let runReplies: Array<Readonly<{ ok: false; error: string; errorCode: string }>
    | Readonly<{ run: Partial<ExecutionRunPublicState>; structuredMeta?: unknown }>> = [];
function runFixture(overrides: Partial<ExecutionRunPublicState> = {}) {
    return ExecutionRunPublicStateSchema.parse({
        runId: 'run_1', callId: 'call_1', sidechainId: 'side_1', intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'read_only',
        retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
        status: 'succeeded', startedAtMs: 1,
        ...(overrides.status === 'running' ? {} : { finishedAtMs: 2 }), ...overrides,
    });
}
const { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
const runMachine = createPlainMachineRowFixture({ id: 'machine-target', accountId: 'account-a' });
const { installSessionPaneRuntimeTestHarness } = await import('@/components/sessions/panes/sessionPaneRuntimeTestHarness');
const runtime = installSessionPaneRuntimeTestHarness({
    sessionId: 'session-1',
    credentials: { token: createAccountTokenForTests('account-a', { currentAccount: true }) },
    request: async (input, init) => {
        const path = new URL(String(input)).pathname;
        // The Run's host is the Account's explicitly admitted daemon Machine.
        if (path === '/v1/machines/read-batch' && init?.method === 'POST') {
            return createMachineReadBatchResponseFixture(init.body, id => id === runMachine.id ? runMachine : null);
        }
        if (path === '/v2/sessions/session-1' && !hydrateReady) {
            return new Promise<Response>(resolve => {
                const release = () => { pendingHydrationReads.delete(release); resolve(Response.json({ error: 'Session not found' }, { status: 404 })); };
                pendingHydrationReads.add(release);
                init?.signal?.addEventListener('abort', release, { once: true });
            });
        }
        return null;
    },
    rpc: async (method) => {
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_SEND || method === SESSION_RPC_METHODS.EXECUTION_RUN_ACTION) sendRunSpy();
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_GET) {
            const reply = runReplies.shift();
            return reply && !('run' in reply) ? reply
                : ExecutionRunGetResponseSchema.parse({ ...reply, run: runFixture(reply?.run) });
        }
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP) return { ok: true };
        if (method === RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST) return { runs: [{
            happyHomeDir: '/tmp/happy', pid: 123, happySessionId: 'session-1', runId: 'run_1', callId: 'call_1', sidechainId: 'side_1',
            intent: 'review', backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            runClass: 'bounded', ioMode: 'request_response', retentionPolicy: 'ephemeral', status: 'succeeded',
            startedAtMs: 1, updatedAtMs: 2, finishedAtMs: 2, process: { pid: 123, cpu: 12.5, memory: 1048576 },
        }] };
        return {};
    },
});
const { getStorage } = await import('@/sync/domains/state/storageStore');
const operations = await import('@/sync/ops/sessionExecutionRuns');
const getRunSpy = vi.spyOn(operations, 'sessionExecutionRunGet');
const stopRunSpy = vi.spyOn(operations, 'sessionExecutionRunStop');
const machineExecutionRunsListSpy = vi.spyOn(await import('@/sync/ops/machineExecutionRuns'), 'machineExecutionRunsList');
const navigateWithBlurOnWebSpy = vi.spyOn(await import('@/utils/platform/navigateWithBlurOnWeb'), 'navigateWithBlurOnWeb');
const { ActivitySpinner } = await import('@/components/ui/feedback/ActivitySpinner');
const { SessionExecutionRunInfoCard } = await import('@/components/sessions/runs/details/SessionExecutionRunInfoCard');
const { SessionCockpitChromeRegistryProvider } = await import('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry');
const { measureScreenContentBottom, PublishBottomChromeHeight } = await import('../testUtils/bottomChromeViewport');
const { layout } = await import('@/components/ui/layout/layout');
const { default: SessionRunDetailsScreen } = await import('@/app/(app)/session/[id]/runs/[runId]');
const stackScreenSpy = route.stackScreen;
const routerPushSpy = route.push;
const routerBackSpy = route.back;
const routerReplaceSpy = route.replace;
const navigationCanGoBackSpy = route.canGoBack;
let restorePopover: (() => void) | undefined;

async function applyRouteFixture() {
    if (hydratedServerId) await runtime.restoreRealm({ serverUrl: `https://run-details-${encodeURIComponent(hydratedServerId)}.example.test`, serverIdentityId: hydratedServerId, accountId: 'account-a' });
    const store = getStorage();
    const machine = createMachineFixture({ id: 'machine-target', activeAt: Date.now() });
    store.setState({ sessions: hydrateReady ? { 'session-1': createSessionFixture({
        id: 'session-1', serverId: runtime.serverId, active: true, activeAt: Date.now(),
        metadata: { machineId: machine.id, path: '/repo', host: machine.metadata!.host, homeDir: machine.metadata!.homeDir },
    }) } : {}, machines: { [machine.id]: machine }, machineListByServerId: { [runtime.serverId]: [machine] },
        machineListStatusByServerId: { [runtime.serverId]: 'idle' },
    });
    if (hydrateReady) {
        if (transcriptHoldsToolMarker) store.getState().applyMessages('session-1', [{ id: 'tool-message-side-1', localId: null, createdAt: 1, seq: 1,
            role: 'agent', isSidechain: false, content: [{ type: 'tool-call', id: 'side_1', name: 'SubAgentRun', description: null,
                uuid: 'run-marker', parentUUID: null, input: { runId: 'run_1' } }],
        }]);
        store.getState().applyMessagesLoaded('session-1');
    }
}

describe('Session Run Details Screen', () => {
    beforeEach(() => {
        restorePopover = withPopoverWebGlobals();
        runReplies = [];
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
        route.params = { id: 'session-1', runId: 'run_1' };
        hydrateReady = true;
        hydratedServerId = undefined;
        transcriptHoldsToolMarker = true;
    });

    afterEach(async () => {
        await standardCleanup();
        hydrateReady = true;
        for (const release of pendingHydrationReads) release();
        restorePopover?.();
    });

    async function renderRunDetailsScreen() {
        await applyRouteFixture();
        const screen = await renderScreen(React.createElement(SessionRunDetailsScreen), { wrapper: runtime.Wrapper });
        await flushHookEffects();
        if (hydrateReady && typeof route.params.id === 'string' && typeof route.params.runId === 'string') {
            await vi.waitFor(() => expect(screen.findAllByType(SessionExecutionRunInfoCard)).toHaveLength(1));
        }
        return screen;
    }

    it('keeps the run details viewport above changing bottom chrome', async () => {
        hydrateReady = false;
        const render = (height: number) => (
            <SessionCockpitChromeRegistryProvider>
                <PublishBottomChromeHeight height={height} />
                <SessionRunDetailsScreen />
            </SessionCockpitChromeRegistryProvider>
        );
        await applyRouteFixture();
        const screen = await renderScreen(render(94), { wrapper: runtime.Wrapper });
        for (const height of [94, 121, 0]) {
            await screen.update(render(height));
            const frame = screen.findAllByType('View')[0];
            expect(frame).toBeTruthy();
            expect(measureScreenContentBottom(frame.props.style, 700)).toBe(700 - height);
        }
    });

    it('configures the run details header and constrains the content width', async () => {
        const screen = await renderRunDetailsScreen();

        expect(stackScreenSpy).toHaveBeenCalled();
        const stackOptions = stackScreenSpy.mock.calls.at(-1)?.[0]?.options;
        // Never "run <id>": the page's own header names the Run.
        expect(stackOptions?.headerTitle).toBe('session.subagents.panel.title');
        expect(typeof stackOptions?.headerLeft).toBe('function');
        expect(typeof stackOptions?.headerRight).toBe('function');

        const headerLeftScreen = await renderScreen(React.createElement(stackOptions.headerLeft));
        await headerLeftScreen.pressByTestIdAsync('session-run-details-back');
        expect(routerBackSpy).toHaveBeenCalledTimes(1);

        const headerRightScreen = await renderScreen(React.createElement(stackOptions.headerRight));
        expect(headerRightScreen.findByTestId('session-run-details-refresh')).toBeTruthy();

        const constrainedContainer = screen.findAllByType('View').find((node: any) => {
            const style = flattenTestStyle(node.props.style);
            return style.maxWidth === layout.maxWidth && style.width === '100%' && style.alignSelf === 'center';
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
        expect(routerReplaceSpy).toHaveBeenCalledWith(`/session/session-1?serverId=${runtime.serverId}`);
    });

    it('keeps the hydrated Home qualified for Run loading and no-history navigation', async () => {
        hydratedServerId = "srv_run_details_hydrated";
        navigationCanGoBackSpy.mockReturnValue(false);
        await renderRunDetailsScreen();

        expect(getRunSpy).toHaveBeenCalledWith(
            'session-1',
            expect.objectContaining({ runId: 'run_1' }),
            expect.objectContaining({ serverId: "srv_run_details_hydrated" }),
        );

        const stackOptions = stackScreenSpy.mock.calls.at(-1)?.[0]?.options;
        const headerLeftScreen = await renderScreen(React.createElement(stackOptions.headerLeft));
        await headerLeftScreen.pressByTestIdAsync('session-run-details-back');

        const { buildScopedSessionRouteHref } = await import('@/hooks/session/sessionRouteServerScope');
        expect(routerReplaceSpy).toHaveBeenCalledWith(buildScopedSessionRouteHref({ sessionId: "session-1", serverId: hydratedServerId }));
    });

    it('renders invalid-link fallback when the run id param is missing', async () => {
        route.params = { id: 'session-1' };
        const screen = await renderRunDetailsScreen();
        expect(screen.findAllByType(ActivitySpinner)).toHaveLength(0);
        expect(screen.findByTestId('session-invalid-link')).toBeTruthy();
    });

    it('does not load run details until route hydration is ready', async () => {
        hydrateReady = false;
        const screen = await renderRunDetailsScreen();
        expect(screen.findAllByType(ActivitySpinner)).toHaveLength(1);
        expect(getRunSpy).not.toHaveBeenCalled();
    });

    it('reads a route without a Session id as an invalid link instead of a pending hydration', async () => {
        // The hydration owner settles an empty Session id as not found at once (there is nothing to wait for).
        hydrateReady = false;
        route.params = {};
        const screen = await renderRunDetailsScreen();
        expect(screen.findAllByType(ActivitySpinner)).toHaveLength(0);
        expect(screen.findAllByTestId('session-invalid-link')).toHaveLength(1);
    });

    it('loads run details via session execution run get', async () => {
        const screen = await renderRunDetailsScreen();
        expect(getRunSpy).toHaveBeenCalledWith('session-1', expect.objectContaining({ runId: 'run_1' }), expect.objectContaining({ serverId: runtime.serverId }));
        expect(screen.findByType(SessionExecutionRunInfoCard).props.run?.runId).toBe('run_1');
    });

    it('retries run details load once when session encryption is not yet available', async () => {
        getRunSpy.mockClear();
        runReplies.push({
            ok: false,
            error: 'Session encryption not found for session-1',
            errorCode: 'session_encryption_not_found',
        });
        runReplies.push({
            run: {
                runId: 'run_1',
                callId: 'call_1',
                sidechainId: 'side_1',
                intent: 'review',
                backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
        expect(screen.findByType(SessionExecutionRunInfoCard).props.run?.runId).toBe('run_1');
    });

    it('renders daemon process stats when machine execution runs list includes the run', async () => {
        const screen = await renderRunDetailsScreen();
        expect(machineExecutionRunsListSpy).toHaveBeenCalledTimes(1);
        const machineIdArg = machineExecutionRunsListSpy.mock.calls[0]?.[0];
        expect(typeof machineIdArg).toBe('string');
        expect(machineIdArg.length).toBeGreaterThan(0);
        await vi.waitFor(() => {
            const daemonProcessLine = screen.findByType(SessionExecutionRunInfoCard).props.daemonProcessLine;
            expect(daemonProcessLine).toContain('pid 123');
            expect(daemonProcessLine).toContain('cpu 12.5');
        });
    });

    it('renders structured meta using the structured message registry when available', async () => {
        runReplies.push({
            run: {
                runId: 'run_1',
                callId: 'call_1',
                sidechainId: 'side_1',
                intent: 'delegate',
                backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
        transcriptHoldsToolMarker = false;
        const screen = await renderRunDetailsScreen();
        expect(screen.findByTestId('session-run-details-open-tool-message')).toBeTruthy();

        await screen.pressByTestIdAsync('session-run-details-open-tool-message');

        expect(navigateWithBlurOnWebSpy).toHaveBeenCalledTimes(1);
        expect(routerPushSpy).toHaveBeenCalledWith(`/session/session-1/message/tool%3Aside_1?serverId=${runtime.serverId}`);
    });

    it('stops a running bounded run without ever offering it a direct send box', async () => {
        runReplies.push({
            run: {
                runId: 'run_1',
                callId: 'call_1',
                sidechainId: 'side_1',
                intent: 'review',
                backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                permissionMode: 'read_write',
                retentionPolicy: 'resumable',
                runClass: 'bounded',
                ioMode: 'request_response',
                status: 'running',
                startedAtMs: 1,
            },
        });

        const screen = await renderRunDetailsScreen();
        // A bounded job is finite work. It keeps its stop control and its result, and it
        // never acquires the durable conversation composer.
        expect(screen.findAllByTestId('session-run-details-send-input')).toHaveLength(0);
        expect(screen.findAllByTestId('session-run-details-send')).toHaveLength(0);

        await screen.pressByTestIdAsync('session-run-details-actions-menu');
        await act(async () => { reportPopoverContentLayout(screen, { width: 340, height: 300 }); });
        expect(screen.findByTestId('session-run-details-stop')).toBeTruthy();
        await screen.pressByTestIdAsync('session-run-details-stop');
        await vi.waitFor(() => expect(stopRunSpy).toHaveBeenCalledWith('session-1', expect.objectContaining({ runId: 'run_1' }), expect.objectContaining({ serverId: runtime.serverId })));
        expect(sendRunSpy).not.toHaveBeenCalled();
    });

    it('hides the send composer for running voice-agent runs', async () => {
        runReplies.push({
            run: {
                runId: 'run_1',
                callId: 'call_1',
                sidechainId: 'side_1',
                intent: 'voice_agent',
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
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
