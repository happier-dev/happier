import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

import { EntityDragItemV1Schema } from '@happier-dev/protocol/plugins/ui';

import { createPluginFlatReorderBinding, createPluginSavedViewsReorderBinding } from './collectionSpacesStripHost';

const scope = { serverId: 'server-a', accountId: 'account-a' };
const items = [{ id: 'mine', name: 'Mine' }, { id: 'team', name: 'Team' }, { id: 'open', name: 'Open' }];

describe('a plugin flat-list reorder', () => {
    it('keeps a list identity and settles vertical anchored moves through the receiving owner', async () => {
        const moves: Array<Readonly<{ id: string; beforeId: string | null }>> = [];
        const binding = createPluginFlatReorderBinding({
            pluginId: 'com.acme.review', localId: 'sub-issues', scope,
            items: items.map(item => ({ id: item.id, title: item.name })),
            executeMove: async (id, beforeId) => { moves.push({ id, beforeId }); return { status: 'applied' }; },
        });
        const item = binding.getItem('team')!;
        expect(EntityDragItemV1Schema.safeParse(item).success).toBe(true);
        const other = createPluginFlatReorderBinding({
            pluginId: 'com.acme.review', localId: 'another-list', scope,
            items: [], executeMove: async () => ({ status: 'applied' }),
        });
        expect(other.getSourceId(item)).toBeNull();
        const move = binding.resolve('open', { anchorId: 'mine', placement: 'before' });
        if (move.status !== 'allowed') throw new Error('expected an allowed anchored move');
        expect(move.effect.preview.glyph).toBe('above');
        await expect(binding.execute(move.effect)).resolves.toEqual({ status: 'applied' });
        expect(moves).toEqual([{ id: 'open', beforeId: 'mine' }]);
    });
});

describe('a plugin saved-view drag', () => {
    it('carries a schema-valid plugin item and reads its own id back, refusing another plugin', () => {
        const binding = createPluginSavedViewsReorderBinding({ pluginId: 'com.acme.review', scope, items, onReorder: async () => true });
        const item = binding.getItem('team')!;
        expect(EntityDragItemV1Schema.safeParse(item).success).toBe(true);
        expect(binding.getSourceId(item)).toBe('team');
        expect(binding.getItem('gone')).toBeNull();
        const other = createPluginSavedViewsReorderBinding({ pluginId: 'com.acme.other', scope, items, onReorder: async () => true });
        expect(other.getSourceId(item)).toBeNull();
    });

    it('settles a move through the caller: the view it lands before, or the end, and a refusal when not accepted', async () => {
        const onReorder = vi.fn(async (id: string, _beforeId: string | null) => id !== 'team');
        const binding = createPluginSavedViewsReorderBinding({ pluginId: 'com.acme.review', scope, items, onReorder });
        const toFront = binding.resolve('open', { anchorId: 'mine', placement: 'before' });
        const toEnd = binding.resolve('team', { anchorId: 'open', placement: 'after' });
        if (toFront.status !== 'allowed' || toEnd.status !== 'allowed') throw new Error('expected both moves to be allowed');
        await expect(binding.execute(toFront.effect)).resolves.toEqual({ status: 'applied' });
        expect(onReorder).toHaveBeenLastCalledWith('open', 'mine');
        await expect(binding.execute(toEnd.effect)).resolves.toMatchObject({ status: 'refused', reason: { code: 'saved_view_reorder_not_applied' } });
        expect(onReorder).toHaveBeenLastCalledWith('team', null);
    });

    it('refuses a place that leaves the order as it is', () => {
        const binding = createPluginSavedViewsReorderBinding({ pluginId: 'com.acme.review', scope, items, onReorder: async () => true });
        expect(binding.resolve('team', { anchorId: 'open', placement: 'before' }).status).not.toBe('allowed');
        expect(binding.resolve('gone', { anchorId: 'open', placement: 'before' }).status).not.toBe('allowed');
    });
});
