import { describe, expect, it } from 'vitest';
import type { PluginServices } from '@happier-dev/plugin-sdk';
import type { BackgroundServiceContext, PluginCheckpointedEventSourceDefinitionV1 } from '@happier-dev/plugin-sdk/background-services';
import { PluginEventAutomationSetupResultV1Schema, type HostEvents } from '@happier-dev/plugin-sdk/events';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { InternalTaskActionIdSchema } from '@happier-dev/protocol/actions/internalTaskActions';
import { executeInternalTaskAction, type AccountJsonKvCollectionPort } from '@happier-dev/protocol/todos/todoActionOperationsV1';
import { TaskResourceSelectionV1Schema } from '@happier-dev/protocol/todos/taskResourceV1';
import { PLUGIN_MANIFEST, TRIAGE_PLUGIN } from '../manifest.js';
import { createTaskEventSourceAdapter } from './automationEvents.js';

const scope = { serverId: 'home', accountId: 'owner' };
const pluginId = 'happier.triage';

async function fixture(eventId: string) {
  const rows = new Map<string, { value: unknown; version: number }>();
  const writes = async (mutations: Parameters<AccountJsonKvCollectionPort['mutate']>[0]) => ({
    success: true as const,
    results: mutations.map(row => {
      const version = row.version + 1;
      rows.set(row.key, { value: row.value, version });
      return { key: row.key, version };
    }),
  });
  const port = {
    read: async (key: string) => rows.get(key) ?? { value: null, version: -1 },
    list: async () => { throw new Error('Expected the authorized Task resource reader'); },
    mutate: writes,
  };
  let nextTaskId = 'blocker';
  const reads: (string[] | null)[] = [];
  const execute = (id: string, input: unknown) => executeInternalTaskAction({
    actionId: InternalTaskActionIdSchema.parse(id), input, scope, port, requireCurrent() {}, createId: () => nextTaskId,
    resources: {
      accountId: scope.accountId,
      requireCurrent() {},
      request: async ({ method, path }) => {
        if (method !== 'GET') throw new Error('Unexpected resource write');
        const url = new URL(path, 'http://task-fixture.invalid');
        const selected = url.searchParams.get('selection');
        const selection = selected === null ? null : TaskResourceSelectionV1Schema.parse(JSON.parse(selected));
        const render = (taskId: string) => {
          const row = rows.get(`todo.${taskId}`);
          return row === undefined ? [] : [{ ownerAccountId: scope.accountId, taskId, version: row.version,
            content: { t: 'plain', v: row.value }, access: 'owner', encryptionMode: 'plain', encryptedDataKey: null }];
        };
        if (url.pathname !== '/v1/tasks') {
          const [taskId] = url.pathname.split('/').slice(-1);
          return { status: 200, body: render(decodeURIComponent(taskId!))[0] };
        }
        const ids = selection?.tasks.filter(task => task.ownerAccountId === scope.accountId).map(task => task.taskId)
          ?? [...rows.keys()].filter(key => key !== 'todo.index').map(key => key.slice('todo.'.length));
        reads.push(selection === null ? null : ids);
        return { status: 200, body: { tasks: ids.flatMap(render), ...(selection === null ? {} : { selectionApplied: true }) } };
      },
      crypto: {
        randomBytes: () => new Uint8Array(32), openKey: async () => null, open: async () => null,
        openAccount: async () => { throw new Error('Plain Task fixture does not open ciphertext'); },
        seal: async () => '', sealAccount: async () => '',
      },
    },
  });
  const create = async (taskId: string, fields: object) => {
    nextTaskId = taskId;
    await expect(execute('tasks.internal.create', { fields })).resolves.toMatchObject({ status: 'applied' });
  };
  await create('blocker', { title: 'Blocker' });
  await create('task', { title: 'Blocked item', blockedBy: ['blocker'] });
  const actions = { execute } as unknown as PluginServices['actions'];
  const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: TRIAGE_PLUGIN, services: { actions } });
  const setup = async () => PluginEventAutomationSetupResultV1Schema.parse(
    await kit.invokeAction(`${eventId}/setup`, { v: 1, serverId: scope.serverId }));
  return { execute, reads, create, setup, dispose: () => kit.dispose(), actions };
}

