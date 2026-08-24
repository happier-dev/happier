import * as React from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createUnavailablePluginUiAccountKv } from '../data/accountKv.js';
import { createUnavailablePluginUiAccountSettings } from '../data/accountSettings.js';
import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';
import type { RenderContext, RenderSurface } from '@happier-dev/plugin-sdk/ui';

import type {
  PluginUiAccountCollectionForDefinition,
  PluginUiCollectionQueryPager,
  PluginUiCollectionQuerySnapshot,
  PluginUiDataClient,
} from '../data/types.js';
import { mountThroughReactNativeWebAsync, type RnwMount } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { Tasks } from '../../../plugin-sdk/examples/projects-tasks/src/collections.ts';
import { renderSurface } from '../../../plugin-sdk/examples/projects-tasks/ui/panel.native.tsx';

const PRIVATE_SURFACE_ENTRY_PROVIDER_KEY = Symbol.for(
  'happier.pluginUi.privateSurfaceEntryProvider.v1',
);

type MutablePager = PluginUiCollectionQueryPager & Readonly<{
  publish(snapshot: PluginUiCollectionQuerySnapshot): void;
}>;

function createMutablePager(initial: PluginUiCollectionQuerySnapshot): MutablePager {
  let snapshot = initial;
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
    publish(next: PluginUiCollectionQuerySnapshot) {
      snapshot = next;
      for (const listener of listeners) listener();
    },
  });
}

function createProjectsTasksRenderContext(): Readonly<{
  context: RenderContext;
  dispose(): void;
}> {
  const controller = new AbortController();
  const surface = createSurfaceContext({
    mount: {
      kind: 'destination',
      destination: { pluginId: 'examples.projects-tasks', localId: 'projects-and-tasks' },
      container: 'appPage',
    },
    target: { kind: 'app' },
  });
  const context = Object.freeze({
    plugin: Object.freeze({ id: 'examples.projects-tasks', version: '0.1.0' }),
    surface,
    hostApi: createHostApiStub(surface),
    signal: controller.signal,
  }) satisfies RenderContext;

  return Object.freeze({ context, dispose: () => controller.abort() });
}

function bindDataClient(
  entry: ReturnType<RenderSurface>,
  dataClient: PluginUiDataClient,
): React.ReactElement {
  if (!entry) throw new Error('Projects and Tasks did not return its public UI entry.');
  if ((typeof entry.type !== 'function' && typeof entry.type !== 'object') || entry.type === null) {
    throw new Error('Projects and Tasks did not return its private entry provider.');
  }
  expect(Reflect.get(entry.type, PRIVATE_SURFACE_ENTRY_PROVIDER_KEY)).toBe(true);
  // The marker proves this is the bundled entry provider that the real host
  // clones with its captured Account-lifetime Data client. The source-imported
  // SDK carries its own React declaration identity, so this is a narrow,
  // marker-checked test boundary rather than an untyped UI fixture.
  const hostEntry = entry as unknown as React.ReactElement<Readonly<{
    dataClient?: PluginUiDataClient;
  }>>;
  return React.cloneElement(
    hostEntry,
    { dataClient },
  );
}

