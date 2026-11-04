import * as React from 'react';
import { StyleSheet } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createActionExecutorBoundaryFixture, createDeferred, flushHookEffects, renderScreen } from '@/dev/testkit';
import { slideTransitionTokens } from '@/components/ui/motion/slideTransitionTokens';
import { dispatchBrowserControlCommand } from '@/sync/domains/browser/control/commands';
import { createBrowserControlState } from '@/sync/domains/browser/control/reducer';
import { useBrowserDaemonControlTransport } from '@/sync/domains/browser/control/useBrowserDaemonControlTransport';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createBrowserRuntimeActionExecutor } from '@/sync/domains/browser/actions/runtimeActionExecutor';
import { browserControlActionId } from '@/sync/domains/browser/actions/controlActionId';
import { SessionViewerBodyPresentation, useOptionalSessionViewerController, type SessionViewerPresenceStore } from '@/components/sessions/viewer/SessionViewerController';
import { SessionViewerControllerProvider } from '@/components/sessions/viewer/SessionViewerControllerProvider';

import { BrowserPresenceCapsule } from './BrowserPresenceCapsule';
import { BrowserShellPresence } from './BrowserShellPresence';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (...args: unknown[]) => rpc(...args),
}));
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

function view(controller: 'agent' | 'human', controlEpoch: number): BrowserControlViewState {
    const opened = dispatchBrowserControlCommand(createBrowserControlState(), {
        kind: 'openView', commandId: 'open', browserSessionId: 'browser_1', viewId: 'view_1',
        target: { kind: 'streamedBrowser', targetId: 'stream_1', streamId: 'stream_1' },
        platform: 'web', currentUrl: 'https://example.test/', focus: true,
    });
    return { ...opened.state.viewsById.view_1!, automationController: {
        browserSessionId: 'browser_1', viewId: 'view_1', controller, controlEpoch,
    } };
}

function Surface({ currentView, enabled = true }: Readonly<{ currentView: BrowserControlViewState; enabled?: boolean }>) {
    const sendDaemonCommand = useBrowserDaemonControlTransport({ machineId: 'machine_1', serverId: 'server_1' });
    const execute = createActionExecutor(createActionExecutorBoundaryFixture({
        isActionEnabled: () => enabled,
        runtimeActionExecute: createBrowserRuntimeActionExecutor({ executeOnMachine: async args => rpc(args), control: {
            readState: () => ({ ...createBrowserControlState(), viewsById: { [currentView.viewId]: currentView } }),
            applyDispatchResult: () => {},
            sendDaemonCommand,
        } }),
    }));
    return <BrowserShellPresence view={currentView} controlService={null} agent={null}
        onCheckAgain={target => execute.execute('browser.automation.snapshot', {
            v: 1, ...target, navigationGeneration: currentView.navigationGeneration, automationRequestId: 'fresh',
            requestedBy: 'user', requesterRef: { kind: 'session', id: 'session_1' }, actionKind: 'snapshot', timeoutMs: 1000,
        }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            externalActionTarget: { kind: 'machine', machineId: 'machine_1' } })}
        onCommand={command => execute.execute(browserControlActionId(command), command, {
            surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        })} testID="p" />;
}

