import * as React from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  usePluginCollectionQuery,
  usePluginAccountSettings,
  usePluginUiDataClient,
  usePluginUiDataClientOrNull,
  type PluginUiCollectionQueryPager,
  type PluginUiCollectionQuerySnapshot,
  type PluginUiDataClient,
} from './index.js';
import { createUnavailablePluginUiAccountKv } from './accountKv.js';
import { createUnavailablePluginUiAccountSettings } from './accountSettings.js';
import { PluginUiDataProviderInternal } from './context.js';
import { mountThroughReactNativeWebAsync } from '../rnwMount.testSupport.js';

type MutablePagerSnapshot = Readonly<{
  rows: PluginUiCollectionQuerySnapshot['rows'];
  hasMore: boolean;
  status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';
}>;

function createPager(initialSnapshot: PluginUiCollectionQuerySnapshot = Object.freeze({
  rows: Object.freeze([]),
  hasMore: false,
  status: 'idle',
})) {
  let snapshot: PluginUiCollectionQuerySnapshot = initialSnapshot;
  const listeners = new Set<() => void>();
  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: vi.fn(async () => {}),
    loadMore: vi.fn(async () => {}),
    dispose: vi.fn(),
    publish(next: MutablePagerSnapshot) {
      snapshot = Object.freeze(next);
      for (const listener of listeners) listener();
    },
  }) satisfies PluginUiCollectionQueryPager;
}

