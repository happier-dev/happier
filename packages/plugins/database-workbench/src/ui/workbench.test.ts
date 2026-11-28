import { expect, it } from 'vitest';
import type { DatabaseOperationResultV1, DatabaseRelationStructureV1, DatabaseRowsContinuationV1 } from '@happier-dev/plugin-sdk/database';
import { createDatabaseDescriptorV1Fixture } from '@happier-dev/database-protocol/testing/v1';
import { DATABASE_EDITS_APPLY_ACTION_ID_V1 } from '@happier-dev/database-protocol';
import { databaseActionLocalIdV1 } from '@happier-dev/plugin-sdk/actions';
import { describeDatabaseConnection } from '../connection.js';
import type { WorkbenchClient, WorkbenchLocation } from './models.js';
import { workbenchTargetKey, createWorkbenchInstance } from './workbench.js';

const descriptor = createDatabaseDescriptorV1Fixture();
const targetKey = workbenchTargetKey(descriptor.target);

it('retains opened pages across switches and only reads on new demand, Refresh or a matching write', async () => {
    const relation = { schema: 'public', name: 'items' };
    const structure: DatabaseRelationStructureV1 = { relation, kind: 'table',
        columns: [{ name: 'id', nativeType: 'bigint', semanticType: 'integer', nullable: false, generated: false }],
        primaryKey: ['id'], indexes: [], foreignKeys: [], capabilities: [] };
    const calls: string[] = [];
    const continuation: DatabaseRowsContinuationV1 = { kind: 'offset', offset: 1, binding: {
        target: descriptor.target, relation, columns: ['id'], order: [],
    } };
    let firstId = '9007199254740993';
    let markFirstStructureStarted!: () => void;
    let releaseFirstStructure!: () => void;
    const firstStructureStarted = new Promise<void>(resolve => { markFirstStructureStarted = resolve; });
    const firstStructureReply = new Promise<void>(resolve => { releaseFirstStructure = resolve; });
    let ownWrite: Parameters<WorkbenchClient['subscribeOwnWrites']>[0] | undefined;
    // Genuine Action transport boundary: deterministic driver answers, real cache/draft logic underneath.
    const client: WorkbenchClient = {
        targets: async () => { throw new Error('Selected targets must not rediscover'); },
        operation: async input => {
            calls.push(input.operation);
            const incomplete = (operation: 'schemas.list' | 'relations.list') => ({ complete: false as const, reason: 'page' as const,
                continuation: { kind: 'catalog' as const, operation, target: descriptor.target, after: 'later' } });
            if (input.operation === 'schemas.list') return { ok: true, operation: input.operation, schemas: [{ name: 'public' }], completeness: incomplete(input.operation) };
            if (input.operation === 'relations.list') return { ok: true, operation: input.operation, relations: [{ relation, kind: 'table' }], completeness: incomplete(input.operation) };
            if (input.operation === 'relation.structure') {
                markFirstStructureStarted();
                await firstStructureReply;
                return { ok: true, operation: input.operation, structure: { ...structure, relation: input.relation } };
            }
            if (input.operation === 'rows.read') {
                const later = input.page.continuation?.kind === 'offset' && input.page.continuation.offset === 1;
                const cell = { type: 'integer', value: later ? '9007199254740995' : firstId } as const;
                return { ok: true, operation: input.operation, result: { columns: structure.columns,
                    rows: [{ cells: [cell], identity: { key: [{ column: 'id', value: cell }], original: [] } }],
                    completeness: later || input.relation.name !== relation.name ? { complete: true } : {
                        complete: false, reason: 'page', continuation,
                    } } };
            }
            throw new Error('Unexpected operation');
        },
        access: async () => { throw new Error('Read caching does not read policy'); },
        subscribeOwnWrites(listener) { ownWrite = listener; return () => { ownWrite = undefined; }; },
        navigate: async () => {}, openRoot: async () => {}, setUnsavedChanges: async () => {}, presentDeviceStorageError(error) { throw error; }, saveExport: async () => { throw new Error('Nothing is saved as a file here'); },
    };
    const location: WorkbenchLocation = { targetKey, relation, mode: 'data', sort: [], columns: ['id'], page: { rows: 40, offset: 0 }, fkTrail: [] };
    const instance = createWorkbenchInstance({ client, scope: { kind: 'worktree', accountId: 'account', installationId: 'installation', projectKey: 'project',
        workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'workspace', rootPath: '/project' } }, location, selectedTarget: descriptor,
        cataloguePageRows: 40, statementRanges: () => [], consoleStorage: () => ({ read: async () => null, write: async () => {} }) });
    const schemas = instance.relations(targetKey);
    const groups = instance.schemaRelations(targetKey, 'public');
    const page = instance.page(location);
    const otherPage = instance.page({ ...location, relation: { schema: 'public', name: 'other' } });
    const off = [schemas.subscribe(() => {}), groups.subscribe(() => {})];
    try {
        await schemas.demand();
        expect(calls).toEqual(['schemas.list']);
        await groups.demand();
        expect(calls).toEqual(['schemas.list', 'relations.list']);
        const hideFirstPage = page.subscribe(() => {});
        off.push(hideFirstPage);
        const opening = page.demand();
        try {
            await firstStructureStarted;
            await Promise.resolve();
            expect(calls.slice(2).sort()).toEqual(['relation.structure', 'rows.read']);
        } finally {
            releaseFirstStructure();
            await opening;
        }
        const held = page.get().data;
        const initialCalls = calls.length;
        const completeness = held?.completeness;
        if (!completeness || completeness.complete || completeness.continuation?.kind !== 'offset') {
            throw new Error('Expected a second page');
        }
        hideFirstPage();
        const laterPage = instance.page({ ...location, page: { ...location.page, offset: 1, continuation: completeness.continuation } });
        const hideLaterPage = laterPage.subscribe(() => {});
        off.push(hideLaterPage);
        await laterPage.demand();
        expect(laterPage.get().data?.rows[0]?.cells).toEqual([{ type: 'integer', value: '9007199254740995' }]);
        expect(calls.slice(initialCalls)).toEqual(['rows.read']);
        hideLaterPage();

        off.push(otherPage.subscribe(() => {}));
        await otherPage.demand();
        const untouched = otherPage.get().data;
        const beforeReveal = calls.length;
        firstId = '9007199254740994'; // An external write has no Workbench own-write notification.
        off.push(page.subscribe(() => {}));
        await page.demand();
        expect(page.get().data).toBe(held);
        expect(calls).toHaveLength(beforeReveal);

        instance.refresh(targetKey, relation);
        await page.demand();
        expect(calls.slice(beforeReveal).sort()).toEqual(['relation.structure', 'rows.read']);
        expect(page.get().data?.rows[0]?.cells).toEqual([{ type: 'integer', value: firstId }]);
        expect(otherPage.get().data).toBe(untouched);
        const refreshed = page.get().data;
        const before = [...calls];
        const change = { targetKey, relation, rowKey: 'row', label: 'Row', change: {
            kind: 'delete' as const, key: [{ column: 'id', value: { type: 'integer' as const, value: '1' } }],
        } };
        instance.drafts.stage(instance.draftKey(change), change);
        const apply = instance.apply(relation);
        expect(apply.action).toBe(databaseActionLocalIdV1(DATABASE_EDITS_APPLY_ACTION_ID_V1));
        await apply.controller.prepare({ signal: new AbortController().signal });
        apply.controller.onSettled({ ok: true, result: { ok: true, operation: 'edits.apply',
            status: 'committed', inserted: '0', updated: '0', deleted: '1' } });
        await page.demand();
        expect(calls, 'Apply settlement waits for the same own-write push as every other workbench').toEqual(before);
        expect(page.get().data).toBe(refreshed);
        ownWrite?.({ target: descriptor.target, relation });
        await page.demand();
        expect(calls.slice(before.length).sort()).toEqual(['relation.structure', 'rows.read']);
        expect(otherPage.get().data).toBe(untouched);
        const afterOwnWrite = calls.length;
        await laterPage.demand();
        expect(calls.slice(afterOwnWrite)).toEqual(['rows.read']);
    } finally { for (const unsubscribe of off) unsubscribe(); instance.close(); }
});

