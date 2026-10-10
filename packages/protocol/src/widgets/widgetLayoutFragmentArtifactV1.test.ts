import { describe, expect, it } from 'vitest';
import { createWorkBoardArtifactBoundary } from '../boards/workBoardArtifactV1.testkit.js';
import { getArtifactUseTargetV1 } from '../artifacts/artifactSharingV1.js';
import type { WidgetDefinitionArtifactTransportV1 } from './widgetDefinitionArtifactV1.js';
import { createWidgetLayoutFragmentArtifactPortV1 } from './widgetLayoutFragmentArtifactV1.js';
import { captureWidgetLayoutFragmentGroupV1, instantiateWidgetLayoutFragmentGroupV1, WidgetLayoutFragmentV1Schema,
    type WidgetLayoutFragmentV1 } from './widgetLayoutFragmentV1.js';
import { buildWidgetSurfaceArtifactIdV1, buildWidgetSurfaceArtifactHeaderV1 } from './widgetSurfaceArtifactV1.js';

const original = (): WidgetLayoutFragmentV1 => ({ v: 1, id: 'saved-group', name: 'Project checks',
    inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false },
    group: { width: 'full', frameStyle: 'card', dividers: 'hairline', context: { session: { kind: 'context', slot: 'session' } },
        children: [{ kind: 'widget', instance: { v: 1, definition: { kind: 'builtin', id: 'changes' }, bindings: {} }, size: 'medium', frameStyle: 'plain' }] },
    provenance: { source: { kind: 'authored' }, authorAccountId: 'owner' } });

function boundary() {
    const b = createWorkBoardArtifactBoundary();
    const transport: WidgetDefinitionArtifactTransportV1 = { ...b.transport,
        read: async (id, options) => { const row = await b.transport.read(id, options); return row ? { ...row, ownerAccountId: 'owner' } : null; },
        list: async options => { const page = await b.transport.list(options); return { ...page, items: page.items.map(row => ({ ...row, ownerAccountId: 'owner' })) }; },
    };
    return { ...b, transport };
}