describe('Plugin UI data provider', () => {
  it('adapts one host-provided Data pager for an author query and retires it with the mount', async () => {
    const pager = createPager();
    const openCollectionQuery: PluginUiDataClient['openCollectionQuery'] = vi.fn(async () => pager);
    const client: PluginUiDataClient = Object.freeze({
      collection: () => {
        throw new Error('Collection mutation is outside this query-hook fixture.');
      },
      openCollectionQuery,
      accountKv: createUnavailablePluginUiAccountKv(),
      accountSettings: createUnavailablePluginUiAccountSettings(),
    });

    function QueryProbe() {
      const data = usePluginUiDataClient();
      const query = usePluginCollectionQuery('tasks', 'open', {});
      const [clientObserved] = React.useState(() => data === client);
      return <output>{`${clientObserved}:${query.status}:${query.rows.length}`}</output>;
    }

    const mount = await mountThroughReactNativeWebAsync(
      <PluginUiDataProviderInternal client={client}>
        <QueryProbe />
      </PluginUiDataProviderInternal>,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(openCollectionQuery).toHaveBeenCalledWith({
      collectionId: 'tasks',
      uiQueryId: 'open',
      parameters: {},
      signal: expect.any(AbortSignal),
    });
    expect(pager.refresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      pager.publish({
        rows: Object.freeze([Object.freeze({ id: 'task-1' })]),
        hasMore: false,
        status: 'ready',
      });
    });
    expect(mount.container.textContent).toBe('true:ready:1');

    mount.unmount();
    expect(pager.dispose).toHaveBeenCalledTimes(1);
  });

  it('does not reread a hosted query pager that already opened with a safe snapshot', async () => {
    const pager = createPager(Object.freeze({
      rows: Object.freeze([Object.freeze({ id: 'task-1' })]),
      hasMore: false,
      status: 'ready',
    }));
    const openCollectionQuery: PluginUiDataClient['openCollectionQuery'] = vi.fn(async () => pager);
    const client: PluginUiDataClient = Object.freeze({
      collection: () => {
        throw new Error('Collection mutation is outside this query-hook fixture.');
      },
      openCollectionQuery,
      accountKv: createUnavailablePluginUiAccountKv(),
      accountSettings: createUnavailablePluginUiAccountSettings(),
    });

    function QueryProbe() {
      const query = usePluginCollectionQuery('tasks', 'open', {});
      return <output>{`${query.status}:${query.rows.length}`}</output>;
    }

    const mount = await mountThroughReactNativeWebAsync(
      <PluginUiDataProviderInternal client={client}>
        <QueryProbe />
      </PluginUiDataProviderInternal>,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(mount.container.textContent).toBe('ready:1');
    expect(pager.refresh).not.toHaveBeenCalled();

    mount.unmount();
    expect(pager.dispose).toHaveBeenCalledTimes(1);
  });

  it('keeps a 200-row Collection snapshot local while unrelated input changes and one row updates', async () => {
    const rows = Object.freeze(Array.from({ length: 200 }, (_, index) => Object.freeze({
      context: Object.freeze({
        collection: Object.freeze({ pluginId: 'measurement.plugin', collectionId: 'tasks' }),
        rowId: `task-${index}`,
        revision: 1,
      }),
      fields: Object.freeze({ title: `Task ${index}`, status: 'open' }),
    }))) satisfies PluginUiCollectionQuerySnapshot['rows'];
    const pager = createPager(Object.freeze({
      rows,
      hasMore: false,
      status: 'ready',
    }));
    const openCollectionQuery: PluginUiDataClient['openCollectionQuery'] = vi.fn(async () => pager);
    const client: PluginUiDataClient = Object.freeze({
      collection: () => {
        throw new Error('Collection mutation is outside this 200-row query fixture.');
      },
      openCollectionQuery,
      accountKv: createUnavailablePluginUiAccountKv(),
      accountSettings: createUnavailablePluginUiAccountSettings(),
    });
    const rowCommits: string[] = [];

    const MeasuredRow = React.memo(function MeasuredRow({ row }: Readonly<{
      row: PluginUiCollectionQuerySnapshot['rows'][number];
    }>) {
      return (
        <React.Profiler id={row.context.rowId} onRender={(id) => { rowCommits.push(id); }}>
          <span>{String(row.fields.title)}</span>
        </React.Profiler>
      );
    });
    const QueryProbe = React.memo(function QueryProbe() {
      const query = usePluginCollectionQuery('tasks', 'open', {});
      return (
        <output data-testid="collection-rows">
          {query.rows.map((row) => <MeasuredRow key={row.context.rowId} row={row} />)}
        </output>
      );
    });
    function Harness() {
      const [draft, setDraft] = React.useState('');
      return (
        <>
          <input
            aria-label="Unrelated composer input"
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
          <output data-testid="draft-value">{draft}</output>
          <QueryProbe />
        </>
      );
    }

    const mount = await mountThroughReactNativeWebAsync(
      <PluginUiDataProviderInternal client={client}>
        <Harness />
      </PluginUiDataProviderInternal>,
    );
    await act(async () => { await Promise.resolve(); });

    expect(openCollectionQuery).toHaveBeenCalledTimes(1);
    expect(rowCommits).toHaveLength(200);
    rowCommits.length = 0;

    const input = mount.container.querySelector<HTMLInputElement>('[aria-label="Unrelated composer input"]');
    expect(input).not.toBeNull();
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(input, 'a');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      input?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(mount.container.querySelector('[data-testid="draft-value"]')?.textContent).toBe('a');
    expect(rowCommits).toEqual([]);
    expect(openCollectionQuery).toHaveBeenCalledTimes(1);

    await act(async () => {
      pager.publish({ rows, hasMore: false, status: 'ready' });
    });
    expect(rowCommits).toEqual([]);

    const updatedRows = rows.slice();
    updatedRows[137] = Object.freeze({
      ...rows[137],
      context: Object.freeze({ ...rows[137]!.context, revision: 2 }),
      fields: Object.freeze({ ...rows[137]!.fields, title: 'Task 137 updated' }),
    });
    await act(async () => {
      pager.publish({ rows: Object.freeze(updatedRows), hasMore: false, status: 'ready' });
    });
    expect(rowCommits).toEqual(['task-137']);
    expect(mount.container.textContent).toContain('Task 137 updated');

    mount.unmount();
    expect(pager.dispose).toHaveBeenCalledTimes(1);
  });

  it('exposes the mounted Account Settings scope and reports no scope without a Data client', async () => {
    const settings = createUnavailablePluginUiAccountSettings();
    const client: PluginUiDataClient = Object.freeze({
      collection: () => {
        throw new Error('This Account Settings probe does not use Collections.');
      },
      openCollectionQuery: async () => {
        throw new Error('This Account Settings probe does not open a query.');
      },
      accountKv: createUnavailablePluginUiAccountKv(),
      accountSettings: settings,
    });

    function SettingsProbe({ expectedClient }: Readonly<{ expectedClient: PluginUiDataClient | null }>) {
      const current = usePluginUiDataClientOrNull();
      const accountSettings = usePluginAccountSettings();
      return <output>{`${current === expectedClient}:${accountSettings === settings}`}</output>;
    }

    const mounted = await mountThroughReactNativeWebAsync(
      <PluginUiDataProviderInternal client={client}>
        <SettingsProbe expectedClient={client} />
      </PluginUiDataProviderInternal>,
    );
    expect(mounted.container.textContent).toBe('true:true');
    mounted.unmount();

    const unavailable = await mountThroughReactNativeWebAsync(
      <SettingsProbe expectedClient={null} />,
    );
    expect(unavailable.container.textContent).toBe('true:false');
    unavailable.unmount();
  });
});