it('merges navigation intent into the local location and clears the previous page when query operands change', async () => {
    const location: WorkbenchLocation = { targetKey, relation: { schema: 'public', name: 'items' }, mode: 'data',
        sort: [], columns: ['id'], page: { rows: 40, offset: 80 }, fkTrail: [] };
    const navigations: WorkbenchLocation[] = [];
    const unexpected = async (): Promise<never> => { throw new Error('Navigation does not read or write a database'); };
    const client: WorkbenchClient = { targets: unexpected, operation: unexpected, access: unexpected,
        subscribeOwnWrites: () => () => {}, navigate: async value => { navigations.push(value); }, openRoot: async () => {},
        setUnsavedChanges: async () => {}, presentDeviceStorageError(error) { throw error; }, saveExport: async () => { throw new Error('Nothing is saved as a file here'); } };
    const instance = createWorkbenchInstance({ client, scope: { kind: 'worktree', accountId: 'account', installationId: 'installation', projectKey: 'project',
        workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'workspace', rootPath: '/project' } }, location, selectedTarget: descriptor,
        cataloguePageRows: 40, statementRanges: () => [], consoleStorage: () => ({ read: async () => null, write: async () => {} }) });
    try {
        await instance.navigate({ mode: 'console' });
        expect(instance.local.get('location')).toEqual({ ...location, mode: 'console' });
        await instance.navigate({ relation: { schema: 'public', name: 'other' }, mode: 'data',
            fkTrail: [{ relation: location.relation! }] });
        expect(instance.local.get('location')).toMatchObject({ targetKey, relation: { schema: 'public', name: 'other' },
            page: { rows: 40, offset: 0 }, fkTrail: [{ relation: location.relation! }] });
        expect(navigations.at(-1)).toBe(instance.local.get('location'));
    } finally { instance.close(); }
});

