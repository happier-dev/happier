import { expect, it } from 'vitest';
import type { DatabaseOperationResultV1, DatabaseRelationStructureV1 } from '@happier-dev/database-protocol';
import { createDatabaseDescriptorV1Fixture } from '@happier-dev/database-protocol/testing/v1';
import type { WorkbenchClient, WorkbenchLocation } from './models.js';
import { createWorkbenchInstance } from './workbench.js';

const descriptor = createDatabaseDescriptorV1Fixture();
const targetKey = JSON.stringify(descriptor.target);

it('reads only demanded catalogue pages, retains held row identity, and scopes own-write invalidation', async () => {
    const relation = { schema: 'public', name: 'items' };
    const structure: DatabaseRelationStructureV1 = { relation, kind: 'table',
        columns: [{ name: 'id', nativeType: 'bigint', semanticType: 'integer', nullable: false, generated: false }],
        primaryKey: ['id'], indexes: [], foreignKeys: [], capabilities: [] };
    const calls: string[] = [];
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
            if (input.operation === 'relation.structure') return { ok: true, operation: input.operation, structure: { ...structure, relation: input.relation } };
            if (input.operation === 'rows.read') return { ok: true, operation: input.operation, result: { columns: structure.columns,
                rows: [{ cells: [{ type: 'integer', value: '9007199254740993' }], identity: { key: [{ column: 'id', value: { type: 'integer', value: '9007199254740993' } }], original: [] } }], completeness: { complete: true } } };
            throw new Error('Unexpected operation');
        },
        access: async () => { throw new Error('Read caching does not read policy'); },
        subscribeOwnWrites(listener) { ownWrite = listener; return () => { ownWrite = undefined; }; },
        navigate: async () => {}, setUnsavedChanges: async () => {}, presentDeviceStorageError(error) { throw error; },
    };
    const location: WorkbenchLocation = { targetKey, relation, mode: 'data', sort: [], columns: ['id'], page: { rows: 40, offset: 0 }, fkTrail: [] };
    const instance = createWorkbenchInstance({ client, scope: { kind: 'worktree', accountId: 'account', installationId: 'installation', projectKey: 'project',
        workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'workspace', rootPath: '/project' } }, location, selectedTarget: descriptor,
        cataloguePageRows: 40, statementRanges: () => [], consoleStorage: () => ({ read: async () => null, write: async () => {} }) });
    const schemas = instance.relations(targetKey);
    const groups = instance.schemaRelations(targetKey, 'public');
    const page = instance.page(location);
    const otherPage = instance.page({ ...location, relation: { schema: 'public', name: 'other' } });
    const off = [schemas.subscribe(() => {}), groups.subscribe(() => {}), page.subscribe(() => {}), otherPage.subscribe(() => {})];
    try {
        await schemas.demand();
        expect(calls).toEqual(['schemas.list']);
        await groups.demand();
        expect(calls).toEqual(['schemas.list', 'relations.list']);
        await page.demand();
        await otherPage.demand();
        const held = page.get().data;
        const before = [...calls];
        await instance.page(location).demand();
        expect(page.get().data).toBe(held);
        expect(calls).toEqual(before);
        ownWrite?.({ target: descriptor.target, relation });
        await page.demand();
        expect(calls.slice(before.length)).toEqual(['relation.structure', 'rows.read']);
        expect(otherPage.get().data).toBeDefined();
    } finally { for (const unsubscribe of off) unsubscribe(); instance.close(); }
});

it('merges navigation intent into the local location and clears the previous page when query operands change', async () => {
    const location: WorkbenchLocation = { targetKey, relation: { schema: 'public', name: 'items' }, mode: 'data',
        sort: [], columns: ['id'], page: { rows: 40, offset: 80 }, fkTrail: [] };
    const navigations: WorkbenchLocation[] = [];
    const unexpected = async (): Promise<never> => { throw new Error('Navigation does not read or write a database'); };
    const client: WorkbenchClient = { targets: unexpected, operation: unexpected, access: unexpected,
        subscribeOwnWrites: () => () => {}, navigate: async value => { navigations.push(value); },
        setUnsavedChanges: async () => {}, presentDeviceStorageError(error) { throw error; } };
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
    const unexpected = async (): Promise<never> => { throw new Error('Staging performs no database reads'); };
    const client: WorkbenchClient & { commit(): Promise<DatabaseOperationResultV1> } = { targets: unexpected, operation: unexpected, access: unexpected,
        commit: async () => { commits++; return { ok: true, operation: 'edits.apply', status: 'committed', inserted: '0', updated: '0', deleted: '1' }; },
        subscribeOwnWrites: () => () => {}, navigate: async () => {},
        setUnsavedChanges: async () => {}, presentDeviceStorageError(error) { throw error; } };
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
    } finally { instance.close(); }
});
