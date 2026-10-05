import { describe, expect, it } from 'vitest';
import { buildWidgetSurfaceArtifactIdV1, createWidgetSurfaceArtifactPortV1, createWidgetAreaActionPortV1, type WidgetSurfaceRefV1 } from './index.js';
import { createWorkBoardArtifactBoundary } from '../boards/workBoardArtifactV1.testkit.js';

const surface: WidgetSurfaceRefV1 = { serverId: 'home', accountId: 'one', owner: { kind: 'pluginArea', pluginId: 'example', pageId: 'overview', area: 'pinned' } };
const instance = (id: string, value = 'A') => ({ v: 1 as const, id, definition: { kind: 'builtin' as const, id: 'session_summary' }, bindings: { session: { kind: 'value' as const, value } } });
function boundary() {
    const b = createWorkBoardArtifactBoundary();
    const transport = b.forAccount('one');
    const port = createWidgetSurfaceArtifactPortV1(transport, { surface, isCurrent: () => true });
    return { ...b, transport, port };
}

describe('personal widget areas at the Account Artifact owner', () => {
    it('preserves both adds when another writer edits before the singleton create acknowledgement returns', async () => {
        const b = boundary();
        const delayed = createWidgetSurfaceArtifactPortV1({ ...b.transport, create: async input => {
            const result = await b.transport.create(input);
            await b.port.apply({ kind: 'add', instance: instance('b') });
            return result;
        } }, { surface, isCurrent: () => true });
        await expect(delayed.apply({ kind: 'add', instance: instance('a') })).resolves.toMatchObject({ instances: [{ instance: { id: 'b' } }, { instance: { id: 'a' } }] });
        expect((await b.port.read()).instances.map(entry => entry.instance.id)).toEqual(['b', 'a']);
    });
    it('persists independent copies, bindings, frame, width and order through conflict replay and reload', async () => {
        const b = boundary();
        expect((await b.port.read()).instances).toEqual([]);
        expect(b.rows.size).toBe(0);
        await Promise.all([b.port.apply({ kind: 'add', instance: instance('a') }), b.port.apply({ kind: 'add', instance: instance('b', 'B') })]);
        await Promise.all([b.port.apply({ kind: 'width', instanceId: 'a', width: 'full' }), b.port.apply({ kind: 'frame', instanceId: 'b', frameStyle: 'card' })]);
        await b.port.apply({ kind: 'inputs', instanceId: 'a', bindings: instance('a', 'C').bindings });
        await b.port.apply({ kind: 'move', instanceId: 'b', toIndex: 0 });
        const reload = createWidgetSurfaceArtifactPortV1(b.transport, { surface, isCurrent: () => true });
        expect((await reload.read()).instances).toEqual([
            { instance: instance('b', 'B'), width: 'half', frameStyle: 'card' }, { instance: instance('a', 'C'), width: 'full' },
        ]);
        expect(b.rows.size).toBe(1);
    });
    it('qualifies singleton identity by Home, Account, plugin, page and area', () => {
        const variations = [surface, { ...surface, serverId: 'other' }, { ...surface, accountId: 'two' },
            ...['pluginId', 'pageId', 'area'].map(key => ({ ...surface, owner: { ...surface.owner, [key]: 'other' } }))];
        expect(new Set(variations.map(buildWidgetSurfaceArtifactIdV1)).size).toBe(variations.length);
    });
    it('refuses invalid or substituted rows without resetting them and preserves transport mode refusals', async () => {
        const b = boundary();
        await b.port.apply({ kind: 'add', instance: instance('a') });
        const id = buildWidgetSurfaceArtifactIdV1(surface);
        const original = b.rows.get(id)!;
        b.rows.set(id, { ...original, body: JSON.stringify({ v: 1, surface: { ...surface, accountId: 'other' }, instances: [] }) });
        await expect(b.port.apply({ kind: 'remove', instanceId: 'a' })).rejects.toMatchObject({ code: 'invalid_widget_area_record' });
        expect(b.rows.get(id)?.body).not.toBe(original.body);
        const refused = createWidgetSurfaceArtifactPortV1({ ...b.transport, read: async () => { throw Object.assign(new Error('mode mismatch'), { code: 'artifact_account_mode_mismatch' }); } }, { surface, isCurrent: () => true });
        await expect(refused.read()).rejects.toMatchObject({ code: 'artifact_account_mode_mismatch' });
        await expect(refused.apply({ kind: 'add', instance: instance('new') })).rejects.toMatchObject({ code: 'artifact_account_mode_mismatch' });
    });
    it('fences late page/Account callbacks before writes and refuses conditional removal after a concurrent edit', async () => {
        const b = boundary();
        await b.port.apply({ kind: 'add', instance: instance('a') });
        const adapter = createWidgetAreaActionPortV1(() => b.port);
        const captured = await adapter.captureMove!(surface, 'a', {});
        expect(captured).toHaveProperty('expectedInstance');
        await b.port.apply({ kind: 'rename', instanceId: 'a', displayName: 'Edited' });
        if ('ok' in captured) throw new Error('capture refused');
        expect(await adapter.apply(surface, { kind: 'remove', instanceId: 'a', ...captured }, {})).toMatchObject({ ok: false, errorCode: 'widget_instance_changed' });
        const updates = b.updates.length;
        let current = true;
        const retired = createWidgetSurfaceArtifactPortV1({ ...b.transport, read: async id => { const row = await b.transport.read(id); current = false; return row; } }, { surface, isCurrent: () => current });
        await expect(retired.apply({ kind: 'remove', instanceId: 'a' })).rejects.toMatchObject({ code: 'widget_area_scope_retired' });
        expect(b.updates).toHaveLength(updates);
    });
    it('keeps Project order/Plain geometry distinct from plugin half/full geometry', async () => {
        const b = boundary();
        const project = createWidgetSurfaceArtifactPortV1(b.transport, { surface: { ...surface, owner: { kind: 'project', projectId: 'source' } }, isCurrent: () => true });
        expect((await project.apply({ kind: 'add', instance: instance('a') })).instances).toEqual([{ instance: instance('a') }]);
        await expect(project.apply({ kind: 'width', instanceId: 'a', width: 'full' })).rejects.toMatchObject({ code: 'widget_width_unsupported' });
    });
});
