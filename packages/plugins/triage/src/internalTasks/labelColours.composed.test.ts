import { describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { PluginServices } from '@happier-dev/plugin-sdk';
import { InternalTaskActionIdSchema, InternalTaskListOutputSchema } from '@happier-dev/protocol/actions/internalTaskActions';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { executeInternalTaskAction, type AccountJsonKvCollectionPort } from '@happier-dev/protocol/todos/todoActionOperationsV1';
import { TodoItemV1StoredSchema } from '@happier-dev/protocol/todos/todoSessionLinkV1';
import { TriageGetResultV1Schema, TriageScanResultV1Schema, TriageSourceEntrySnapshotV1Schema } from '@happier-dev/triage-protocol/v1';
import { PLUGIN_MANIFEST, TRIAGE_PLUGIN } from '../manifest.js';

const scope = { serverId: 'home', accountId: 'account' };
const instance = { v: 1, instance: { source: { pluginId: 'happier.triage', localId: 'internal' },
  sourceInstanceId: '6a741117-c35d-47ee-9060-efb56c6ea275' }, binding: { purpose: 'tasks', source: 'accountData' },
  localInstanceKey: 'personal', configuration: { v: 1, token: 'happier-tasks-v1' } };
// Same released shape as ../0.2/apps/ui/sources/sync/domains/todos/todoOps.ts
// at a7cfad84168f21b364b37d431175f50c311acb7e; labels are a later optional refinement.
const predecessor = { id: 'old', title: 'Existing task', done: false, createdAt: 17, updatedAt: 18,
  linkedSessions: { session: { title: 'Existing work', linkedAt: 19 } } };

async function fixture() {
  const rows = new Map<string, { value: unknown; version: number }>([
    ['todo.old', { value: { ...predecessor, labels: ['bug'] }, version: 1 }],
    ['todo.other', { value: { ...predecessor, id: 'other', labels: ['bug', 'docs'] }, version: 1 }],
  ]);
  const reads: string[] = [];
  const port: AccountJsonKvCollectionPort = {
    read: async key => { reads.push(key); return structuredClone(rows.get(key) ?? { value: null, version: -1 }); },
    list: async prefix => [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, row]) => ({ key, ...structuredClone(row) })),
    mutate: async mutations => {
      const errors = mutations.filter(row => row.version !== (rows.get(row.key)?.version ?? -1))
        .map(row => ({ key: row.key, ...structuredClone(rows.get(row.key) ?? { value: null, version: -1 }) }));
      if (errors.length) return { success: false, errors };
      const results = mutations.map(row => { const version = row.version + 1;
        rows.set(row.key, { value: structuredClone(row.value), version }); return { key: row.key, version }; });
      return { success: true, results };
    },
  };
  const execute = (id: string, input: unknown) => executeInternalTaskAction({ actionId: InternalTaskActionIdSchema.parse(id),
    input, scope, port, requireCurrent: () => {}, createId: () => 'new' });
  // Only the host Action transport and persistent KV boundary are substituted.
  const actions = { execute } as unknown as PluginServices['actions'];
  const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: TRIAGE_PLUGIN, services: { actions } });
  const scan = () => kit.invokeAction('internal/tasks/scan-v1', { v: 1, instance, page: { kind: 'initial', limit: 20 } })
    .then(value => TriageScanResultV1Schema.parse(value));
  const detail = () => kit.invokeAction('internal/tasks/get-v1', { v: 1, instance,
    localRef: { kindId: 'task', collisionScope: 'personal', entryId: 'old' } }).then(value => TriageGetResultV1Schema.parse(value));
  return { rows, reads, execute, kit, scan, detail };
}

