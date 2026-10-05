import { describe, expect, it, vi } from 'vitest';
import { appPaneReduce, createAppPaneState } from '@/components/appShell/panes/model/appPaneReducer';
import { invokeSessionTerminalAction } from './sessionTerminalActions';
import { registerSessionTerminalWorkspaceOwner, registerSessionTerminalSplitMeasurements } from './sessionTerminalWorkspaceRuntime';
import { createEmptyTerminalSurfaceState, readTerminalSurfaceState, replaceTerminalSurfaceState } from './terminalSurfaceStateCache';
import { resolveSessionTerminalIdentity } from './sessionTerminalMode';
import { machineTerminalEnsure, machineTerminalRestart } from '@/sync/ops/machineTerminal';
import { buildDetailsWorkspaceStateView } from '@/components/appShell/panes/details/workspace/detailsWorkspaceSelectors';
import { createSessionTerminalLeafHandles } from './strip/sessionTerminalLeafHandles';

// Machine transport is outside the deterministic pane/Action ownership boundary.
const machineRpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));

describe('mounted terminal Actions', () => {
    it('opens the exact retained member in pinned Details through the same Action owner', async () => {
        const scopeId = 'session:address:home-details:session-details';
        let state = appPaneReduce(createAppPaneState({ maxScopesInMemory: 3 }), { type: 'openBottom', scopeId, tabId: 'terminal' });
        const retire = registerSessionTerminalWorkspaceOwner({ getState: () => state, dispatch: (action) => { state = appPaneReduce(state, action); } });
        try {
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.open_in_details', input: { scopeId, terminalId: 'embedded' } })).toEqual({ ok: true });
            expect(buildDetailsWorkspaceStateView(state.scopes[scopeId].details).tabs).toMatchObject([{ key: 'terminal:embedded', isPinned: true }]);
            expect(state.scopes[scopeId].bottom.isOpen).toBe(false);
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.open_in_details', input: { scopeId, terminalId: 'missing' } })).toMatchObject({ ok: false, errorCode: 'terminal_not_found' });
        } finally { retire(); }
    });
    it('restarts only the exact mounted owned member and reports unavailable/read-only admission', async () => {
        const scopeId = 'session:address:home-restart:session-restart';
        let state = appPaneReduce(createAppPaneState({ maxScopesInMemory: 3 }), { type: 'activateScope', scopeId });
        state = appPaneReduce(state, { type: 'terminalWorkspace', scopeId, command: { type: 'open', terminal: { id: 'borrowed', target: { kind: 'terminal_view', machineId: 'm', terminalId: 'other', terminalKey: 'other-key', cwd: '/repo' } } } });
        const retire = registerSessionTerminalWorkspaceOwner({ getState: () => state, dispatch: (action) => { state = appPaneReduce(state, action); } });
        const handles = createSessionTerminalLeafHandles(scopeId);
        let attempts = 0;
        const unregister = handles.register('embedded', { copySelection: null, paste: () => {}, clear: () => {}, restart: () => { attempts += 1; } });
        try {
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.restart', input: { scopeId, terminalId: 'embedded' } })).toEqual({ ok: true });
            expect(attempts).toBe(1);
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.restart', input: { scopeId, terminalId: 'borrowed' } })).toMatchObject({ ok: false, errorCode: 'terminal_restart_unavailable' });
            let detailsAttempts = 0;
            const unregisterDetails = handles.register('embedded', { copySelection: null, paste: () => {}, clear: () => {}, restart: () => { detailsAttempts += 1; } });
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.restart', input: { scopeId, terminalId: 'embedded' } })).toEqual({ ok: true });
            expect(detailsAttempts).toBe(1);
            expect(attempts).toBe(1);
            unregisterDetails();
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.restart', input: { scopeId, terminalId: 'embedded' } })).toEqual({ ok: true });
            expect(attempts).toBe(2);
            unregister();
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.restart', input: { scopeId, terminalId: 'embedded' } })).toMatchObject({ ok: false, errorCode: 'terminal_restart_unavailable' });
        } finally { unregister(); retire(); }
    });
    it.each(['ensure', 'restart'] as const)('stops a connecting shell whose %s finishes after close was requested', async (operation) => {
        vi.useFakeTimers();
        const scopeId = `session:address:home-connect:session-connect-${operation}`;
        const terminalKey = `${scopeId}:terminal:connecting`;
        let state = appPaneReduce(createAppPaneState({ maxScopesInMemory: 3 }), { type: 'activateScope', scopeId });
        state = appPaneReduce(state, { type: 'terminalWorkspace', scopeId, command: { type: 'open', terminal: {
            id: 'connecting', target: { kind: 'machine_shell', machineId: 'machine-connect', cwd: '/repo' },
        } } });
        const retire = registerSessionTerminalWorkspaceOwner({ getState: () => state, dispatch: (action) => { state = appPaneReduce(state, action); } });
        let running = false;
        machineRpc.mockImplementation(async (request: { method: string }) => {
            if (request.method === `daemon.terminal.${operation}`) return await new Promise((resolve) => {
                setTimeout(() => { running = true; resolve({ ok: true, terminalId: 'connecting-pty', reused: false }); }, 25);
            });
            if (request.method === 'daemon.terminal.list') return { ok: true, terminals: running ? [{ terminalId: 'connecting-pty', terminalKey, cwd: '/repo', ended: false, exit: null }] : [] };
            running = false;
            return { ok: true };
        });
        try {
            const ensuring = (operation === 'ensure' ? machineTerminalEnsure : machineTerminalRestart)('machine-connect', { terminalKey, cwd: '/repo' }, { serverId: 'home-connect' });
            const closing = invokeSessionTerminalAction({ actionId: 'session.terminals.close', input: { scopeId, terminalId: 'connecting' } });
            // Delay belongs to the simulated network boundary. Drain earlier
            // microtasks before its response so a no-op async yield cannot pass.
            await vi.advanceTimersByTimeAsync(25);
            await ensuring;
            expect(await closing).toEqual({ ok: true });
            expect(running).toBe(false);
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.list', input: { scopeId } })).toMatchObject({ workspace: { tabs: [{ id: 'embedded' }] } });
        } finally { retire(); machineRpc.mockReset(); vi.useRealTimers(); }
    });
    it('detaches the original shell without changing its PTY identity and reorders the real tabs', async () => {
        const scopeId = 'session:address:home-drag:session-drag';
        let state = appPaneReduce(createAppPaneState({ maxScopesInMemory: 3 }), { type: 'activateScope', scopeId });
        const retire = registerSessionTerminalWorkspaceOwner({ getState: () => state, dispatch: (action) => { state = appPaneReduce(state, action); } });
        const retireMeasurement = registerSessionTerminalSplitMeasurements(scopeId, () => ({ availableWidthPx: 1000, minimumTerminalWidthPx: 320 }));
        try {
            await invokeSessionTerminalAction({ actionId: 'session.terminals.split', input: { scopeId, target: { kind: 'terminal_view', machineId: 'machine', terminalId: 'borrowed-drag', terminalKey: 'other', cwd: '/repo' } } });
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.detach', input: { scopeId, terminalId: 'embedded' } })).toEqual({ ok: true });
            const detached = await invokeSessionTerminalAction({ actionId: 'session.terminals.list', input: { scopeId } });
            if (!('workspace' in detached) || !detached.workspace) throw new Error('No workspace');
            expect(detached.workspace.tabs).toHaveLength(2);
            const shellTab = detached.workspace.tabs.find((tab) => tab.terminals[0]?.id === 'embedded');
            expect(shellTab?.id).not.toBe('embedded');
            if (!shellTab) throw new Error('Shell was not detached');
            expect(resolveSessionTerminalIdentity({ scopeId, sessionId: 'session-drag', terminal: shellTab.terminals[0] }).terminalKey).toBe(`${scopeId}:terminal`);
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.reorder', input: { scopeId, tabId: shellTab.id, index: 0 } })).toEqual({ ok: true });
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.list', input: { scopeId } })).toMatchObject({ workspace: { tabs: [{ id: shellTab.id }, { id: 'embedded' }] } });
            expect(machineRpc).not.toHaveBeenCalled();
        } finally { retireMeasurement(); retire(); }
    });
    it('does not remove newly opened shells while close-others is waiting for its PTY stop', async () => {
        const scopeId = 'session:address:home-race:session-race';
        let state = appPaneReduce(createAppPaneState({ maxScopesInMemory: 3 }), { type: 'activateScope', scopeId });
        state = appPaneReduce(state, { type: 'terminalWorkspace', scopeId, command: { type: 'close', terminalId: 'embedded' } });
        for (const id of ['keep', 'stop']) state = appPaneReduce(state, { type: 'terminalWorkspace', scopeId, command: { type: 'open', terminal: {
            id, target: { kind: 'machine_shell', machineId: 'machine-race', cwd: '/repo' },
        } } });
        const retire = registerSessionTerminalWorkspaceOwner({ getState: () => state, dispatch: (action) => { state = appPaneReduce(state, action); } });
        let completeClose: (() => void) | undefined;
        let closeStarted: (() => void) | undefined;
        const started = new Promise<void>((resolve) => { closeStarted = resolve; });
        machineRpc.mockImplementation(async (request: { method: string }) => {
            if (request.method === 'daemon.terminal.list') return { ok: true, terminals: [{ terminalId: 'pty-stop', terminalKey: `${scopeId}:terminal:stop`, cwd: '/repo', ended: false, exit: null }] };
            return await new Promise<{ ok: true }>((resolve) => { completeClose = () => resolve({ ok: true }); closeStarted?.(); });
        });
        try {
            const closing = invokeSessionTerminalAction({ actionId: 'session.terminals.close_others', input: { scopeId, tabId: 'keep' } });
            await started;
            await invokeSessionTerminalAction({ actionId: 'session.terminals.open', input: { scopeId, target: { kind: 'machine_shell', machineId: 'machine-race', cwd: '/new' } } });
            completeClose?.();
            expect(await closing).toEqual({ ok: true });
            const listed = await invokeSessionTerminalAction({ actionId: 'session.terminals.list', input: { scopeId } });
            expect(listed).toMatchObject({ workspace: { tabs: [{ id: 'keep' }, { terminals: [{ target: { cwd: '/new' } }] }] } });
        } finally { retire(); machineRpc.mockReset(); }
    });
    it('stops owned shell PTYs before removing a tab and preserves the tab when close is denied', async () => {
        const scopeId = 'session:address:home-close:session-close';
        let state = appPaneReduce(createAppPaneState({ maxScopesInMemory: 3 }), { type: 'activateScope', scopeId });
        state = appPaneReduce(state, { type: 'terminalWorkspace', scopeId, command: { type: 'open', terminal: {
            id: 'owned-shell', target: { kind: 'machine_shell', machineId: 'machine-close', cwd: '/repo' },
        } } });
        const retire = registerSessionTerminalWorkspaceOwner({ getState: () => state, dispatch: (action) => { state = appPaneReduce(state, action); } });
        const process = { terminalId: 'pty-owned', terminalKey: `${scopeId}:terminal:owned-shell`, cwd: '/repo', ended: false, exit: null };
        let deny = true;
        machineRpc.mockImplementation(async (request: { method: string }) => {
            if (request.method === 'daemon.terminal.list') return { ok: true, terminals: [process] };
            return deny ? { ok: false, errorCode: 'terminal_disabled', error: 'terminal_disabled' } : { ok: true };
        });
        try {
            const before = state;
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.close_tab', input: { scopeId, tabId: 'owned-shell' } }))
                .toMatchObject({ ok: false, errorCode: 'terminal_disabled' });
            expect(state).toBe(before);
            deny = false;
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.close_tab', input: { scopeId, tabId: 'owned-shell' } })).toEqual({ ok: true });
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.list', input: { scopeId } }))
                .toMatchObject({ workspace: { tabs: [{ id: 'embedded' }] } });
            expect(machineRpc).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-close', serverId: 'home-close',
                method: 'daemon.terminal.close', payload: { terminalId: 'pty-owned' } }));
            await invokeSessionTerminalAction({ actionId: 'session.terminals.open', input: { scopeId, target: { kind: 'machine_shell', machineId: 'machine-close', cwd: '/empty' } } });
            const listed = await invokeSessionTerminalAction({ actionId: 'session.terminals.list', input: { scopeId } });
            if (!('workspace' in listed) || !listed.workspace) throw new Error('No workspace');
            const empty = listed.workspace.tabs.at(-1)!.terminals[0];
            const emptyKey = `${scopeId}:terminal:${empty.id}`;
            replaceTerminalSurfaceState(emptyKey, { ...createEmptyTerminalSurfaceState(), terminalId: 'stale-cache-id', output: 'old output' });
            machineRpc.mockImplementation(async () => ({ ok: true, terminals: [] }));
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.close', input: { scopeId, terminalId: empty.id } })).toEqual({ ok: true });
            expect(readTerminalSurfaceState(emptyKey)?.terminalId).toBeNull();
        } finally { retire(); machineRpc.mockReset(); }
    });
    it('requires authoritative ownership on old daemons and only falls back to an observed PTY id', async () => {
        const scopeId = 'session:address:home-legacy:session-legacy';
        let state = appPaneReduce(createAppPaneState({ maxScopesInMemory: 3 }), { type: 'activateScope', scopeId });
        state = appPaneReduce(state, { type: 'terminalWorkspace', scopeId, command: { type: 'open', terminal: {
            id: 'legacy-owned', target: { kind: 'machine_shell', machineId: 'machine-legacy', cwd: '/repo' },
        } } });
        const retire = registerSessionTerminalWorkspaceOwner({ getState: () => state, dispatch: (action) => { state = appPaneReduce(state, action); } });
        machineRpc.mockImplementation(async (request: { method: string }) => {
            if (request.method === 'daemon.terminal.list') throw { rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' };
            return { ok: true };
        });
        try {
            const before = state;
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.close', input: { scopeId, terminalId: 'legacy-owned' } }))
                .toMatchObject({ ok: false, errorCode: 'terminal_close_identity_unavailable' });
            expect(state).toBe(before);
            replaceTerminalSurfaceState(`${scopeId}:terminal:legacy-owned`, { ...createEmptyTerminalSurfaceState(), terminalId: 'observed-pty' });
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.close', input: { scopeId, terminalId: 'legacy-owned' } })).toEqual({ ok: true });
            expect(machineRpc).toHaveBeenCalledWith(expect.objectContaining({ method: 'daemon.terminal.close', payload: { terminalId: 'observed-pty' } }));
        } finally { retire(); machineRpc.mockReset(); }
    });
    it('uses the real AppPane layout for opening, splitting, focusing and closing borrowed views', async () => {
        const scopeId = 'session:address:home-a:session-a';
        let state = appPaneReduce(createAppPaneState({ maxScopesInMemory: 3 }), { type: 'activateScope', scopeId });
        const retire = registerSessionTerminalWorkspaceOwner({ getState: () => state, dispatch: (action) => { state = appPaneReduce(state, action); } });
        let width = 500;
        const retireMeasurement = registerSessionTerminalSplitMeasurements(scopeId, () => ({ availableWidthPx: width, minimumTerminalWidthPx: 320 }));
        try {
            const opened = await invokeSessionTerminalAction({ actionId: 'session.terminals.open', input: { scopeId,
                target: { kind: 'terminal_view', machineId: 'machine', terminalId: 'borrowed-pty', terminalKey: 'another-session', cwd: '/repo', sessionId: 'another-session' } } });
            expect(opened).toMatchObject({ ok: true });
            if (!('terminalId' in opened) || !opened.terminalId) throw new Error('No opened terminal view');
            const terminalId = opened.terminalId;
            const narrowBefore = state;
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.split', input: { scopeId, target: { kind: 'workspace_shell' } } }))
                .toMatchObject({ ok: false, errorCode: 'terminal_split_unavailable' });
            expect(state).toBe(narrowBefore);
            width = 1000;
            const split = await invokeSessionTerminalAction({ actionId: 'session.terminals.split', input: { scopeId, target: { kind: 'workspace_shell' } } });
            expect(split).toMatchObject({ ok: true });
            const current = await invokeSessionTerminalAction({ actionId: 'session.terminals.list', input: { scopeId } });
            if (!('workspace' in current) || !current.workspace) throw new Error('No workspace');
            const root = current.workspace.tabs.find((tab) => tab.id === terminalId)?.root;
            if (root?.kind !== 'split') throw new Error('No split');
            const beforeResize = state;
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.resize', input: { scopeId, tabId: terminalId, splitId: root.id, ratio: 0.8 } }))
                .toMatchObject({ ok: false, errorCode: 'terminal_layout_unmeasured' });
            expect(state).toBe(beforeResize);
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.rename', input: { scopeId, terminalId, title: 'Borrowed' } })).toEqual({ ok: true });
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.focus', input: { scopeId, terminalId } })).toEqual({ ok: true });
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.list_view', input: { scopeId, showList: true } })).toEqual({ ok: true });
            const listed = await invokeSessionTerminalAction({ actionId: 'session.terminals.list', input: { scopeId } });
            expect(listed).toMatchObject({ ok: true, workspace: { showList: true, activeTabId: terminalId, tabs: [
                { id: 'embedded' }, { id: terminalId, focusedTerminalId: terminalId, terminals: [{ id: terminalId, title: 'Borrowed' }, { target: { kind: 'workspace_shell' } }] },
            ] } });
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.close', input: { scopeId, terminalId } })).toEqual({ ok: true });
            const afterClose = await invokeSessionTerminalAction({ actionId: 'session.terminals.list', input: { scopeId } });
            expect(afterClose).toMatchObject({ workspace: { tabs: [{ id: 'embedded' }, { terminals: [{ target: { kind: 'workspace_shell' } }] }] } });
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.close', input: { scopeId, terminalId: 'missing' } }))
                .toMatchObject({ ok: false, errorCode: 'terminal_not_found' });
        } finally { retireMeasurement(); retire(); }
        expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.list', input: { scopeId } }))
            .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    });
    it('runs a script in a fresh tab using only the daemon-owned selection intent', async () => {
        const scopeId = 'session:address:home-a:session-a';
        let state = appPaneReduce(createAppPaneState({ maxScopesInMemory: 3 }), { type: 'activateScope', scopeId });
        const retire = registerSessionTerminalWorkspaceOwner({ getState: () => state, dispatch: (action) => { state = appPaneReduce(state, action); } });
        try {
            const result = await invokeSessionTerminalAction({ actionId: 'session.terminals.run_script', input: { scopeId, machineId: 'machine', cwd: '/repo', runTargetId: 'web:dev' } });
            expect(result).toMatchObject({ ok: true });
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.list', input: { scopeId } })).toMatchObject({ workspace: { tabs: [
                { id: 'embedded' }, { terminals: [{ target: { kind: 'machine_shell', machineId: 'machine', cwd: '/repo', launch: { kind: 'package_script', runTargetId: 'web:dev' } } }] },
            ] } });
            const before = state;
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.open', input: { scopeId: 'session:unqualified', target: { kind: 'workspace_shell' } } }))
                .toMatchObject({ ok: false, errorCode: 'terminal_scope_unavailable' });
            expect(state).toBe(before);
        } finally { retire(); }
    });
});
