import { describe, expect, it } from 'vitest';
import { WidgetAreaLayoutV1Schema, applyWidgetAreaLayoutIntentV1 } from './widgetSurfaceArtifactV1.js';
import { resolveWidgetGroupWidthFitV1, type WidgetSizeV1 } from './widgetPresentationV1.js';
import type { WidgetAreaLayoutV1, WidgetAreaLayoutIntentV1 } from './widgetSurfaceArtifactV1.js';
import type { WidgetLayoutWidgetV1 } from './widgetLayoutItemV1.js';
import type { WidgetSurfaceRefV1 } from './widgetInstanceV1.js';
import { WidgetInstanceActionInputSchemasV1 } from './actionsV1.js';

const widget = (id: string, size: WidgetSizeV1 = 'small'): WidgetLayoutWidgetV1 => ({ kind: 'widget', instance: { v: 1, id, definition: { kind: 'builtin', id: 'session_summary' }, bindings: {} }, size });
const group = { kind: 'group', id: 'g', children: [widget('a'), widget('b')], width: 'half', frameStyle: 'card', dividers: 'hairline' };
const surface: WidgetSurfaceRefV1 = { serverId: 'home', accountId: 'account', owner: { kind: 'pluginArea', pluginId: 'example', pageId: 'page', area: 'main' } };

describe('widget layout items', () => {
  it('admits group Actions through strict instance refs only on group-capable surfaces', () => {
    const schema = WidgetInstanceActionInputSchemasV1['widgets.group.ungroup'];
    const input = { ref: { surface, instanceId: 'g' } };
    expect(schema.parse(input)).toEqual(input);
    expect(schema.safeParse({ ref: { ...input.ref, instanceId: '' } }).success).toBe(false);
    expect(schema.safeParse({ ref: { ...input.ref, unknownAuthority: true } }).success).toBe(false);
    expect(schema.safeParse({ ref: { ...input.ref, surface: {
      ...surface, owner: { kind: 'sessionBoard', sessionId: 'session' },
    } } }).success).toBe(false);
  });
  it('admits groups at the area owner and rejects duplicate identity across kinds and children', () => {
    expect(WidgetAreaLayoutV1Schema.safeParse({ v: 1, surface, items: [group, widget('c')] }).success).toBe(true);
    expect(WidgetAreaLayoutV1Schema.safeParse({ v: 1, surface, items: [group, widget('g')] }).success).toBe(false);
    expect(WidgetAreaLayoutV1Schema.safeParse({ v: 1, surface, items: [group, widget('a')] }).success).toBe(false);
    expect(WidgetAreaLayoutV1Schema.safeParse({ v: 1, surface, items: [{ ...group, children: [group] }] }).success).toBe(false);
  });
  it('offers both widths and names the first saved child that cannot fit', () => {
    expect(resolveWidgetGroupWidthFitV1([widget('a'), widget('wide', 'full')])).toEqual({
      widths: [{ width: 'half', available: false, blockingChildId: 'wide' }, { width: 'full', available: true }],
      availableWidths: ['full'],
    });
  });
  it('groups, reorders children, restores their saved frame, and dissolves an empty group', () => {
    const initial: WidgetAreaLayoutV1 = { v: 1, surface, items: [{ ...widget('a'), frameStyle: 'plain' }, widget('b'), widget('c')] };
    const apply = (layout: WidgetAreaLayoutV1, intent: WidgetAreaLayoutIntentV1) => applyWidgetAreaLayoutIntentV1(layout, intent);
    const grouped = apply(initial, { kind: 'group_create', groupId: 'g', instanceIds: ['a', 'b'] });
    expect(grouped.items[0]).toMatchObject({ kind: 'group', id: 'g', frameStyle: 'card', dividers: 'hairline', width: 'full', children: [{ instance: { id: 'a' } }, { instance: { id: 'b' } }] });
    const reordered = apply(grouped, { kind: 'move', instanceId: 'b', groupId: 'g', toIndex: 0 });
    const first = reordered.items[0];
    expect(first?.kind === 'group' ? first.children.map(entry => entry.instance.id) : null).toEqual(['b', 'a']);
    const out = apply(reordered, { kind: 'move', instanceId: 'a', groupId: null, toIndex: 1 });
    expect(out.items[1]).toMatchObject({ kind: 'widget', instance: { id: 'a' }, frameStyle: 'plain' });
    const dissolved = apply(out, { kind: 'remove', instanceId: 'b' });
    expect(dissolved.items.map(entry => entry.kind === 'widget' ? entry.instance.id : entry.id)).toEqual(['a', 'c']);
  });
  it('atomically adds a transferred child to its requested group and refuses widths that cannot fit', () => {
    const initial: WidgetAreaLayoutV1 = { v: 1, surface, items: [{ kind: 'group', id: 'g', children: [widget('a')], width: 'half', frameStyle: 'card', dividers: 'hairline' }] };
    const added = applyWidgetAreaLayoutIntentV1(initial, { kind: 'add', instance: widget('b').instance, size: 'tall', frameStyle: 'plain', groupId: 'g', toIndex: 0 });
    expect(added.items).toMatchObject([{ kind: 'group', children: [{ instance: { id: 'b' }, size: 'tall', frameStyle: 'plain' }, { instance: { id: 'a' } }] }]);
    expect(() => applyWidgetAreaLayoutIntentV1(initial, { kind: 'add', instance: widget('b').instance, size: 'full', groupId: 'g' })).toThrow('widget_group_width_no_fit');
    expect(initial.items).toHaveLength(1);
    expect(initial.items[0]).toMatchObject({ children: [{ instance: { id: 'a' } }] });
  });
  it('keeps the parent Project area when a child leaves a moved group', () => {
    const project: WidgetSurfaceRefV1 = { ...surface, owner: { kind: 'project', projectId: 'project' } };
    const initial: WidgetAreaLayoutV1 = { v: 1, surface: project, items: [{ ...widget('a'), area: 'main' }, { ...widget('b'), area: 'main' }] };
    const grouped = applyWidgetAreaLayoutIntentV1(initial, { kind: 'group_create', groupId: 'g', instanceIds: ['a', 'b'] });
    const moved = applyWidgetAreaLayoutIntentV1(grouped, { kind: 'move', instanceId: 'g', toIndex: 0, area: 'aside' });
    const out = applyWidgetAreaLayoutIntentV1(moved, { kind: 'move', instanceId: 'a', groupId: null, toIndex: 1 });
    expect(out.items.find(item => item.kind === 'widget' && item.instance.id === 'a')).toMatchObject({ area: 'aside' });
  });
});
