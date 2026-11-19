import { describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { PluginError, type PluginServices } from '@happier-dev/plugin-sdk';
import { MAX_TRIAGE_TEXT_UTF8_BYTES_V1, REVIEW_TRIAGE_SOURCE_V1, TriageConfiguredSourceInstanceV1Schema, TriageGetResultV1Schema, TriageScanResultV1Schema, TriageTaskWriteResultV1Schema, TriageReadConfiguredSourceInstancesResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { PLUGIN_MANIFEST, TRIAGE_PLUGIN, TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../manifest.js';
import { TriageSourceDescriptorV1Schema } from '@happier-dev/triage-protocol/v1';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { TriageListEntriesResultV1Schema } from '../actions/listEntriesProtocol.js';
import { executeInternalTaskAction, executeInternalTaskReorder, type AccountJsonKvCollectionPort } from '@happier-dev/protocol/todos/todoActionOperationsV1';
import { applyTodoSessionLinkV1, TodoSessionLinkInputV1Schema, resolveTodoSessionLinkInputV1 } from '@happier-dev/protocol/todos/todoSessionLinkV1';
import { InternalTaskListOutputSchema, InternalTaskReadInputSchema } from '@happier-dev/protocol/actions/internalTaskActions';
import { INTERNAL_TASK_DESCRIPTOR_V1 } from './contribution.js';
import { qualifySourceObservation } from '../corpus/fold/qualify.js';
import { runTriageScanPass } from '../projection/scanPass.js';
import { foldTriageListWindow, TRIAGE_LIST_DEFAULT_LENS_V1, TRIAGE_LIST_NO_FILTERS_V1 } from '../projection/listWindow.js';
import { planTriageFilterFacetsV1 } from '../ui/filters/plan.js';
import { readTriageFilterConditionModelV1 } from '../ui/filters/rail.js';
import { planTriageTaskViewInventoryV1 } from '../ui/list/viewInventory.js';
import { TriageSavedViewsCatalogValueV1Schema } from '../actions/savedViewsProtocol.js';

const scope = { serverId: 'home', accountId: 'account' };
// Rechecked against ../0.2 HEAD 2bf968563bf2015455c0cd54bcc74e91f67891b9:
// sync/domains/todos/todoOps.ts addTodo/updateTodoLinkedSessions and
// taskSessionLink.ts linkTaskToSession write this unqualified map; no corpus PR
// relationship writer exists in that predecessor. The host normalizes only state.
const predecessor = { id: 'old-task', title: 'Keep my existing task', done: false,
  createdAt: 17, updatedAt: 18, linkedSessions: { 'session-old': { title: 'Existing work', linkedAt: 19 } } };
const source = { pluginId: 'happier.triage', localId: 'internal' };
const instance = { v: 1, instance: { source, sourceInstanceId: '6a741117-c35d-47ee-9060-efb56c6ea275' },
  binding: { purpose: 'tasks', source: 'accountData' }, localInstanceKey: 'personal',
  configuration: { v: 1, token: 'happier-tasks-v1' } };
const localRef = { kindId: 'task', collisionScope: 'personal', entryId: predecessor.id };

async function withSource(run: (kit: Awaited<ReturnType<typeof createPluginTestkit>>, calls: { id: string; input: unknown }[]) => Promise<void>,
  list: unknown = { status: 'ok', scope, todos: [{ ...predecessor, state: 'unstarted' }], undoneOrder: [predecessor.id], completedOrder: [] },
  hostAction?: (id: string, input: unknown) => unknown) {
  const calls: { id: string; input: unknown }[] = [];
  // The plugin-to-host Action transport is a genuine process boundary. Host
  // Account-mode, CAS and predecessor preservation are exercised at its owner.
  const actions = { execute: async (id: string, input: unknown) => {
    calls.push({ id, input });
    if (hostAction) return hostAction(id, input);
    if (id === 'tasks.internal.list') return list;
    if (id === 'tasks.internal.read') {
      const current = InternalTaskListOutputSchema.parse(list);
      if (current.status !== 'ok') return current;
      const address = InternalTaskReadInputSchema.parse(input);
      const todo = current.todos.find(task => task.id === address.taskId
        && (task.ownerAccountId ?? current.scope.accountId) === (address.ownerAccountId ?? current.scope.accountId));
      return todo === undefined ? { status: 'refused', reason: 'task_not_found' } : { status: 'applied', scope: current.scope, todo };
    }
    if (id === 'tasks.internal.edit') return { status: 'uncertain', reason: 'lost_response' };
    if (id === 'tasks.internal.session.link') return { status: 'linked' };
    throw new Error(`Unexpected host Action ${id}`);
  } } as unknown as PluginServices['actions'];
  const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: TRIAGE_PLUGIN, services: { actions } });
  try { await run(kit, calls); } finally { await kit.dispose(); }
}

describe('registered internal Happier task source', () => {
  it('preserves host read refusal Code and Request ID through each registered source read', async () => {
    const error = new PluginError({ code: 'task_storage_unavailable', retryable: true, details: { requestId: 'task-read-17' } });
    await withSource(async kit => {
      for (const [action, input] of [
        ['internal/tasks/scan-v1', { v: 1, instance, page: { kind: 'initial', limit: 20 } }],
        ['internal/tasks/get-v1', { v: 1, instance, localRef }],
        ['internal/tasks/read-session-links-v1', { v: 1, instance, localRef }],
      ] as const) await expect(kit.invokeAction(action, input)).rejects.toMatchObject({
        code: error.code, data: { details: { requestId: 'task-read-17' } },
      });
    }, undefined, () => { throw error; });
  });
  it('reports authoritative missing Task access as absent, preserving other refusals', async () => {
    for (const reason of ['task_not_found', 'task_access_denied', 'task_storage_unavailable']) {
      await withSource(async (kit, calls) => {
        const result = TriageGetResultV1Schema.parse(await kit.invokeAction('internal/tasks/get-v1', { v: 1, instance, localRef }));
        expect(result).toMatchObject(reason === 'task_not_found'
          ? { kind: 'absent', localRef } : { kind: 'unresolved', failure: { code: reason } });
        expect(calls.map(call => call.id)).toEqual(['tasks.internal.read']);
      }, undefined, () => ({ status: 'refused', reason }));
    }
  });
  it('keeps exact Task content readable when inverse child enrichment is unavailable', async () => {
    await withSource(async kit => {
      const result = TriageGetResultV1Schema.parse(await kit.invokeAction('internal/tasks/get-v1', { v: 1, instance, localRef }));
      expect(result).toMatchObject({ kind: 'present', snapshot: { title: predecessor.title } });
      if (result.kind === 'present') expect(result.snapshot.relations).not.toHaveProperty('children');
    }, undefined, id => {
      if (id === 'tasks.internal.read') return { status: 'applied', scope, todo: { ...predecessor, state: 'unstarted' } };
      throw new PluginError({ code: 'task_list_unavailable', details: { requestId: 'children-17' } });
    });
  });
  const sortedTasks = [
    { ...predecessor, id: 'delta', state: 'started', createdAt: 20, updatedAt: 30, dueAt: 30 },
    { ...predecessor, id: 'bravo', state: 'backlog', createdAt: 30, updatedAt: 10, dueAt: 10 },
    { ...predecessor, id: 'alpha', state: 'completed', done: true, createdAt: 10, updatedAt: 20 },
    { ...predecessor, id: 'echo', state: 'unstarted', ownerAccountId: 'other', createdAt: 50, updatedAt: 50, dueAt: 20 },
    { ...predecessor, id: 'charlie', state: 'canceled', done: true, createdAt: 40, updatedAt: 40, dueAt: 20 },
  ];
  const sortedList = { status: 'ok', scope, todos: sortedTasks,
    undoneOrder: ['delta', 'bravo'], completedOrder: ['charlie', 'alpha'] };
  it.each([
    ['updated', 'asc', ['bravo', 'alpha', 'delta', 'charlie', 'echo']],
    ['updated', 'desc', ['echo', 'charlie', 'delta', 'alpha', 'bravo']],
    ['created', 'asc', ['alpha', 'delta', 'bravo', 'charlie', 'echo']],
    ['created', 'desc', ['echo', 'charlie', 'bravo', 'delta', 'alpha']],
    ['status', 'asc', ['bravo', 'charlie', 'alpha', 'delta', 'echo']],
    ['status', 'desc', ['echo', 'delta', 'alpha', 'charlie', 'bravo']],
    ['due', 'asc', ['bravo', 'charlie', 'echo', 'delta', 'alpha']],
    ['due', 'desc', ['delta', 'charlie', 'echo', 'bravo', 'alpha']],
  ] as const)('orders internal Tasks by %s %s before cutting each page', async (field, direction, expected) => {
    await withSource(async (kit, calls) => {
      const sort = { field, direction };
      const first = TriageScanResultV1Schema.parse(await kit.invokeAction('internal/tasks/scan-v1', {
        v: 1, instance, sort, page: { kind: 'initial', limit: 3 },
      }));
      if (first.kind !== 'page') throw new Error('Expected the first task page');
      const second = TriageScanResultV1Schema.parse(await kit.invokeAction('internal/tasks/scan-v1', {
        v: 1, instance, sort, page: { kind: 'continuation', continuation: first.continuation },
      }));
      if (second.kind !== 'complete') throw new Error('Expected the final task page');
      expect(first.observations.map(value => value.localRef.entryId)).toEqual(expected.slice(0, 3));
      expect(second.observations.map(value => value.localRef.entryId)).toEqual(expected.slice(3));
      // One host inventory read per source scan; field sorting adds no per-task reads.
      expect(calls).toEqual([{ id: 'tasks.internal.list', input: {} }, { id: 'tasks.internal.list', input: {} }]);
    }, sortedList);
  });
  it('binds internal Task continuations to the exact requested sort', async () => {
    await withSource(async (kit) => {
      const first = TriageScanResultV1Schema.parse(await kit.invokeAction('internal/tasks/scan-v1', {
        v: 1, instance, sort: { field: 'created', direction: 'asc' }, page: { kind: 'initial', limit: 2 },
      }));
      if (first.kind !== 'page') throw new Error('Expected a task continuation');
      for (const sort of [undefined, { field: 'created', direction: 'desc' }, { field: 'updated', direction: 'asc' }]) {
        expect(await kit.invokeAction('internal/tasks/scan-v1', {
          v: 1, instance, ...(sort === undefined ? {} : { sort }),
          page: { kind: 'continuation', continuation: first.continuation },
        })).toEqual({ kind: 'failed', failure: { class: 'unsupportedContract', code: 'invalidTaskAddress' } });
      }
    }, sortedList);
  });
  it('preserves personal manual order followed by shared Tasks when no field sort is requested', async () => {
    await withSource(async (kit) => {
      const page = TriageScanResultV1Schema.parse(await kit.invokeAction('internal/tasks/scan-v1', {
        v: 1, instance, page: { kind: 'initial', limit: 10 },
      }));
      if (page.kind !== 'complete') throw new Error('Expected all Tasks');
      expect(page.observations.map(value => value.localRef.entryId)).toEqual(['delta', 'bravo', 'charlie', 'alpha', 'echo']);
    }, sortedList);
  });

  it.each(['notStarted', 'denied', 'cancelled', 'responseLost'] as const)('preserves the internal host write outcome for create, edit and transition: %s', async outcome => {
    await withSource(async (kit, calls) => {
      const code = outcome === 'denied' || outcome === 'cancelled' ? outcome : 'unavailable';
      const expected = outcome === 'responseLost'
        ? { kind: 'uncertain', failure: { class: 'unknown', code } }
        : { kind: 'refused', reason: code, details: {}, retryable: false };
      expect(await kit.invokeAction('internal/tasks/create-v1', { v: 1, instance, kindId: 'task', fields: { title: 'Create' } })).toEqual(expected);
      expect(await kit.invokeAction('internal/tasks/edit-v1', { v: 1, instance, localRef, fields: { title: 'Edit' } })).toEqual(expected);
      expect(await kit.invokeAction('internal/tasks/transition-v1', { v: 1, instance, localRef, transitionId: 'started' })).toEqual(expected);
      expect(calls.map(call => call.id)).toEqual(['tasks.internal.create', 'tasks.internal.edit', 'tasks.internal.transition']);
    }, undefined, () => {
      const error = new PluginError({
        code: outcome === 'denied' || outcome === 'cancelled' ? outcome : 'unavailable',
        retryable: false,
        ...(outcome === 'responseLost' ? { effectAttempted: true } : {}),
      });
      // Host transport boundary: mirror registration/actionHandlerInvocation.ts's exception and serialized data.
      throw outcome === 'notStarted' ? Object.assign(error, { actionHandlerInvocation: 'notStarted',
        data: { ...error.data, actionHandlerInvocation: 'notStarted' } }) : error;
    });
  });
  it('finds tasks shared by different owners through the existing Scope condition without per-row reads', async () => {
    const todos = [
      { ...predecessor, id: 'mine', state: 'unstarted', ownerDisplayName: 'Mara' },
      { ...predecessor, id: 'mine-explicit', state: 'unstarted', ownerAccountId: scope.accountId, access: 'owner' },
      { ...predecessor, id: 'shared-view', state: 'unstarted', ownerAccountId: 'other', ownerDisplayName: 'Mara', access: 'view' },
      { ...predecessor, id: 'shared-edit', state: 'unstarted', ownerAccountId: 'third', owner: scope.accountId, access: 'edit' },
    ];
    await withSource(async (kit, calls) => {
      const scan = TriageScanResultV1Schema.parse(await kit.invokeAction('internal/tasks/scan-v1', {
        v: 1, instance, page: { kind: 'initial', limit: 20 },
      }));
      if (scan.kind !== 'complete') throw new Error('Expected all tasks');
      const observations = scan.observations.map(observation => {
        const result = qualifySourceObservation({ source, declaredKindIds: ['task'],
          sourceInstanceId: instance.instance.sourceInstanceId, observedAtMs: 100, observation });
        if (result.status !== 'qualified') throw new Error('Expected qualified task');
        return result.observation;
      });
      const fold = (filters = TRIAGE_LIST_NO_FILTERS_V1) => foldTriageListWindow({
        observations, lanes: [{ ...instance.instance, health: { kind: 'walkFinished' }, exhausted: true }],
        configuredSourcesStatus: 'complete', activeSourceInstanceIds: [instance.instance.sourceInstanceId],
        lens: { ...TRIAGE_LIST_DEFAULT_LENS_V1, filters }, assembledAtMs: 100,
      });
      const window = fold();
      const facets = planTriageFilterFacetsV1({ configuredSources: [{ ...instance.instance, configurationRowId: instance.instance.sourceInstanceId, available: true }],
        facetCensus: window.facetCensus, filters: TRIAGE_LIST_NO_FILTERS_V1,
        inventory: planTriageTaskViewInventoryV1(() => INTERNAL_TASK_DESCRIPTOR_V1.kinds) });
      const scopes = facets.find(facet => facet.facet === 'scopes')!;
      expect(scopes.options.map(option => option.label)).toEqual(['Owned by you', 'Shared with you']);
      const shared = scopes.options.find(option => option.label === 'Shared with you')!;
      expect(readTriageFilterConditionModelV1(facets).availableFields.find(field => field.id === 'scopes')?.valueOptions)
        .toContainEqual({ value: shared.key, label: 'Shared with you' });
      if (shared.selection.facet !== 'scopes') throw new Error('Expected Scope selection');
      const filters = { ...TRIAGE_LIST_NO_FILTERS_V1, tasks: 'everyone' as const, scopes: [shared.selection.value] };
      const filtered = fold(filters);
      expect(filtered.rows.map(row => row.entryRef.entryId).sort()).toEqual(['shared-edit', 'shared-view']);
      expect(filtered.facetCensus.scopes).toEqual(window.facetCensus.scopes);
      const mine = scopes.options.find(option => option.label === 'Owned by you')!;
      if (mine.selection.facet !== 'scopes') throw new Error('Expected Scope selection');
      expect(fold({ ...filters, scopes: [mine.selection.value] }).rows.map(row => row.entryRef.entryId).sort())
        .toEqual(['mine', 'mine-explicit']);
      // The existing strict persisted reader accepts this ordinary string-valued Scope lens.
      const saved = { v: 1, views: [{ viewId: 'shared-tasks', label: 'Shared tasks', query: '', filters,
        order: 'newest', smartPolicy: TRIAGE_LIST_DEFAULT_LENS_V1.smartPolicy }] };
      expect(TriageSavedViewsCatalogValueV1Schema.parse(saved)).toEqual(saved);
      expect(calls).toEqual([{ id: 'tasks.internal.list', input: {} }]);
    }, { status: 'ok', scope, todos, undoneOrder: todos.map(task => task.id), completedOrder: [] });
  });
  it('returns owner-qualified children with one exact read and one shared list at 1,000 Tasks', async () => {
    const parent = { ...predecessor, state: 'unstarted' };
    const children = [
      { ...parent, id: 'child-open', parentId: parent.id },
      { ...parent, id: 'child-done', parentId: parent.id, state: 'completed', done: true },
    ];
    const list = { status: 'ok', scope, todos: [parent, ...children,
      { ...children[0], id: 'foreign-child', ownerAccountId: 'other' },
      ...Array.from({ length: 996 }, (_, index) => ({ ...parent, id: `unrelated-${index}` }))],
      undoneOrder: [parent.id, children[0]!.id], completedOrder: [children[1]!.id] };
    await withSource(async (kit, calls) => {
      const scan = TriageScanResultV1Schema.parse(await kit.invokeAction('internal/tasks/scan-v1', {
        v: 1, instance, page: { kind: 'initial', limit: 20 },
      }));
      if (scan.kind !== 'page' || scan.observations[0]?.kind !== 'present') throw new Error('Expected the parent on the first page');
      const before = calls.length;
      const detail = TriageGetResultV1Schema.parse(await kit.invokeAction('internal/tasks/get-v1', { v: 1, instance, localRef }));
      expect(detail).toMatchObject({ kind: 'present', snapshot: { relations: { children: {
        total: 2, completed: 1, complete: true,
        entries: children.map(child => ({ source, ...localRef, entryId: child.id })),
      } } } });
      if (detail.kind !== 'present') throw new Error('Expected detail');
      expect(detail.snapshot.relations?.children).toEqual(scan.observations[0].snapshot.relations?.children);
      expect(calls.slice(before)).toEqual([
        { id: 'tasks.internal.read', input: { taskId: predecessor.id } },
        { id: 'tasks.internal.list', input: {} },
      ]);
    }, list);
  });
  it('projects the personal creator as assignee using the admitted owner name on list and detail', async () => {
    await withSource(async (kit, calls) => {
      const scan = TriageScanResultV1Schema.parse(await kit.invokeAction('internal/tasks/scan-v1', {
        v: 1, instance, page: { kind: 'initial', limit: 20 },
      }));
      expect(scan).toMatchObject({ observations: [{ snapshot: { assigneeLabel: 'Mara' } }] });
      const detail = TriageGetResultV1Schema.parse(await kit.invokeAction('internal/tasks/get-v1', { v: 1, instance, localRef }));
      expect(detail).toMatchObject({ kind: 'present', snapshot: { assigneeLabel: 'Mara' }, taskFields: { assigneeIds: [scope.accountId] } });
      expect(calls.map(call => call.id)).toEqual(['tasks.internal.list', 'tasks.internal.read', 'tasks.internal.list']);
    }, { status: 'ok', scope, todos: [{ ...predecessor, state: 'unstarted', createdBy: scope.accountId,
      ownerDisplayName: 'Mara' }], undoneOrder: [predecessor.id], completedOrder: [] });
  });
  it('opens an exact owner-qualified task plus its relations, keeping denied and missing reads unresolved', async () => {
    const sharedRef = { ...localRef, collisionScope: 'account:other' };
    const shared = { ...predecessor, state: 'unstarted', ownerAccountId: 'other', access: 'view', title: 'Exact shared task' };
    await withSource(async (kit, calls) => {
      const read = TriageGetResultV1Schema.parse(await kit.invokeAction('internal/tasks/get-v1', { v: 1, instance, localRef: sharedRef }));
      expect(read).toMatchObject({ kind: 'present', localRef: sharedRef, snapshot: { title: 'Exact shared task',
        taskCapabilities: { editFields: [], transitions: [] } } });
      if (read.kind !== 'present') throw new Error('Expected readable task despite relation failure');
      expect(read.snapshot.relations).not.toHaveProperty('children');
      expect(calls).toEqual([{ id: 'tasks.internal.read', input: { taskId: predecessor.id, ownerAccountId: 'other' } },
        { id: 'tasks.internal.list', input: {} }]);
      expect(await kit.invokeAction('internal/tasks/read-session-links-v1', { v: 1, instance, localRef: sharedRef }))
        .toEqual({ kind: 'complete', links: [] });
      expect(calls.slice(2)).toEqual([{ id: 'tasks.internal.read', input: { taskId: predecessor.id, ownerAccountId: 'other' } }]);
    }, undefined, id => id === 'tasks.internal.list' ? { status: 'failed', reason: 'task_storage_unavailable' }
      : { status: 'applied', scope, todo: shared });
    for (const reason of ['not_found', 'permission_denied']) await withSource(async (kit, calls) => {
      expect(await kit.invokeAction('internal/tasks/get-v1', { v: 1, instance, localRef: sharedRef }))
        .toMatchObject({ kind: 'unresolved', localRef: sharedRef });
      expect(calls).toEqual([{ id: 'tasks.internal.read', input: { taskId: predecessor.id, ownerAccountId: 'other' } }]);
    }, undefined, () => ({ status: 'refused', reason }));
  });
  it('keeps duplicate task ids distinct through scan pages, relations and requester Session links', async () => {
    const shared = { ...predecessor, state: 'unstarted', ownerAccountId: 'other', access: 'edit', title: 'Shared task',
      blockedBy: [{ source, ...localRef, entryId: 'same-owner-blocker' },
        { source, ...localRef, collisionScope: 'account:third', entryId: 'cross-owner-blocker' }],
      linkedSessions: { private: { title: 'Owner work', linkedAt: 1 }, own: { title: 'My work', linkedAt: 2,
        session: { ...scope, sessionId: 'my-session' } } } };
    const list = { status: 'ok', scope, todos: [{ ...predecessor, state: 'unstarted' }, shared,
      { ...shared, id: 'child', createdAt: 18, parentId: predecessor.id, linkedSessions: {} }], undoneOrder: [predecessor.id], completedOrder: [] };
    await withSource(async kit => {
      const first = TriageScanResultV1Schema.parse(await kit.invokeAction('internal/tasks/scan-v1', { v: 1, instance, page: { kind: 'initial', limit: 1 } }));
      expect(first).toMatchObject({ kind: 'page', observations: [{ localRef, snapshot: { title: predecessor.title,
        relations: { children: { total: 0 } } } }] });
      if (first.kind !== 'page') throw new Error('Expected shared tasks on the next page');
      const next = TriageScanResultV1Schema.parse(await kit.invokeAction('internal/tasks/scan-v1', { v: 1, instance,
        page: { kind: 'continuation', continuation: first.continuation } }));
      expect(next).toMatchObject({ kind: 'page', observations: [{ localRef: { ...localRef, collisionScope: 'account:other' },
        snapshot: { title: 'Shared task', relations: {
          blockedBy: [{ source, ...localRef, collisionScope: 'account:other', entryId: 'same-owner-blocker' },
            { source, ...localRef, collisionScope: 'account:third', entryId: 'cross-owner-blocker' }],
          children: { total: 1, entries: [{ entryId: 'child', collisionScope: 'account:other' }] } } },
        viewer: { involvement: [] } }] });
      expect(await kit.invokeAction('internal/tasks/get-v1', { v: 1, instance,
        localRef: { ...localRef, collisionScope: 'account:other' } })).toMatchObject({ kind: 'present', snapshot: { relations: {
          children: { total: 1, entries: [{ source, ...localRef, collisionScope: 'account:other', entryId: 'child' }] },
        } }, taskFields: { assigneeIds: ['other'] } });
      const links = await kit.invokeAction('internal/tasks/read-session-links-v1', { v: 1, instance,
        localRef: { ...localRef, collisionScope: 'account:other' } });
      expect(links).toEqual({ kind: 'complete', links: [{ localRef: { ...localRef, collisionScope: 'account:other' },
        sessionId: 'my-session', linkedAtMs: 2, displayPath: 'Shared task' }] });
    }, list);
  });
  it('preserves same-Home qualified shared Session links for the recipient on detail and inverse reads', async () => {
    const sharedRef = { ...localRef, collisionScope: 'account:other' };
    const shared = { ...predecessor, state: 'unstarted', ownerAccountId: 'other', access: 'view', linkedSessions: {
      legacy: { title: 'Unqualified owner work', linkedAt: 1 },
      qualified: { title: 'Shared work', linkedAt: 2,
        session: { serverId: scope.serverId, accountId: 'other', sessionId: 'shared-session' } },
      elsewhere: { title: 'Different Home', linkedAt: 3,
        session: { serverId: 'other-home', accountId: 'other', sessionId: 'shared-session' } },
    } };
    await withSource(async (kit, calls) => {
      const expected = { kind: 'complete', links: [{ localRef: sharedRef,
        sessionId: 'shared-session', linkedAtMs: 2, displayPath: predecessor.title }] };
      expect(await kit.invokeAction('internal/tasks/read-session-links-v1', { v: 1, instance, localRef: sharedRef }))
        .toEqual(expected);
      expect(await kit.invokeAction('internal/tasks/read-session-links-v1', { v: 1, instance, sessionId: 'shared-session' }))
        .toEqual(expected);
      expect(calls).toEqual([
        { id: 'tasks.internal.read', input: { taskId: predecessor.id, ownerAccountId: 'other' } },
        { id: 'tasks.internal.list', input: {} },
      ]);
    }, { status: 'ok', scope, todos: [shared], undoneOrder: [], completedOrder: [] });
  });
  it('reports a partial scan when an admitted task is waiting for recipient keys', async () => {
    await withSource(async kit => {
      let sourceReads = 0;
      const pass = await runTriageScanPass({
        lanes: [{ sourceInstanceId: instance.instance.sourceInstanceId, source, declaredKindIds: ['task'],
          configured: TriageConfiguredSourceInstanceV1Schema.parse(instance), scan: async input => {
            sourceReads += 1;
            return TriageScanResultV1Schema.parse(await kit.invokeAction('internal/tasks/scan-v1', input));
          } }],
        pageLimit: 1, observationBudget: 1, nowMs: () => 100,
      });
      expect(pass.observations.map(item => item.entryRef.entryId)).toEqual([predecessor.id]);
      expect(pass.lanes).toMatchObject([{ health: { kind: 'partial', reason: 'taskContentUnavailable' } }]);
      expect(sourceReads).toBe(1);
      expect(await kit.invokeAction('internal/tasks/read-session-links-v1', { v: 1, instance, sessionId: 'session-old' }))
        .toEqual({ kind: 'partial', links: [{ localRef, sessionId: 'session-old', linkedAtMs: 19, displayPath: predecessor.title }],
          unavailableRefs: [{ ...localRef, collisionScope: 'account:other' }] });
      expect(await kit.invokeAction('internal/tasks/read-session-links-v1', { v: 1, instance,
        localRef: { ...localRef, collisionScope: 'account:other' } })).toMatchObject({ kind: 'failed' });
    }, { status: 'ok', scope, todos: [{ ...predecessor, state: 'unstarted' }], undoneOrder: [predecessor.id], completedOrder: [],
      unavailableTasks: [{ ownerAccountId: 'other', taskId: predecessor.id, error: 'task_content_unavailable', reason: 'recipient_key_pending' }] });
    await withSource(async kit => {
      const scan = TriageScanResultV1Schema.parse(await kit.invokeAction('internal/tasks/scan-v1', { v: 1, instance, page: { kind: 'initial', limit: 10 } }));
      if (scan.kind !== 'complete' || scan.observations[0]?.kind !== 'present') throw new Error('Expected the readable shared parent');
      expect(scan.observations[0].snapshot.relations).not.toHaveProperty('children');
      const detail = TriageGetResultV1Schema.parse(await kit.invokeAction('internal/tasks/get-v1', { v: 1, instance,
        localRef: { ...localRef, collisionScope: 'account:other' } }));
      if (detail.kind !== 'present') throw new Error('Expected readable parent despite unavailable child');
      expect(detail.snapshot.relations).not.toHaveProperty('children');
      expect(await kit.invokeAction('internal/tasks/read-session-links-v1', { v: 1, instance,
        localRef: { ...localRef, collisionScope: 'account:other' } })).toEqual({ kind: 'complete', links: [] });
    }, { status: 'ok', scope, todos: [{ ...predecessor, state: 'unstarted', ownerAccountId: 'other' }], undoneOrder: [], completedOrder: [],
      unavailableTasks: [{ ownerAccountId: 'other', taskId: 'unreadable-child', error: 'task_content_unavailable', reason: 'recipient_key_pending' }] });
    await withSource(async kit => {
      expect(await kit.invokeAction('internal/tasks/read-session-links-v1', { v: 1, instance, sessionId: 'session-old' }))
        .toEqual({ kind: 'partial', links: [], unavailableRefs: [localRef] });
    }, { status: 'ok', scope, todos: [], undoneOrder: [], completedOrder: [],
      unavailableTasks: [{ ownerAccountId: scope.accountId, taskId: predecessor.id, error: 'task_content_unavailable', reason: 'recipient_key_pending' }] });
  });

  it('routes shared edits and links to their owner, rejects foreign parents and retains cross-owner blockers', async () => {
    const sharedRef = { ...localRef, collisionScope: 'account:other' };
    await withSource(async (kit, calls) => {
      const address = { v: 1, instance, localRef: sharedRef };
      expect(await kit.invokeAction('internal/tasks/edit-v1', { ...address, fields: { parent: { source, ...localRef } } }))
        .toEqual({ kind: 'refused', reason: 'unsupportedField' });
      expect(calls.filter(call => call.id === 'tasks.internal.edit')).toHaveLength(1);
      await kit.invokeAction('internal/tasks/edit-v1', { ...address,
        fields: { blockedBy: [{ source, ...localRef }, { source, ...sharedRef, entryId: 'peer' }] } });
      expect(calls.filter(call => call.id === 'tasks.internal.edit')[1]?.input).toMatchObject({ ownerAccountId: 'other',
        fields: { blockedBy: [{ source, ...localRef }, { source, ...sharedRef, entryId: 'peer' }] } });
      expect(await kit.invokeAction('internal/tasks/link-session-v1', { ...address, sessionId: 'my-session', linked: true })).toEqual({ status: 'linked' });
      expect(calls.find(call => call.id === 'tasks.internal.session.link')?.input).toMatchObject({ ownerAccountId: 'other',
        session: { sessionId: 'my-session' } });
      expect(calls.some(call => call.id === 'tasks.internal.list')).toBe(false);
    }, undefined, (id, input) => id === 'tasks.internal.edit'
      ? executeInternalTaskAction({ actionId: id, input, scope, requireCurrent: () => {}, createId: () => 'new', port: {
        read: async () => { throw new Error('Invalid parent cannot read task content'); },
        list: async () => { throw new Error('Writes cannot read an inventory'); },
        mutate: async () => { throw new Error('Invalid parent cannot write'); },
      } }) : { status: 'linked' });
  });
  it('keeps shared write results and same-owner parents qualified without changing the requester scope', async () => {
    const sharedRef = { ...localRef, collisionScope: 'account:other' };
    const shared = { ...predecessor, state: 'started', ownerAccountId: 'other', access: 'edit', parentId: 'parent' };
    const list = { status: 'ok', scope, todos: [{ ...predecessor, state: 'unstarted' }, shared], undoneOrder: [predecessor.id], completedOrder: [] };
    await withSource(async (kit, calls) => {
      const address = { v: 1, instance, localRef: sharedRef };
      expect(await kit.invokeAction('internal/tasks/edit-v1', { ...address, fields: { parent: { source, ...sharedRef, entryId: 'parent' } } }))
        .toMatchObject({ kind: 'applied', observation: { localRef: sharedRef, snapshot: { relations: { parent: { source, ...sharedRef, entryId: 'parent' } } } } });
      expect(calls.find(call => call.id === 'tasks.internal.edit')?.input).toMatchObject({ ownerAccountId: 'other',
        fields: { parentId: { source, ...sharedRef, entryId: 'parent' } } });
      expect(await kit.invokeAction('internal/tasks/transition-v1', { ...address, transitionId: 'started' }))
        .toMatchObject({ kind: 'applied', observation: { localRef: sharedRef } });
      expect(calls.find(call => call.id === 'tasks.internal.transition')?.input).toMatchObject({ ownerAccountId: 'other', state: 'started' });
    }, list, () => ({ status: 'applied', scope, todo: shared }));
  });
  it('keeps explicit native assignment and never displays an unnamed Account as its raw id', async () => {
    await withSource(async kit => {
      const scan = TriageScanResultV1Schema.parse(await kit.invokeAction('internal/tasks/scan-v1', {
        v: 1, instance, page: { kind: 'initial', limit: 20 },
      }));
      expect(scan).toMatchObject({ kind: 'complete', observations: [{ snapshot: { assigneeLabel: 'Mara' } }] });
    }, { status: 'ok', scope, todos: [{ ...predecessor, state: 'unstarted', owner: 'Mara' }], undoneOrder: [predecessor.id], completedOrder: [] });
    await withSource(async kit => {
      const scan = TriageScanResultV1Schema.parse(await kit.invokeAction('internal/tasks/scan-v1', {
        v: 1, instance, page: { kind: 'initial', limit: 20 },
      }));
      if (scan.kind !== 'complete' || scan.observations[0]?.kind !== 'present') throw new Error('Expected personal task');
      expect(scan.observations[0].snapshot.assigneeLabel).toBeNull();
    });
  });
  it('surfaces a known task CAS conflict once without automatically replaying the edit', async () => {
    let stored = { ...predecessor };
    let version = 1;
    let writes = 0;
    const port: AccountJsonKvCollectionPort = {
      read: async () => ({ value: stored, version }),
      list: async () => [],
      mutate: async mutations => {
        writes += 1;
        if (writes === 1) {
          stored = { ...stored, title: 'Concurrent title' };
          version += 1;
          return { success: false, errors: [{ key: 'todo.old-task', value: stored, version }] };
        }
        return { success: true, results: mutations.map(row => ({ key: row.key, version: version + 1 })) };
      },
    };

    const result = await executeInternalTaskAction({
      actionId: 'tasks.internal.edit', input: { scope, taskId: predecessor.id, fields: { title: 'My edit' } },
      scope, port, requireCurrent: () => {}, createId: () => 'unused',
    });

    expect(result).toMatchObject({ status: 'refused' });
    expect(writes).toBe(1);
    expect(stored.title).toBe('Concurrent title');
  });

  it('indexes child relationships once for a scan page over a large personal inventory', async () => {
    let parentReads = 0;
    const todos = Array.from({ length: 1000 }, (_, index) => ({
      id: `task-${index}`, title: `Task ${index}`, state: index % 2 === 0 ? 'unstarted' : 'completed',
      done: index % 2 !== 0, createdAt: 17, updatedAt: 18,
      get parentId() {
        parentReads++;
        return index === 0 ? undefined : `task-${Math.floor((index - 1) / 2)}`;
      },
    }));
    await withSource(async (kit, calls) => {
      const scan = TriageScanResultV1Schema.parse(await kit.invokeAction('internal/tasks/scan-v1', {
        v: 1, instance, page: { kind: 'initial', limit: 100 },
      }));
      expect(scan.kind).toBe('page');
      if (scan.kind !== 'page') throw new Error('Expected a continuation over the large inventory');
      expect(scan.observations).toHaveLength(100);
      for (const index of [0, 99]) expect(scan.observations[index]).toMatchObject({
        kind: 'present', snapshot: { relations: { children: {
          total: 2, completed: 1, complete: true,
          entries: [index * 2 + 1, index * 2 + 2].map(child => ({ source, kindId: 'task', collisionScope: 'personal', entryId: `task-${child}` })),
        } } },
      });
      // One inventory pass plus each visible row's own parent projection.
      // A per-row scan costs 100,000 visits on this fixture.
      expect(parentReads).toBeLessThanOrEqual(todos.length + scan.observations.length * 2);
      expect(calls.filter(call => call.id === 'tasks.internal.list')).toHaveLength(1);
    }, { status: 'ok', scope, todos, undoneOrder: todos.map(task => task.id), completedOrder: [] });
  });

  it('reads active and recently completed personal tasks from the same Account list without inferring unknown completion dates', async () => {
    const todos = [
      { ...predecessor, id: 'active', state: 'unstarted' },
      { ...predecessor, id: 'recent', state: 'completed', done: true, completedAt: 100 },
      { ...predecessor, id: 'old', state: 'completed', done: true, completedAt: 99 },
      { ...predecessor, id: 'unknown', state: 'completed', done: true },
    ];
    await withSource(async kit => {
      const scan = TriageScanResultV1Schema.parse(await kit.invokeAction('internal/tasks/scan-v1', {
        v: 1, instance, completed: { kindIds: ['task'], sinceMs: 100 }, page: { kind: 'initial', limit: 20 },
      }));
      expect(scan.kind === 'complete' && scan.observations.map(row => row.localRef.entryId)).toEqual(['active', 'recent']);
    }, { status: 'ok', scope, todos, undoneOrder: ['active'], completedOrder: ['recent', 'old', 'unknown'] });
  });
  it('projects personal due/completion facts and the declared one-step completion through registered scan admission', async () => {
    await withSource(async kit => {
      const scan = TriageScanResultV1Schema.parse(await kit.invokeAction('internal/tasks/scan-v1', {
        v: 1, instance, page: { kind: 'initial', limit: 20 },
      }));
      expect(scan).toMatchObject({ kind: 'complete', observations: [{ snapshot: { dueDate: new Date(30).toISOString(), completedAtMs: 25 } }] });
      const declaration = PLUGIN_MANIFEST.contributes?.targetedPluginContributions?.find(entry => entry.id === 'internal');
      expect(declaration?.descriptor).toMatchObject({ kinds: expect.arrayContaining([
        expect.objectContaining({ id: 'task', taskCapabilities: expect.objectContaining({ completingTransitionId: 'completed' }) }),
      ]) });
    }, { status: 'ok', scope, todos: [{ ...predecessor, done: true, state: 'completed', dueAt: 30, completedAt: 25 }],
      undoneOrder: [], completedOrder: [predecessor.id] });
  });
  it('returns complete editable values only on an exact read of the existing task', async () => {
    const encoder = new TextEncoder();
    const cjk = '界'.repeat(Math.floor(MAX_TRIAGE_TEXT_UTF8_BYTES_V1 / encoder.encode('界').byteLength));
    const atBound = cjk + 'x'.repeat(MAX_TRIAGE_TEXT_UTF8_BYTES_V1 - encoder.encode(cjk).byteLength);
    const notes = 'Task notes\n\nPreserve whitespace.  \n';
    // BOUNDS-DESIGN admits the old 1000-CJK fixture; only the first byte over its allocation truncates.
    for (const title of ['界'.repeat(1000), atBound, `${atBound}x`]) await withSource(async kit => {
      const exact = TriageGetResultV1Schema.parse(await kit.invokeAction('internal/tasks/get-v1', { v: 1, instance, localRef }));
      const truncated = encoder.encode(title).byteLength > MAX_TRIAGE_TEXT_UTF8_BYTES_V1;
      expect(exact).toMatchObject({ kind: 'present', snapshot: { title: truncated ? atBound : title },
        taskFields: { title, body: notes, assigneeIds: [scope.accountId], labelIds: [], dueDate: null, parent: null, blockedBy: [] } });
      if (exact.kind !== 'present') throw new Error('Expected task at the display allocation boundary');
      if (truncated) expect(exact.snapshot.projectionTruncated).toBe(true);
      else expect(exact.snapshot).not.toHaveProperty('projectionTruncated');
      expect(TriageGetResultV1Schema.safeParse(exact).success).toBe(true);
      const scan = await kit.invokeAction('internal/tasks/scan-v1', { v: 1, instance, page: { kind: 'initial', limit: 20 } });
      expect(JSON.stringify(scan)).not.toContain(notes);
      expect(TriageScanResultV1Schema.safeParse(scan).success).toBe(true);
    }, { status: 'ok', scope, todos: [{ ...predecessor, title, notes, state: 'unstarted' }], undoneOrder: [predecessor.id], completedOrder: [] });
  });
  it.each([undefined, 'started'] as const)('defaults to Happier with no configured sources and creates, edits, completes and reopens the same Account task (initial status: %s)', async initialStatusId => {
    let inventoryReads = 0, inventoryBodiesOpened = 0;
    const writeCosts: { operation: string; inventoryReads: number; inventoryBodiesOpened: number }[] = [];
    const measureWrite = async <T>(operation: string, run: () => Promise<T>): Promise<T> => {
      const before = { inventoryReads, inventoryBodiesOpened };
      const result = await run();
      writeCosts.push({ operation, inventoryReads: inventoryReads - before.inventoryReads,
        inventoryBodiesOpened: inventoryBodiesOpened - before.inventoryBodiesOpened });
      return result;
    };
    const rows = new Map<string, { value: unknown; version: number }>([
      ['todo.old-task', { value: predecessor, version: 1 }],
      ['todo.index', { value: { undoneOrder: ['old-task'], completedOrder: [] }, version: 1 }],
    ]);
    // Only persistence is substituted; the real host domain owns CAS inputs,
    // field updates, completion/index semantics and qualified linking.
    const port: AccountJsonKvCollectionPort = {
      read: async key => structuredClone(rows.get(key) ?? { value: null, version: -1 }),
      list: async prefix => {
        inventoryReads++;
        const selected = [...rows].filter(([key]) => key.startsWith(prefix));
        inventoryBodiesOpened += selected.filter(([key]) => key !== 'todo.index').length;
        return selected.map(([key, row]) => ({ key, ...structuredClone(row) }));
      },
      mutate: async mutations => {
        const errors = mutations.filter(mutation => mutation.version !== (rows.get(mutation.key)?.version ?? -1))
          .map(mutation => ({ key: mutation.key, ...structuredClone(rows.get(mutation.key) ?? { value: null, version: -1 }) }));
        if (errors.length) return { success: false, errors };
        const results = mutations.map(mutation => {
          const version = mutation.version + 1;
          rows.set(mutation.key, { value: structuredClone(mutation.value), version });
          return { key: mutation.key, version };
        });
        return { success: true, results };
      },
    };
    const actions = { execute: async (id: string, input: unknown) => {
      if (id === 'tasks.internal.reorder') return executeInternalTaskReorder({ input, scope, port, requireCurrent: () => {} });
      if (id === 'tasks.internal.list' || id === 'tasks.internal.read' || id === 'tasks.internal.create' || id === 'tasks.internal.edit' || id === 'tasks.internal.transition') {
        return executeInternalTaskAction({ actionId: id, input, scope, port, requireCurrent: () => {}, createId: () => 'new-task' });
      }
      if (id !== 'tasks.internal.session.link') throw new Error(`Unexpected host Action ${id}`);
      const intent = resolveTodoSessionLinkInputV1(TodoSessionLinkInputV1Schema.parse(input), scope);
      const key = `todo.${intent.taskId}`;
      await applyTodoSessionLinkV1(intent, { read: () => port.read(key), compareAndSet: async (value, version) => {
        const result = await port.mutate([{ key, value, version }]);
        return result.success ? { success: true, version: result.results[0]!.version }
          : { success: false, ...(await port.read(key)) };
      } }, { requireCurrent: () => {} });
      return { status: intent.linked === false ? 'unlinked' : 'linked' };
    } } as unknown as PluginServices['actions'];
    const corpus = createTestkitCorpusCollections();
    // Account persistence and host Actions are genuine boundaries; admission,
    // opaque operation handles, aggregate dispatch and the todo CAS owner stay real.
    const storage = { account: { collection: (definition: { id: string }) => {
      if (definition.id === 'source-instances') return corpus.collections.sourceInstances;
      if (definition.id === 'session-links') return corpus.collections.sessionLinks;
      if (definition.id === 'user-marks') return corpus.collections.userMarks;
      throw new Error(`Unexpected Collection ${definition.id}`);
    } } } as unknown as PluginServices['storage'];
    const open = () => createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: TRIAGE_PLUGIN,
      services: { actions, storage }, resolveCurrentPluginMaterializationRef: () => null });
    let kit = await open();
    const invocation = () => ({ surface: 'agent' as const, services: {
      targetedContributions: { observeForSelf: () => ({ readCurrent: async () => {
        const snapshot = kit.readTargetedContributionFixture(TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1);
        return { ...snapshot, contributions: snapshot.contributions.map(entry => ({ ...entry,
          descriptor: TriageSourceDescriptorV1Schema.parse(PLUGIN_MANIFEST.contributes.targetedPluginContributions
            .find(candidate => candidate.id === entry.contributor.contributionId)?.descriptor), surfaces: {},
        })) };
      }, dispose: () => {} }) } as unknown as PluginServices['targetedContributions'],
    } });
    try {
      const catalog = TriageReadConfiguredSourceInstancesResultV1Schema.parse(await kit.invokeAction('sources/read-configured-v1', { v: 1 }, invocation()));
      expect(catalog.kind).toBe('read');
      if (catalog.kind !== 'read') throw new Error('Expected the built-in task catalog');
      expect(catalog.instances).toHaveLength(2);
      expect(catalog.instances).toContainEqual(expect.objectContaining({
        configured: expect.objectContaining({ instance: expect.objectContaining({ source: REVIEW_TRIAGE_SOURCE_V1 }) }),
      }));
      const task = catalog.instances.find(({ configured }) => configured.instance.source.pluginId === source.pluginId
        && configured.instance.source.localId === source.localId);
      if (task === undefined) throw new Error('Expected the built-in task source');
      const instance = task.configured;
      expect(instance).toMatchObject({ instance: { source }, binding: { source: 'accountData' },
        locator: { displayLabel: 'Happier tasks' } });
      expect(await kit.invokeAction('sources/read-configured-v1', { v: 1, exact: instance }, invocation()))
        .toMatchObject({ kind: 'read', instances: [{ lifecycle: 'active', configured: instance }] });
      expect((await corpus.collections.sourceInstances.query({ index: 'by-lifecycle', order: 'asc' })).rows).toEqual([]);
      const predecessorLinks = await kit.invokeAction('sessions/read-source-links-v1', { v: 1, sessionId: 'session-old' }, invocation());
      expect(predecessorLinks).toMatchObject({ kind: 'complete', links: [{ entryRef: { source, ...localRef },
        sessionId: 'session-old', linkedAtMs: 19 }] });
      expect(rows.get('todo.old-task')).toEqual({ value: predecessor, version: 1 });
      expect((await corpus.collections.sessionLinks.query({ index: 'by-session', prefix: ['session-old'], order: 'asc' })).rows).toEqual([]);
      const externalBlockers = [
        { source: { pluginId: 'acme.tracker', localId: 'issues' }, kindId: 'issue', collisionScope: 'project-1', entryId: 'old-task' },
        { source: { pluginId: 'acme.other-tracker', localId: 'issues' }, kindId: 'issue', collisionScope: 'project-1', entryId: 'old-task' },
        { source: { pluginId: 'acme.tracker', localId: 'issues' }, kindId: 'issue', collisionScope: 'project-2', entryId: 'old-task' },
      ];
      expect(await kit.invokeAction('tasks/create-v1', { v: 1, source,
        sourceInstanceId: instance.instance.sourceInstanceId, kindId: 'task', initialStatusId: 'unknown-status',
        fields: { title: 'Must not create' },
      }, invocation())).toEqual({ kind: 'refused', reason: 'unsupportedTransition' });
      expect(rows.has('todo.new-task')).toBe(false);
      const capabilities = INTERNAL_TASK_DESCRIPTOR_V1.kinds[0]!.taskCapabilities!;
      const defaults = capabilities.initialStatuses!.filter(status => status.isDefault === true);
      expect(defaults).toEqual([expect.objectContaining({ id: 'unstarted' })]);
      expect(capabilities.transitions?.some(status => 'isDefault' in status)).toBe(false);
      const created = TriageTaskWriteResultV1Schema.parse(await measureWrite('create', () => kit.invokeAction('tasks/create-v1', {
        v: 1, source, sourceInstanceId: instance.instance.sourceInstanceId, kindId: 'task',
        ...(initialStatusId === undefined ? {} : { initialStatusId }),
        fields: { title: 'New work', body: 'Keep the whole\nmultiline note', parent: { source, ...localRef }, labelIds: ['personal'], blockedBy: externalBlockers },
      }, invocation())));
      expect(created).toMatchObject({ kind: 'applied', observation: { localRef: { entryId: 'new-task' },
        snapshot: { state: initialStatusId === undefined ? defaults[0]!.state : { presentation: 'active', stage: 'started' } } } });
      expect(rows.get('todo.new-task')?.value).toMatchObject({ state: initialStatusId ?? defaults[0]!.id, done: false });
      expect(created).toMatchObject({ observation: { snapshot: { relations: { blockedBy: externalBlockers } } } });
      const address = { v: 1, instance, localRef: { ...localRef, entryId: 'new-task' } };
      const aggregateAddress = { v: 1, sourceInstanceId: instance.instance.sourceInstanceId, entryRef: { source, ...address.localRef } };
      expect(TriageTaskWriteResultV1Schema.parse(await measureWrite('edit', () => kit.invokeAction('tasks/edit-v1', { ...aggregateAddress,
        fields: { title: 'Edited once', blockedBy: [{ source, ...localRef }, ...externalBlockers] } }, invocation()))).kind).toBe('applied');
      expect(await actions.execute('tasks.internal.reorder', { scope, sourceId: 'new-task',
        position: { anchorId: 'old-task', placement: 'before' } })).toEqual({ status: 'applied' });
      expect(rows.get('todo.index')?.value).toEqual({ undoneOrder: ['new-task', 'old-task'], completedOrder: [] });
      await kit.dispose();
      kit = await open();
      expect(await actions.execute('tasks.internal.list', {})).toMatchObject({ undoneOrder: ['new-task', 'old-task'] });
      const oldest = TriageListEntriesResultV1Schema.parse(await kit.invokeAction('tasks/list-v1', {
        v: 1, sources: { kind: 'allConfigured' }, limit: 10, order: 'oldest',
      }, invocation()));
      // Source order persists; the Triage lens still owns its explicit sort.
      expect(oldest.window.rows.map(row => row.entryRef.entryId)).toEqual(['old-task', 'new-task']);
      expect(await kit.invokeAction('internal/tasks/transition-v1', { ...address, transitionId: 'completed',
        fieldValues: [{ fieldId: 'resolution', value: 'done' }] }))
        .toEqual({ kind: 'refused', reason: 'unsupportedField' });
      expect(rows.get('todo.new-task')?.value).toMatchObject({ done: false });
      expect(TriageTaskWriteResultV1Schema.parse(await measureWrite('transition', () => kit.invokeAction('tasks/transition-v1', { ...aggregateAddress,
        transitionId: 'completed', fieldValues: [] }, invocation())))).toMatchObject({ kind: 'applied', observation: { snapshot: { state: { presentation: 'resolved' } } } });
      expect(await measureWrite('link', () => kit.invokeAction('internal/tasks/link-session-v1', { ...address, sessionId: 'work-session', linked: true }))).toEqual({ status: 'linked' });
      await kit.dispose();
      kit = await open();
      const listed = TriageListEntriesResultV1Schema.parse(await kit.invokeAction('tasks/list-v1', {
        v: 1, sources: { kind: 'allConfigured' }, limit: 10, order: 'newest',
      }, invocation()));
      expect(listed.window.rows.map(row => row.entryRef.entryId).sort()).toEqual(['new-task', 'old-task']);
      expect(await kit.invokeAction('entries/read-detail-v1', aggregateAddress, invocation())).toMatchObject({
        kind: 'read', instance, linkedSessions: [{ sessionId: 'work-session' }],
      });
      expect(TriageGetResultV1Schema.parse(await kit.invokeAction('internal/tasks/get-v1', address))).toMatchObject({ kind: 'present',
        snapshot: { title: 'Edited once', relations: { parent: { entryId: 'old-task' }, blockedBy: [{ source, ...localRef }, ...externalBlockers] } },
        taskFields: { blockedBy: [{ source, ...localRef }, ...externalBlockers] } });
      expect(await kit.invokeAction('internal/tasks/read-session-links-v1', { v: 1, instance, sessionId: 'work-session' })).toMatchObject({ kind: 'complete', links: [{ localRef: address.localRef }] });
      expect(await measureWrite('unlink', () => kit.invokeAction('internal/tasks/link-session-v1', { ...address, sessionId: 'work-session', linked: false }))).toEqual({ status: 'unlinked' });
      expect(rows.get('todo.old-task')?.value).toEqual(predecessor);
      expect(rows.get('todo.new-task')?.value).toMatchObject({ id: 'new-task', title: 'Edited once', done: true,
        notes: 'Keep the whole\nmultiline note', parentId: 'old-task', blockedBy: ['old-task', ...externalBlockers],
        labels: ['personal'], linkedSessions: {}, createdBy: scope.accountId });
      expect(rows.get('todo.index')?.value).toEqual({ undoneOrder: ['old-task'], completedOrder: ['new-task'] });
      expect([...rows.keys()].sort()).toEqual(['todo.index', 'todo.new-task', 'todo.old-task']);
      expect(writeCosts).toEqual(['create', 'edit', 'transition', 'link', 'unlink'].map(operation => ({
        operation, inventoryReads: 0, inventoryBodiesOpened: 0,
      })));
    } finally { await kit.dispose(); }
  });
  it('discovers a credentialless source and reads predecessor tasks through the admitted host owner', async () => {
    await withSource(async (kit, calls) => {
      expect(await kit.invokeAction('internal/tasks/list-instances-v1', { v: 1 })).toMatchObject({ kind: 'complete',
        candidates: [{ binding: instance.binding, localInstanceKey: 'personal' }] });
      const page = TriageScanResultV1Schema.parse(await kit.invokeAction('internal/tasks/scan-v1', { v: 1, instance, page: { kind: 'initial', limit: 10 } }));
      expect(page).toMatchObject({ kind: 'complete', evidence: { kind: 'walkFinished' }, observations: [{ kind: 'present', localRef,
        snapshot: { title: predecessor.title, state: { presentation: 'active', stage: 'unstarted' } } }] });
      const exact = TriageGetResultV1Schema.parse(await kit.invokeAction('internal/tasks/get-v1', { v: 1, instance, localRef }));
      expect(exact).toMatchObject({ kind: 'present', localRef });
      expect(calls.map(call => call.id)).toEqual(['tasks.internal.list', 'tasks.internal.read', 'tasks.internal.list']);
    });
  });

  it('preserves missing/unknown reads and write uncertainty without replay or task copies', async () => {
    await withSource(async (kit, calls) => {
      const result = TriageTaskWriteResultV1Schema.parse(await kit.invokeAction('internal/tasks/edit-v1', { v: 1, instance, localRef,
        fields: { title: 'One committed edit', blockedBy: [{ source, kindId: 'task', collisionScope: 'personal', entryId: 'dependency' }] } }));
      expect(result.kind).toBe('uncertain');
      expect(calls.filter(call => call.id === 'tasks.internal.edit')).toHaveLength(1);
      expect(calls.find(call => call.id === 'tasks.internal.edit')?.input).toMatchObject({ taskId: predecessor.id,
        fields: { title: 'One committed edit', blockedBy: [{ source, kindId: 'task', collisionScope: 'personal', entryId: 'dependency' }] } });
    });
    await withSource(async kit => {
      expect(TriageScanResultV1Schema.parse(await kit.invokeAction('internal/tasks/scan-v1', { v: 1, instance, page: { kind: 'initial', limit: 10 } }))).toMatchObject({ kind: 'failed' });
      expect(TriageGetResultV1Schema.parse(await kit.invokeAction('internal/tasks/get-v1', { v: 1, instance, localRef }))).toMatchObject({ kind: 'unresolved' });
    }, { status: 'unavailable' });
  });

  it('reads legacy Session links once and routes linking through the todo owner only', async () => {
    await withSource(async (kit, calls) => {
      expect(await kit.invokeAction('internal/tasks/read-session-links-v1', { v: 1, instance, sessionId: 'session-old' })).toEqual({ kind: 'complete',
        links: [{ localRef, sessionId: 'session-old', linkedAtMs: 19, displayPath: predecessor.title }] });
      expect(await kit.invokeAction('internal/tasks/link-session-v1', { v: 1, instance, localRef, sessionId: 'session-new', linked: true })).toEqual({ status: 'linked' });
      expect(calls.filter(call => call.id === 'tasks.internal.session.link')).toEqual([{ id: 'tasks.internal.session.link', input: {
        taskId: predecessor.id, session: { sessionId: 'session-new' }, linked: true,
      } }]);
    });
  });
});
