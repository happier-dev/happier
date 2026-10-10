import { describe, expect, it } from 'vitest';
import type { HomeHubLayoutIntent } from './homeHubLayoutV1.js';
import { readBuiltinWidgetDescriptorV1 } from '../widgets/builtinWidgetDescriptorV1.js';
import type { WidgetSizeDeclarationV1 } from '../widgets/widgetPresentationV1.js';
import type { WidgetDefinitionV1 } from '../widgets/widgetDefinitionV1.js';

import {
    HOME_HUB_DEFAULT_LAYOUT,
    HomeHubLayoutV1Schema,
    HomeHubLayoutIntentSchema,
    applyHomeHubLayoutIntent,
    homeHubDefaultWidgetInstanceId,
    listHiddenHomeSetupSteps,
    moveHomeHubSection,
    reorderHomeHubSections,
    setHomeSetupStepHidden,
    resolveHomeHubLayout,
    setHomeHubSectionHidden,
    type HomeHubBuiltinDefinition,
    type HomeHubLayoutValue,
    type HomeHubWidgetInput,
} from './homeHubLayoutV1.js';

// The built-in section table's shape; its rows and renderers live in `homeHubSections.tsx`.
const BUILTINS: readonly HomeHubBuiltinDefinition[] = [
    { id: 'start', hideable: false },
    { id: 'attention', hideable: false },
    { id: 'setup', hideable: true },
    { id: 'machines', hideable: true },
    { id: 'usage', hideable: true },
];

const SHOWN: HomeHubWidgetInput = { key: 'acme.review/latest', homeDefault: 'shown', surface: { pluginId: 'acme.review', localId: 'latest' } };
const AVAILABLE: HomeHubWidgetInput = { key: 'acme.ci/runs', homeDefault: 'available', surface: { pluginId: 'acme.ci', localId: 'runs' } };
const SHOWN_ID = homeHubDefaultWidgetInstanceId(SHOWN.key);
const AVAILABLE_ID = homeHubDefaultWidgetInstanceId(AVAILABLE.key);