it('prepares Apply for a host gesture and retains proposals edited while the submitted batch settles', async () => {
    const relation = { schema: 'public', name: 'items' };
    const location: WorkbenchLocation = { targetKey, relation, mode: 'data', sort: [], columns: ['id'], page: { rows: 40, offset: 0 }, fkTrail: [] };
    let commits = 0;
    const unsavedTransitions: boolean[] = [];
    const unexpected = async (): Promise<never> => { throw new Error('Staging performs no database reads'); };
    const client: WorkbenchClient & { commit(): Promise<DatabaseOperationResultV1> } = { targets: unexpected, operation: unexpected, access: unexpected,
        commit: async () => { commits++; return { ok: true, operation: 'edits.apply', status: 'committed', inserted: '0', updated: '0', deleted: '1' }; },
        subscribeOwnWrites: () => () => {}, navigate: async () => {}, openRoot: async () => {},
        setUnsavedChanges: async dirty => { unsavedTransitions.push(dirty); }, presentDeviceStorageError(error) { throw error; },
        saveExport: async () => { throw new Error('Nothing is saved as a file here'); } };
    const instance = createWorkbenchInstance({ client, scope: { kind: 'worktree', accountId: 'account', installationId: 'installation', projectKey: 'project',
        workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'workspace', rootPath: '/project' } }, location, selectedTarget: descriptor,
        cataloguePageRows: 40, statementRanges: () => [], consoleStorage: () => ({ read: async () => null, write: async () => {} }) });
    const submitted = { targetKey, relation, rowKey: 'row', label: 'Row', change: { kind: 'delete' as const,
        key: [{ column: 'id', value: { type: 'integer' as const, value: '1' } }] } };
    try {
        instance.drafts.stage(instance.draftKey(submitted), submitted);
        const binding = instance.apply(relation);
        expect(commits).toBe(0);
        const prepared = await binding.controller.prepare({ signal: new AbortController().signal });
        expect(prepared?.input).toMatchObject({ operation: 'edits.apply', target: descriptor.target, relation, changes: [submitted.change] });
        const replacement = { ...submitted, label: 'New proposal' };
        instance.drafts.stage(instance.draftKey(replacement), replacement);
        binding.controller.onSettled({ ok: true, result: { ok: true, operation: 'edits.apply', status: 'committed', inserted: '0', updated: '0', deleted: '1' } });
        expect(instance.drafts.changes()).toEqual([replacement]);
        expect(instance.applyOutcomes.get(JSON.stringify([targetKey, relation]))).toMatchObject({ kind: 'applied', count: '1' });
        instance.drafts.takeBack(instance.draftKey(replacement));
        expect(unsavedTransitions).toEqual([true, false]);
    } finally { instance.close(); }
});

