import { describe, expect, it } from 'vitest';
import { normalizeSessionListFilterV1, sessionWorkFilterFields, matchSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { createWorkflowListFilterRegistryV1, compileWorkflowListFilterV1 } from '@happier-dev/protocol/workflows/listing/workflowListFilterV1';
import { admitPluginListFilterFieldV1 } from '@happier-dev/protocol/collections/filter/pluginListFilterFieldV1';
import { SESSION_WORK_STATUS_FILTERS_V1, listSessionPresentationStatesForWorkStatusFilterV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';
import * as publicFilters from '../../components/CollectionFilter.js';

describe('shared collection condition model', () => {
    it('toggles a single-choice field by replacing its value, never holding two', async () => {
        const { toggleCollectionConditionValue, isCollectionConditionChoiceOn } = await import('./conditionModel.js');
        const registry = createWorkflowListFilterRegistryV1();
        let filter = { view: 'all', extensions: {} } as never as Parameters<typeof publicFilters.conditionModelFromFilter<never, never>>[1];
        const press = (value: string) => {
            filter = publicFilters.applyCollectionConditionEdit(registry as never, filter, toggleCollectionConditionValue(
                publicFilters.conditionModelFromFilter(registry as never, filter), 'view', value));
        };
        press('running');
        expect((filter as { view: string }).view).toBe('running');
        press('triggered');
        expect((filter as { view: string }).view).toBe('triggered');
        expect(isCollectionConditionChoiceOn(publicFilters.conditionModelFromFilter(registry as never, filter), 'view', 'running')).toBe(false);
        press('triggered');
        expect((filter as { view: string }).view).toBe('all');
    });

    it('toggles a grouped choice as its whole group through the real Session registry', async () => {
        const { toggleCollectionConditionValue, isCollectionConditionChoiceOn } = await import('./conditionModel.js');
        const filter = normalizeSessionListFilterV1({} as never);
        const off = publicFilters.conditionModelFromFilter(sessionWorkFilterFields, filter);
        const on = publicFilters.applyCollectionConditionEdit(sessionWorkFilterFields, filter, toggleCollectionConditionValue(off, 'statuses', 'working'));
        expect([...(on.statuses ?? [])].sort()).toEqual([...listSessionPresentationStatesForWorkStatusFilterV1('working')].sort());
        const model = publicFilters.conditionModelFromFilter(sessionWorkFilterFields, on);
        expect(isCollectionConditionChoiceOn(model, 'statuses', 'working')).toBe(true);
        const cleared = publicFilters.applyCollectionConditionEdit(sessionWorkFilterFields, on, toggleCollectionConditionValue(model, 'statuses', 'working'));
        expect(cleared.statuses ?? []).toEqual([]);
    });

    it('toggles one value through its condition: adds it, keeps the others, removes the row with the last', async () => {
        const { toggleCollectionConditionValue } = await import('./conditionModel.js');
        const row = (values: string[]) => ({ id: 'row', fieldId: 'statuses', operator: 'is', values, available: true }) as never;
        expect(toggleCollectionConditionValue({ rows: [] }, 'statuses', 'working'))
            .toEqual({ type: 'add', condition: { fieldId: 'statuses', operator: 'is', values: ['working'] } });
        expect(toggleCollectionConditionValue({ rows: [row(['failed'])] }, 'statuses', 'working'))
            .toEqual({ type: 'change', rowId: 'row', condition: { fieldId: 'statuses', operator: 'is', values: ['failed', 'working'] } });
        expect(toggleCollectionConditionValue({ rows: [row(['failed', 'working'])] }, 'statuses', 'working'))
            .toEqual({ type: 'change', rowId: 'row', condition: { fieldId: 'statuses', operator: 'is', values: ['failed'] } });
        expect(toggleCollectionConditionValue({ rows: [row(['working'])] }, 'statuses', 'working')).toEqual({ type: 'remove', rowId: 'row' });
    });

    it('counts isolated registry choices lazily from held Workflow facts, preserving unknowns and equal result references', () => {
        const registry = createWorkflowListFilterRegistryV1();
        const filter = { view: 'running' as const };
        const request = { fieldId: 'view', options: [{ value: 'triggered' }, { value: 'running' }] };
        let reads = 0;
        const facts = () => { reads += 1; return [{ triggered: true, running: false }, { triggered: false, running: false }]; };
        expect(publicFilters.collectionConditionValueCountsFromFacts(registry, filter, null, facts)).toBeUndefined();
        expect(reads).toBe(0);
        const first = publicFilters.collectionConditionValueCountsFromFacts(registry, filter, request, facts);
        expect(first).toEqual({ fieldId: 'view', options: [{ value: 'triggered', count: 1 }, { value: 'running', count: 0 }] });
        expect(reads).toBe(1);
        const unchanged = publicFilters.collectionConditionValueCountsFromFacts(registry, filter, request, facts, first);
        expect(unchanged).toBe(first);
        expect(unchanged?.options[0]).toBe(first?.options[0]);
        const unknown = publicFilters.collectionConditionValueCountsFromFacts(registry, filter, request,
            () => [{ triggered: true }], first);
        expect(unknown).toEqual({ fieldId: 'view', options: [{ value: 'triggered', count: 1 }, { value: 'running' }] });
        expect(unknown?.options[0]).toBe(first?.options[0]);
        const unsupported = publicFilters.collectionConditionValueCountsFromFacts(registry, filter,
            { fieldId: 'server-only', options: [{ value: 'one' }] }, facts);
        expect(unsupported).toEqual({ fieldId: 'server-only', options: [{ value: 'one' }] });
        expect(reads).toBe(2);
    });

    it('binds optional held-corpus counts by option identity without changing grouped vectors or other fields', () => {
        const filter = normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible' });
        const counts = { fieldId: 'statuses', options: [{ value: 'working', count: 7 }, { value: 'idle', count: 0 }] };
        const model = publicFilters.conditionModelFromFilter(sessionWorkFilterFields, filter, { valueCounts: counts });
        const options = model.availableFields.find(field => field.id === 'statuses')!.valueOptions;
        expect(options.find(option => option.value === 'working')).toMatchObject({ count: 7,
            values: listSessionPresentationStatesForWorkStatusFilterV1('working') });
        expect(options.find(option => option.value === 'idle')).toMatchObject({ count: 0 });
        expect(options.find(option => option.value === 'needs_you')).not.toHaveProperty('count');
        expect(model.availableFields.find(field => field.id === 'excludedStatuses')!.valueOptions
            .every(option => !Object.hasOwn(option, 'count'))).toBe(true);
        expect(filter).not.toHaveProperty('valueCounts');
        const homes = [{ value: 'home', label: 'Home' }];
        const rebound = publicFilters.conditionModelFromFilter(sessionWorkFilterFields, filter, {
            fields: { homeServerIds: { valueOptions: homes } }, valueCounts: counts,
        });
        expect(rebound.availableFields.find(field => field.id === 'homeServerIds')!.valueOptions).toBe(homes);
    });

    it('counts canonical Session groups and unrestricted Scope, and clears the same field\'s opposite selection', () => {
        const filter = normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'assigned_to_me',
            machines: { include: [], exclude: [{ serverId: 'home', machineId: 'one' }] } });
        const facts = [{ serverId: 'home', kind: 'session' as const, startedBy: 'you' as const,
            machine: { serverId: 'home', machineId: 'one' }, scopeMatches: { my_work: true, assigned_to_me: false },
            status: 'thinking' as const, workStatus: { bucket: 'working' as const, tone: 'neutral' as const } }];
        const machines = publicFilters.collectionConditionValueCountsFromFacts(sessionWorkFilterFields, filter,
            { fieldId: 'machines', options: [{ value: { serverId: 'home', machineId: 'one' } }] }, () => facts);
        expect(machines?.options[0]?.count).toBe(1);
        const scope = publicFilters.collectionConditionValueCountsFromFacts(sessionWorkFilterFields, filter,
            { fieldId: 'scope', options: [{ value: 'all_accessible' }, { value: 'my_work' }, { value: 'assigned_to_me' }] }, () => facts);
        expect(scope?.options.map(option => option.count)).toEqual([1, 1, 0]);
        const status = publicFilters.collectionConditionValueCountsFromFacts(sessionWorkFilterFields, filter,
            // A host can label a group, not replace its canonical state vector.
            { fieldId: 'statuses', options: [{ value: 'working', values: ['ready'] }] }, () => facts);
        expect(status?.options[0]?.count).toBe(1);
    });

    it('replaces its own scalar row, without admitting an add or a change over another existing row', () => {
        const initial = normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'assigned_to_me', show: 'runs', source: 'direct' });
        const model = publicFilters.conditionModelFromFilter(sessionWorkFilterFields, initial);
        for (const [fieldId, value] of [['scope', 'following'], ['show', 'sessions'], ['source', 'persisted']] as const) {
            const row = model.rows.find(candidate => candidate.fieldId === fieldId)!;
            const changed = publicFilters.applyCollectionConditionEdit(sessionWorkFilterFields, initial, {
                type: 'change', rowId: row.id, condition: { fieldId, operator: 'is', values: [value] },
            });
            expect(changed[fieldId]).toBe(value);
            expect(publicFilters.conditionModelFromFilter(sessionWorkFilterFields, changed).rows.filter(candidate => candidate.fieldId === fieldId))
                .toMatchObject([{ id: row.id, operator: 'is', values: [value] }]);
            expect(() => publicFilters.applyCollectionConditionEdit(sessionWorkFilterFields, initial, {
                type: 'add', condition: { fieldId, operator: 'is', values: [value] },
            })).toThrow(TypeError);
        }
        const scope = model.rows.find(candidate => candidate.fieldId === 'scope')!;
        expect(() => publicFilters.applyCollectionConditionEdit(sessionWorkFilterFields, initial, {
            type: 'change', rowId: scope.id, condition: { fieldId: 'show', operator: 'is', values: ['sessions'] },
        })).toThrow(TypeError);
        expect(initial).toMatchObject({ scope: 'assigned_to_me', show: 'runs', source: 'direct' });
    });

    it('offers canonical grouped Status values for either operator without persisting group identities', () => {
        const filter = normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible' });
        const model = publicFilters.conditionModelFromFilter(sessionWorkFilterFields, filter);
        const positive = model.availableFields.find(field => field.id === 'statuses')!;
        const negative = model.availableFields.find(field => field.id === 'excludedStatuses')!;
        expect(positive.valueOptions.map(option => option.value)).toEqual(SESSION_WORK_STATUS_FILTERS_V1);
        expect(positive.valueOptions).toEqual(negative.valueOptions);
        const working = positive.valueOptions.find(option => option.value === 'working')!;
        expect(working.values).toEqual(listSessionPresentationStatesForWorkStatusFilterV1('working'));
        if (!working.values) throw new Error('Missing grouped Status values');
        const selected = publicFilters.applyCollectionConditionEdit(sessionWorkFilterFields, filter, { type: 'add',
            condition: { fieldId: positive.id, operator: 'is', values: working.values } });
        expect(selected.statuses).toEqual(working.values);
        const run = { serverId: 'home', kind: 'run', startedBy: 'you', status: 'running',
            workStatus: { bucket: 'working', tone: 'neutral' } } as const;
        expect(matchSessionListFilterV1(selected, run)).toBe('match');
        const excluded = publicFilters.applyCollectionConditionEdit(sessionWorkFilterFields, selected, { type: 'add',
            condition: { fieldId: negative.id, operator: 'is_not', values: working.values } });
        expect(matchSessionListFilterV1(excluded, run)).toBe('miss');
        expect(excluded.excludedStatuses).toEqual(working.values);
        expect(excluded.statuses).not.toContain('working');
        const labelled = publicFilters.conditionModelFromFilter(sessionWorkFilterFields, excluded, {
            fields: { statuses: { valueOptions: [{ value: 'working', label: 'Working', values: ['ready'] }] } },
        });
        expect(labelled.rows.find(row => row.fieldId === 'statuses')?.field.valueOptions)
            .toEqual([{ ...working, label: 'Working' }]);
        const partial = normalizeSessionListFilterV1({ ...filter, statuses: ['thinking'] });
        expect(publicFilters.conditionModelFromFilter(sessionWorkFilterFields, partial).rows.find(row => row.fieldId === 'statuses')?.values)
            .toEqual(['thinking']);
        expect(partial.statuses).toEqual(['thinking']);
    });

    it('projects and edits Session include/exclude selections through the registry without persisting rows', () => {
        const included = { serverId: 'home', machineId: 'one' };
        const excluded = { serverId: 'home', machineId: 'two' };
        const filter = normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible',
            machines: { include: [included], exclude: [excluded] } });
        const bindings = { fields: { machines: { label: 'Machine', valueOptions: [
            { value: included, label: 'Laptop' }, { value: excluded, label: 'Build box' },
        ] } } };
        const model = publicFilters.conditionModelFromFilter(sessionWorkFilterFields, filter, bindings);
        const machineRows = model.rows.filter(row => row.fieldId === 'machines');
        expect(machineRows.map(row => [row.operator, row.values])).toEqual([
            ['is', [included]], ['is_not', [excluded]],
        ]);
        expect(machineRows[0]?.field.label).toBe('Machine');
        expect(model.availableFields.find(field => field.id === 'machines')).toMatchObject({
            operators: ['is', 'is_not'], valueOptions: bindings.fields.machines.valueOptions,
        });
        expect(model.availableFields.find(field => field.id === 'machines')?.valueOptions).toBe(bindings.fields.machines.valueOptions);
        const changed = publicFilters.applyCollectionConditionEdit(sessionWorkFilterFields, filter, {
            type: 'change', rowId: machineRows[0]!.id,
            condition: { fieldId: 'machines', operator: 'is', values: [excluded] },
        });
        expect(changed.machines).toEqual({ include: [excluded], exclude: [excluded] });
        const removed = publicFilters.applyCollectionConditionEdit(sessionWorkFilterFields, changed, {
            type: 'remove', rowId: machineRows[1]!.id,
        });
        expect(removed.machines).toEqual({ include: [excluded], exclude: [] });
        expect(matchSessionListFilterV1(removed, { serverId: 'home', kind: 'session', startedBy: 'you', machine: excluded })).toBe('match');
        expect(filter.machines).toEqual({ include: [included], exclude: [excluded] });
        expect(removed).not.toHaveProperty('conditions');
        expect(removed).not.toHaveProperty('rows');
        expect(publicFilters.applyCollectionConditionEdit(sessionWorkFilterFields, removed, { type: 'clear' }))
            .toEqual(normalizeSessionListFilterV1({ extensions: {} }));
    });

    it('uses the same model for Workflow choices and a genuine plugin-owned is/is-not field', () => {
        const admitted = admitPluginListFilterFieldV1({ pluginId: 'test.release', factKeys: new Set(['stage']),
            field: { id: 'stage', title: 'Release stage', source: { factKey: 'stage' },
                value: { kind: 'set', options: [{ value: 'ready', title: 'Ready' }, { value: 'blocked', title: 'Blocked' }] } } });
        if (admitted.kind !== 'admitted') throw new Error('Invalid fixture');
        const registry = createWorkflowListFilterRegistryV1([admitted.field]);
        const initial = { view: 'all' as const };
        const available = publicFilters.conditionModelFromFilter(registry, initial, {
            valueCounts: { fieldId: admitted.field.id, options: [{ value: 'ready', count: 4 }] },
        }).availableFields;
        expect(available.find(field => field.id === 'view')).toMatchObject({ operators: ['is'],
            valueOptions: [{ value: 'triggered' }, { value: 'running' }] });
        expect(available.find(field => field.id === admitted.field.id)?.operators).toEqual(['is', 'is_not']);
        expect(available.find(field => field.id === admitted.field.id)?.valueOptions).toEqual([
            { value: 'ready', count: 4 }, { value: 'blocked' },
        ]);
        const triggered = publicFilters.applyCollectionConditionEdit(registry, initial, {
            type: 'add', condition: { fieldId: 'view', operator: 'is', values: ['triggered'] },
        });
        const included = publicFilters.applyCollectionConditionEdit(registry, triggered, {
            type: 'add', condition: { fieldId: admitted.field.id, operator: 'is', values: ['ready'] },
        });
        const excluded = publicFilters.applyCollectionConditionEdit(registry, included, {
            type: 'add', condition: { fieldId: admitted.field.id, operator: 'is_not', values: ['blocked'] },
        });
        expect(excluded).toEqual({ view: 'triggered', extensions: { [admitted.field.id]: { kind: 'set', include: ['ready'], exclude: ['blocked'] } } });
        const match = compileWorkflowListFilterV1(excluded, [admitted.field]);
        expect(match({ triggered: true, extensions: { [admitted.field.id]: 'ready' } })).toBe('match');
        expect(match({ triggered: true, extensions: { [admitted.field.id]: ['ready', 'blocked'] } })).toBe('miss');
        const row = publicFilters.conditionModelFromFilter(registry, excluded).rows.find(item => item.fieldId === 'view')!;
        const running = publicFilters.applyCollectionConditionEdit(registry, excluded, { type: 'change', rowId: row.id,
            condition: { fieldId: 'view', operator: 'is', values: ['running'] } });
        expect(running.view).toBe('running');
        expect(publicFilters.applyCollectionConditionEdit(registry, running, { type: 'clear' })).toEqual({ view: 'all', extensions: {} });
    });

    it('preserves opaque narrowing on unrelated edits and refuses invalid, stale or unsupported edits', () => {
        const filter = normalizeSessionListFilterV1({ homeServerIds: ['home'], scope: 'all_accessible',
            extensions: { 'retired/field': { kind: 'boolean', value: true } } });
        const model = publicFilters.conditionModelFromFilter(sessionWorkFilterFields, filter, { evaluator: 'daemonRule' });
        expect(model.availableFields.some(field => field.id === 'branches')).toBe(false);
        expect(model.rows.find(row => row.fieldId === 'unavailableExtensions')?.available).toBe(false);
        expect(() => publicFilters.applyCollectionConditionEdit(sessionWorkFilterFields, filter, {
            type: 'add', condition: { fieldId: 'branches', operator: 'is', values: ['main'] },
        }, { evaluator: 'daemonRule' })).toThrow(TypeError);
        expect(() => publicFilters.applyCollectionConditionEdit(sessionWorkFilterFields, filter, {
            type: 'add', condition: { fieldId: 'machines', operator: 'is', values: ['not-a-qualified-machine'] },
        })).toThrow();
        expect(() => publicFilters.applyCollectionConditionEdit(sessionWorkFilterFields, filter, { type: 'remove', rowId: 'stale' })).toThrow(TypeError);
        const updated = publicFilters.applyCollectionConditionEdit(sessionWorkFilterFields, filter, {
            type: 'add', condition: { fieldId: 'updated', operator: 'between', values: [10, 20] },
        });
        expect(updated.updated).toEqual({ op: 'between', fromMs: 10, toMs: 20 });
        expect(updated.extensions).toBe(filter.extensions);
        expect(publicFilters.conditionModelFromFilter(sessionWorkFilterFields, updated).rows.find(row => row.fieldId === 'updated'))
            .toMatchObject({ operator: 'between', values: [10, 20] });
        const updatedRow = publicFilters.conditionModelFromFilter(sessionWorkFilterFields, updated).rows.find(row => row.fieldId === 'updated')!;
        expect(() => publicFilters.applyCollectionConditionEdit(sessionWorkFilterFields, updated, {
            type: 'change', rowId: updatedRow.id,
            condition: { fieldId: 'updated', operator: 'between', values: [10] },
        })).toThrow(TypeError);
        const after = publicFilters.applyCollectionConditionEdit(sessionWorkFilterFields, updated, {
            type: 'change', rowId: updatedRow.id,
            condition: { fieldId: 'updated', operator: 'after', values: [20] },
        });
        expect(after.updated).toEqual({ op: 'after', atMs: 20 });
        expect(matchSessionListFilterV1(after, { serverId: 'home', kind: 'session', startedBy: 'you', updatedAt: 20 }))
            .toBe('miss');
        expect(() => publicFilters.applyCollectionConditionEdit(sessionWorkFilterFields, after, {
            type: 'add', condition: { fieldId: 'updated', operator: 'after', values: [30] },
        })).toThrow(TypeError);
    });
});
