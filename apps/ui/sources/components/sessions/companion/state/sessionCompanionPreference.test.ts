import { describe, expect, it } from 'vitest';
import { SessionCompanionPresentationItemRefV1Schema } from '@happier-dev/protocol/sessions';

import {
    AGENT_PLAN_COMPANION_ITEM,
    HIDDEN_SESSION_COMPANION_PREFERENCE_V1,
    SESSION_SUMMARY_COMPANION_ITEM,
    SessionCompanionPreferencesV1Schema,
    addSessionCompanionItem,
    areSessionCompanionPreferencesEqual,
    hideSessionCompanion,
    moveSessionCompanionItem,
    normalizeSessionCompanionPreference,
    removeSessionCompanionItem,
    showSessionCompanion,
    setSessionCompanionInstanceInputs,
    renameSessionCompanionInstance,
    setSessionCompanionItemFrameStyle,
    type SessionCompanionItemRefV1,
    type SessionCompanionPreferenceV1,
} from './sessionCompanionPreference';

const widget = (widgetId: string): SessionCompanionItemRefV1 => ({ kind: 'widget', widgetId });

const visible: SessionCompanionPreferenceV1 = {
    v: 1,
    visible: true,
    collapsed: false,
    edge: 'trailing',
    density: 'compact',
    items: [SESSION_SUMMARY_COMPANION_ITEM, widget('item-a')],
};

describe('session companion preference schema', () => {
    it('reads known preference and instance fields recursively, dropping extras while input admission remains strict', () => {
        const instance = { v: 1, id: 'copy-a', definition: { kind: 'installed', surface: { pluginId: 'acme.tools', localId: 'glance' } }, bindings: { session: { kind: 'context', slot: 'session' } } };
        const item = { kind: 'instance', instance };
        const storedItem = { ...item, savedBy: 'other-client', instance: { ...instance, savedBy: 'other-client', definition: { ...instance.definition, savedBy: 'other-client', surface: { ...instance.definition.surface, savedBy: 'other-client' } }, bindings: { session: { ...instance.bindings.session, savedBy: 'other-client' } } } };
        const stored = { ...visible, savedBy: 'other-client', items: [storedItem] };
        const expected = { ...visible, items: [item] };
        expect(normalizeSessionCompanionPreference(stored)).toEqual(expected);
        expect(SessionCompanionPreferencesV1Schema.parse({ 'realm:good': stored, 'realm:missing': { ...stored, density: undefined } })).toEqual({ 'realm:good': expected });
        expect(normalizeSessionCompanionPreference({ ...stored, items: [{ ...storedItem, instance: { ...storedItem.instance, id: undefined } }] })).toEqual(HIDDEN_SESSION_COMPANION_PREFERENCE_V1);
        expect(SessionCompanionPresentationItemRefV1Schema.safeParse(storedItem).success).toBe(false);
    });
    it('keeps independently configured copies while a shared Board reference remains separate', () => {
        const instance = { v: 1, id: 'copy-a', definition: { kind: 'installed', surface: { pluginId: 'acme.tools', localId: 'glance' } }, bindings: { session: { kind: 'value', value: 'session-a' } } };
        const second = { ...instance, id: 'copy-b', bindings: { session: { kind: 'value', value: 'session-b' } } };
        const refs = [{ kind: 'instance', instance }, { kind: 'instance', instance: second }, widget('shared-item')];
        expect(normalizeSessionCompanionPreference({ ...visible, items: refs }).items).toEqual(refs);
    });
    it('retains compact glances and pane links with independent frame overrides, deduplicating by reference identity', () => {
        const refs = [
            { kind: 'builtin', id: 'changes', frameStyle: 'card' },
            { kind: 'builtin', id: 'local_services' },
            { kind: 'pane', paneId: 'git', frameStyle: 'plain' },
            { kind: 'instance', instance: { v: 1, id: 'copy-a', definition: { kind: 'installed', surface: { pluginId: 'acme.tools', localId: 'glance' } }, bindings: {} }, frameStyle: 'card' },
        ];
        const normalized = normalizeSessionCompanionPreference({ ...visible, items: [...refs, { ...refs[2], frameStyle: 'card' }] });
        expect(normalized.items).toEqual(refs);
        expect(addSessionCompanionItem(normalized, { kind: 'pane', paneId: 'git' })).toBe(normalized);
        expect(removeSessionCompanionItem(normalized, { kind: 'pane', paneId: 'git' }).items).toEqual([refs[0], refs[1], refs[3]]);
        expect(areSessionCompanionPreferencesEqual(normalized, { ...normalized, items: normalized.items.map((ref) => ({ ...ref, frameStyle: 'plain' })) })).toBe(false);
    });
    it('drops only the malformed entry and keeps every valid sibling', () => {
        const parsed = SessionCompanionPreferencesV1Schema.parse({
            'realm:good': visible,
            'realm:bad': { v: 1, visible: 'yes' },
            'realm:alsoBad': 42,
            'realm:unknownItemKind': { ...visible, items: [{ kind: 'pet', id: 'x' }] },
        });

        expect(Object.keys(parsed).sort()).toEqual(['realm:good']);
    });

    it('resolves a malformed root to an empty map instead of failing the whole local-settings parse', () => {
        expect(SessionCompanionPreferencesV1Schema.parse('not-a-map')).toEqual({});
        expect(SessionCompanionPreferencesV1Schema.parse(null)).toEqual({});
        expect(SessionCompanionPreferencesV1Schema.parse([visible])).toEqual({});
    });

    it('drops an unknown version instead of inventing an opaque future-settings protocol', () => {
        const future = { v: 2, visible: true, edge: 'leading', railGroups: [{ id: 'g1' }] };
        const parsed = SessionCompanionPreferencesV1Schema.parse({ 'realm:future': future });

        expect(parsed).toEqual({});
        expect(normalizeSessionCompanionPreference(parsed['realm:future']))
            .toEqual(HIDDEN_SESSION_COMPANION_PREFERENCE_V1);
    });

    it('accepts only known built-in item ids', () => {
        const withUnknownBuiltin = { ...visible, items: [{ kind: 'builtin', id: 'session_summary_shard' }] };

        expect(SessionCompanionPreferencesV1Schema.parse({ 'realm:x': withUnknownBuiltin })).toEqual({});
    });

    it('keeps the agent Plan as a built-in reference of its own', () => {
        const withPlan = { ...visible, items: [SESSION_SUMMARY_COMPANION_ITEM, AGENT_PLAN_COMPANION_ITEM] };

        expect(SessionCompanionPreferencesV1Schema.parse({ 'realm:x': withPlan })).toEqual({ 'realm:x': withPlan });
        expect(normalizeSessionCompanionPreference(withPlan).items).toEqual([
            { kind: 'builtin', id: 'session_summary' },
            { kind: 'builtin', id: 'agent_plan' },
        ]);
    });
});

