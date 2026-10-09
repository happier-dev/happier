import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { storage } from '@/sync/domains/state/storage';
import { readSessionTerminalWorkspaceForScope, registerSessionTerminalSplitMeasurements, setSessionTerminalPendingActionApproval } from '@/components/sessions/terminal/sessionTerminalWorkspaceRuntime';
import { invokeSessionTerminalAction } from '@/components/sessions/terminal/sessionTerminalActions';
import { buildProjectPaneScopeId } from '../projectPaneScope';
import { ProjectTerminalSurface } from './ProjectTerminalSurface';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { createEmptyTerminalSurfaceState, readTerminalSurfaceState, replaceTerminalSurfaceState } from '@/components/sessions/terminal/terminalSurfaceStateCache';
import { buildProjectTerminalKey } from '../projectTerminalScope';
import { buildProjectAccountRowPhysicalKeyV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';

async function invoke(input: Parameters<typeof invokeSessionTerminalAction>[0]) {
    const outcome: { result?: Awaited<ReturnType<typeof invokeSessionTerminalAction>> } = {};
    await act(async () => { outcome.result = await invokeSessionTerminalAction(input); });
    return outcome.result!;
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative'); return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles'); return createUnistylesMock();
});
// Xterm is the external renderer boundary. The real pane/controller remains mounted;
// no layout-ready event is emitted, so this presentation test does not request a PTY.
vi.mock('@/components/terminal/xterm/XtermTerminalView.web', () => ({
    XtermTerminalView: React.forwardRef((_props, _ref) => React.createElement('XtermBoundary')),
}));

describe('Project terminal through the incumbent pane workspace', () => {
    it('opens an admitted shell without a Session, then preserves labels, split identity and borrowed-view close', async () => {
        const home = await serveActionHomes({ homes: [{ key: 'project', serverUrl: 'https://project-terminal-pane.test', accountId: 'bob', settings: {
            actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'session.terminals.open': ['ui'] } },
        } }], route: () => undefined });
        let retireMeasurements: (() => void) | undefined;
        try {
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
            const serverId = home.homes.project!.id;
            const ref = { id: 'accepted', serverId, machineId: 'machine', rootPath: '/accepted', projectKey: 'project', createdAtMs: 1 };
            const checkout = { ...ref, id: 'selected-checkout', rootPath: '/accepted-worktree' };
            const workspace = { serverId, workspaceId: checkout.id, machineId: checkout.machineId, rootPath: checkout.rootPath };
            applyProjectAccountRowsFixture(storage, { workspaceRefs: [ref, checkout] });
            const scopeId = buildProjectPaneScopeId(ref.id, serverId);
            const sessions = storage.getState().sessions;
            const screen = await renderScreen(<AppPaneProvider><ProjectTerminalSurface scopeId={scopeId}
                workspaceRefId={ref.id} machineId={ref.machineId} rootPath={ref.rootPath} serverId={serverId} /></AppPaneProvider>);
            // Even registered base-root props cannot replace a missing accepted checkout address.
            expect(screen.findByTestId('project-terminal-workspace-root')).toBeNull();
            expect(readSessionTerminalWorkspaceForScope(scopeId)?.tabs ?? []).toEqual([]);
            await screen.update(<AppPaneProvider><ProjectTerminalSurface scopeId={scopeId}
                workspaceRefId={ref.id} machineId={ref.machineId} rootPath={ref.rootPath} serverId={serverId}
                workspace={workspace} /></AppPaneProvider>);
            expect(screen.findByTestId('project-terminal-workspace-root')).not.toBeNull();
            await screen.pressByTestIdAsync('project-terminal-workspace-strip-new');
            await vi.waitFor(() => expect(readSessionTerminalWorkspaceForScope(scopeId)?.tabs).toHaveLength(1));
            // The genuine UI intent remains lazy until the renderer is ready;
            // it must not be mistaken for an external caller needing admission now.
            expect(home.requests.filter(request => request.path === '/v1/artifacts')).toEqual([]);
            const original = readSessionTerminalWorkspaceForScope(scopeId)!.tabs[0].terminals[0];
            expect(original.target).toMatchObject({ kind: 'workspace_shell', workspace });
            expect(storage.getState().sessions).toBe(sessions);
            const pendingActionApproval = { scope: { serverId, accountId: 'bob' }, artifactId: 'approval-own-open', actionId: 'machines.terminal.open' as const };
            act(() => { expect(setSessionTerminalPendingActionApproval(scopeId, original.id, pendingActionApproval)).toBe(true); });
            expect(await invoke({ actionId: 'session.terminals.rename', input: { scopeId, terminalId: original.id, title: 'Build shell' } })).toMatchObject({ ok: true });
            retireMeasurements = registerSessionTerminalSplitMeasurements(scopeId, () => ({ availableWidthPx: 1000, minimumTerminalWidthPx: 320 }));
            const split = await invoke({ actionId: 'session.terminals.split', input: { scopeId,
                target: { kind: 'terminal_view', machineId: ref.machineId, terminalId: 'task-pty', terminalKey: 'task-output', cwd: ref.rootPath } } });
            expect(split).toMatchObject({ ok: true });
            if (!('terminalId' in split) || !split.terminalId) throw new Error('Expected borrowed view');
            expect(await invoke({ actionId: 'session.terminals.detach', input: { scopeId, terminalId: original.id } })).toMatchObject({ ok: true });
            expect(readSessionTerminalWorkspaceForScope(scopeId)?.tabs.flatMap(tab => tab.terminals).find(member => member.id === original.id))
                .toMatchObject({ title: 'Build shell', target: { workspace }, pendingActionApproval });
            act(() => { expect(setSessionTerminalPendingActionApproval(scopeId, original.id, null)).toBe(true); });
            expect(await invoke({ actionId: 'session.terminals.close', input: { scopeId, terminalId: split.terminalId } })).toMatchObject({ ok: true });
            expect(readSessionTerminalWorkspaceForScope(scopeId)?.tabs.flatMap(tab => tab.terminals).map(member => member.id)).toEqual([original.id]);
            expect(home.requests.filter(request => request.path.includes('/rpc'))).toEqual([]);
            const key = buildProjectTerminalKey({ serverId, accountId: 'bob' }, workspace, original.id);
            replaceTerminalSurfaceState(key, { ...createEmptyTerminalSurfaceState(), terminalId: 'private-pty', output: 'private output' });
            act(() => { applyProjectAccountRowsFixture(storage, { workspaceRefs: [], revisionsByPhysicalKey: {
                [buildProjectAccountRowPhysicalKeyV1({ kind: 'workspace-ref', serverId, id: checkout.id })]: 1,
                [buildProjectAccountRowPhysicalKeyV1({ kind: 'workspace-ref', serverId, id: ref.id })]: 1,
            } }); });
            await vi.waitFor(() => expect(screen.findByTestId('project-terminal-workspace-root')).toBeNull());
            expect(readTerminalSurfaceState(key)?.output).toBe('');
            await screen.unmount();
        } finally { retireMeasurements?.(); home.dispose(); }
    });
});
