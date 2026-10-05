import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowTriggerSetV1Schema } from '@happier-dev/protocol';
import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { useWorkflowTriggerEditing } from './useWorkflowTriggerEditing';
import { editWorkflowTriggerDraft } from './workflowTriggerDraft';
import { useWorkflowTriggerSets } from './useWorkflowTriggerSets';

// The Action transport and applied network identity are boundaries; schemas, store and hook stay real.
const transport = vi.hoisted(() => vi.fn());
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({ createFrontDoorActionExecute: () => transport }));
vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    getAppliedActiveServerSnapshot: () => ({ serverId: storage.getState().profileScope?.serverId }),
    isAppliedActiveServerRuntimeAvailable: () => true,
}));

const definitionId = '00000000-0000-4000-8000-000000000001';
const projectTarget = { machineId: 'm1', directory: '/repo' };
const trigger = { kind: 'schedule', enabled: true, schedule: { kind: 'cron', scheduleExpr: '0 9 * * *', everyMs: null, timezone: null } } as const;
const set = WorkflowTriggerSetV1Schema.parse({ automationId: 'set-1', revision: 1, enabled: true, health: 'available', project: projectTarget,
    target: { kind: 'workflow', ref: definitionId }, triggers: [{ ...trigger, id: 't1', revision: 1, createdAt: 1, updatedAt: 1,
        nextRunAt: null, triggerDefinitionEnvelope: null }] });
let previous = storage.getState();
beforeEach(() => {
    previous = storage.getState();
    storage.setState({ profileScope: { serverId: 'server-a', accountId: 'account-a' } });
    transport.mockReset();
    transport.mockResolvedValue({ ok: true, result: { sets: [] } });
});
afterEach(() => { standardCleanup(); storage.setState(previous); });

