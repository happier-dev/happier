import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import { ScopeActionOutputSchemas } from '@happier-dev/protocol/actions/scopeActionFamily';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { invokeScopeAction, registerShellColumnActionOwner } from '@/sync/ops/actions/scopeActionFamily';
import { RightSidebarActionsContext, openRightSidebarBuiltinTab, toggleRightSidebarTab, usePublishRightSidebarActions, type RightSidebarActions } from './rightSidebarActions';
import { getRightSidebarBuiltinTab, resolveSessionRightSidebarTabs } from './rightSidebarTabRegistry';
import { appPaneReduce, createAppPaneState } from '@/components/appShell/panes/model/appPaneReducer';

afterEach(standardCleanup);

describe('catalog-directed tab opening', () => {
  it('honors an explicit companion request for a resolved both destination', () => {
    const tab = resolveSessionRightSidebarTabs({ arrangement: 'editor' }).find(tab => tab.id === 'agents');
    if (!tab || tab.owner !== 'builtin') throw new Error('Work must be admitted');
    let presentation: boolean | undefined;
    openRightSidebarBuiltinTab({ openRight: options => { presentation = options?.present !== false; }, setMainTab: () => { throw new Error('Companion request selected main'); } },
      tab, { scope: 'session', arrangement: 'editor' }, () => {}, 'side');
    expect(presentation).toBe(true);
  });
  it('keeps main selection independent while opening and closing a companion', () => {
    const scopeId = 'session:placement';
    let state = appPaneReduce(createAppPaneState({ maxScopesInMemory: 12 }), { type: 'activateScope', scopeId });
    state = appPaneReduce(state, { type: 'setMainHidden', scopeId, hidden: true });
    let presented = false;
    const pane = { openRight: (options?: { tabId?: string; present?: boolean }) => {
      state = appPaneReduce(state, { type: 'openRight', scopeId, tabId: options?.tabId });
      presented = options?.present !== false;
    }, setMainTab: (tabId: string | null) => {
      state = appPaneReduce(state, { type: 'setMainTab', scopeId, tabId });
    } };
    const showMain = () => { state = appPaneReduce(state, { type: 'setMainHidden', scopeId, hidden: false }); };
    const agents = resolveSessionRightSidebarTabs({ arrangement: 'editor' }).find(tab => tab.id === 'agents');
    if (!agents || agents.owner !== 'builtin') throw new Error('Work must be admitted');
    openRightSidebarBuiltinTab(pane, agents, { scope: 'session', arrangement: 'editor' }, showMain);
    expect(state.scopes[scopeId]).toMatchObject({ mainHidden: false, mainTabId: 'agents', right: { isOpen: false } });
    state = appPaneReduce(state, { type: 'closeRight', scopeId });
    expect(state.scopes[scopeId]).toMatchObject({ mainTabId: 'agents', right: { isOpen: false } });
    openRightSidebarBuiltinTab(pane, getRightSidebarBuiltinTab('files'), { scope: 'session', arrangement: 'editor' }, showMain);
    expect(state.scopes[scopeId]?.right).toMatchObject({ isOpen: true, activeTabId: 'files' });
    expect(state.scopes[scopeId]?.mainTabId).toBe('agents');
    expect(presented).toBe(true);
  });

  it('returns from session context without closing the editor when its side overlay is covered', () => {
    const scopeId = 'session:placement';
    let state = appPaneReduce(createAppPaneState({ maxScopesInMemory: 12 }), { type: 'openRight', scopeId, tabId: 'agents' });
    state = appPaneReduce(state, { type: 'openDetailsTab', scopeId, openAs: 'pinned', tab: {
      key: 'file:source.ts', kind: 'file', title: 'source.ts', resource: { path: 'source.ts' },
    } });
    const details = state.scopes[scopeId]!.details;
    toggleRightSidebarTab({
      scopeState: { right: state.scopes[scopeId]!.right },
      closeRight: () => { state = appPaneReduce(state, { type: 'closeRight', scopeId }); },
      closeDetails: () => { state = appPaneReduce(state, { type: 'closeDetails', scopeId }); },
    }, 'agents', 'agents', tabId => { state = appPaneReduce(state, { type: 'openRight', scopeId, tabId }); }, true, 'main');
    expect(state.scopes[scopeId]!.right).toMatchObject({ isOpen: false, activeTabId: 'agents' });
    expect(state.scopes[scopeId]!.details).toBe(details);
  });
});

describe('mounted right-sidebar Action publication', () => {
  it('uses the current catalog and chooser through the column owner and withdraws on unmount', async () => {
    let selected = 'files';
    let available = ['files', 'plugin:notes'];
    const publication = { current: null as RightSidebarActions | null };
    function Rail() {
      usePublishRightSidebarActions({ tabs: available, activeTab: selected, selectTab: tab => { selected = tab; } });
      return null;
    }
    const read = () => ({ present: true, visible: false, available: publication.current !== null,
      ...publication.current, setVisible: () => {} });
    const cleanup = registerShellColumnActionOwner('side', read);
    const screen = await renderScreen(<RightSidebarActionsContext.Provider value={publication}><Rail /></RightSidebarActionsContext.Provider>);
    try {
      expect(await invokeScopeAction('shell.column.set', { column: 'side', visible: true, tab: 'plugin:notes' })).toEqual({ ok: true });
      expect(selected).toBe('plugin:notes');
      available = ['files'];
      await act(async () => { screen.update(<RightSidebarActionsContext.Provider value={publication}><Rail /></RightSidebarActionsContext.Provider>); });
      const result = ScopeActionOutputSchemas['shell.column.get'].parse(await invokeScopeAction('shell.column.get', { column: 'side' }));
      expect(result.tabs).toEqual(['files']);
      expect(await invokeScopeAction('shell.column.set', { column: 'side', visible: true, tab: 'plugin:notes' })).toMatchObject({ ok: false, errorCode: 'client_control_unavailable' });
      await act(async () => { screen.unmount(); });
      expect(publication.current).toBeNull();
      expect(await invokeScopeAction('shell.column.set', { column: 'side', visible: true })).toMatchObject({ ok: false, errorCode: 'client_control_unavailable' });
    } finally { cleanup(); }
  });
});