describe('configured Home placements', () => {
    it('uses the loaded effective width when admitting a default-shown child into a group', () => {
        const widget = { ...SHOWN, sizeDeclaration: { sizes: ['wide'], defaultSize: 'wide' } satisfies WidgetSizeDeclarationV1 };
        expect(() => applyHomeHubLayoutIntent(HOME_HUB_DEFAULT_LAYOUT, BUILTINS, [widget],
            { kind: 'group_create', groupId: 'wide-group', instanceIds: [SHOWN_ID], width: 'half' })).toThrowError('widget_group_width_no_fit');
        const grouped = applyHomeHubLayoutIntent(HOME_HUB_DEFAULT_LAYOUT, BUILTINS, [widget],
            { kind: 'group_create', groupId: 'wide-group', instanceIds: [SHOWN_ID], width: 'full' });
        expect(grouped.items).toMatchObject([{ kind: 'group', children: [{ size: 'wide' }] }]);
    });
    it('groups a projected default without duplicating it and restores child presentation on ungroup', () => {
        const grouped = applyHomeHubLayoutIntent(HOME_HUB_DEFAULT_LAYOUT, BUILTINS, [SHOWN],
            HomeHubLayoutIntentSchema.parse({ kind: 'group_create', groupId: 'reviews', instanceIds: [SHOWN_ID] }));
        expect(grouped.items).toMatchObject([{ kind: 'group', id: 'reviews', frameStyle: 'card', dividers: 'hairline', children: [{ instance: { id: SHOWN_ID } }] }]);
        const resolved = resolveHomeHubLayout(grouped, BUILTINS, [SHOWN]);
        expect(resolved.sections.filter(section => section.kind === 'widget')).toEqual([]);
        expect(resolved.sections.find(section => section.id === 'reviews')).toMatchObject({ kind: 'group', children: [{ id: SHOWN_ID }] });
        const restored = applyHomeHubLayoutIntent(grouped, BUILTINS, [SHOWN],
            HomeHubLayoutIntentSchema.parse({ kind: 'group_ungroup', instanceId: 'reviews' }));
        expect(restored.items).toMatchObject([{ kind: 'widget', instance: { id: SHOWN_ID } }]);
        expect(restored.order).toContain(SHOWN_ID);
        expect(restored.order).not.toContain('reviews');
    });
    it('rejects duplicate child identities across Home groups and standalone items', () => {
        const instance = { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'session_summary' }, bindings: {} };
        expect(HomeHubLayoutV1Schema.safeParse({ v: 1, order: [], hidden: [], items: [
            { kind: 'widget', instance },
            { kind: 'group', id: 'group', width: 'full', frameStyle: 'card', dividers: 'hairline', children: [{ kind: 'widget', instance }] },
        ] }).success).toBe(false);
    });
    it('moves the last child out, dissolves its group, and retains its saved card frame', () => {
        const added = applyHomeHubLayoutIntent(HOME_HUB_DEFAULT_LAYOUT, BUILTINS, [], { kind: 'widget_add',
            instance: { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'session_summary' }, bindings: {} }, frameStyle: 'card', size: 'small', position: { nativeIndex: 1 } });
        const grouped = applyHomeHubLayoutIntent(added, BUILTINS, [], { kind: 'group_create', groupId: 'group', instanceIds: ['copy'] });
        expect(resolveHomeHubLayout(grouped, BUILTINS, []).sections.find(section => section.kind === 'group')).toMatchObject({ children: [{ frameStyle: 'plain' }] });
        const moved = applyHomeHubLayoutIntent(grouped, BUILTINS, [], { kind: 'move', instanceId: 'copy', toIndex: 0, groupId: null });
        expect(moved.items).toEqual(added.items);
        expect(moved.order).toEqual(added.order);
        expect(moved.order).not.toContain('group');
        expect(resolveHomeHubLayout(moved, BUILTINS, []).sections.find(section => section.id === 'copy')).toMatchObject({ frameStyle: 'card' });
    });
    it('atomically adds a transferred child inside its destination group and retains its saved presentation', () => {
        const one = { v: 1 as const, id: 'one', definition: { kind: 'builtin' as const, id: 'session_summary' }, bindings: {} };
        const grouped = applyHomeHubLayoutIntent(HOME_HUB_DEFAULT_LAYOUT, BUILTINS, [], { kind: 'group_add', group: {
            kind: 'group', id: 'group', width: 'full', frameStyle: 'card', dividers: 'hairline', children: [{ kind: 'widget', instance: one, size: 'small' }] } });
        const two = { ...one, id: 'two' };
        const added = applyHomeHubLayoutIntent(grouped, BUILTINS, [], HomeHubLayoutIntentSchema.parse({ kind: 'widget_add', instance: two,
            groupId: 'group', size: 'tall', frameStyle: 'card', position: { nativeIndex: 0 } }));
        expect(added.items).toMatchObject([{ kind: 'group', children: [{ instance: two, size: 'tall', frameStyle: 'card' }, { instance: one }] }]);
        expect(added.order).not.toContain('two');
    });
    it('removes grouped default children without projecting them again and keeps builtin/setup state', () => {
        const base = setHomeSetupStepHidden(HOME_HUB_DEFAULT_LAYOUT, 'addPhone', true);
        const grouped = applyHomeHubLayoutIntent(base, BUILTINS, [SHOWN], { kind: 'group_create', groupId: 'group', instanceIds: [SHOWN_ID] });
        const removed = applyHomeHubLayoutIntent(grouped, BUILTINS, [SHOWN], { kind: 'remove', instanceId: 'group' });
        expect(resolveHomeHubLayout(removed, BUILTINS, [SHOWN]).sections.filter(section => section.kind !== 'builtin')).toEqual([]);
        expect(removed.hidden).toContain('setup:addPhone');
        expect(removed.hidden).toContain(SHOWN_ID);
        expect(removed.order).not.toContain('group');
    });
    it('projects declared defaults and normalizes stale saved size without changing the personal layout', () => {
        const widget = { ...SHOWN, sizeDeclaration: { sizes: ['wide'], defaultSize: 'wide' } satisfies WidgetSizeDeclarationV1 };
        const defaultBefore = structuredClone(HOME_HUB_DEFAULT_LAYOUT);
        expect(resolveHomeHubLayout(HOME_HUB_DEFAULT_LAYOUT, BUILTINS, [widget]).sections
            .find(section => section.id === SHOWN_ID)).toMatchObject({ size: 'wide' });
        expect(HOME_HUB_DEFAULT_LAYOUT).toEqual(defaultBefore);
        const tallDefault = { ...SHOWN,
            sizeDeclaration: { sizes: ['medium', 'tall'], defaultSize: 'tall' } satisfies WidgetSizeDeclarationV1 };
        expect(resolveHomeHubLayout(HOME_HUB_DEFAULT_LAYOUT, BUILTINS, [tallDefault]).sections
            .find(section => section.id === SHOWN_ID)).toMatchObject({ size: 'tall' });
        expect(HOME_HUB_DEFAULT_LAYOUT).toEqual(defaultBefore);

        const stored: HomeHubLayoutValue = { ...HOME_HUB_DEFAULT_LAYOUT,
            items: [{ kind: 'widget', instance: { v: 1, id: SHOWN_ID, definition: { kind: 'installed', surface: SHOWN.surface }, bindings: {} }, size: 'medium', frameStyle: 'plain' }] };
        const before = structuredClone(stored);
        expect(resolveHomeHubLayout(stored, BUILTINS, [widget]).sections
            .find(section => section.id === SHOWN_ID)).toMatchObject({ size: 'wide', frameStyle: 'plain' });
        expect(stored).toEqual(before);
    });
    it('uses inline declarations and loaded Artifact descriptors without requiring an installed catalog entry', () => {
        const definition: WidgetDefinitionV1 = { v: 1, id: 'authored', name: 'Authored',
            sizeDeclaration: { sizes: ['tall'], defaultSize: 'tall' },
            body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Hello' } } },
            inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false },
            provenance: { source: { kind: 'authored' } } };
        const inline = { v: 1 as const, id: 'inline', definition: { kind: 'inline' as const, definition }, bindings: {} };
        const artifact = { v: 1 as const, id: 'artifact', definition: { kind: 'artifact' as const, artifactId: 'authored' }, bindings: {} };
        const loaded: HomeHubWidgetInput = { key: 'artifact:authored', homeDefault: 'available',
            definition: artifact.definition, sizeDeclaration: definition.sizeDeclaration };
        const layout: HomeHubLayoutValue = { ...HOME_HUB_DEFAULT_LAYOUT, items: [
            { kind: 'widget', instance: inline, size: 'medium' }, { kind: 'widget', instance: artifact, size: 'medium' }] };
        expect(resolveHomeHubLayout(layout, [], [loaded]).sections).toMatchObject([
            { id: 'inline', size: 'tall' }, { id: 'artifact', size: 'tall', widget: loaded },
        ]);
        expect(resolveHomeHubLayout(layout, [], []).sections).toMatchObject([
            { id: 'inline', size: 'tall' }, { id: 'artifact', size: 'medium' },
        ]);
        expect(layout.items.map(item => item.kind === 'widget' && item.size)).toEqual(['medium', 'medium']);
    });
    it('stores a tall size atomically with Add and keeps an independently sized sibling', () => {
        const instance = { v: 1 as const, id: 'tall-copy', definition: { kind: 'builtin' as const, id: 'session_summary' }, bindings: {} };
        const added = applyHomeHubLayoutIntent(HOME_HUB_DEFAULT_LAYOUT, BUILTINS, [],
            { kind: 'widget_add', instance, size: 'tall' });
        expect(added.items).toMatchObject([{ size: 'tall' }]);
        const sibling = { ...instance, id: 'wide-copy' };
        const copies = applyHomeHubLayoutIntent(added, BUILTINS, [], { kind: 'widget_add', instance: sibling, size: 'full' });
        const edited = applyHomeHubLayoutIntent(copies, BUILTINS, [], { kind: 'widget_size', instanceId: instance.id, size: 'small' });
        expect(edited.items).toMatchObject([{ instance: { id: 'tall-copy' }, size: 'small' }, { instance: { id: 'wide-copy' }, size: 'full' }]);
    });
    it('projects a configured native copy through the same catalog identity without creating defaults or changing its sibling', () => {
        const descriptor = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'session_summary' })!;
        const one = { v: 1 as const, id: 'summary-one', definition: descriptor.definition,
            bindings: { session: { kind: 'value' as const, value: { serverId: 'home', sessionId: 'B' } } } };
        const two = { ...one, id: 'summary-two', bindings: { session: { kind: 'value' as const, value: { serverId: 'home', sessionId: 'C' } } } };
        expect(resolveHomeHubLayout(HOME_HUB_DEFAULT_LAYOUT, BUILTINS, [descriptor]).sections.filter(section => section.kind === 'widget')).toEqual([]);
        const added = applyHomeHubLayoutIntent(HOME_HUB_DEFAULT_LAYOUT, BUILTINS, [descriptor], { kind: 'widget_add', instance: one });
        const copies = applyHomeHubLayoutIntent(added, BUILTINS, [descriptor], { kind: 'widget_add', instance: two });
        const projected = resolveHomeHubLayout(copies, BUILTINS, [descriptor]).sections.filter(section => section.kind === 'widget');
        expect(projected).toMatchObject([{ id: one.id, widget: descriptor }, { id: two.id, widget: descriptor }]);
        const removed = applyHomeHubLayoutIntent(copies, BUILTINS, [descriptor], { kind: 'widget_remove', instanceId: one.id });
        expect(removed.items).toEqual([{ kind: 'widget', instance: two }]);
        expect(resolveHomeHubLayout(removed, BUILTINS, []).sections.find(section => section.id === two.id)).toMatchObject({ instance: two });
    });
    it('adds two independently bound copies and edits only the selected instance', () => {
        const instance = (id: string, sessionId: string) => ({ v: 1, id,
            definition: { kind: 'installed', surface: { pluginId: 'acme.ci', localId: 'runs' } },
            bindings: { session: { kind: 'value', value: sessionId } } });
        const apply = (layout: HomeHubLayoutValue, intent: unknown) => applyHomeHubLayoutIntent(layout, BUILTINS, [AVAILABLE], intent as HomeHubLayoutIntent);
        const one = apply(HOME_HUB_DEFAULT_LAYOUT, { kind: 'widget_add', instance: instance('one', 'A') });
        const two = apply(one, { kind: 'widget_add', instance: instance('two', 'B') });
        expect(two).toMatchObject({ items: [{ instance: instance('one', 'A') }, { instance: instance('two', 'B') }] });
        const edited = apply(two, { kind: 'widget_inputs', instanceId: 'one', bindings: { session: { kind: 'value', value: 'C' } } });
        expect(edited).toMatchObject({ items: [{ instance: instance('one', 'C') }, { instance: instance('two', 'B') }] });
        const wide = apply(edited, { kind: 'widget_size', instanceId: 'one', size: 'full' });
        expect(wide.items[0]).toMatchObject({ size: 'full' });
        const removed = apply(wide, { kind: 'widget_remove', instanceId: 'one' });
        expect(removed).toMatchObject({ items: [{ instance: instance('two', 'B') }] });
    });
});