it('blocks stale Apply after a row conflict and reloads only that original before explicit Apply', async () => {
    const relation = { schema: 'public', name: 'items' };
    const location: WorkbenchLocation = { targetKey, relation, mode: 'data', sort: [], columns: [], page: { rows: 40, offset: 0 }, fkTrail: [] };
    const cell = (value: string) => ({ type: 'text' as const, value });
    const column = { name: 'label', nativeType: 'text', semanticType: 'text' as const };
    const reads: Parameters<WorkbenchClient['operation']>[0][] = [];
    type ReadOutcome = 'missing' | 'failed' | 'partial' | 'complete';
    const replies: ReadOutcome[] = ['missing', 'failed', 'partial', 'complete'];
    const unexpected = async (): Promise<never> => { throw new Error('Unexpected database demand'); };
    const client: WorkbenchClient = {
        targets: unexpected, access: unexpected, subscribeOwnWrites: () => () => {},
        navigate: async () => {}, openRoot: async () => {}, setUnsavedChanges: async () => {},
        presentDeviceStorageError(error) { throw error; }, saveExport: unexpected,
        async operation(input) {
            reads.push(input);
            const reply = replies.shift();
            if (input.operation !== 'rows.read' || !reply) return unexpected();
            if (reply === 'failed') return { ok: false, status: 'unavailable', code: 'database_unavailable', reason: 'The connection closed' };
            if (reply === 'partial') return { ok: true, operation: 'rows.read', result: {
                columns: [], rows: [{ cells: [] }], completeness: { complete: false, reason: 'response_envelope' },
            } };
            return { ok: true, operation: 'rows.read', result: {
                columns: [column], rows: reply === 'missing' ? [] : [{ cells: [cell('concurrent')] }],
                completeness: { complete: true },
            } };
        },
    };
    const instance = createWorkbenchInstance({ client, scope: { kind: 'worktree', accountId: 'account', installationId: 'installation', projectKey: 'project',
        workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'workspace', rootPath: '/project' } }, location, selectedTarget: descriptor,
        cataloguePageRows: 40, statementRanges: () => [], consoleStorage: () => ({ read: async () => null, write: async () => {} }) });
    const stage = (id: string) => {
        const proposal = {
            targetKey, relation, rowKey: id, label: id,
            change: { kind: 'update' as const,
                key: [{ column: 'tenant', value: { type: 'integer' as const, value: id } }, { column: 'id', value: cell('same-id') }],
                original: [{ column: 'label', value: cell(`original-${id}`) }],
                values: [{ column: 'label', value: { kind: 'value' as const, cell: cell(`draft-${id}`) } }],
            },
        };
        instance.drafts.stage(instance.draftKey(proposal), proposal);
        return proposal;
    };
    try {
        const first = stage('1');
        const second = stage('2');
        const binding = instance.apply(relation);
        const gesture = { signal: new AbortController().signal };
        const conflict = (reason: 'row_changed' | 'relation_changed') =>
            binding.controller.onSettled({ ok: true, result: {
                ok: false, status: 'conflict', code: 'database_edit_conflict', changeIndex: 1, reason,
            } });

        expect(await binding.controller.prepare(gesture)).not.toBeNull();
        conflict('row_changed');
        expect(await binding.controller.prepare(gesture)).toBeNull();
        expect(instance.applyOutcomes.get(JSON.stringify([targetKey, relation]))).toMatchObject({ kind: 'conflict', rowKey: '2' });

        for (const failed of ['missing', 'failed', 'partial']) {
            await instance.reloadConflict(second);
            expect(await binding.controller.prepare(gesture), failed).toBeNull();
            expect(instance.drafts.changes(), failed).toEqual([first, second]);
        }
        await instance.reloadConflict(second);
        expect(reads).toEqual(Array.from({ length: 4 }, () => ({
            operation: 'rows.read', target: descriptor.target, relation, columns: ['label'], order: [], page: { rows: 1 },
            filter: { kind: 'and', filters: second.change.key.map(({ column, value }) => ({ kind: 'comparison', column, operator: 'eq', value })) },
        })));
        expect(instance.drafts.get(instance.draftKey(first))).toBe(first);
        const rebased = { ...second.change, original: [{ column: 'label', value: cell('concurrent') }] };
        expect(instance.review(instance.drafts.changes()).groups[0]?.rows[1]?.changes[0]?.old).toEqual(cell('concurrent'));
        expect(await binding.controller.prepare(gesture)).toMatchObject({ input: { changes: [first.change, rebased] } });

        conflict('relation_changed');
        await instance.reloadConflict(second);
        expect(reads).toHaveLength(4);
        const scope = { targetKey, relation };
        instance.takeBackChanges(scope, [second.rowKey]);
        expect(await binding.controller.prepare(gesture)).toBeNull();
        instance.takeBackChanges(scope, [first.rowKey]);
        stage('1');
        stage('2');
        expect(await binding.controller.prepare(gesture)).not.toBeNull();
        conflict('row_changed');
        instance.takeBackChanges(scope, [second.rowKey]);
        expect(await binding.controller.prepare(gesture)).toMatchObject({ input: { changes: [first.change] } });
    } finally { instance.close(); }
});

