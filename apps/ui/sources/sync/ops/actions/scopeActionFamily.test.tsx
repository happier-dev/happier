import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol';
import { ScopeActionOutputSchemas } from '@happier-dev/protocol/actions/scopeActionFamily';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { resolveSessionListViewContextDefaults } from '@/components/sessions/shell/search/sessionListViewFilters';
import { clearSessionListViewFilterRetentionForTests, useSessionListViewFilters } from '@/components/sessions/shell/search/useSessionListViewFilters';
import { invokeScopeAction, registerFileEditorActionOwner, registerSessionListScopeActionOwner, registerShellColumnActionOwner } from './scopeActionFamily';

afterEach(() => { standardCleanup(); clearSessionListViewFilterRetentionForTests(); });

describe('client scope Actions through canonical mounted owners', () => {
  it('reads and selects a mounted main page through one admitted Action effect', async () => {
    let activeTab = 'chat';
    let selections = 0;
    const setVisible = vi.fn();
    const items = [{ id: 'chat', label: 'Chat', available: true, placement: 'pinned' as const, pageKind: 'session' },
      { id: 'info', label: 'Info', available: true, placement: 'pinned' as const, pageKind: 'session' }];
    const unregister = registerShellColumnActionOwner('main', () => ({ present: true, visible: true, available: true,
      tabs: items.map(item => item.id), items, activeTab, selectTab: tab => { activeTab = tab; selections++; }, setVisible }));
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ scopeAction: ({ actionId, input }) => invokeScopeAction(actionId, input) }));
    try {
      expect(await executor.execute('shell.column.get', { column: 'main' }, { surface: 'ui' })).toMatchObject({ ok: true, result: { items, activeTab: 'chat' } });
      expect(selections).toBe(0);
      expect(await executor.execute('shell.column.set', { column: 'main', visible: true, tab: 'info' }, { surface: 'ui' })).toMatchObject({ ok: true });
      expect(activeTab).toBe('info');
      expect(selections).toBe(1);
      expect(setVisible).not.toHaveBeenCalled();
      expect(await executor.execute('shell.column.set', { column: 'main', visible: true, tab: 'missing' }, { surface: 'ui' })).toMatchObject({ ok: false });
      expect(selections).toBe(1);
    } finally { unregister(); }
  });
  it('routes mounted editor commands through the executor, targets tabs, and releases retired owners', async () => {
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ scopeAction: ({ actionId, input }) => invokeScopeAction(actionId, input) }));
    // Exercise the approved execution path; the protocol suite separately proves Ask-first defaults.
    const approvedContext = { surface: 'ui', authority: 'present_user', bypassApprovals: true } as const;
    const executeSave = (tabId?: string) => executor.execute('file.editor.save', tabId ? { tabId } : {}, approvedContext);
    expect(await executeSave()).toEqual({ ok: true, result: { status: 'unavailable' } });
    let selectedResolution: string | null = null;
    const cleanFirst = registerFileEditorActionOwner(() => ({ tabId: 'first', serverId: 'home-a', accountId: 'account-a', save: async () => ({ status: 'clean', hash: 'base' }),
      resolve: async () => ({ status: 'unavailable' }) }));
    const cleanSecond = registerFileEditorActionOwner(() => ({ tabId: 'second', serverId: 'home-b', accountId: 'account-b', save: async () => ({ status: 'conflict' }),
      resolve: async resolution => { selectedResolution = resolution; return { status: 'resolved', hash: 'resolved' }; } }));
    try {
      expect(await executeSave()).toEqual({ ok: true, result: { status: 'conflict' } });
      expect(await executeSave('first')).toEqual({ ok: true, result: { status: 'clean', hash: 'base' } });
      expect(await executeSave('missing')).toEqual({ ok: true, result: { status: 'unavailable' } });
      expect(await invokeScopeAction('file.editor.save', {}, { serverId: 'home-a', runtimeAccountId: 'account-a' }))
        .toEqual({ status: 'clean', hash: 'base' });
      expect(await invokeScopeAction('file.editor.save', { tabId: 'second' }, { serverId: 'home-a', runtimeAccountId: 'account-a' }))
        .toEqual({ status: 'unavailable' });
      expect(await invokeScopeAction('file.editor.resolve', { tabId: 'first', resolution: 'discardDraft' }, { runtimeAccountId: 'account-b' }))
        .toEqual({ status: 'unavailable' });
      const cleanSameTabInAnotherScope = registerFileEditorActionOwner(() => ({ tabId: 'first', serverId: 'home-b', accountId: 'account-b',
        save: async () => ({ status: 'saved', hash: 'other-account' }), resolve: async () => ({ status: 'unavailable' }) }));
      try {
        expect(await invokeScopeAction('file.editor.save', { tabId: 'first' }, { serverId: 'home-a', runtimeAccountId: 'account-a' }))
          .toEqual({ status: 'clean', hash: 'base' });
        expect(await invokeScopeAction('file.editor.save', { tabId: 'first' }, { serverId: 'home-b', runtimeAccountId: 'account-b' }))
          .toEqual({ status: 'saved', hash: 'other-account' });
      } finally { cleanSameTabInAnotherScope(); }
      const resolved = await executor.execute('file.editor.resolve', { resolution: 'useTheirs', tabId: 'second' }, approvedContext);
      expect(resolved).toEqual({ ok: true, result: { status: 'resolved', hash: 'resolved' } });
      expect(selectedResolution).toBe('useTheirs');
      expect(ScopeActionOutputSchemas['file.editor.resolve'].parse(resolved.ok ? resolved.result : null)).toEqual({ status: 'resolved', hash: 'resolved' });
      const cleanReplacement = registerFileEditorActionOwner(() => ({ tabId: 'second', serverId: 'home-b', accountId: 'account-b', save: async () => ({ status: 'saved', hash: 'written' }),
        resolve: async () => ({ status: 'unavailable' }) }));
      try {
        cleanSecond();
        expect(await executeSave('second')).toEqual({ ok: true, result: { status: 'saved', hash: 'written' } });
      } finally { cleanReplacement(); }
      expect(await executeSave('second')).toEqual({ ok: true, result: { status: 'unavailable' } });
      expect(await executeSave()).toEqual({ ok: true, result: { status: 'clean', hash: 'base' } });
    } finally { cleanFirst(); cleanSecond(); }
    expect(await executeSave()).toEqual({ ok: true, result: { status: 'unavailable' } });
  });
  it('routes columns independently through the executor, selects offered tabs and rejects unavailable controls', async () => {
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ scopeAction: ({ actionId, input }) => invokeScopeAction(actionId, input) }));
    let navigationVisible = true;
    let mainVisible = true;
    let sideVisible = false;
    let activeTab = 'files';
    const cleanups = [
      registerShellColumnActionOwner('navigation', () => ({ present: true, available: true, visible: navigationVisible, setVisible: value => { navigationVisible = value; } })),
      registerShellColumnActionOwner('main', () => ({ present: true, available: true, visible: mainVisible, label: 'Hide session', setVisible: value => { mainVisible = value; } })),
      registerShellColumnActionOwner('side', () => ({ present: true, available: true, visible: sideVisible, tabs: ['files', 'plugin:notes'], activeTab,
        selectTab: tab => { activeTab = tab; sideVisible = true; }, setVisible: value => { sideVisible = value; } })),
    ];
    try {
      expect(await executor.execute('shell.column.set', { column: 'main', visible: false }, { surface: 'agent' })).toEqual({ ok: true, result: { ok: true } });
      expect(mainVisible).toBe(false);
      expect(navigationVisible).toBe(true);
      expect(await executor.execute('shell.column.set', { column: 'side', visible: false, tab: 'plugin:notes' }, { surface: 'mcp' })).toEqual({ ok: true, result: { ok: true } });
      expect(sideVisible).toBe(true);
      expect(activeTab).toBe('plugin:notes');
      const observed = await invokeScopeAction('shell.column.get', { column: 'side' });
      expect(ScopeActionOutputSchemas['shell.column.get'].parse(observed)).toMatchObject({ visible: true, activeTab: 'plugin:notes' });
      expect(await executor.execute('shell.column.set', { column: 'side', visible: true, tab: 'missing' }, { surface: 'ui' })).toMatchObject({ ok: false, errorCode: 'client_control_unavailable' });
      expect(activeTab).toBe('plugin:notes');
      expect(await invokeScopeAction('shell.column.set', { visible: false, tab: 'files' })).toMatchObject({ ok: false, errorCode: 'client_control_unavailable' });
    } finally { cleanups.forEach(cleanup => cleanup()); }
    expect(await invokeScopeAction('shell.column.get', { column: 'main' })).toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
  });
  it('changes the real retained filter model, preserves other facets, resets and retires at unmount', async () => {
    // The UI host is the system boundary; internal filtering and Action admission remain real.
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ scopeAction: ({ actionId, input }) => invokeScopeAction(actionId, input) }));
    const viewContext = { kind: 'global' } as const;
    let retentionScopeKey = 'credential-a';
    const context = resolveSessionListViewContextDefaults(viewContext, ['home-a', 'home-b'], 'all');
    const hook = await renderHook(() => {
      const retained = useSessionListViewFilters({ ...context, viewContext,
        accountScopeResolutions: new Map([['home-a', { kind: 'bound', scope: { serverId: 'home-a', accountId: 'account-a' } }]]),
      });
      const ref = React.useRef(retained);
      ref.current = retained;
      React.useEffect(() => registerSessionListScopeActionOwner(() => ({
        ...ref.current, viewContext, viewContextKey: context.contextKey, corpusStorage: 'active',
        retentionScopeKey,
        includeInactive: true, setIncludeInactive: () => {}, setSource: (source) => ref.current.updateFilters((filters) => ({ ...filters, source })),
        queryEnabled: true, followingAvailable: true, sourceAvailable: true,
        homeOptions: [{ serverId: 'home-a', label: 'A' }, { serverId: 'home-b', label: 'B' }],
      })), []);
      return retained;
    });
    await act(async () => hook.getCurrent().setSearchQuery('retained search'));
    await act(async () => {
      expect(await executor.execute('session.list.view.set', { filters: { scope: 'assigned_to_me',
        show: 'runs', startedBy: ['agents', 'triggers'],
        homeServerIds: ['home-a', 'home-a'], tagIds: [{ serverId: 'home-a', tagId: 'urgent' }] } }, { surface: 'agent' })).toEqual({ ok: true, result: { ok: true } });
    });
    expect(hook.getCurrent().filters).toMatchObject({ scope: 'assigned_to_me', show: 'runs', startedBy: ['agents', 'triggers'], homeServerIds: ['home-a'], searchQuery: 'retained search' });
    await act(async () => {
      expect(await executor.execute('session.list.view.set', { filters: { scope: 'involving_me' } }, { surface: 'agent' }))
        .toEqual({ ok: true, result: { ok: true } });
    });
    expect(hook.getCurrent().filters).toMatchObject({ scope: 'involving_me', show: 'runs', startedBy: ['agents', 'triggers'], searchQuery: 'retained search' });
    expect(await executor.execute('session.list.view.get', {}, { surface: 'mcp' })).toMatchObject({ ok: true, result: { filters: hook.getCurrent().filters } });
    const before = hook.getCurrent().filters;
    expect(await executor.execute('session.list.view.set', { filters: { scope: 'not-a-scope' } }, { surface: 'ui' }))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(await executor.execute('session.list.view.set', { view: { kind: 'team', serverId: 'home-a', teamId: 'team-a' }, filters: { scope: 'all_accessible' } }, { surface: 'ui' }))
      .toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
    expect(await executor.execute('session.list.view.set', { filters: { homeServerIds: ['unknown-home'] } }, { surface: 'ui' }))
      .toMatchObject({ ok: false, errorCode: 'client_control_unavailable' });
    expect(hook.getCurrent().filters).toBe(before);
    await act(async () => {
      expect(await executor.execute('session.list.view.reset', {}, { surface: 'ui' }))
        .toEqual({ ok: true, result: { ok: true } });
    });
    expect(hook.getCurrent().filters).toEqual(context.defaults);
    retentionScopeKey = 'credential-b';
    expect(await executor.execute('session.list.view.get', {}, { surface: 'ui' }))
      .toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
    await hook.unmount();
    expect(await invokeScopeAction('session.list.view.set', { filters: { scope: 'all_accessible' } })).toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
  });

  it('changes the mounted column owner and prevents an older cleanup from retiring its replacement', async () => {
    const hook = await renderHook(() => {
      const [visible, setVisible] = React.useState(true);
      const read = React.useRef(() => ({ present: true, visible, available: true, setVisible }));
      read.current = () => ({ present: true, visible, available: true, setVisible });
      React.useEffect(() => registerShellColumnActionOwner('navigation', () => read.current()), []);
      return visible;
    });
    await act(async () => { expect(await invokeScopeAction('shell.column.set', { visible: false })).toEqual({ ok: true }); });
    expect(hook.getCurrent()).toBe(false);
    expect(await invokeScopeAction('shell.column.get', {})).toEqual({ present: true, visible: false, available: true });
    const cleanup = registerShellColumnActionOwner('navigation', () => ({ present: false, visible: false, available: false, setVisible: () => {} }));
    await hook.unmount();
    expect(await invokeScopeAction('shell.column.get', {})).toEqual({ present: false, visible: false, available: false });
    expect(await invokeScopeAction('shell.column.set', { visible: true })).toMatchObject({ ok: false });
    cleanup();
  });

  it('keeps the replacement Sessions control authoritative when a duplicate control cleans up', async () => {
    const context = resolveSessionListViewContextDefaults({ kind: 'global' }, ['home-a'], 'all');
    const hook = await renderHook(() => useSessionListViewFilters({ ...context,
      accountScopeResolutions: new Map([['home-a', { kind: 'bound', scope: { serverId: 'home-a', accountId: 'account-a' } }]]),
    }));
    const read = () => ({ ...hook.getCurrent(), viewContext: { kind: 'global' as const }, viewContextKey: context.contextKey,
      corpusStorage: 'active' as const, retentionScopeKey: 'credential-a', includeInactive: true,
      setIncludeInactive: () => {}, setSource: () => {}, queryEnabled: true, followingAvailable: true, sourceAvailable: true,
      homeOptions: [{ serverId: 'home-a', label: 'A' }],
    });
    const cleanOlder = registerSessionListScopeActionOwner(read);
    const cleanReplacement = registerSessionListScopeActionOwner(() => read());
    cleanOlder();
    await act(async () => { expect(await invokeScopeAction('session.list.view.set', { filters: { scope: 'involving_me' } })).toEqual({ ok: true }); });
    expect(hook.getCurrent().filters.scope).toBe('involving_me');
    cleanReplacement();
    await hook.unmount();
    expect(await invokeScopeAction('session.list.view.get', {})).toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
  });
});