describe('Home customization intents shared with Actions', () => {
    it('preserves saved overrides, including temporarily unknown widgets, across customization and clears only the requested override', () => {
        const stored: HomeHubLayoutValue = { ...HOME_HUB_DEFAULT_LAYOUT, order: ['start', 'future-section', 'attention', 'setup', 'machines', 'usage'],
            hidden: ['setup:addPhone'],
            sections: { 'future-section': { frameStyle: 'card' } },
            items: [{ kind: 'widget', instance: { v: 1, id: SHOWN_ID, definition: { kind: 'installed', surface: SHOWN.surface }, bindings: {} }, frameStyle: 'plain' }],
        };
        const added = applyHomeHubLayoutIntent(stored, BUILTINS, [SHOWN, AVAILABLE], { kind: 'widget_add', instance: { v: 1, id: AVAILABLE_ID, definition: { kind: 'installed', surface: AVAILABLE.surface }, bindings: {} } });
        const moved = applyHomeHubLayoutIntent(added, BUILTINS, [SHOWN, AVAILABLE], { kind: 'move', sectionId: AVAILABLE_ID, step: -1 });
        const setupChanged = setHomeSetupStepHidden(moved, 'addPhone', false);
        const restored = applyHomeHubLayoutIntent(setupChanged, BUILTINS, [SHOWN, AVAILABLE], { kind: 'restore_setup' });
        expect(restored.sections).toEqual(stored.sections);
        expect(resolveHomeHubLayout(restored, BUILTINS, [SHOWN, AVAILABLE]).sections.find((section) => section.id === SHOWN_ID)?.frameStyle).toBe('plain');
        const cleared = applyHomeHubLayoutIntent(restored, BUILTINS, [SHOWN, AVAILABLE], { kind: 'frameStyle', sectionId: SHOWN_ID, frameStyle: null });
        expect(cleared.sections).toEqual({ 'future-section': { frameStyle: 'card' } });
        expect(applyHomeHubLayoutIntent({ ...HOME_HUB_DEFAULT_LAYOUT, order: [], hidden: [], sections: stored.sections }, BUILTINS, [], { kind: 'reset' })).toEqual(HOME_HUB_DEFAULT_LAYOUT);
    });
    it('adds a widget, reorders without discarding unknown slots, preserves mandatory sections and restores dismissed setup', () => {
        const stored = { ...HOME_HUB_DEFAULT_LAYOUT, order: ['start', 'future-section', 'attention', 'setup', 'machines', 'usage'], hidden: ['setup:addPhone'] };
        const added = applyHomeHubLayoutIntent(stored, WITH_DEFAULT_HIDDEN, [SHOWN, AVAILABLE], { kind: 'widget_add', instance: { v: 1, id: AVAILABLE_ID, definition: { kind: 'installed', surface: AVAILABLE.surface }, bindings: {} } });
        expect(added.order).toContain(AVAILABLE_ID);
        const reordered = applyHomeHubLayoutIntent(added, WITH_DEFAULT_HIDDEN, [SHOWN, AVAILABLE], {
            kind: 'reorder', sectionIds: ['usage', 'start', 'attention', 'setup', 'machines', SHOWN_ID, AVAILABLE_ID],
        });
        expect(reordered.order[1]).toBe('future-section');
        expect(reordered.order[0]).toBe('usage');
        const mandatory = applyHomeHubLayoutIntent(reordered, WITH_DEFAULT_HIDDEN, [SHOWN, AVAILABLE], { kind: 'visibility', sectionId: 'attention', hidden: true });
        expect(mandatory).toBe(reordered);
        const restored = applyHomeHubLayoutIntent(mandatory, WITH_DEFAULT_HIDDEN, [SHOWN, AVAILABLE], { kind: 'restore_setup' });
        expect(restored.hidden).not.toContain('setup:addPhone');
        expect(applyHomeHubLayoutIntent(restored, WITH_DEFAULT_HIDDEN, [SHOWN, AVAILABLE], { kind: 'reset' })).toEqual(HOME_HUB_DEFAULT_LAYOUT);
    });
});

