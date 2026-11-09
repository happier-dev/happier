import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ScopeActionOutputSchemas } from '@happier-dev/protocol/actions/scopeActionFamily';

import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { resolveSessionListViewContextDefaults, type SessionListViewFilters } from '@/components/sessions/shell/search/sessionListViewFilters';
import { clearSessionListViewFilterRetentionForTests, useSessionListViewFilters } from '@/components/sessions/shell/search/useSessionListViewFilters';
import { invokeScopeAction, registerFileEditorActionOwner, registerSessionListScopeActionOwner, registerShellColumnActionOwner } from './scopeActionFamily';
import { createSkillsSurfaceHarness } from '@/dev/testkit/harness/skillsSurfaceHarness';
import { useSettingsColumnFilter } from '@/components/settings/shell/useSettingsColumnFilter';
import { defineSettingsCollectionAdapter } from '@/components/settings/shell/settingsCollectionAdapter';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const queryAdapter = defineSettingsCollectionAdapter(['status']);
const queryFields = { status: { label: 'Status', valueLabel: (value: string) => value } };
const queryFacts = [{ key: 'one', title: 'One', context: null, status: 'enabled', fields: { status: ['enabled'] } }];
// S40 adds its mounted Store case here; all owners share these assertions.
const queryOwnerCases = ['mcp', 'skills', 'agents', 'providers', 'plugins', 'connected-services', 'store'] as const;
function MountedQueryColumn({ column }: { column: typeof queryOwnerCases[number] }) {
  const [query, setQuery] = React.useState('');
  useSettingsColumnFilter({ column, testIDPrefix: 'query-contract', adapter: queryAdapter,
    fields: queryFields, facts: queryFacts,
    ...(column === 'connected-services' ? {} : { search: { value: query, set: setQuery } }),
  });
  return column === 'connected-services' ? null
    : <CompactSearchField testID="query-contract.input" value={query} onChangeText={setQuery} placeholder="Search" />;
}

afterEach(() => { standardCleanup(); clearSessionListViewFilterRetentionForTests(); });

