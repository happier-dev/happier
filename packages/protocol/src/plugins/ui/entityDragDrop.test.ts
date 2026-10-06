import { describe, expect, it } from 'vitest';
import { EntityDragItemV1Schema, EntityDropEffectV1Schema, entityDragKindV1, isEntityDragKindV1 } from './entityDragDrop.js';

const scope = { serverId: 'home-a', accountId: 'account-a' };
describe('transient entity identity', () => {
    it('isolates navigation placement carries by surface and item instead of accepting them as destinations', () => {
        const item = { kind: 'navigation-item', scope, surfaceId: 'appRail', itemId: 'plugin:example:review' };
        expect(EntityDragItemV1Schema.safeParse(item).success).toBe(true);
        expect(isEntityDragKindV1('navigation-item')).toBe(true);
        expect(EntityDragItemV1Schema.safeParse({ ...item, href: '/settings' }).success).toBe(false);
        expect(EntityDragItemV1Schema.safeParse({ ...item, itemId: '' }).success).toBe(false);
    });
    it('admits declared bounded drop marks while rejecting arbitrary glyphs', () => {
        const effect = { actionId: 'example.link', input: {}, preview: { verb: 'Link', target: 'Release', glyph: 'copy' } };
        expect(EntityDropEffectV1Schema.safeParse(effect).success).toBe(true);
        expect(EntityDropEffectV1Schema.safeParse({ ...effect, preview: { ...effect.preview, glyph: 'anything' } }).success).toBe(false);
    });
    it('recognizes actual Board/session kinds through the same grammar without accepting widget or raw plugin kinds', () => {
        expect(isEntityDragKindV1('work-board-item')).toBe(true);
        expect(isEntityDragKindV1('session')).toBe(true);
        expect(isEntityDragKindV1('widget')).toBe(false);
        expect(isEntityDragKindV1('plugin')).toBe(false);
        expect(isEntityDragKindV1('plugin:example.entities/pull-request')).toBe(true);
    });
    it('keeps the Board placement Account separate from the qualified referenced Home', () => {
        const item = { kind: 'work-board-item', scope, boardId: 'board-a',
            item: { kind: 'machine', qualifiedId: { serverId: 'home-b', id: 'machine-a' } } };
        expect(EntityDragItemV1Schema.safeParse(item).success).toBe(true);
        expect(EntityDragItemV1Schema.safeParse({ ...item, item: { kind: 'widget', qualifiedId: item.item.qualifiedId } }).success).toBe(false);
    });
    it('carries a WorkBoard widget placement as its Board and instance in the carried Account, nothing more', () => {
        const widget = { kind: 'work-board-widget', scope, boardId: 'board-a', instanceId: 'copy-1' };
        expect(isEntityDragKindV1('work-board-widget')).toBe(true);
        expect(entityDragKindV1(EntityDragItemV1Schema.parse(widget))).toBe('work-board-widget');
        expect(EntityDragItemV1Schema.safeParse({ ...widget, surface: { serverId: 'home-b', accountId: 'other' } }).success).toBe(false);
        expect(EntityDragItemV1Schema.safeParse({ ...widget, instanceId: '' }).success).toBe(false);
    });
    it('rejects raw Session ids, conflicting Home addresses and unexpected authority or transport fields', () => {
        const session = { kind: 'session', scope, address: { serverId: 'home-a', sessionId: 'same-id' } };
        expect(EntityDragItemV1Schema.safeParse(session).success).toBe(true);
        expect(EntityDragItemV1Schema.safeParse({ kind: 'session', sessionId: 'same-id' }).success).toBe(false);
        expect(EntityDragItemV1Schema.safeParse({ ...session, address: { serverId: 'home-b', sessionId: 'same-id' } }).success).toBe(false);
        expect(EntityDragItemV1Schema.safeParse({ ...session, bearerToken: 'secret' }).success).toBe(false);
        expect(EntityDragItemV1Schema.safeParse({ ...session, scope: { ...scope, grant: 'input' } }).success).toBe(false);
    });
    it('carries only current Project/plugin-area widget references qualified to the carried Account', () => {
        for (const owner of [{ kind: 'project', projectId: 'source-a' }, { kind: 'pluginArea', pluginId: 'example', pageId: 'overview', area: 'pinned' }]) {
            const item = { kind: 'widget-area-instance', scope, ref: { surface: { ...scope, owner }, instanceId: 'copy' } };
            expect(EntityDragItemV1Schema.safeParse(item).success).toBe(true);
            expect(EntityDragItemV1Schema.safeParse({ ...item, ref: { ...item.ref, surface: { ...item.ref.surface, accountId: 'another' } } }).success).toBe(false);
            expect(EntityDragItemV1Schema.safeParse({ ...item, ref: { ...item.ref, surface: { ...item.ref.surface, serverId: 'another' } } }).success).toBe(false);
            expect(EntityDragItemV1Schema.safeParse({ ...item, ref: { ...item.ref, authority: 'editor' } }).success).toBe(false);
        }
        expect(EntityDragItemV1Schema.safeParse({ kind: 'widget-area-instance', scope,
            ref: { surface: { ...scope, owner: { kind: 'home' } }, instanceId: 'copy' } }).success).toBe(false);
    });
    it('qualifies contributed kinds and rejects executable or OS bytes in JSON references/effects', () => {
        const plugin = { kind: 'plugin', scope, contribution: { pluginId: 'example.entities', localId: 'pull-request' }, reference: { repositoryId: 'repo', number: 4 } };
        const parsed = EntityDragItemV1Schema.parse(plugin);
        expect(entityDragKindV1(parsed)).toBe('plugin:example.entities/pull-request');
        expect(EntityDragItemV1Schema.safeParse({ ...plugin, reference: { run: () => {} } }).success).toBe(false);
        expect(EntityDragItemV1Schema.safeParse({ ...plugin, reference: new Uint8Array([1]) }).success).toBe(false);
        expect(EntityDropEffectV1Schema.safeParse({ actionId: 'session.reports_to.set', input: { callback: () => {} }, preview: { verb: 'Put under', target: 'Lead' } }).success).toBe(false);
    });
});
