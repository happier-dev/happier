import { describe, expect, it } from 'vitest';
import { appPaneReduce, createAppPaneState } from '@/components/appShell/panes/model/appPaneReducer';
import { SessionTerminalWorkspaceV1Schema } from '@happier-dev/protocol/terminal';
import { EMPTY_TERMINAL_WORKSPACE, selectSessionTerminalWorkspaceHost, selectVisibleSessionTerminalTabs } from './sessionTerminalWorkspace';

const scopeId = 'project:home:checkout';
function openOutput() {
    let state = appPaneReduce(createAppPaneState({ maxScopesInMemory: 3 }), { type: 'activateScope', scopeId });
    state = appPaneReduce(state, { type: 'setBottomTabState', scopeId, tabId: 'terminal', nextState: EMPTY_TERMINAL_WORKSPACE });
    return appPaneReduce(state, { type: 'terminalWorkspace', scopeId, command: { type: 'open', terminal: {
        id: 'output', target: { kind: 'terminal_view', machineId: 'machine', terminalId: 'pty', terminalKey: 'output-key', cwd: '/repo' },
    } } });
}

describe('visible AppPane terminal workspace', () => {
    it('keeps a different Shell in Details while the active tab is docked elsewhere', () => {
        let state = appPaneReduce(openOutput(), { type: 'openDetailsTab', scopeId, openAs: 'pinned', tab: {
            key: 'terminal:output', kind: 'terminal', title: 'Output',
            resource: { kind: 'terminal', terminalInstanceId: 'output' },
        } });
        state = appPaneReduce(state, { type: 'terminalWorkspace', scopeId, command: { type: 'open', terminal: {
            id: 'other', target: { kind: 'workspace_shell' },
        } } });
        expect(selectSessionTerminalWorkspaceHost(state, scopeId)).toBe('bottom');
        expect(selectSessionTerminalWorkspaceHost(state, scopeId, 'other')).toBe('bottom');
        expect(selectSessionTerminalWorkspaceHost(state, scopeId, 'output')).toBe('details');
        const moved = appPaneReduce(state, { type: 'openRight', scopeId, tabId: 'terminal' });
        expect(selectSessionTerminalWorkspaceHost(moved, scopeId, 'other')).toBe('right');
        expect(selectSessionTerminalWorkspaceHost(moved, scopeId, 'output')).toBe('details');
    });
    it('counts page-owned output as visible without a dock, and releases the page fact on blur', () => {
        const opened = openOutput();
        const page = appPaneReduce(opened, { type: 'setTerminalPageActive', scopeId, active: true });
        expect(page.scopes[scopeId].bottom.isOpen).toBe(false);
        expect(selectVisibleSessionTerminalTabs(page, scopeId).map(tab => tab.id)).toEqual(['output']);
        const blurred = appPaneReduce(page, { type: 'setTerminalPageActive', scopeId, active: false });
        expect(selectVisibleSessionTerminalTabs(blurred, scopeId)).toEqual([]);
        expect(blurred.scopes[scopeId].bottom.tabState.terminal).toBe(opened.scopes[scopeId].bottom.tabState.terminal);
    });
    it('keeps the focused Terminal page as host when a desktop dock is replayed under it, and returns the dock on blur', () => {
        // Phone width after a desktop session: the Session URL still carries `bottom=terminal`,
        // and a revealed Session scene replays it after the page took the workspace.
        const page = appPaneReduce(openOutput(), { type: 'setTerminalPageActive', scopeId, active: true });
        const replayed = appPaneReduce(page, { type: 'openBottom', scopeId, tabId: 'terminal' });
        expect(replayed.scopes[scopeId].bottom.isOpen).toBe(true);
        expect(selectSessionTerminalWorkspaceHost(replayed, scopeId)).toBe('page');
        expect(selectSessionTerminalWorkspaceHost(replayed, scopeId, 'output')).toBe('page');
        const blurred = appPaneReduce(replayed, { type: 'setTerminalPageActive', scopeId, active: false });
        expect(selectSessionTerminalWorkspaceHost(blurred, scopeId)).toBe('bottom');
    });
    it('keeps output visible after moving to the sidebar and releases it when that sidebar closes', () => {
        const opened = openOutput();
        const sidebar = appPaneReduce(opened, { type: 'openRight', scopeId, tabId: 'terminal' });
        expect(sidebar.scopes[scopeId].bottom.isOpen).toBe(false);
        expect(selectVisibleSessionTerminalTabs(sidebar, scopeId)).toEqual(selectVisibleSessionTerminalTabs(opened, scopeId));
        const hidden = appPaneReduce(sidebar, { type: 'closeRight', scopeId });
        expect(selectVisibleSessionTerminalTabs(hidden, scopeId)).toEqual([]);
    });
    it('retains hidden output without claiming it is visible, and restores it on reopen', () => {
        const opened = openOutput();
        expect(selectVisibleSessionTerminalTabs(opened, scopeId).map(tab => tab.id)).toEqual(['output']);
        const hidden = appPaneReduce(opened, { type: 'closeBottom', scopeId });
        expect(SessionTerminalWorkspaceV1Schema.parse(hidden.scopes[scopeId].bottom.tabState.terminal).tabs).toHaveLength(1);
        expect(selectVisibleSessionTerminalTabs(hidden, scopeId)).toEqual([]);
        expect(selectVisibleSessionTerminalTabs(appPaneReduce(hidden, { type: 'openBottom', scopeId, tabId: 'terminal' }), scopeId))
            .toEqual(selectVisibleSessionTerminalTabs(opened, scopeId));
    });

    it.each([
        { kind: 'builtin', id: 'tasks' },
        { kind: 'plugin', destination: { pluginId: 'example', localId: 'terminal' } },
    ] as const)('does not claim the terminal is visible under another $kind destination', destination => {
        const selected = appPaneReduce(openOutput(), { type: 'selectBottomDestination', scopeId, destination });
        expect(selected.scopes[scopeId].bottom.isOpen).toBe(true);
        expect(selectVisibleSessionTerminalTabs(selected, scopeId)).toEqual([]);
    });

    it('selects only the active tab but keeps every split member visible', () => {
        let state = appPaneReduce(openOutput(), { type: 'terminalWorkspace', scopeId, command: { type: 'open', terminal: {
            id: 'other', target: { kind: 'terminal_view', machineId: 'machine', terminalId: 'other-pty', terminalKey: 'other-key', cwd: '/repo' },
        } } });
        expect(selectVisibleSessionTerminalTabs(state, scopeId).map(tab => tab.id)).toEqual(['other']);
        state = appPaneReduce(state, { type: 'terminalWorkspace', scopeId, command: { type: 'focus', terminalId: 'output' } });
        state = appPaneReduce(state, { type: 'terminalWorkspace', scopeId, command: { type: 'split', terminal: {
            id: 'split', target: { kind: 'terminal_view', machineId: 'machine', terminalId: 'split-pty', terminalKey: 'split-key', cwd: '/repo' },
        }, availableWidthPx: 1000, minimumTerminalWidthPx: 320 } });
        expect(selectVisibleSessionTerminalTabs(state, scopeId).map(tab => tab.terminals.map(member => member.id)))
            .toEqual([['output', 'split']]);
    });

    it('hides retained tabs when their owning scope leaves, and preserves them when returning', () => {
        const opened = openOutput();
        const elsewhere = appPaneReduce(opened, { type: 'activateScope', scopeId: 'another-project' });
        expect(selectVisibleSessionTerminalTabs(elsewhere, scopeId)).toEqual([]);
        expect(selectVisibleSessionTerminalTabs(appPaneReduce(elsewhere, { type: 'activateScope', scopeId }), scopeId))
            .toEqual(selectVisibleSessionTerminalTabs(opened, scopeId));
        expect(selectVisibleSessionTerminalTabs(elsewhere, 'missing')).toEqual([]);
    });
});