describe('BrowserShellPresence daemon takeover', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });
    it('offers fresh observation after unknown completion and refuses it without Action dispatch', async () => {
        rpc.mockReset();
        const original = view('human', 5);
        const currentView = { ...original, automationController: { ...original.automationController!, uncertain: true } };
        const screen = await renderScreen(<Surface currentView={currentView} enabled={false} />);
        await screen.pressByTestIdAsync('p-check-again');
        expect(rpc).not.toHaveBeenCalled();
        expect(screen.getTextContent()).toContain('browserPresence.lastActionMayHaveLanded');
        rpc.mockResolvedValue({ v: 1, automationRequestId: 'fresh', status: 'failed', durationMs: 0,
            adapterKind: 'chromiumSidecar', fidelity: 'cdp', trustedInput: true, navigationGenerationBefore: 0,
            navigationGenerationAfter: 0, controlEpochBefore: 5, controlEpochAfter: 5, errorCode: 'runtime_unavailable' });
        await screen.update(<Surface currentView={currentView} />);
        await screen.pressByTestIdAsync('p-check-again');
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ actionId: 'browser.automation.snapshot',
            context: expect.objectContaining({ externalActionTarget: { kind: 'machine', machineId: 'machine_1' } }),
            input: expect.objectContaining({ browserSessionId: 'browser_1', viewId: 'view_1',
                navigationGeneration: currentView.navigationGeneration, actionKind: 'snapshot' }) }));
        expect(screen.getTextContent()).toContain('browserPresence.lastActionMayHaveLanded');
    });
    it('publishes the same observation recovery across viewer and pane presentations without claiming standalone surfaces', async () => {
        rpc.mockReset();
        let store: SessionViewerPresenceStore | undefined;
        function ReadPresence() { store = useOptionalSessionViewerController()?.presence; return null; }
        const original = view('human', 5);
        const currentView = { ...original, automationController: { ...original.automationController!, uncertain: true } };
        function Tree({ presentation }: Readonly<{ presentation: 'pane' | 'viewer' | null }>) {
            const surface = <Surface currentView={currentView} enabled={false} />;
            return <SessionViewerControllerProvider sessionId="session_1" serverId="server_1"
                phone={false} canPresentSource={() => true} openDocked={() => {}}>
                <ReadPresence />
                {presentation === null ? surface : <SessionViewerBodyPresentation presentation={presentation}>{surface}</SessionViewerBodyPresentation>}
            </SessionViewerControllerProvider>;
        }
        const screen = await renderScreen(<Tree presentation="viewer" />);
        expect(screen.findHostByTestId('p-human')).toBeNull();
        expect(store?.get('browser')?.presence).toMatchObject({ kind: 'human', interruptedCompletion: 'unknown' });
        expect(store?.get('browser')?.onCheckAgain).toBeTypeOf('function');
        // The dock must predict the floating footer before Float is admitted. Drawing the
        // capsule in the pane must not erase the source fact that determines that fit.
        await screen.update(<Tree presentation="pane" />);
        expect(screen.findHostByTestId('p-human')).not.toBeNull();
        expect(store?.get('browser')?.presence).toMatchObject({ kind: 'human', interruptedCompletion: 'unknown' });
        await act(async () => store?.get('browser')?.onCheckAgain?.());
        expect(rpc).not.toHaveBeenCalled();
        await screen.update(<Tree presentation={null} />);
        expect(store?.get('browser')).toBeNull();
    });
    it('reserves its own footer below the page instead of floating over the streamed input controls', async () => {
        const screen = await renderScreen(<Surface currentView={view('human', 5)} />);
        // A dock over the page covers the stream's control bar (Escape, keyboard) along the page's
        // bottom edge; the footer sits in flow under it, as the Computer viewer's does.
        const frame = screen.findHostByTestId('p-frame');
        expect(frame).not.toBeNull();
        expect(StyleSheet.flatten(frame!.props.style)?.position ?? 'relative').not.toBe('absolute');
        expect(screen.root.findByType(BrowserPresenceCapsule).props.placement).toBe('inline');
        await screen.pressByTestIdAsync('p-hand-back');
        // Nobody acting draws no empty band under the page.
        await screen.update(<Surface currentView={{ ...view('human', 5), automationController: undefined }} />);
        expect(screen.findHostByTestId('p-frame')).toBeNull();
    });
    it('does not take control or hand back when the existing Action policy refuses UI admission', async () => {
        rpc.mockReset();
        const screen = await renderScreen(<Surface currentView={view('agent', 4)} enabled={false} />);
        await screen.pressByTestIdAsync('p-take-control');
        expect(screen.findHostByTestId('p-human')).toBeNull();
        await screen.update(<Surface currentView={view('human', 5)} enabled={false} />);
        await screen.pressByTestIdAsync('p-hand-back');
        expect(rpc).not.toHaveBeenCalled();
    });
    it.each(['unavailable', 'connection-lost'] as const)('recovers a %s result through the real app binding and transport', async (failure) => {
        rpc.mockReset();
        if (failure === 'unavailable') rpc.mockResolvedValue({ error: 'Method not found', errorCode: 'RPC_METHOD_NOT_FOUND' });
        else rpc.mockRejectedValue(new Error('socket down'));
        const screen = await renderScreen(<Surface currentView={view('agent', 4)} />);
        await screen.pressByTestIdAsync('p-take-control');
        expect(screen.findHostByTestId('p-take-control')).toBeTruthy();
        // The real motion owner briefly retains the outgoing row, hidden/noninteractive, while it leaves.
        await flushHookEffects({ cycles: 1, advanceTimersMs: slideTransitionTokens.routine.timed.durationMs.enter });
        expect(Boolean(screen.findHostByTestId('p-stopping'))).toBe(false);
        expect(screen.findHostByTestId('p-human')).toBeNull();
        expect(screen.getTextContent()).toContain('browserPresence.stopUnconfirmed');

        const lateAnswer = createDeferred<unknown>();
        rpc.mockImplementationOnce(() => lateAnswer.promise);
        await screen.pressByTestIdAsync('p-take-control');
        expect(screen.findHostByTestId('p-stopping')).toBeTruthy();
        await screen.update(<Surface currentView={view('human', 5)} />);
        await act(async () => { lateAnswer.resolve({ protocolVersion: 1, result: { bogus: true } }); });
        await flushHookEffects({ cycles: 1, advanceTimersMs: slideTransitionTokens.routine.timed.durationMs.enter });
        expect(screen.findHostByTestId('p-human')).toBeTruthy();
        expect(screen.findHostByTestId('p-hand-back')).toBeTruthy();
    });
});
