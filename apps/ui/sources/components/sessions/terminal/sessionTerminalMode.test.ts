import { describe, expect, it } from 'vitest';
import { appPaneReduce, createAppPaneState } from '@/components/appShell/panes/model/appPaneReducer';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { readSessionTerminalMode, resolveSessionTerminalIdentity, setSessionTerminalMode } from './sessionTerminalMode';
import { registerSessionTerminalWorkspaceOwner, readSessionTerminalWorkspaceForScope } from './sessionTerminalWorkspaceRuntime';

describe('legacy terminal mode adapter', () => {
    it('does not admit an unresolved instance reference as an owned shell', () => {
        const identity = resolveSessionTerminalIdentity({ sessionId: 'closed', scopeId: createSessionPaneScopeId('closed', 'home-mode'), terminalInstanceId: 'closed-instance' });
        expect(identity.available).toBe(false);
        expect(identity).toMatchObject({ terminalId: null });
        expect(resolveSessionTerminalIdentity({ sessionId: 'closed', scopeId: createSessionPaneScopeId('closed', 'home-mode'), terminalInstanceId: 'stale-reference', terminal: { id: 'live', target: { kind: 'workspace_shell' } } })).toMatchObject({ available: true, terminalId: 'live' });
    });
    it('opens the requested target only in the supplied destination scope for duplicate Session tabs', () => {
        const firstScope = createSessionPaneScopeId('same-session', 'home-mode', 'a');
        const secondScope = createSessionPaneScopeId('same-session', 'home-mode', 'b');
        let state = createAppPaneState({ maxScopesInMemory: 3 });
        state = appPaneReduce(state, { type: 'activateScope', scopeId: firstScope });
        state = appPaneReduce(state, { type: 'activateScope', scopeId: secondScope });
        const first = state.scopes[firstScope];
        const unregister = registerSessionTerminalWorkspaceOwner({ getState: () => state, dispatch: (action) => { state = appPaneReduce(state, action); } });
        try {
            setSessionTerminalMode('same-session', 'session_attach', 'home-mode', secondScope);
            expect(readSessionTerminalWorkspaceForScope(secondScope)?.activeTabId).toBe('session-attach');
            expect(state.scopes[firstScope]).toBe(first);
            expect(state.scopes[createSessionPaneScopeId('same-session', 'home-mode')]).toBeUndefined();
        } finally { unregister(); }
    });
    it('opens the requested agent target before a session scope has been activated', () => {
        let state = createAppPaneState({ maxScopesInMemory: 3 });
        const unregister = registerSessionTerminalWorkspaceOwner({ getState: () => state, dispatch: (action) => { state = appPaneReduce(state, action); } });
        try {
            setSessionTerminalMode('header-open', 'session_attach', 'home-mode');
            expect(readSessionTerminalWorkspaceForScope(createSessionPaneScopeId('header-open', 'home-mode'))).toMatchObject({ activeTabId: 'session-attach' });
        } finally { unregister(); }
    });
    it('selects retained target tabs through the pane owner instead of hiding an independent mode', () => {
        const scopeId = createSessionPaneScopeId('mode-adapter', 'home-mode');
        let state = appPaneReduce(createAppPaneState({ maxScopesInMemory: 3 }), { type: 'activateScope', scopeId });
        const unregister = registerSessionTerminalWorkspaceOwner({ getState: () => state, dispatch: (action) => { state = appPaneReduce(state, action); } });
        try {
            setSessionTerminalMode('mode-adapter', 'session_attach', 'home-mode');
            expect(readSessionTerminalWorkspaceForScope(scopeId)).toMatchObject({ activeTabId: 'session-attach', tabs: [
                { id: 'embedded', terminals: [{ target: { kind: 'workspace_shell' } }] },
                { id: 'session-attach', terminals: [{ target: { kind: 'session_attach' } }] },
            ] });
            setSessionTerminalMode('mode-adapter', 'workspace_shell', 'home-mode');
            expect(readSessionTerminalWorkspaceForScope(scopeId)?.tabs).toHaveLength(2);
            expect(readSessionTerminalMode('mode-adapter', 'home-mode')).toBe('workspace_shell');
            state = appPaneReduce(state, { type: 'terminalWorkspace', scopeId, command: { type: 'focus', terminalId: 'session-attach' } });
            expect(readSessionTerminalMode('mode-adapter', 'home-mode')).toBe('session_attach');
        } finally { unregister(); }
    });
});