describe('Account widget layout fragment Artifact owner', () => {
    it('refuses publication of copied groups containing private group context, hidden child pins or inline Resource literals', () => {
        const surface = { serverId: 'home', accountId: 'owner', owner: { kind: 'project', projectId: 'project' } } as const;
        const group = instantiateWidgetLayoutFragmentGroupV1(original().group, { groupId: 'group', childIds: ['child'] });
        const layout = { v: 1 as const, surface, items: [group] };
        const resource = { artifactId: buildWidgetSurfaceArtifactIdV1(surface), header: buildWidgetSurfaceArtifactHeaderV1(layout),
            body: JSON.stringify(layout) };
        expect(getArtifactUseTargetV1(resource).canShare).toBe(true);
        const pin = { service: { pluginId: 'com.acme', localId: 'cloud' }, accountId: 'private', extra: true };
        const privateGroups = [
            { ...group, context: { connection: { kind: 'value', value: pin } } },
            { ...group, children: [{ ...group.children[0], instance: { ...group.children[0]!.instance, extra: { nested: [pin] } } }] },
            { ...group, children: [{ kind: 'widget', instance: { v: 1, id: 'child', bindings: {}, definition: { kind: 'inline', definition: {
                v: 1, id: 'inline', name: 'Metric', sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, inputs: { fields: [] },
                inputSchema: { type: 'object', additionalProperties: false }, provenance: { source: { kind: 'authored' } },
                body: { kind: 'declarative', document: { version: 1, root: { kind: 'metric', label: 'Count', value: { path: ['count'], type: 'number' },
                    data: { kind: 'resource', resource: { pluginId: 'com.acme', localId: 'metrics' }, input: {},
                        inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object', properties: { count: { type: 'number' } },
                            required: ['count'], additionalProperties: false } } } } },
            } } } }] },
        ];
        for (const privateGroup of privateGroups) expect(getArtifactUseTargetV1({ ...resource,
            body: JSON.stringify({ ...layout, items: [privateGroup] }) }).canShare).toBe(false);
    });
    it('keeps saved groups private at the generic Artifact sharing owner, including private child pins', () => {
        const fragment = { ...original(), group: { ...original().group, children: [{ kind: 'widget' as const,
            instance: { v: 1 as const, definition: { kind: 'builtin' as const, id: 'changes' },
                bindings: { connection: { kind: 'value' as const, value: { service: { pluginId: 'com.acme', localId: 'cloud' }, accountId: 'private' } } } } }] } };
        const target = getArtifactUseTargetV1({ artifactId: fragment.id,
            header: { kind: 'widget-layout-fragment.v1', v: 1, title: fragment.name }, body: JSON.stringify(fragment) });
        expect(target).toMatchObject({ canShare: false, publicLinkAllowed: false, browserListed: false });
    });
    it('discovers saved groups from Artifact headers without opening child bodies', async () => {
        const b = boundary();
        const summary = { artifactId: 'saved-group', name: 'Project checks', inputs: { fields: [] },
            inputSchema: { type: 'object', additionalProperties: false }, childCount: 1,
            group: { width: 'full', frameStyle: 'card', dividers: 'hairline', children: [{ kind: 'widget',
                instance: { v: 1, definition: { kind: 'builtin', id: 'changes' }, bindings: {} }, size: 'medium', frameStyle: 'card' }] } };
        await b.transport.create({ artifactId: 'saved-group', header: { kind: 'widget-layout-fragment.v1', v: 1,
            title: 'Project checks', summary }, body: '{}' });
        const port = createWidgetLayoutFragmentArtifactPortV1({ ...b.transport, read: async () => {
            throw new Error('list_must_not_open_bodies');
        } }, { accountId: 'owner' });
        expect(await port.list()).toEqual([summary]);
    });
    it('copies group content with fresh ids, preserves child frames and never links mutable placement inputs', () => {
        const source = instantiateWidgetLayoutFragmentGroupV1(original().group, { groupId: 'source', childIds: ['child'] });
        const captured = captureWidgetLayoutFragmentGroupV1({ ...source, area: 'main' });
        expect(captured).toEqual(original().group);
        const copy = instantiateWidgetLayoutFragmentGroupV1(captured, { groupId: 'copy', childIds: ['copy-child'] });
        expect(copy.children[0]!.instance.id).toBe('copy-child');
        expect(copy.children[0]!.frameStyle).toBe('plain');
        copy.children[0]!.instance.bindings.session = { kind: 'value', value: 'other' };
        expect(source.children[0]!.instance.bindings).toEqual({});
        expect(captured.children[0]!.instance.bindings).toEqual({});
        expect(() => instantiateWidgetLayoutFragmentGroupV1(captured, { groupId: 'copy', childIds: ['copy'] })).toThrow('widget_fragment_copy_identity_invalid');
        expect(() => instantiateWidgetLayoutFragmentGroupV1(captured, { groupId: 'copy', childIds: [] })).toThrow('widget_fragment_copy_identity_invalid');
    });
    it('drops stored extras, writes strict content and replays independent edits on the Artifact CAS winner', async () => {
        const b = boundary();
        const port = createWidgetLayoutFragmentArtifactPortV1(b.transport, { accountId: 'owner' });
        await port.create(original());
        const row = b.rows.get('saved-group')!;
        const raw = { ...original(), extra: true, group: { ...original().group, extra: true,
            children: original().group.children.map(child => ({ ...child, extra: true, instance: { ...child.instance, extra: true,
                definition: { ...child.instance.definition, extra: true } } })) } };
        expect(WidgetLayoutFragmentV1Schema.safeParse(raw).success).toBe(false);
        b.rows.set('saved-group', { ...row, body: JSON.stringify(raw), header: { ...row.header,
            summary: { ...(row.header.summary as Record<string, unknown>), extra: true } } });
        expect(await port.get('saved-group')).toEqual(original());
        expect((await port.list())[0]).not.toHaveProperty('extra');
        await Promise.all([port.update('saved-group', { name: 'Renamed' }), port.update('saved-group', { description: 'Details' })]);
        expect(await port.get('saved-group')).toMatchObject({ name: 'Renamed', description: 'Details' });
        expect(JSON.parse(b.rows.get('saved-group')!.body!)).not.toHaveProperty('extra');
        const copy = await port.duplicate('saved-group', 'independent');
        await port.update('saved-group', { group: { ...original().group, dividers: 'none' } });
        expect(await port.get('independent')).toEqual(copy);
        await port.delete('saved-group');
        expect(await port.get('saved-group')).toBeNull();
    });
    it('preserves mode failures and refuses another Account or retired scope before disclosure or mutation', async () => {
        const b = boundary();
        const port = createWidgetLayoutFragmentArtifactPortV1(b.transport, { accountId: 'owner' });
        await port.create(original());
        const other = createWidgetLayoutFragmentArtifactPortV1(b.transport, { accountId: 'other' });
        await expect(other.get('saved-group')).rejects.toMatchObject({ code: 'widget_fragment_account_mismatch' });
        await expect(other.update('saved-group', { name: 'Wrong' })).rejects.toMatchObject({ code: 'widget_fragment_account_mismatch' });
        const failure = Object.assign(new Error('artifact_account_mode_mismatch'), { code: 'artifact_account_mode_mismatch' });
        await expect(createWidgetLayoutFragmentArtifactPortV1({ ...b.transport, read: async () => { throw failure; } }, { accountId: 'owner' })
            .get('saved-group')).rejects.toBe(failure);
        await expect(createWidgetLayoutFragmentArtifactPortV1(b.transport, { accountId: 'owner', shouldContinue: () => false })
            .get('saved-group')).rejects.toMatchObject({ code: 'widget_fragment_scope_retired' });
        expect(b.updates).toEqual([]);
    });
    it('refuses a raced create winner without rewriting it and does not disclose an acknowledgment after scope retirement', async () => {
        const b = boundary();
        const other = createWidgetLayoutFragmentArtifactPortV1(b.transport, { accountId: 'owner' });
        const raced = createWidgetLayoutFragmentArtifactPortV1({ ...b.transport, create: async input => {
            await other.create({ ...original(), name: 'Other creator' });
            return b.transport.create(input);
        } }, { accountId: 'owner' });
        await expect(raced.create(original())).rejects.toMatchObject({ code: 'widget_fragment_create_conflict' });
        expect((await other.get('saved-group'))?.name).toBe('Other creator');
        expect(b.updates).toEqual([]);
        let active = true;
        const retiring = createWidgetLayoutFragmentArtifactPortV1({ ...b.transport, update: async input => {
            const result = await b.transport.update(input); active = false; return result;
        } }, { accountId: 'owner', shouldContinue: () => active });
        await expect(retiring.update('saved-group', { name: 'Committed' })).rejects.toMatchObject({ code: 'widget_fragment_scope_retired' });
        expect((await other.get('saved-group'))?.name).toBe('Committed');
    });
});