describe('client scope Actions through canonical mounted owners', () => {
  it('keeps a parent page control addressed while an embedded Session borrows the presented column', async () => {
    let parent = 'session';
    let embedded = 'chat';
    let sideVisible = false;
    const unregister = registerShellColumnActionOwner('main', () => ({ present: true, visible: true, available: true,
      tabs: ['chat', 'code'], activeTab: embedded, selectTab: tab => { embedded = tab; }, setVisible: () => {} }));
    const unregisterSide = registerShellColumnActionOwner('side', () => ({ present: true, visible: sideVisible, available: true,
      setVisible: visible => { sideVisible = visible; } }));
    const owner = { kind: 'shell.columns' as const, columns: { main: () => ({ present: true, visible: true, available: true,
      tabs: ['overview', 'session'], activeTab: parent, selectTab: (tab: string) => { parent = tab; }, setVisible: () => {} }) } };
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
      scopeAction: ({ actionId, input, context }) => invokeScopeAction(actionId, input, context, owner),
    }));
    try {
      // The presented Session correctly refuses an Overview it does not own.
      expect(await invokeScopeAction('shell.column.set', { column: 'main', visible: true, tab: 'overview' }))
        .toMatchObject({ ok: false, errorCode: 'client_control_unavailable' });
      expect(await executor.execute('shell.column.set', { column: 'main', visible: true, tab: 'overview' }, { surface: 'ui' }))
        .toMatchObject({ ok: true });
      expect(parent).toBe('overview');
      expect(embedded).toBe('chat');
      expect(await executor.execute('shell.column.set', { column: 'main', visible: true, tab: 'missing' }, { surface: 'ui' }))
        .toMatchObject({ ok: false });
      // The page lends only its main owner; other columns keep their presented target.
      expect(await executor.execute('shell.column.set', { column: 'side', visible: true }, { surface: 'ui' }))
        .toMatchObject({ ok: true });
      expect(sideVisible).toBe(true);
      expect(parent).toBe('overview');
    } finally { unregisterSide(); unregister(); }
  });
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
  it.each(queryOwnerCases)('settings.column.filter.get: returns the current mounted query when supported (%s)', async column => {
    const home = await createSkillsSurfaceHarness('https://mounted-column-query.test');
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
      scopeAction: ({ actionId, input, context }) => invokeScopeAction(actionId, input, context),
    }));
    const target = { column, ...home.scope };
    const context = { surface: 'agent', serverId: home.scope.serverId, runtimeAccountId: home.scope.accountId } as const;
    const tree = (active: boolean) => <PluginSurfaceFocusEligibilityProvider active={active} presentationActive={active}>
      <MountedQueryColumn column={column} />
    </PluginSurfaceFocusEligibilityProvider>;
    const screen = await renderScreen(tree(true));
    const get = () => executor.execute('settings.column.filter.get', target, context);
    const filters = { status: { include: ['enabled'], exclude: [] } };
    try {
      const supported = column !== 'connected-services';
      const expected = (query: string, conditions = {}) => ({ ok: true, result: {
        ...target, filters: conditions, matchedCount: 1, coverage: 'complete', ...(supported ? { searchQuery: query } : {}),
      } });
      expect(await get()).toEqual(expected(''));
      if (supported) {
        await act(async () => screen.findHostByTestId('query-contract.input')!.props.onChangeText('typed query'));
        expect(await get()).toEqual(expected('typed query'));
      }
      await act(async () => {
        expect(await executor.execute('settings.column.filter.set', { ...target, filters }, context))
          .toEqual({ ok: true, result: { ok: true } });
      });
      expect(await get()).toEqual(expected(supported ? 'typed query' : '', filters));
      await act(async () => {
        expect(await executor.execute('settings.column.filter.set', { ...target, filters: {}, searchQuery: 'agent query' }, context))
          .toMatchObject(supported ? { ok: true } : { ok: false, errorCode: 'client_control_unavailable' });
      });
      expect(await get()).toEqual(expected('agent query', supported ? {} : filters));
      if (supported) {
        expect(screen.findHostByTestId('query-contract.input')!.props.value).toBe('agent query');
        await act(async () => {
          expect(await executor.execute('settings.column.filter.set', { ...target,
            filters: { foreign: { include: ['unknown'], exclude: [] } }, searchQuery: 'must not apply',
          }, context)).toMatchObject({ ok: false, errorCode: 'client_control_unavailable' });
        });
        expect(await get()).toEqual(expected('agent query'));
        await act(async () => { await executor.execute('settings.column.filter.set', { ...target, filters }, context); });
        await act(async () => { await executor.execute('settings.column.filter.clear', target, context); });
        expect(await get()).toEqual(expected('agent query'));
        await act(async () => { await executor.execute('settings.column.filter.set', { ...target, filters: {}, searchQuery: '' }, context); });
        expect(await get()).toEqual(expected(''));
        expect(screen.findHostByTestId('query-contract.input')!.props.value).toBe('');
      }
      await screen.update(tree(false));
      expect(await get()).toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
      await screen.update(<>{tree(true)}{tree(true)}</>);
      expect(await get()).toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
    } finally { await screen.unmount(); await home.dispose(); }
    expect(await get()).toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
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
        spacesReady: true, spaceSettingsScope: { serverId: 'home-a', accountId: 'account-a' },
        selectedSpaceId: 'my-work', coverage: 'complete',
        includeInactive: true, setIncludeInactive: () => {}, setSource: (source: SessionListViewFilters['source']) => ref.current.updateFilters((filters) => ({ ...filters, source })),
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
    expect(await executor.execute('session.list.view.set', { filters: { extensions: { 'test.retired/stage': { kind: 'boolean', value: true } } } }, { surface: 'ui' }))
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
      selectedSpaceId: 'my-work', coverage: 'complete' as const,
      spacesReady: true, spaceSettingsScope: { serverId: 'home-a', accountId: 'account-a' },
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

  it('refuses a different Account or unreadable saved-space authority without mutating the retained Session draft', async () => {
    const context = resolveSessionListViewContextDefaults({ kind: 'global' }, ['home-a'], 'all');
    let spacesReady = true;
    const hook = await renderHook(() => useSessionListViewFilters({ ...context,
      accountScopeResolutions: new Map([['home-a', { kind: 'bound', scope: { serverId: 'home-a', accountId: 'account-a' } }]]),
    }));
    const cleanup = registerSessionListScopeActionOwner(() => ({ ...hook.getCurrent(), viewContext: { kind: 'global' },
      viewContextKey: context.contextKey, corpusStorage: 'active', retentionScopeKey: 'credential-a', includeInactive: true,
      selectedSpaceId: 'my-work', coverage: 'complete', spacesReady,
      spaceSettingsScope: { serverId: 'home-a', accountId: 'account-a' },
      queryEnabled: true, followingAvailable: true, sourceAvailable: true, homeOptions: [{ serverId: 'home-a', label: 'A' }],
    }));
    const before = hook.getCurrent().filters;
    try {
      expect(await invokeScopeAction('session.list.view.set', { filters: { source: 'direct' } }, { serverId: 'home-a', runtimeAccountId: 'account-b' }))
        .toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
      expect(await invokeScopeAction('session.list.view.get', {}, { serverId: 'home-b', runtimeAccountId: 'account-a' }))
        .toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
      spacesReady = false;
      expect(await invokeScopeAction('session.list.view.set', { filters: { source: 'direct' } }))
        .toMatchObject({ ok: false, errorCode: 'client_control_unavailable' });
      expect(await invokeScopeAction('session.list.view.reset', {})).toMatchObject({ ok: false, errorCode: 'client_control_unavailable' });
      expect(hook.getCurrent().filters).toBe(before);
    } finally { cleanup(); await hook.unmount(); }
  });
});