describe('normalizeSessionCompanionPreference', () => {
    it('returns the hidden implicit default for an absent entry', () => {
        expect(normalizeSessionCompanionPreference(undefined)).toEqual(HIDDEN_SESSION_COMPANION_PREFERENCE_V1);
    });

    it('keeps the first occurrence of a duplicated reference', () => {
        const normalized = normalizeSessionCompanionPreference({
            ...visible,
            items: [widget('item-a'), SESSION_SUMMARY_COMPANION_ITEM, widget('item-a')],
        });

        expect(normalized.items).toEqual([widget('item-a'), SESSION_SUMMARY_COMPANION_ITEM]);
    });
});

describe('session companion mutations', () => {
    it('conditionally removes only the captured personal instance and presentation, preserving later edits', () => {
        const instance = { v: 1 as const, id: 'copy-a', definition: { kind: 'builtin' as const, id: 'session_summary' }, bindings: {} };
        const item = { kind: 'instance' as const, instance };
        const original = normalizeSessionCompanionPreference({ ...visible, items: [SESSION_SUMMARY_COMPANION_ITEM, item, widget('shared-item')] });
        const guard = { expectedInstance: instance, expectedPresentation: { frameStyle: null, nativeIndex: 1 } };
        expect(removeSessionCompanionItem(original, item, { ...guard,
            expectedPresentation: { ...guard.expectedPresentation, size: 'medium' } })).toBe(original);
        const edited = renameSessionCompanionInstance(original, instance.id, 'Changed while moving');
        expect(removeSessionCompanionItem(edited, item, guard)).toBe(edited);
        const reframed = setSessionCompanionItemFrameStyle(original, item, 'plain');
        expect(removeSessionCompanionItem(reframed, item, guard)).toBe(reframed);
        const reordered = moveSessionCompanionItem(original, item, 0);
        expect(removeSessionCompanionItem(reordered, item, guard)).toBe(reordered);
        const unrelated = { ...original, density: 'comfortable' as const };
        expect(removeSessionCompanionItem(unrelated, item, guard)).toEqual({ ...unrelated, items: [SESSION_SUMMARY_COMPANION_ITEM, widget('shared-item')] });
        // A human removal still acts on identity rather than a transfer snapshot.
        expect(removeSessionCompanionItem(edited, item).items).toEqual([SESSION_SUMMARY_COMPANION_ITEM, widget('shared-item')]);
    });
    it('edits one personal copy without rewriting its sibling or the shared Board reference', () => {
        const instance = { v: 1 as const, id: 'copy-a', definition: { kind: 'installed' as const, surface: { pluginId: 'acme.tools', localId: 'glance' } }, bindings: {} };
        const original = normalizeSessionCompanionPreference({ ...visible, items: [{ kind: 'instance', instance }, { kind: 'instance', instance: { ...instance, id: 'copy-b' } }, widget('shared-item')] });
        const edited = setSessionCompanionInstanceInputs(original, 'copy-a', { session: { kind: 'value', value: 'session-b' } });
        expect(edited.items[0]).toMatchObject({ instance: { bindings: { session: { kind: 'value', value: 'session-b' } } } });
        expect(edited.items.slice(1)).toEqual(original.items.slice(1));
        expect(edited.items[1]).toBe(original.items[1]);
        expect(edited.items[2]).toBe(original.items[2]);
        expect(original.items[0]).toMatchObject({ instance: { bindings: {} } });
        expect(setSessionCompanionInstanceInputs(edited, 'copy-a', { session: { kind: 'value', value: 'session-b' } })).toBe(edited);
        expect(renameSessionCompanionInstance(edited, 'copy-a', 'Pinned').items[0]).toMatchObject({ instance: { displayName: 'Pinned' } });
        expect(removeSessionCompanionItem(edited, { kind: 'instance', instance }).items).toEqual(original.items.slice(1));
    });
    it('seeds the Session Summary only when nothing is selected yet', () => {
        expect(showSessionCompanion(HIDDEN_SESSION_COMPANION_PREFERENCE_V1)).toEqual({
            ...HIDDEN_SESSION_COMPANION_PREFERENCE_V1,
            visible: true,
            items: [SESSION_SUMMARY_COMPANION_ITEM],
        });
        expect(showSessionCompanion({ ...visible, visible: false }).items).toEqual(visible.items);
    });

    it('adds an explicitly requested item without seeding the summary', () => {
        const shown = showSessionCompanion(HIDDEN_SESSION_COMPANION_PREFERENCE_V1, widget('item-b'));

        expect(shown.visible).toBe(true);
        expect(shown.items).toEqual([widget('item-b')]);
    });

    it('hides without losing items, order, edge or density', () => {
        expect(hideSessionCompanion(visible)).toEqual({ ...visible, visible: false });
    });

    it('ignores a duplicate add and an unknown move or remove', () => {
        expect(addSessionCompanionItem(visible, widget('item-a'))).toBe(visible);
        expect(moveSessionCompanionItem(visible, widget('missing'), 0)).toBe(visible);
        expect(removeSessionCompanionItem(visible, widget('missing'))).toBe(visible);
    });

    it('hides the card when the last item is removed, keeping the empty customization', () => {
        const single: SessionCompanionPreferenceV1 = { ...visible, items: [widget('item-a')] };
        const removed = removeSessionCompanionItem(single, widget('item-a'));

        expect(removed.items).toEqual([]);
        expect(removed.visible).toBe(false);
    });

    it('keeps the card visible while other items remain', () => {
        const removed = removeSessionCompanionItem(visible, widget('item-a'));

        expect(removed.items).toEqual([SESSION_SUMMARY_COMPANION_ITEM]);
        expect(removed.visible).toBe(true);
    });

    it('clamps a move index instead of dropping the item', () => {
        expect(moveSessionCompanionItem(visible, SESSION_SUMMARY_COMPANION_ITEM, 9).items)
            .toEqual([widget('item-a'), SESSION_SUMMARY_COMPANION_ITEM]);
        expect(moveSessionCompanionItem(visible, widget('item-a'), -3).items)
            .toEqual([widget('item-a'), SESSION_SUMMARY_COMPANION_ITEM]);
    });

    it('inserts at a requested index', () => {
        expect(addSessionCompanionItem(visible, widget('item-b'), 1).items)
            .toEqual([SESSION_SUMMARY_COMPANION_ITEM, widget('item-b'), widget('item-a')]);
    });
});