describe('workflow trigger editing lifetime', () => {
    it('restores semantic history across addition acknowledgement without duplicating a saved trigger', async () => {
        transport.mockImplementation(async (action: string) => action === 'workflow.trigger.add'
            ? { ok: true, result: { set, triggerId: 't1', triggerRevision: 1 } }
            : { ok: true, result: { sets: [] } });
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId, sourceKey: 'history', projectTarget } });
        const before = hook.getCurrent().captureSnapshot();
        const next = editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'add', clientId: 'c1', trigger });
        const after = hook.getCurrent().captureSnapshot(next);
        await act(async () => hook.getCurrent().setDraft(next));
        await act(async () => { await hook.getCurrent().save(definitionId, () => true); });
        expect(hook.getCurrent().dirty).toBe(false);
        await act(async () => hook.getCurrent().restoreSnapshot(before));
        expect(hook.getCurrent().draft.removes).toEqual(['t1']);
        await act(async () => hook.getCurrent().restoreSnapshot(after));
        expect(hook.getCurrent().dirty).toBe(false);
        expect(hook.getCurrent().draft.adds).toEqual([]);
    });

    it('can Undo the first trigger Save before the created definition id reaches the hook props', async () => {
        transport.mockResolvedValue({ ok: true, result: { set, triggerId: 't1', triggerRevision: 1 } });
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId: null, sourceKey: 'new-history', projectTarget } });
        const before = hook.getCurrent().captureSnapshot();
        await act(async () => hook.getCurrent().restoreSnapshot(before));
        expect(hook.getCurrent().dirty).toBe(false);
        const next = editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'add', clientId: 'c1', trigger });
        const after = hook.getCurrent().captureSnapshot(next);
        await act(async () => hook.getCurrent().setDraft(next));
        await act(async () => { await hook.getCurrent().save(definitionId, () => true); });
        await act(async () => hook.getCurrent().restoreSnapshot(before));
        expect(hook.getCurrent().draft.removes).toEqual(['t1']);
        await act(async () => hook.getCurrent().restoreSnapshot(after));
        expect(hook.getCurrent().dirty).toBe(false);
    });

    it('refuses Undo of a private Event whose removal is already being saved without consuming the current draft', async () => {
        const first = set.triggers[0]!;
        if (first.kind !== 'schedule') throw new Error('schedule fixture required');
        const { schedule: _schedule, nextRunAt: _nextRunAt, ...base } = first;
        const eventSet = WorkflowTriggerSetV1Schema.parse({ ...set, triggers: [{ ...base, kind: 'pluginEvent',
            eventRef: { pluginId: 'plugin', localId: 'event' }, sourceSelectorId: 'source', sourceContractVersion: 1,
            observation: { kind: 'socket', watcher: null }, sourceStatus: null, sourceCatalogStatus: null, triggerDefinitionEnvelope: 'sealed-private' }] });
        const deferred = createDeferred<unknown>();
        transport.mockImplementation(async (action: string) => action === 'workflow.trigger.remove'
            ? deferred.promise : { ok: true, result: { sets: [eventSet] } });
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId, sourceKey: 'private-history', projectTarget } });
        const before = hook.getCurrent().captureSnapshot();
        await act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'remove', triggerId: eventSet.triggers[0]!.id })));
        let saving!: ReturnType<ReturnType<typeof hook.getCurrent>['save']>;
        await act(async () => { saving = hook.getCurrent().save(definitionId, () => true); });
        expect(() => hook.getCurrent().restoreSnapshot(before)).toThrowError(expect.objectContaining({ code: 'workflow_trigger_restore_requires_setup' }));
        expect(hook.getCurrent().draft.removes).toEqual(['t1']);
        await act(async () => { deferred.resolve({ ok: true, result: { set: { ...eventSet, revision: 2, triggers: [] } } }); await saving; });
        expect(hook.getCurrent().dirty).toBe(false);
    });

    it('keeps an Undo made while a removal is being saved after its acknowledgement', async () => {
        const deferred = createDeferred<unknown>();
        transport.mockImplementation(async (action: string) => action === 'workflow.trigger.remove'
            ? deferred.promise : { ok: true, result: { sets: [set] } });
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId, sourceKey: 'history', projectTarget } });
        const before = hook.getCurrent().captureSnapshot();
        await act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'remove', triggerId: set.triggers[0]!.id })));
        let saving!: ReturnType<ReturnType<typeof hook.getCurrent>['save']>;
        await act(async () => { saving = hook.getCurrent().save(definitionId, () => true); });
        await act(async () => hook.getCurrent().restoreSnapshot(before));
        await act(async () => { deferred.resolve({ ok: true, result: { set: { ...set, revision: 2, triggers: [] } } }); await saving; });
        expect(hook.getCurrent().draft.adds).toEqual([{ clientId: 'saved:t1', trigger }]);
        expect(hook.getCurrent().dirty).toBe(true);
    });

    it('restores deleted schedules and set context after Save, and reuses the replacement identity on redo', async () => {
        const original = WorkflowTriggerSetV1Schema.parse({ ...set, context: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' }, inputs: { name: 'old' } } });
        const removed = WorkflowTriggerSetV1Schema.parse({ ...original, revision: 2, project: { machineId: 'm2', directory: '/other' },
            context: { ...original.context, inputs: { name: 'new' } }, triggers: [] });
        const restored = WorkflowTriggerSetV1Schema.parse({ ...original, revision: 3, triggers: [{ ...set.triggers[0], id: 'replacement' }] });
        transport.mockImplementation(async (action: string) => ({ ok: true, result: action === 'workflow.trigger.list' ? { sets: [original] }
            : action === 'workflow.trigger.remove' ? { set: removed } : action === 'workflow.trigger.add'
                ? { set: restored, triggerId: 'replacement', triggerRevision: 1 } : { set: removed } }));
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId, sourceKey: 'history', projectTarget } });
        const before = hook.getCurrent().captureSnapshot();
        let next = editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'remove', triggerId: set.triggers[0]!.id });
        next = editWorkflowTriggerDraft(next, { kind: 'setContext', context: { project: removed.project, inputs: { name: 'new' } } });
        const after = hook.getCurrent().captureSnapshot(next);
        await act(async () => hook.getCurrent().setDraft(next));
        await act(async () => { await hook.getCurrent().save(definitionId, () => true); });
        await act(async () => hook.getCurrent().restoreSnapshot(before));
        expect(hook.getCurrent().draft.adds).toEqual([{ clientId: 'saved:t1', trigger }]);
        expect(hook.getCurrent().draft.context).toEqual({ project: projectTarget, inputs: { name: 'old' } });
        await act(async () => { await hook.getCurrent().save(definitionId, () => true); });
        await act(async () => hook.getCurrent().restoreSnapshot(after));
        expect(hook.getCurrent().draft.removes).toEqual(['replacement']);
        expect(hook.getCurrent().draft.adds).toEqual([]);
    });

    it('resets pending edits across source, Account and server changes, including unsaved sources', async () => {
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId: null, sourceKey: 'new-a', projectTarget } });
        const add = async () => act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'add', clientId: 'c1', trigger })));
        await add();
        expect(hook.getCurrent().dirty).toBe(true);
        await hook.rerender({ definitionId: null, sourceKey: 'new-b', projectTarget });
        expect(hook.getCurrent().dirty).toBe(false);
        await add();
        await act(async () => storage.setState({ profileScope: { serverId: 'server-a', accountId: 'account-b' } }));
        expect(hook.getCurrent().dirty).toBe(false);
        await add();
        await act(async () => storage.setState({ profileScope: { serverId: 'server-b', accountId: 'account-b' } }));
        expect(hook.getCurrent().dirty).toBe(false);
    });

    it('subtracts acknowledged additions while keeping edits made during Save', async () => {
        const deferred = createDeferred<unknown>();
        transport.mockImplementation(async (action: string) => action === 'workflow.trigger.add' ? deferred.promise : { ok: true, result: { sets: [] } });
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId, sourceKey: 'saved-a', projectTarget } });
        await act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'add', clientId: 'captured', trigger })));
        let saving!: ReturnType<ReturnType<typeof hook.getCurrent>['save']>;
        await act(async () => { saving = hook.getCurrent().save(definitionId, () => true); });
        await act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'add', clientId: 'later', trigger })));
        await act(async () => { deferred.resolve({ ok: true, result: { set, triggerId: 't1', triggerRevision: 1 } }); await saving; });
        expect(hook.getCurrent().draft.adds.map((add) => add.clientId)).toEqual(['later']);
    });

    it.each(['change', 'discard'] as const)('keeps a %s made to an addition while Save is pending on its new saved identity', async (edit) => {
        const deferred = createDeferred<unknown>();
        transport.mockImplementation(async (action: string) => action === 'workflow.trigger.add' ? deferred.promise : { ok: true, result: { sets: [] } });
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId, sourceKey: 'saved-a', projectTarget } });
        await act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'add', clientId: 'c1', trigger })));
        let saving!: ReturnType<ReturnType<typeof hook.getCurrent>['save']>;
        await act(async () => { saving = hook.getCurrent().save(definitionId, () => true); });
        const changed = { ...trigger, enabled: false, schedule: { ...trigger.schedule, scheduleExpr: '0 8 * * *' } };
        await act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft,
            edit === 'change' ? { kind: 'add', clientId: 'c1', trigger: changed } : { kind: 'discardAdd', clientId: 'c1' })));
        await act(async () => { deferred.resolve({ ok: true, result: { set, triggerId: 't1', triggerRevision: 1 } }); await saving; });
        expect(hook.getCurrent().draft.adds).toEqual([]);
        if (edit === 'change') expect(hook.getCurrent().draft.updates).toEqual({ t1: { trigger: { kind: 'schedule', schedule: changed.schedule }, enabled: false } });
        else expect(hook.getCurrent().draft.removes).toEqual(['t1']);
    });

    it('keeps later trigger and context values while acknowledging the captured update batch', async () => {
        const original = WorkflowTriggerSetV1Schema.parse({ ...set, context: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' }, inputs: { name: 'old' } } });
        const capturedTrigger = { kind: 'schedule', schedule: { ...trigger.schedule, scheduleExpr: '0 7 * * *' } } as const;
        const written = WorkflowTriggerSetV1Schema.parse({ ...original, revision: 2, triggers: [{ ...original.triggers[0], ...capturedTrigger, enabled: false }] });
        const deferred = createDeferred<unknown>();
        transport.mockImplementation(async (action: string, request: { triggerId?: string }) => action === 'workflow.trigger.list'
            ? { ok: true, result: { sets: [original] } } : request.triggerId ? deferred.promise
                : { ok: true, result: { set: { ...written, revision: 3, project: { machineId: 'm2', directory: '/captured' }, context: { ...written.context, inputs: { name: 'captured' } } } } });
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId, sourceKey: 'saved-a', projectTarget } });
        await act(async () => {
            let draft = editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'update', triggerId: original.triggers[0]!.id, trigger: capturedTrigger, enabled: false });
            draft = editWorkflowTriggerDraft(draft, { kind: 'setContext', context: { project: { machineId: 'm2', directory: '/captured' }, inputs: { name: 'captured' } } });
            hook.getCurrent().setDraft(draft);
        });
        let saving!: ReturnType<ReturnType<typeof hook.getCurrent>['save']>;
        await act(async () => { saving = hook.getCurrent().save(definitionId, () => true); });
        const changedTrigger = { kind: 'schedule', schedule: { ...trigger.schedule, scheduleExpr: '0 8 * * *' } } as const;
        const changedContext = { project: { machineId: 'm3', directory: '/later' }, inputs: { name: 'later' } };
        await act(async () => {
            let draft = editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'update', triggerId: original.triggers[0]!.id, trigger: changedTrigger, enabled: true });
            draft = editWorkflowTriggerDraft(draft, { kind: 'setContext', context: changedContext });
            hook.getCurrent().setDraft(draft);
        });
        await act(async () => { deferred.resolve({ ok: true, result: { set: written } }); await saving; });
        expect(hook.getCurrent().draft.updates).toEqual({ t1: { trigger: changedTrigger, enabled: true } });
        expect(hook.getCurrent().draft.context).toEqual(changedContext);
    });

    it('stops the captured batch after navigation even when the caller fence stays true', async () => {
        const deferred = createDeferred<unknown>();
        transport.mockImplementation(async (action: string) => action === 'workflow.trigger.add' ? deferred.promise : { ok: true, result: { sets: [] } });
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId, sourceKey: 'saved-a', projectTarget } });
        await act(async () => {
            let draft = editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'add', clientId: 'first', trigger });
            draft = editWorkflowTriggerDraft(draft, { kind: 'add', clientId: 'second', trigger });
            hook.getCurrent().setDraft(draft);
        });
        let saving!: ReturnType<ReturnType<typeof hook.getCurrent>['save']>;
        await act(async () => { saving = hook.getCurrent().save(definitionId, () => true); });
        await hook.rerender({ definitionId, sourceKey: 'saved-b', projectTarget });
        let outcome: string | undefined;
        await act(async () => { deferred.resolve({ ok: true, result: { set, triggerId: 't1', triggerRevision: 1 } }); outcome = await saving; });
        expect(outcome).toBe('stale');
        expect(transport.mock.calls.filter(([action]) => action === 'workflow.trigger.add')).toHaveLength(1);
        expect(hook.getCurrent().dirty).toBe(false);
    });

    it('keeps the unsaved source draft when its first definition is saved', async () => {
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId: null as string | null, sourceKey: 'new-a', projectTarget } });
        await act(async () => hook.getCurrent().setDraft(editWorkflowTriggerDraft(hook.getCurrent().draft, { kind: 'add', clientId: 'first', trigger })));
        await hook.rerender({ definitionId, sourceKey: 'new-a', projectTarget });
        expect(hook.getCurrent().draft.adds.map((add) => add.clientId)).toEqual(['first']);
    });

    it('reports cold Account reads as failed and recovers through its original query', async () => {
        transport.mockRejectedValueOnce(new Error('offline'));
        const query = { scope: 'account_inline' } as const;
        const hook = await renderHook(() => useWorkflowTriggerSets(query));
        expect(hook.getCurrent().status).toBe('failed');
        expect(hook.getCurrent().sets).toEqual([]);
        await act(async () => hook.getCurrent().retry());
        expect(hook.getCurrent().status).toBe('ready');
        expect(transport.mock.calls.filter(([action]) => action === 'workflow.trigger.list').map(([, request]) => request)).toEqual([query, query]);
    });

    it('reports failed reads, keeps known rows and retries the same owner', async () => {
        transport.mockResolvedValueOnce({ ok: true, result: { sets: [set] } });
        const hook = await renderHook(useWorkflowTriggerEditing, { initialProps: { definitionId, sourceKey: 'saved-a', projectTarget } });
        expect(hook.getCurrent().set?.automationId).toBe('set-1');
        transport.mockRejectedValueOnce(new Error('offline'));
        await act(async () => hook.getCurrent().retry());
        expect(hook.getCurrent().status).toBe('failed');
        expect(hook.getCurrent().set?.automationId).toBe('set-1');
        transport.mockResolvedValueOnce({ ok: true, result: { sets: [set] } });
        await act(async () => hook.getCurrent().retry());
        expect(hook.getCurrent().status).toBe('ready');
    });
});