function ids(layout: HomeHubLayoutValue, widgets: readonly HomeHubWidgetInput[] = []) {
    return resolveHomeHubLayout(layout, BUILTINS, widgets).sections.map((section) => section.id);
}

// Machines is off until the person turns it on (a Home is about work, machines are a detail).
const WITH_DEFAULT_HIDDEN: readonly HomeHubBuiltinDefinition[] = BUILTINS.map((section) => (
    section.id === 'machines' ? { ...section, defaultHidden: true } : section
));

function hiddenIds(layout: HomeHubLayoutValue, widgets: readonly HomeHubWidgetInput[] = []) {
    return resolveHomeHubLayout(layout, WITH_DEFAULT_HIDDEN, widgets).sections
        .filter((section) => section.hidden)
        .map((section) => section.id);
}

describe('home hub layout: sections off by default', () => {
    it('keeps a default-hidden section off until the person turns it on, and remembers that', () => {
        expect(hiddenIds(HOME_HUB_DEFAULT_LAYOUT)).toEqual(['machines']);
        const shown = setHomeHubSectionHidden(HOME_HUB_DEFAULT_LAYOUT, WITH_DEFAULT_HIDDEN, [], 'machines', false);
        expect(hiddenIds(shown)).toEqual([]);
        expect(hiddenIds(setHomeHubSectionHidden(shown, WITH_DEFAULT_HIDDEN, [], 'machines', true))).toEqual(['machines']);
    });

    it('does not turn a default-hidden section on when another section moves', () => {
        const moved = moveHomeHubSection(HOME_HUB_DEFAULT_LAYOUT, WITH_DEFAULT_HIDDEN, [], 'usage', -1);
        expect(hiddenIds(moved)).toEqual(['machines']);
        const hiddenSetup = setHomeHubSectionHidden(HOME_HUB_DEFAULT_LAYOUT, WITH_DEFAULT_HIDDEN, [], 'setup', true);
        expect(hiddenIds(hiddenSetup)).toEqual(['setup', 'machines']);
    });
});

