import { describe, expect, it } from 'vitest';
import { appPaneReduce, createAppPaneState } from '@/components/appShell/panes/model/appPaneReducer';
import { invokeSessionTerminalAction } from './sessionTerminalActions';
import { registerSessionTerminalWorkspaceOwner } from './sessionTerminalWorkspaceRuntime';

describe('supervised service terminal presentation', () => {
    it('returns, focuses and updates the same Action member after an explicit service restart', async () => {
        const scopeId = 'session:address:home-services:session-services';
        let state = appPaneReduce(createAppPaneState({ maxScopesInMemory: 3 }), { type: 'activateScope', scopeId });
        const retire = registerSessionTerminalWorkspaceOwner({ getState: () => state,
            dispatch: action => { state = appPaneReduce(state, action); } });
        const target = { kind: 'terminal_view' as const, machineId: 'machine', terminalKey: 'declaration',
            terminalId: 'first-process', cwd: '/repo', interactive: true as const };
        try {
            const opened = await invokeSessionTerminalAction({ actionId: 'session.terminals.open', input: { scopeId, target } });
            if (!('terminalId' in opened) || !opened.terminalId) throw new Error('Service view did not open');
            const retainedId = opened.terminalId;
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.open', input: { scopeId, target } }))
                .toMatchObject({ ok: true, terminalId: retainedId });
            const other = await invokeSessionTerminalAction({ actionId: 'session.terminals.open',
                input: { scopeId, target: { ...target, machineId: 'other-machine', terminalId: 'other-process' } } });
            expect(other).toMatchObject({ ok: true });
            expect('terminalId' in other ? other.terminalId : undefined).not.toBe(retainedId);
            const replacement = { ...target, terminalId: 'replacement-process' };
            expect(await invokeSessionTerminalAction({ actionId: 'session.terminals.open', input: { scopeId, target: replacement } }))
                .toMatchObject({ ok: true, terminalId: retainedId });
            const listed = await invokeSessionTerminalAction({ actionId: 'session.terminals.list', input: { scopeId } });
            if (!('workspace' in listed) || !listed.workspace) throw new Error('Service workspace is unavailable');
            const serviceTabs = listed.workspace.tabs.filter(tab => tab.terminals.some(member => member.target.kind === 'terminal_view'));
            expect(serviceTabs).toHaveLength(2);
            const retainedTab = serviceTabs.find(tab => tab.terminals.some(member => member.id === retainedId));
            expect(retainedTab).toMatchObject({ focusedTerminalId: retainedId, terminals: [{ id: retainedId, target: replacement }] });
            expect(listed.workspace.activeTabId).toBe(retainedTab?.id);
        } finally { retire(); }
    });
});
