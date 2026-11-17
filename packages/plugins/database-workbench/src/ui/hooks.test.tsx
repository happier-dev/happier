// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { createDatabaseDescriptorV1Fixture } from '@happier-dev/database-protocol/testing/v1';
import type { WorkbenchChange, WorkbenchClient, WorkbenchLocation } from './models.js';
import { createWorkbenchInstance } from './workbench.js';
import { useDatabaseSchemaRelations, useWorkbenchDraft, WorkbenchProvider } from './hooks.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const descriptor = createDatabaseDescriptorV1Fixture();
const targetKey = JSON.stringify(descriptor.target);
const relation = { schema: 'public', name: 'items' };
const location: WorkbenchLocation = { targetKey, relation, mode: 'data', sort: [], columns: [], page: { rows: 40, offset: 0 }, fkTrail: [] };
function workbench(operation?: WorkbenchClient['operation']) {
    const unexpected = async (): Promise<never> => { throw new Error('Draft intents do not execute database operations'); };
    const client: WorkbenchClient = { targets: unexpected, operation: operation ?? unexpected, access: unexpected,
        subscribeOwnWrites: () => () => {}, navigate: async () => {}, setUnsavedChanges: async () => {},
        presentDeviceStorageError(error) { throw error; } };
    return createWorkbenchInstance({ client, scope: { kind: 'worktree', accountId: 'account', installationId: 'installation', projectKey: 'project',
        workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'workspace', rootPath: '/project' } }, location, selectedTarget: descriptor,
        cataloguePageRows: 40, statementRanges: () => [], consoleStorage: () => ({ read: async () => null, write: async () => {} }) });
}

it('reviews, counts, discards and applies only the selected relation transaction while retaining other drafts', async () => {
    const instance = workbench();
    const change: WorkbenchChange = { targetKey, relation, rowKey: 'row', label: 'Selected row', change: { kind: 'delete',
        key: [{ column: 'id', value: { type: 'integer', value: '1' } }] } };
    const otherDrafts = [
        { ...change, targetKey: 'another-target', label: 'Other target' },
        { ...change, relation: { schema: 'public', name: 'other' }, label: 'Other relation' },
        { ...change, relation: { ...relation, database: 'other' }, label: 'Other database' },
    ];
    for (const value of [change, ...otherDrafts]) instance.drafts.stage(instance.draftKey(value), value);
    let draft: ReturnType<typeof useWorkbenchDraft> | undefined;
    function Probe() { draft = useWorkbenchDraft(instance); return null; }
    const root = createRoot(document.createElement('div'));
    try {
        await act(async () => root.render(createElement(Probe)));
        expect(draft!.counts).toEqual({ edits: 0, inserts: 0, removals: 1 });
        expect(draft!.review()).toEqual([{ relation, rows: [expect.objectContaining({ label: 'Selected row', rowKey: 'row' })] }]);
        const prepared = await draft!.apply(relation).controller.prepare({ signal: new AbortController().signal });
        expect(prepared?.input).toMatchObject({ target: descriptor.target, relation, changes: [change.change] });
        await act(async () => draft!.discard());
        expect(instance.drafts.changes()).toEqual(otherDrafts);
        expect(draft!.counts).toEqual({ edits: 0, inserts: 0, removals: 0 });
        await act(async () => instance.navigate({ relation: otherDrafts[1]!.relation }));
        expect(draft!.counts).toEqual({ edits: 0, inserts: 0, removals: 1 });
        expect(draft!.review()).toEqual([{ relation: otherDrafts[1]!.relation, rows: [expect.objectContaining({ label: 'Other relation' })] }]);
    } finally { await act(async () => root.unmount()); instance.close(); }
});

it('exposes only the demanded schema page continuation and reuses held pages when revisited', async () => {
    const calls: (string | undefined)[] = [];
    const instance = workbench(async input => {
        if (input.operation !== 'relations.list') throw new Error('Only the opened schema is read');
        calls.push(input.page.after);
        return { ok: true, operation: 'relations.list',
            relations: [{ relation: { schema: 'public', name: input.page.after ? 'later_table' : 'first_table' }, kind: 'table', estimatedRows: '9007199254740993', size: { bytes: '1024', tableBytes: '768', indexBytes: '256', measurement: 'exact' } }],
            completeness: input.page.after ? { complete: true } : { complete: false, reason: 'page',
                continuation: { kind: 'catalog', operation: 'relations.list', target: descriptor.target, schema: 'public', after: 'next-page' } } };
    });
    let page: ReturnType<typeof useDatabaseSchemaRelations> | undefined;
    function Probe(props: { after?: string }) { page = useDatabaseSchemaRelations(targetKey, 'public', props.after); return null; }
    const root = createRoot(document.createElement('div'));
    const render = async (after?: string) => act(async () => root.render(createElement(WorkbenchProvider, { instance }, createElement(Probe, { after }))));
    try {
        await render();
        expect(page!.relations.map(value => value.name)).toEqual(['first_table']);
        expect(page!.relations[0]).toMatchObject({ approxRows: '9007199254740993', size: { bytes: '1024', tableBytes: '768', indexBytes: '256' } });
        expect(page!.nextPageAfter).toBe('next-page');
        expect(calls).toEqual([undefined]);
        await render(page!.nextPageAfter);
        expect(page!.relations.map(value => value.name)).toEqual(['later_table']);
        expect(page!.nextPageAfter).toBeUndefined();
        await render();
        expect(page!.relations.map(value => value.name)).toEqual(['first_table']);
        expect(calls).toEqual([undefined, 'next-page']);
    } finally { await act(async () => root.unmount()); instance.close(); }
});

it('exposes view definitions from the same demanded Structure and does not acquire a second read', async () => {
    let reads = 0;
    const instance = workbench(async input => {
        if (input.operation !== 'relation.structure') throw new Error('Only Structure is demanded');
        reads++;
        return { ok: true, operation: 'relation.structure', structure: { relation, kind: 'view', columns: [], primaryKey: [], foreignKeys: [], indexes: [], capabilities: [], viewDefinition: 'SELECT 1 AS id' } };
    });
    let structure: ReturnType<typeof import('./hooks.js').useStructure> | undefined;
    const { useStructure } = await import('./hooks.js');
    function Probe() { structure = useStructure(relation); return null; }
    const root = createRoot(document.createElement('div'));
    try {
        await act(async () => root.render(createElement(WorkbenchProvider, { instance }, createElement(Probe))));
        expect(structure!.viewDefinition).toBe('SELECT 1 AS id');
        expect(reads).toBe(1);
    } finally { await act(async () => root.unmount()); instance.close(); }
});