describe('home hub layout: default order (lab hindex I1)', () => {
    // The shipping table: sections that follow the widget row say so.
    const LAB: readonly HomeHubBuiltinDefinition[] = [
        { id: 'start', hideable: false },
        { id: 'attention', hideable: false },
        { id: 'setup', hideable: true },
        { id: 'automations', hideable: true, afterWidgets: true },
        { id: 'machines', hideable: true, defaultHidden: true, afterWidgets: true },
        { id: 'usage', hideable: true, afterWidgets: true },
    ];

    it('puts default-shown widgets between Get set up and Latest runs, Machines and Usage', () => {
        const resolved = resolveHomeHubLayout(HOME_HUB_DEFAULT_LAYOUT, LAB, [SHOWN, AVAILABLE]);
        expect(resolved.sections.map((section) => `${section.id}${section.hidden ? ' (off)' : ''}`)).toEqual([
            'start', 'attention', 'setup', SHOWN_ID, 'automations', 'machines (off)', 'usage',
        ]);
    });

    it('slots a newly shown widget into the widget row of an arranged layout, keeping the person\'s order', () => {
        const arranged = { ...HOME_HUB_DEFAULT_LAYOUT, order: ['attention', 'start', 'setup', 'automations', 'machines', 'usage'], hidden: [] };
        expect(resolveHomeHubLayout(arranged, LAB, [SHOWN]).sections.map((section) => section.id))
            .toEqual(['attention', 'start', 'setup', SHOWN_ID, 'automations', 'machines', 'usage']);
    });
});