it('keeps typed filters, full FK Back state and loaded-only export on the same cached page owner', async () => {
    const relation = { schema: 'public', name: 'items' };
    const location: WorkbenchLocation = { targetKey, relation, mode: 'data', columns: ['id', 'parent'], sort: [],
        conditions: { kind: 'comparison', column: 'id', operator: 'eq', value: { type: 'integer', value: '9007199254740993' } },
        page: { rows: 40, offset: 0 }, fkTrail: [] };
    const columns = ['id', 'parent'].map(name => ({ name, nativeType: 'bigint', semanticType: 'integer' as const, nullable: false, generated: false }));
    let rowReads = 0;
    const unexpected = async (): Promise<never> => { throw new Error('Only demanded reads may execute'); };
    const client: WorkbenchClient = { targets: unexpected, access: unexpected, subscribeOwnWrites: () => () => {},
        navigate: async () => {}, openRoot: async () => {}, setUnsavedChanges: async () => {}, presentDeviceStorageError(error) { throw error; }, saveExport: async () => { throw new Error('Nothing is saved as a file here'); },
        operation: async input => {
            if (input.operation === 'relation.structure') return { ok: true, operation: input.operation, structure: { relation, kind: 'table', columns,
                primaryKey: ['id'], indexes: [], capabilities: [], foreignKeys: [{ name: 'parent_fk', columns: ['parent'], target: { schema: 'public', name: 'parents' }, targetColumns: ['id'] }] } };
            if (input.operation === 'rows.read') {
                rowReads++;
                expect(input.filter).toEqual(location.conditions);
                return { ok: true, operation: input.operation, result: { columns, rows: [{ cells: [{ type: 'integer', value: '9007199254740993' }, { type: 'integer', value: '4' }], identity: { key: [{ column: 'id', value: { type: 'integer', value: '9007199254740993' } }], original: [] } }], completeness: { complete: false, reason: 'page' } } };
            }
            return unexpected();
        } };
    const instance = createWorkbenchInstance({ client, scope: { kind: 'worktree', accountId: 'account', installationId: 'installation', projectKey: 'project',
        workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'workspace', rootPath: '/project' } }, location, selectedTarget: descriptor,
        cataloguePageRows: 40, statementRanges: () => [], consoleStorage: () => ({ read: async () => null, write: async () => {} }) });
    try {
        const resource = instance.page(location);
        await resource.demand();
        const page = resource.get().data!;
        expect(page.exportInput([page.rows[0]!.rowKey], 'json')).toMatchObject({ result: { rows: [{ cells: page.rows[0]!.cells }], completeness: { complete: false, reason: 'page' } } });
        expect(page.exportInput([], 'csv').result.rows).toEqual([]);
        // The resource is reused while source paging changes; its FK closure uses the current location.
        await instance.navigate({ page: { rows: 40, offset: 80 } });
        const source = instance.local.get('location');
        const destination = page.foreignKey(page.rows[0]!.rowKey, 'parent_fk');
        expect(destination.status).toBe('ready');
        if (destination.status !== 'ready') throw new Error('Expected a referenced row');
        await instance.navigate(destination.location);
        expect(instance.local.get('location').conditions).toEqual({ kind: 'comparison', column: 'id', operator: 'eq', value: { type: 'integer', value: '4' } });
        await instance.back();
        expect(instance.local.get('location')).toEqual(source);
        expect(rowReads).toBe(1);
    } finally { instance.close(); }
});

