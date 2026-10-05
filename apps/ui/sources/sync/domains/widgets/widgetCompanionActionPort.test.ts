import { describe, expect, it } from 'vitest';
import { normalizeSessionCompanionPreference, setSessionCompanionInstanceInputs, removeSessionCompanionItem, addSessionCompanionItem, moveSessionCompanionItem } from '@/components/sessions/companion/state/sessionCompanionPreference';
import { createWidgetCompanionActionPortV1 } from './widgetCompanionActionPort';

describe('Companion widget Action adapter', () => {
    it('orders configured instances without treating existing glances and pane links as widget indices', async () => {
        const makeInstance = (id: string) => ({ v: 1 as const, id, definition: { kind: 'builtin' as const, id: 'summary' }, bindings: {} });
        const a = { kind: 'instance' as const, instance: makeInstance('a') };
        const b = { kind: 'instance' as const, instance: makeInstance('b') };
        const glance = { kind: 'builtin' as const, id: 'session_summary' as const };
        const pane = { kind: 'pane' as const, paneId: 'shared-pane' };
        let preference = normalizeSessionCompanionPreference({ v: 1, visible: true, collapsed: false, density: 'compact', edge: 'trailing', items: [glance, a, pane, b] });
        const surface = { serverId: 'home-a', accountId: 'viewer-a', owner: { kind: 'companion' as const, sessionId: 'session-a' } };
        const port = createWidgetCompanionActionPortV1({
            lifetime: { scope: surface, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
            readPreference: () => preference,
            applyPresentation: async (_surface, intent) => {
                if (intent.kind === 'companion.item.move') preference = moveSessionCompanionItem(preference, intent.item, intent.toIndex);
                if (intent.kind === 'companion.item.add') preference = addSessionCompanionItem(preference, intent.item, intent.index);
                return { ok: true, result: { status: 'applied' } };
            },
        });
        await port.apply(surface, { kind: 'move', instanceId: 'b', toIndex: 0 }, {});
        expect(preference.items).toEqual([glance, b, a, pane]);
        await port.apply(surface, { kind: 'add', instance: makeInstance('c'), toIndex: 1 }, {});
        expect(preference.items).toEqual([glance, b, { kind: 'instance', instance: makeInstance('c') }, a, pane]);
        await port.apply(surface, { kind: 'move', instanceId: 'b', toIndex: 2 }, {});
        expect(preference.items).toEqual([glance, { kind: 'instance', instance: makeInstance('c') }, a, pane, b]);
        await port.apply(surface, { kind: 'add', instance: makeInstance('d'), position: { index: 0 } }, {});
        expect(preference.items[0]).toEqual({ kind: 'instance', instance: makeInstance('d') });
        await port.apply(surface, { kind: 'move', instanceId: 'b', nativeIndex: 1 }, {});
        expect(preference.items).toEqual([{ kind: 'instance', instance: makeInstance('d') }, b, glance,
            { kind: 'instance', instance: makeInstance('c') }, a, pane]);
    });
    it('translates edits into current presentation without changing shared Board references', async () => {
        const instance = { v: 1 as const, id: 'copy-a', definition: { kind: 'installed' as const, surface: { pluginId: 'acme.metrics', localId: 'status' } }, bindings: {} };
        let preference = normalizeSessionCompanionPreference({ v: 1, visible: true, collapsed: false, density: 'compact', edge: 'trailing', items: [{ kind: 'widget', widgetId: 'shared' }, { kind: 'instance', instance }] });
        let current = true;
        const surface = { serverId: 'home-a', accountId: 'viewer-a', owner: { kind: 'companion' as const, sessionId: 'session-a' } };
        const port = createWidgetCompanionActionPortV1({
            lifetime: { scope: { serverId: 'home-a', accountId: 'viewer-a' }, isCurrent: () => current, onRetire: () => ({ dispose() {} }) },
            readPreference: () => preference,
            // The current-client transport boundary acknowledges the real preference reducer.
            applyPresentation: async (_surface, intent) => {
                if (intent.kind === 'companion.instance.inputs.set') preference = setSessionCompanionInstanceInputs(preference, intent.instanceId, intent.bindings);
                if (intent.kind === 'companion.item.remove') preference = removeSessionCompanionItem(preference, intent.item);
                if (intent.kind === 'companion.item.add') preference = addSessionCompanionItem(preference, intent.item, intent.index);
                return { ok: true, result: { status: 'applied', revision: 'acknowledged' } };
            },
        });
        expect(await port.read(surface, {})).toMatchObject({ instances: [{ instance }], canEdit: true });
        expect(await port.apply(surface, { kind: 'inputs', instanceId: 'copy-a', bindings: { session: { kind: 'value', value: 'session-b' } } }, {})).toMatchObject({ ok: true, result: { instance: { bindings: { session: { kind: 'value', value: 'session-b' } } } } });
        expect(preference.items[0]).toEqual({ kind: 'widget', widgetId: 'shared' });
        expect(await port.apply(surface, { kind: 'width', instanceId: 'copy-a', width: 'full' }, {})).toMatchObject({ ok: false, errorCode: 'widgets_width_unavailable' });
        expect(await port.apply(surface, { kind: 'add', instance: { ...instance, id: 'copy-b' }, placement: { tabId: 't' } }, {})).toMatchObject({ ok: false, errorCode: 'widgets_placement_unavailable' });
        expect(preference.items).toHaveLength(2);
        current = false;
        expect(await port.apply(surface, { kind: 'remove', instanceId: 'copy-a' }, {})).toMatchObject({ ok: false, errorCode: 'widgets_surface_unavailable' });
        expect(preference.items).toHaveLength(2);
    });
});