describe('home hub layout: reorder by drag', () => {
    it('writes the dragged order and keeps unknown ids and unplaced widgets where they were', () => {
        const stored = { ...HOME_HUB_DEFAULT_LAYOUT, order: ['start', 'from-a-newer-app', 'attention', 'setup', 'machines', 'usage'], hidden: [] };
        const next = reorderHomeHubSections(stored, BUILTINS, [], ['usage', 'start', 'attention', 'setup', 'machines']);
        expect(ids(next)).toEqual(['usage', 'start', 'attention', 'setup', 'machines']);
        expect(next.order.indexOf('from-a-newer-app')).toBe(1);
    });

    it('ignores a drag that changes nothing', () => {
        const same = reorderHomeHubSections(HOME_HUB_DEFAULT_LAYOUT, BUILTINS, [], ['start', 'attention', 'setup', 'machines', 'usage']);
        expect(same).toBe(HOME_HUB_DEFAULT_LAYOUT);
    });
});

describe('home hub layout: dismissed setup steps', () => {
    it('records a dismissed step on the layout without touching the sections, and shows it again', () => {
        const dismissed = setHomeSetupStepHidden(HOME_HUB_DEFAULT_LAYOUT, 'addPhone', true);
        expect(listHiddenHomeSetupSteps(dismissed)).toEqual(['addPhone']);
        expect(ids(dismissed)).toEqual(['start', 'attention', 'setup', 'machines', 'usage']);
        expect(setHomeSetupStepHidden(dismissed, 'addPhone', true)).toBe(dismissed);
        expect(listHiddenHomeSetupSteps(setHomeSetupStepHidden(dismissed, 'addPhone', false))).toEqual([]);
    });
});

