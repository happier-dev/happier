import { describe, expect, it } from 'vitest';
import { createWorkBoardArtifactBoundary } from '../boards/workBoardArtifactV1.testkit.js';
import { createWidgetDefinitionArtifactPortV1, type WidgetDefinitionArtifactTransportV1 } from './widgetDefinitionArtifactV1.js';
import { WidgetDefinitionV1Schema, type WidgetDefinitionV1 } from './widgetDefinitionV1.js';

const original = (id = 'definition'): WidgetDefinitionV1 => ({ sizeDeclaration: { sizes: ['small', 'medium', 'wide', 'full', 'tall', 'large'], defaultSize: 'medium' }, v: 1, id, name: 'Checks', body: { kind: 'declarative',
    document: { version: 1, root: { kind: 'text', text: 'Before' } } }, inputs: { fields: [] },
    inputSchema: { type: 'object', additionalProperties: false }, provenance: { source: { kind: 'authored' }, authorAccountId: 'owner' } });
function boundary() {
    const b = createWorkBoardArtifactBoundary();
    const transport: WidgetDefinitionArtifactTransportV1 = { ...b.transport,
        read: async (id, options) => { const row = await b.transport.read(id, options); return row ? { ...row, ownerAccountId: 'owner' } : null; },
        list: async options => { const page = await b.transport.list(options); return { ...page, items: page.items.map(row => ({ ...row, ownerAccountId: 'owner' })) }; },
    };
    return { ...b, transport };
}
describe('Account widget definition Artifact owner', () => {
    it('admits explicit useful sizes, requires the default to be declared and retains them in setup metadata', async () => {
        const sizeDeclaration = { sizes: ['medium', 'tall'], defaultSize: 'tall' };
        const definition = { ...original(), sizeDeclaration };
        expect(WidgetDefinitionV1Schema.safeParse(definition).success).toBe(true);
        expect(WidgetDefinitionV1Schema.safeParse({ ...definition, sizeDeclaration: { ...sizeDeclaration, defaultSize: 'full' } }).success).toBe(false);
        expect(WidgetDefinitionV1Schema.safeParse({ ...definition, sizeDeclaration: undefined }).success).toBe(false);
        const b = boundary();
        const port = createWidgetDefinitionArtifactPortV1(b.transport, { accountId: 'owner' });
        await port.create(WidgetDefinitionV1Schema.parse(definition));
        expect(await port.get('definition')).toMatchObject({ sizeDeclaration });
        expect(await port.list()).toMatchObject([{ sizeDeclaration }]);
    });
    it('drops stored body and summary extras, refuses missing required fields and writes canonical content', async () => {
        const b = boundary();
        const port = createWidgetDefinitionArtifactPortV1(b.transport, { accountId: 'owner' });
        await port.create(original());
        const row = b.rows.get('definition')!;
        const field = { path: 'filter', title: 'Filter', widget: 'select', options: [{ value: 'all', label: 'All' }],
            visibleWhen: { op: 'not', predicate: { op: 'eq', path: 'mode', value: 'minimal' } } };
        const raw = { ...original(), extra: true, inputs: { fields: [{ ...field, extra: true,
            options: field.options.map(option => ({ ...option, extra: true })),
            visibleWhen: { ...field.visibleWhen, extra: true, predicate: { ...field.visibleWhen.predicate, extra: true } } }], extra: true },
            provenance: { ...original().provenance, extra: true, source: { kind: 'authored', extra: true } },
            body: { kind: 'declarative', extra: true, document: { version: 1, extra: true, root: { kind: 'text', text: 'Before', extra: true } } } };
        b.rows.set('definition', { ...row, body: JSON.stringify(raw), header: { ...row.header,
            summary: { ...(row.header.summary as Record<string, unknown>), extra: true } } });
        const expected = { ...original(), inputs: { fields: [field] } };
        expect(await port.get('definition')).toEqual(expected);
        expect(await port.list()).toMatchObject([{ name: 'Checks' }]);
        expect((await port.list())[0]).not.toHaveProperty('extra');
        expect(WidgetDefinitionV1Schema.safeParse(raw).success).toBe(false);
        await port.update('definition', { name: 'Updated' });
        expect(JSON.parse(b.rows.get('definition')!.body!)).toEqual({ ...expected, name: 'Updated' });
        b.rows.set('definition', { ...row, body: JSON.stringify({ ...raw, name: undefined }) });
        await expect(port.get('definition')).rejects.toMatchObject({ code: 'invalid_widget_definition_record' });
    });
    it('lists complete setup metadata from the header without opening each definition body', async () => {
        const b = boundary();
        const port = createWidgetDefinitionArtifactPortV1(b.transport, { accountId: 'owner' });
        await port.create(original());
        const listed = createWidgetDefinitionArtifactPortV1({ ...b.transport, read: async () => {
            throw new Error('list_must_not_open_bodies');
        } }, { accountId: 'owner' });
        expect(await listed.list()).toEqual([{ artifactId: 'definition', name: 'Checks', bodyKind: 'declarative',
            inputs: original().inputs, inputSchema: original().inputSchema, sizeDeclaration: original().sizeDeclaration, resources: [] }]);
    });
    it('replays independent changes on the CAS winner, updates every reference, duplicates independently and leaves deleted refs intact', async () => {
        const b = boundary();
        const port = createWidgetDefinitionArtifactPortV1(b.transport, { accountId: 'owner' });
        await port.create(original());
        const refs = [{ kind: 'artifact', artifactId: 'definition' }, { kind: 'artifact', artifactId: 'definition' }] as const;
        await Promise.all([port.update('definition', { name: 'Renamed' }), port.update('definition', { description: 'Details' })]);
        for (const ref of refs) expect(await port.get(ref.artifactId)).toMatchObject({ name: 'Renamed', description: 'Details' });
        const duplicate = await port.duplicate('definition', 'copy');
        await port.update('definition', { body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Changed' } } } });
        expect(await port.get('copy')).toEqual(duplicate);
        expect(duplicate.provenance).toEqual(original().provenance);
        await port.delete('definition');
        expect(await port.get(refs[0].artifactId)).toBeNull();
        expect(refs).toHaveLength(2);
        expect(await port.list()).toMatchObject([{ artifactId: 'copy', name: 'Renamed', description: 'Details',
            bodyKind: 'declarative', inputs: original().inputs, inputSchema: original().inputSchema }]);
    });
    it('refuses another Account, malformed content and retired scope without a write', async () => {
        const b = boundary();
        const port = createWidgetDefinitionArtifactPortV1(b.transport, { accountId: 'owner' });
        await port.create(original());
        const before = b.rows.get('definition');
        const other = createWidgetDefinitionArtifactPortV1(b.transport, { accountId: 'other' });
        await expect(other.get('definition')).rejects.toMatchObject({ code: 'widget_definition_account_mismatch' });
        await expect(other.update('definition', { name: 'Wrong' })).rejects.toMatchObject({ code: 'widget_definition_account_mismatch' });
        expect(b.rows.get('definition')).toBe(before);
        b.rows.set('definition', { ...before!, body: '{bad' });
        await expect(port.update('definition', { name: 'Overwrite' })).rejects.toMatchObject({ code: 'invalid_widget_definition_record' });
        await expect(createWidgetDefinitionArtifactPortV1(b.transport, { accountId: 'owner', shouldContinue: () => false }).get('definition'))
            .rejects.toMatchObject({ code: 'widget_definition_scope_retired' });
        expect(b.updates).toEqual([]);
    });
    it('keeps transport/mode refusals distinct from absent definitions and never overwrites an exact-id create winner', async () => {
        const b = boundary();
        const port = createWidgetDefinitionArtifactPortV1(b.transport, { accountId: 'owner' });
        await port.create(original());
        await expect(port.create({ ...original(), name: 'Wrong' })).rejects.toMatchObject({ code: 'widget_definition_already_exists' });
        const failure = Object.assign(new Error('artifact_account_mode_mismatch'), { code: 'artifact_account_mode_mismatch' });
        const refused = createWidgetDefinitionArtifactPortV1({ ...b.transport, read: async () => { throw failure; } }, { accountId: 'owner' });
        await expect(refused.get('definition')).rejects.toBe(failure);
        expect((await port.get('definition'))?.name).toBe('Checks');
    });
    it('rejects unknown identity/authority fields and undeclared Session input paths', () => {
        expect(WidgetDefinitionV1Schema.safeParse({ ...original(), sourceAuthority: 'editor' }).success).toBe(false);
        expect(WidgetDefinitionV1Schema.safeParse({ ...original(), provenance: { ...original().provenance, token: 'secret' } }).success).toBe(false);
        expect(WidgetDefinitionV1Schema.safeParse({ ...original(), sessionInputPath: 'session' }).success).toBe(false);
    });
    it('does not disclose an update acknowledgment to a retired Account scope', async () => {
        const b = boundary();
        let active = true;
        const port = createWidgetDefinitionArtifactPortV1({ ...b.transport, update: async input => {
            const result = await b.transport.update(input); active = false; return result;
        } }, { accountId: 'owner', shouldContinue: () => active });
        await port.create(original());
        await expect(port.update('definition', { name: 'Committed' })).rejects.toMatchObject({ code: 'widget_definition_scope_retired' });
        // Mutation truth is retained, but its bytes are not returned to the new scope.
        expect(JSON.parse(String(b.rows.get('definition')?.body)).name).toBe('Committed');
    });
    it('refuses an exact-id raced create winner without rewriting it', async () => {
        const b = boundary();
        const other = createWidgetDefinitionArtifactPortV1(b.transport, { accountId: 'owner' });
        const port = createWidgetDefinitionArtifactPortV1({ ...b.transport, create: async input => {
            await other.create({ ...original(), name: 'Other creator' });
            return b.transport.create(input);
        } }, { accountId: 'owner' });
        await expect(port.create(original())).rejects.toMatchObject({ code: 'widget_definition_create_conflict' });
        expect((await other.get('definition'))?.name).toBe('Other creator');
        expect(b.updates).toEqual([]);
    });
});