it('says a Worktree and an Environment database by the one facts line the page header uses', async () => {
    const worktree = { ...descriptor, target: { ...descriptor.target,
        source: { kind: 'service' as const, serviceId: 'postgres', variable: 'DATABASE_URL' } } };
    const environment = { ...descriptor, label: 'billing', origin: { label: 'Railway', environmentName: 'Staging' },
        target: { kind: 'deployment_service' as const, environment: { serverId: 'home', environmentId: 'env', projectSourceId: 'source' },
            deploymentId: 'deployment', targetLinkId: 'link', serviceId: 'postgres', database: 'billing' } };
    const unexpected = async (): Promise<never> => { throw new Error('Listing must not open a database'); };
    const client: WorkbenchClient = {
        targets: async () => ({ targets: [worktree, environment], completeness: { complete: true } }),
        operation: unexpected, access: unexpected, subscribeOwnWrites: () => () => {},
        navigate: async () => {}, openRoot: async () => {}, setUnsavedChanges: async () => {}, presentDeviceStorageError: unexpected, saveExport: unexpected,
    };
    const scope = { kind: 'project' as const, accountId: 'account', installationId: 'installation', projectKey: 'project' };
    const instance = createWorkbenchInstance({ client, scope,
        location: { targetKey, mode: 'overview', sort: [], columns: [], page: { rows: 40, offset: 0 }, fkTrail: [] },
        cataloguePageRows: 40, statementRanges: () => [], consoleStorage: () => ({ read: async () => null, write: async () => {} }) });
    try {
        const resource = instance.targets(scope);
        await resource.demand();
        expect(resource.get().data?.targets.map(target => target.facts)).toEqual([
            `PostgreSQL · ${descriptor.origin.label}`,
            'PostgreSQL · Staging',
        ]);
    } finally { instance.close(); }
});

it('projects target facts from the connection and Machine owners without inventing a catalogue count', async () => {
    let known = true;
    const machineReads: { serverId: string; machineId: string }[] = [];
    const selected = { ...descriptor, ...describeDatabaseConnection('postgresql://alice:private@localhost:5432/billing?token=private') ,
        capabilities: [...descriptor.capabilities] };
    const sameMachine = Array.from({ length: 24 }, (_, index) => ({ ...selected,
        target: { ...descriptor.target, source: { kind: 'service' as const, serviceId: `service-${index}`, variable: 'DATABASE_URL' } },
    }));
    const otherHome = { ...selected, placement: { ...selected.placement, serverId: 'other-home' } };
    const unexpected = async (): Promise<never> => { throw new Error('Listing must not open a database'); };
    const client: WorkbenchClient = {
        targets: async () => ({ targets: known ? [...sameMachine, otherHome] : [descriptor], completeness: { complete: true } }),
        machineDisplayName: async (request) => {
            machineReads.push(request);
            return known ? { status: 'ready', displayName: request.serverId === 'home' ? 'MacBook Pro' : 'Other Mac' } : { status: 'unavailable' };
        },
        operation: unexpected, access: unexpected, subscribeOwnWrites: () => () => {},
        navigate: async () => {}, openRoot: async () => {}, setUnsavedChanges: async () => {}, presentDeviceStorageError: unexpected, saveExport: unexpected,
    };
    const scope = { kind: 'project' as const, accountId: 'account', installationId: 'installation', projectKey: 'project' };
    const instance = createWorkbenchInstance({ client, scope,
        location: { targetKey, mode: 'overview', sort: [], columns: [], page: { rows: 40, offset: 0 }, fkTrail: [] },
        cataloguePageRows: 40, statementRanges: () => [], consoleStorage: () => ({ read: async () => null, write: async () => {} }) });
    try {
        const resource = instance.targets(scope);
        await resource.demand();
        expect(resource.get().data?.targets[0]).toMatchObject({ engineLabel: 'PostgreSQL', endpointLabel: 'localhost:5432',
            machineLabel: 'MacBook Pro', relationCount: null });
        expect(resource.get().data?.targets.map(target => target.machineLabel)).toEqual([...sameMachine.map(() => 'MacBook Pro'), 'Other Mac']);
        expect(machineReads).toHaveLength(2);
        expect(JSON.stringify(resource.get().data)).not.toContain('private');
        const initial = resource.get();
        const publications: ReturnType<typeof resource.get>[] = [];
        resource.subscribe(() => publications.push(resource.get()));
        resource.invalidate();
        await resource.demand();
        expect(machineReads).toHaveLength(4);
        expect(publications).toHaveLength(0);
        expect(resource.get()).toBe(initial);
        known = false;
        resource.invalidate();
        await resource.demand();
        expect(resource.get().data?.targets[0]).toMatchObject({ engineLabel: 'PostgreSQL', endpointLabel: null,
            machineLabel: null, relationCount: null });
        expect(machineReads).toHaveLength(5);
        expect(publications).toEqual([resource.get()]);
    } finally { instance.close(); }
});