async function observeFixture(eventId: string) {
  const f = await fixture(eventId);
  try {
    const setup = await f.setup();
    const materialization = { pluginId, machineId: 'machine', materializationId: 'installation' };
    const definition: PluginCheckpointedEventSourceDefinitionV1 = {
      automationId: 'workflow', triggerId: 'trigger', triggerRevision: 1, sourceSelectorId: 'selector',
      eventRef: { pluginId, localId: eventId }, sourceInstanceId: setup.sourceInstanceId,
      sourceContractVersion: setup.sourceContractVersion, sourceConfig: setup.sourceConfig,
      observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: materialization },
      filter: null, maximumObservationAgeMs: null,
    };
    let changed: ((event: { payload: unknown }) => Promise<void>) | undefined;
    const host = {
      subscribe(target: { eventId: string }, listener: typeof changed) {
        if (target.eventId === '@happier/account/entities-invalidated') changed = listener;
        return { dispose() {} };
      },
    } as HostEvents;
    const context = { services: { actions: f.actions }, signal: new AbortController().signal, materialization } as BackgroundServiceContext;
    const adapter = createTaskEventSourceAdapter(host, () => Date.now() + 1);
    const subscription = adapter.subscribeWake!(async () => {});
    const source = adapter.decode(definition);
    if (!source) throw new Error('Task source setup did not decode');
    const input = { context, definition, definitions: [definition], source, isCurrent: async () => true };
    const observe = async () => {
      const result = await adapter.observe(input);
      if (result.checkpoint !== undefined) await adapter.save({ ...input, checkpoint: result.checkpoint });
      return result.observations;
    };
    return {
      ...f, observe,
      notify: (...keys: string[]) => changed?.({ payload: { entityIds: [], accountKvChanges: [{ keys }] } }),
      dispose: async () => { subscription.dispose(); await f.dispose(); },
    };
  } catch (error) {
    await f.dispose();
    throw error;
  }
}

describe('Task event source', () => {
  it('reports a Task created after the rule was set up and ignores older Tasks', async () => {
    const f = await observeFixture('task-created');
    try {
      expect(await f.observe()).toEqual([]);
      await f.create('new-task', { title: 'New item' });
      await f.notify('todo.index', 'todo.new-task');
      expect(await f.observe()).toMatchObject([{ payload: { task: { ownerAccountId: scope.accountId, taskId: 'new-task' } } }]);
      await f.notify('todo.new-task');
      expect(await f.observe()).toEqual([]);
      expect(f.reads).toEqual([null, ['new-task'], ['new-task']]);
    } finally { await f.dispose(); }
  });

  it('reports a direct label edit once and reads only the invalidated Task', async () => {
    const f = await observeFixture('task-labeled');
    try {
      expect(await f.observe()).toEqual([]);
      await expect(f.execute('tasks.internal.edit', { taskId: 'task', fields: { labels: ['agent-ok'] } }))
        .resolves.toMatchObject({ status: 'applied' });
      await f.notify('settings', 'todo.index', 'todo.task');
      expect(await f.observe()).toMatchObject([{ payload: { task: { ownerAccountId: scope.accountId, taskId: 'task' }, labels: ['agent-ok'] } }]);
      await f.execute('tasks.internal.edit', { taskId: 'task', fields: { labels: ['agent-ok'], notes: 'Edited' } });
      await f.notify('todo.task');
      expect(await f.observe()).toEqual([]);
      await f.notify('settings');
      expect(await f.observe()).toEqual([]);
      expect(f.reads.filter(selection => selection === null)).toHaveLength(1);
      expect(f.reads.every(selection => selection === null || selection.length === 1)).toBe(true);
    } finally { await f.dispose(); }
  });

  it('reports a Task becoming Ready after its blocker completes without rereading the inventory', async () => {
    const f = await observeFixture('task-ready');
    try {
      expect(await f.observe()).toEqual([]);
      await expect(f.execute('tasks.internal.transition', { taskId: 'blocker', state: 'completed' }))
        .resolves.toMatchObject({ status: 'applied' });
      await f.notify('todo.blocker', 'todo.index');
      expect(await f.observe()).toMatchObject([{ payload: { task: { ownerAccountId: scope.accountId, taskId: 'task' } } }]);
      await f.notify('todo.blocker');
      expect(await f.observe()).toEqual([]);
      expect(f.reads).toEqual([null, ['blocker', 'task'], ['blocker', 'task']]);
    } finally { await f.dispose(); }
  });
});