describe('home hub layout', () => {
    it('shows every built-in section in the default order until the person changes it', () => {
        expect(resolveHomeHubLayout(HOME_HUB_DEFAULT_LAYOUT, BUILTINS, []).sections).toEqual([
            { kind: 'builtin', id: 'start', hidden: false, hideable: false },
            { kind: 'builtin', id: 'attention', hidden: false, hideable: false },
            { kind: 'builtin', id: 'setup', hidden: false, hideable: true },
            { kind: 'builtin', id: 'machines', hidden: false, hideable: true },
            { kind: 'builtin', id: 'usage', hidden: false, hideable: true },
        ]);
    });

    it('never hides "Start a session" or "Needs your attention", whatever is stored', () => {
        const sections = resolveHomeHubLayout({ ...HOME_HUB_DEFAULT_LAYOUT, order: [], hidden: ['start', 'attention', 'usage'] }, BUILTINS, []).sections;
        expect(sections.filter((section) => section.hidden).map((section) => section.id)).toEqual(['usage']);
        expect(setHomeHubSectionHidden(HOME_HUB_DEFAULT_LAYOUT, BUILTINS, [], 'attention', true)).toBe(HOME_HUB_DEFAULT_LAYOUT);
    });

    it('reorders by one step and keeps ids it does not know in their place', () => {
        const stored = { ...HOME_HUB_DEFAULT_LAYOUT, order: ['usage', 'news-from-a-newer-app'], hidden: ['news-from-a-newer-app'] };
        expect(ids(stored)).toEqual(['usage', 'start', 'attention', 'setup', 'machines']);

        const moved = moveHomeHubSection(stored, BUILTINS, [], 'machines', -1);
        expect(ids(moved)).toEqual(['usage', 'start', 'attention', 'machines', 'setup']);
        expect(moved.order.indexOf('news-from-a-newer-app')).toBe(1);
        expect(moved.hidden).toContain('news-from-a-newer-app');

        // Already first: nothing to do.
        expect(moveHomeHubSection(moved, BUILTINS, [], 'usage', -1)).toBe(moved);
    });

    it('hides and shows a built-in section', () => {
        const hidden = setHomeHubSectionHidden(HOME_HUB_DEFAULT_LAYOUT, BUILTINS, [], 'machines', true);
        expect(resolveHomeHubLayout(hidden, BUILTINS, []).sections.find((section) => section.id === 'machines')?.hidden).toBe(true);
        const shown = setHomeHubSectionHidden(hidden, BUILTINS, [], 'machines', false);
        expect(resolveHomeHubLayout(shown, BUILTINS, []).sections.every((section) => !section.hidden)).toBe(true);
    });

    it('places a widget that declares itself shown after the built-in sections, and offers the others to add', () => {
        const resolved = resolveHomeHubLayout(HOME_HUB_DEFAULT_LAYOUT, BUILTINS, [AVAILABLE, SHOWN]);
        expect(resolved.sections.map((section) => section.id))
            .toEqual(['start', 'attention', 'setup', 'machines', 'usage', SHOWN_ID]);
        expect(resolved.sections.at(-1)).toMatchObject({ kind: 'widget', widget: SHOWN });
        expect(resolved.available).toEqual([AVAILABLE, SHOWN]);

        // A default-shown widget appears after a layout the person already arranged, too.
        expect(ids({ ...HOME_HUB_DEFAULT_LAYOUT, order: ['usage', 'start', 'attention', 'setup', 'machines'], hidden: [] }, [SHOWN]))
            .toEqual(['usage', 'start', 'attention', 'setup', 'machines', SHOWN_ID]);
    });

    it('adds an available widget at the end, and removing a widget returns it to Add widgets for good', () => {
        const added = applyHomeHubLayoutIntent(HOME_HUB_DEFAULT_LAYOUT, BUILTINS, [SHOWN, AVAILABLE], { kind: 'widget_add', instance: { v: 1, id: AVAILABLE_ID, definition: { kind: 'installed', surface: AVAILABLE.surface }, bindings: {} } });
        expect(ids(added, [SHOWN, AVAILABLE]))
            .toEqual(['start', 'attention', 'setup', 'machines', 'usage', SHOWN_ID, AVAILABLE_ID]);

        const removed = setHomeHubSectionHidden(added, BUILTINS, [SHOWN, AVAILABLE], SHOWN_ID, true);
        expect(ids(removed, [SHOWN, AVAILABLE])).not.toContain(SHOWN_ID);
        expect(resolveHomeHubLayout(removed, BUILTINS, [SHOWN, AVAILABLE]).available).toEqual([SHOWN, AVAILABLE]);
        // The next app launch re-reads the default; the recorded choice still wins.
        expect(ids({ ...HOME_HUB_DEFAULT_LAYOUT, order: [], hidden: removed.hidden }, [SHOWN])).not.toContain(SHOWN_ID);

        const readded = applyHomeHubLayoutIntent(removed, BUILTINS, [SHOWN, AVAILABLE], { kind: 'widget_add', instance: { v: 1, id: SHOWN_ID, definition: { kind: 'installed', surface: SHOWN.surface }, bindings: {} } });
        expect(ids(readded, [SHOWN, AVAILABLE])).toContain(SHOWN_ID);
    });

    it('keeps an uninstalled widget\'s place so it comes back where it was', () => {
        const arranged: HomeHubLayoutValue = { ...HOME_HUB_DEFAULT_LAYOUT, items: [{ kind: 'widget', instance: { v: 1, id: SHOWN_ID, definition: { kind: 'installed', surface: SHOWN.surface }, bindings: {} } }], order: ['start', SHOWN_ID, 'attention', 'setup', 'machines', 'usage'], hidden: [] };
        // The plugin is disabled: its widget draws nowhere and is not offered…
        const without = resolveHomeHubLayout(arranged, BUILTINS, []);
        expect(without.sections.map((section) => section.id)).toEqual(['start', SHOWN_ID, 'attention', 'setup', 'machines', 'usage']);
        expect(without.sections.find(section => section.id === SHOWN_ID)).toMatchObject({ instance: arranged.items[0]?.kind === 'widget' ? arranged.items[0].instance : undefined });
        // …and moving another section keeps the widget's id where it was.
        const moved = moveHomeHubSection(arranged, BUILTINS, [], 'usage', -1);
        expect(moved.order).toEqual(['start', SHOWN_ID, 'attention', 'setup', 'usage', 'machines']);
        expect(ids(moved, [SHOWN])).toEqual(['start', SHOWN_ID, 'attention', 'setup', 'usage', 'machines']);
    });

    it('moves a widget among the sections the person sees', () => {
        const moved = moveHomeHubSection(HOME_HUB_DEFAULT_LAYOUT, BUILTINS, [SHOWN, AVAILABLE], SHOWN_ID, -1);
        expect(ids(moved, [SHOWN, AVAILABLE]))
            .toEqual(['start', 'attention', 'setup', 'machines', SHOWN_ID, 'usage']);
        // An available widget the person never added is not written into the layout by a move.
        expect(moved.order).not.toContain(AVAILABLE_ID);
    });
});
