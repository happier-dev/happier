import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { resolveSessionListViewContextDefaults } from '@/components/sessions/shell/search/sessionListViewFilters';
import { clearSessionListViewFilterRetentionForTests, useSessionListViewFilters } from '@/components/sessions/shell/search/useSessionListViewFilters';
import { invokeScopeAction, registerSessionListScopeActionOwner, registerShellColumnActionOwner } from './scopeActionFamily';

afterEach(() => { standardCleanup(); clearSessionListViewFilterRetentionForTests(); });

describe('client scope Actions through canonical mounted owners', () => {
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
      React.useEffect(() => registerShellColumnActionOwner(() => read.current()), []);
      return visible;
    });
    await act(async () => { expect(await invokeScopeAction('shell.column.set', { visible: false })).toEqual({ ok: true }); });
    expect(hook.getCurrent()).toBe(false);
    expect(await invokeScopeAction('shell.column.get', {})).toEqual({ present: true, visible: false, available: true });
    const cleanup = registerShellColumnActionOwner(() => ({ present: false, visible: false, available: false, setVisible: () => {} }));
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