describe('personal task label colours through registered source projections', () => {
  it('dispatches the palette write through public Action admission and the existing Todo owner', async () => {
    const f = await fixture();
    try {
      // Substitute only the host transport; the actual Action admission, owner and storage fixture run.
      const deps = { internalTaskAction: async ({ actionId, input }) => f.execute(actionId, input) } satisfies Partial<ActionExecutorDeps>;
      const executor = createActionExecutor(deps as ActionExecutorDeps);
      expect(await executor.execute('tasks.internal.labels.setColor', { scope, name: 'bug', colorToken: 'accent' },
        { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: scope.serverId }))
        .toMatchObject({ ok: true, result: { status: 'applied', labelCatalog: [{ name: 'bug', colorToken: 'accent' }] } });
    } finally { await f.kit.dispose(); }
  });

  it('retains string labels when the new reader admits an optional colour projection', () => {
    const retained = { v: 1, title: 'Retained task', scopeLabel: 'Personal', state: { presentation: 'active' }, facts: [], labels: ['bug'] };
    expect(TriageSourceEntrySnapshotV1Schema.parse(retained)).toEqual(retained);
    const current = { ...retained, labelColors: [{ name: 'bug', colorToken: 'success' }] };
    expect(TriageSourceEntrySnapshotV1Schema.parse(current)).toEqual(current);
  });

  it('keeps legacy string labels readable without imposing a new display constraint', async () => {
    const f = await fixture();
    const labels = ['', '\n', 'x'.repeat(100_000)];
    f.rows.set('todo.old', { value: { ...predecessor, labels }, version: 1 });
    try {
      const scan = await f.scan();
      expect(scan).toMatchObject({ kind: 'complete', observations: [{ snapshot: { labels } }, {}] });
      if (scan.kind !== 'complete' || scan.observations[0]?.kind !== 'present') throw new Error('Expected present task');
      const snapshot = scan.observations[0].snapshot;
      expect(snapshot.labelColors).toEqual(labels.map(name => ({ name, colorToken: 'secondaryText' })));
      expect(f.rows.get('todo.old')?.value).toEqual({ ...predecessor, labels });
    } finally { await f.kit.dispose(); }
  });

  it('keeps a 0.2 item readable and projects neutral labels without a catalog', async () => {
    expect(TodoItemV1StoredSchema.parse(predecessor)).toEqual(predecessor);
    const f = await fixture();
    try {
      expect(await f.detail()).toMatchObject({ kind: 'present', snapshot: {
        labelColors: [{ name: 'bug', colorToken: 'secondaryText' }],
      } });
    } finally { await f.kit.dispose(); }
  });

  it('sets and clears one Account label colour in every list/board/detail projection without item writes or per-row reads', async () => {
    const f = await fixture();
    try {
      const original = structuredClone([...f.rows]);
      expect(await f.execute('tasks.internal.labels.setColor', { scope, name: 'bug', colorToken: 'success' }))
        .toMatchObject({ status: 'applied', labelCatalog: [{ name: 'bug', colorToken: 'success' }] });
      for (const [key, row] of original) expect(f.rows.get(key)).toEqual(row);
      f.reads.length = 0;
      const list = InternalTaskListOutputSchema.parse(await f.execute('tasks.internal.list', {}));
      expect(list).toMatchObject({ status: 'ok', todos: [
        { labelColors: [{ name: 'bug', colorToken: 'success' }] },
        { labelColors: [{ name: 'bug', colorToken: 'success' }, { name: 'docs', colorToken: 'secondaryText' }] },
      ] });
      expect(f.reads.filter(key => key === 'task-label-colours.v1')).toHaveLength(1);
      const scan = await f.scan();
      expect(scan).toMatchObject({ kind: 'complete', observations: [
        { snapshot: { labelColors: [{ name: 'bug', colorToken: 'success' }] } },
        { snapshot: { labelColors: [{ name: 'bug', colorToken: 'success' }, { name: 'docs', colorToken: 'secondaryText' }] } },
      ] });
      expect(await f.detail()).toMatchObject({ kind: 'present', snapshot: { labelColors: [{ name: 'bug', colorToken: 'success' }] } });
      expect(await f.execute('tasks.internal.labels.clearColor', { scope, name: 'bug' }))
        .toMatchObject({ status: 'applied', labelCatalog: [] });
      expect(await f.detail()).toMatchObject({ kind: 'present', snapshot: { labelColors: [{ name: 'bug', colorToken: 'secondaryText' }] } });
      expect(await f.execute('tasks.internal.labels.setColor', { scope: { ...scope, accountId: 'other' }, name: 'bug', colorToken: 'success' }))
        .toMatchObject({ status: 'refused', reason: 'task_scope_mismatch' });
      expect(await f.execute('tasks.internal.labels.setColor', { scope, name: 'bug', colorToken: '#ffffff' }))
        .toMatchObject({ status: 'failed' });
    } finally { await f.kit.dispose(); }
  });
});