function findByAccessibleName(mount: RnwMount, name: string): HTMLElement {
  const element = [...mount.container.querySelectorAll<HTMLElement>('[aria-label]')]
    .find((candidate) => candidate.getAttribute('aria-label') === name);
  if (!element) throw new Error(`Unable to find ${name}.`);
  return element;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

type RecordingAccountKv = PluginUiDataClient['accountKv'] & Readonly<{
  writes: { key: string; value: unknown; expectedVersion: number | 'absent' }[];
}>;

/**
 * One in-memory Account row with the public per-key CAS contract, so the
 * example's remembered-project behaviour is exercised through the same shape
 * the real Protocol row owner enforces.
 */
function createRecordingAccountKv(
  initial: Readonly<Record<string, Readonly<{ version: number; value: unknown }>>> = {},
): RecordingAccountKv {
  const values = new Map(Object.entries(initial));
  const writes: { key: string; value: unknown; expectedVersion: number | 'absent' }[] = [];
  const unsupported = async (): Promise<never> => {
    throw new Error('This fixture only exercises the get/set Account KV path.');
  };
  return Object.freeze({
    writes,
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(async (
      key: string,
      value: unknown,
      options: Readonly<{ expectedVersion: number | 'absent' }>,
    ) => {
      writes.push({ key, value, expectedVersion: options.expectedVersion });
      const current = values.get(key);
      const expected = current ? current.version : 'absent';
      if (options.expectedVersion !== expected) {
        throw Object.assign(new Error('conflict'), { code: 'plugin_account_kv_conflict' });
      }
      const version = current ? current.version + 1 : 0;
      values.set(key, { version, value });
      return { version };
    }),
    delete: unsupported,
    list: unsupported,
    transaction: unsupported,
  }) as unknown as RecordingAccountKv;
}

describe('Projects and Tasks Account KV continuity', () => {
  it('restores the remembered project from Account KV and writes the next choice conditionally', async () => {
    const emptyPager = createMutablePager(Object.freeze({
      rows: Object.freeze([]),
      hasMore: false,
      status: 'idle',
    }));
    const accountKv = createRecordingAccountKv({
      'ui/lastProjectId': { version: 4, value: 'project-remembered' },
    });
    const openCollectionQuery: PluginUiDataClient['openCollectionQuery'] = vi.fn(async () => emptyPager);
    const unusedCollection = vi.fn(async () => {
      throw new Error('This journey never performs a direct collection mutation.');
    });
    const dataClient = Object.freeze({
      collection: () => Object.freeze({
        identityTag: unusedCollection,
        get: unusedCollection,
        put: unusedCollection,
        delete: unusedCollection,
        query: unusedCollection,
        batch: unusedCollection,
        limits: unusedCollection,
        measureBatch: unusedCollection,
      }),
      openCollectionQuery,
      accountKv,
      accountSettings: createUnavailablePluginUiAccountSettings(),
    }) as unknown as PluginUiDataClient;
    const renderFixture = createProjectsTasksRenderContext();
    const mount = await mountThroughReactNativeWebAsync(
      bindDataClient(renderSurface(renderFixture.context), dataClient),
    );

    try {
      // The surface opens straight onto the remembered project: no daemon is in
      // the path and the person did not have to retype the id on this device.
      await vi.waitFor(() => {
        expect(openCollectionQuery).toHaveBeenCalledWith(expect.objectContaining({
          parameters: { projectId: 'project-remembered' },
        }));
      });
      expect(accountKv.writes).toEqual([]);

      const projectInput = findByAccessibleName(mount, 'Project ID') as HTMLInputElement;
      await act(async () => {
        setInputValue(projectInput, 'project-next');
      });
      await act(async () => {
        findByAccessibleName(mount, 'Show open tasks').click();
      });

      await vi.waitFor(() => {
        expect(accountKv.writes).toEqual([{
          key: 'ui/lastProjectId',
          value: 'project-next',
          expectedVersion: 4,
        }]);
      });
    } finally {
      mount.unmount();
      renderFixture.dispose();
    }
  });
});

describe('Projects and Tasks Account Collection surface', () => {
  it('waits for a submitted Project before opening the declared query, then pages, distinguishes retained and empty query errors, and surfaces a revision conflict after completing with the current revision', async () => {
    const emptyPager = createMutablePager(Object.freeze({
      rows: Object.freeze([]),
      hasMore: false,
      status: 'idle',
    }));
    const taskRow = Object.freeze({
      context: Object.freeze({
        collection: Object.freeze({
          pluginId: 'examples.projects-tasks',
          collectionId: 'tasks',
        }),
        rowId: 'task-1',
        revision: 7,
      }),
      fields: Object.freeze({
        title: 'Write the release notes',
        status: 'open',
        dueAt: '2026-08-14T12:00:00.000Z',
      }),
    });
    const selectedPager = createMutablePager(Object.freeze({
      rows: Object.freeze([]),
      hasMore: false,
      status: 'idle',
    }));
    type TasksCollection = PluginUiAccountCollectionForDefinition<typeof Tasks>;
    const get: TasksCollection['get'] = vi.fn(async () => Object.freeze({
      rowId: 'task-1',
      revision: 7,
      value: Object.freeze({
        id: 'task-1',
        title: 'Write the release notes',
        status: 'open' as const,
        dueAt: '2026-08-14T12:00:00.000Z',
        projectId: 'project-a',
      }),
    }));
    const put: TasksCollection['put'] = vi.fn(async (value) => Object.freeze({
      rowId: value.id,
      revision: 8,
      value,
    }));
    const collection = Object.freeze({
      identityTag: vi.fn(async () => {
        throw new Error('Projects and Tasks does not derive a Collection identity in this journey.');
      }),
      get,
      put,
      delete: vi.fn(async () => {
        throw new Error('Projects and Tasks only completes a row in this journey.');
      }),
      query: vi.fn(async () => {
        throw new Error('Projects and Tasks reads the bounded UI query in this journey.');
      }),
      batch: vi.fn(async () => {
        throw new Error('Projects and Tasks does not create a batch mutation in this journey.');
      }),
    }) satisfies TasksCollection;
    const openCollectionQuery: PluginUiDataClient['openCollectionQuery'] = vi.fn(async (input) => (
      input.parameters.projectId === 'project-a' ? selectedPager : emptyPager
    ));
    const dataClient = Object.freeze({
      collection<TDefinition extends PluginAccountCollectionDefinition>(definition: TDefinition) {
        expect(definition).toBe(Tasks);
        // The public author surface supplies this exact definition; this is
        // the one runtime-checked generic edge in the Data boundary fixture.
        return collection as unknown as PluginUiAccountCollectionForDefinition<TDefinition>;
      },
      openCollectionQuery,
      accountKv: createUnavailablePluginUiAccountKv(),
      accountSettings: createUnavailablePluginUiAccountSettings(),
    }) satisfies PluginUiDataClient;
    const renderFixture = createProjectsTasksRenderContext();
    const { context: renderContext } = renderFixture;
    const mount = await mountThroughReactNativeWebAsync(bindDataClient(renderSurface(renderContext), dataClient));
    let unmounted = false;

    try {
      await act(async () => { await Promise.resolve(); });
      expect(mount.container.textContent).toContain('Choose a project');
      expect(openCollectionQuery).not.toHaveBeenCalled();

      const projectInput = findByAccessibleName(mount, 'Project ID') as HTMLInputElement;
      await act(async () => {
        setInputValue(projectInput, 'project-a');
      });
      await act(async () => {
        findByAccessibleName(mount, 'Show open tasks').click();
      });
      await vi.waitFor(() => {
        expect(openCollectionQuery).toHaveBeenCalledWith({
          collectionId: 'tasks',
          uiQueryId: 'openByProject',
          parameters: { projectId: 'project-a' },
          signal: expect.any(AbortSignal),
        });
        expect(selectedPager.refresh).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        selectedPager.publish(Object.freeze({
          rows: Object.freeze([taskRow]),
          hasMore: true,
          status: 'ready',
        }));
      });
      expect(mount.container.textContent).toContain('Write the release notes');
      expect(mount.container.textContent).toContain('Due 2026-08-14T12:00:00.000Z');

      await act(async () => {
        findByAccessibleName(mount, 'Load more tasks').click();
      });
      expect(selectedPager.loadMore).toHaveBeenCalledTimes(1);

      await act(async () => {
        findByAccessibleName(mount, 'Mark Write the release notes complete').click();
      });
      await vi.waitFor(() => {
        expect(get).toHaveBeenCalledWith('task-1', { signal: renderContext?.signal });
        expect(put).toHaveBeenCalledWith({
          id: 'task-1',
          title: 'Write the release notes',
          status: 'done',
          dueAt: '2026-08-14T12:00:00.000Z',
          projectId: 'project-a',
        }, {
          expectedRevision: 7,
          signal: renderContext?.signal,
        });
        expect(mount.container.textContent).toContain('Task marked complete');
      });

      put.mockRejectedValueOnce(Object.assign(
        new Error('Collection mutation conflicted with a newer row revision'),
        { code: 'plugin_collection_conflict' },
      ));
      await act(async () => {
        findByAccessibleName(mount, 'Mark Write the release notes complete').click();
      });
      await vi.waitFor(() => {
        expect(mount.container.textContent).toContain(
          'Task changed before it could be completed. Refresh tasks and try again.',
        );
      });

      await act(async () => {
        selectedPager.publish(Object.freeze({
          rows: Object.freeze([taskRow]),
          hasMore: false,
          status: 'error',
          error: Object.freeze({
            error: 'collection_unavailable',
          }),
        }));
      });
      expect(mount.container.textContent).toContain('Open tasks could not be refreshed');
      expect(mount.container.textContent).toContain('Write the release notes');
      expect(mount.container.textContent).toContain(
        'Showing the last available Account Collection result. Refresh to try again.',
      );
      expect(mount.container.textContent).toContain('Last available open tasks');
      expect(mount.container.textContent).not.toContain('Current open tasks');

      await act(async () => {
        findByAccessibleName(mount, 'Refresh tasks').click();
      });
      expect(selectedPager.refresh).toHaveBeenCalledTimes(2);

      await act(async () => {
        selectedPager.publish(Object.freeze({
          rows: Object.freeze([]),
          hasMore: false,
          status: 'error',
          error: Object.freeze({
            error: 'collection_unavailable',
          }),
        }));
      });
      expect(mount.container.textContent).toContain('Open tasks could not be loaded');
      expect(mount.container.textContent).not.toContain(
        'Showing the last available Account Collection result. Refresh to try again.',
      );
      mount.unmount();
      unmounted = true;
      expect(selectedPager.dispose).toHaveBeenCalledTimes(1);
    } finally {
      if (!unmounted) mount.unmount();
      renderFixture.dispose();
    }
  });
});
