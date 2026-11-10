import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { InputPathSchema } from '../inputs/inputFields.js';
import { UiSurfaceNetworkRequestV1Schema } from '../plugins/contributions/ui/hostedHtmlCapabilitiesV1.js';
import { WidgetInstanceV1Schema, WidgetInputBindingsV1Schema, resetWidgetInputBindingsV1, setWidgetInputBindingsV1 } from './widgetInstanceV1.js';
import { WidgetGroupWidthV1Schema, WidgetGridSizeV1Schema, WidgetProjectAreaV1Schema, resolveWidgetGroupWidthFitV1 } from './widgetPresentationV1.js';

const id = z.string().check(z.trim(), z.minLength(1));
const index = z.number().check(z.int(), z.nonnegative(), z.int());
const frameStyle = z.enum(['card', 'plain']);
export const WidgetLayoutWidgetV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('widget'), instance: WidgetInstanceV1Schema,
  size: z.optional(WidgetGridSizeV1Schema), frameStyle: z.optional(frameStyle), area: z.optional(WidgetProjectAreaV1Schema),
}));
export type WidgetLayoutWidgetV1 = z.infer<typeof WidgetLayoutWidgetV1Schema>;
export const WidgetLayoutGroupV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('group'), id, children: z.array(WidgetLayoutWidgetV1Schema).check(z.minLength(1)),
  width: z._default(WidgetGroupWidthV1Schema, 'full'), title: z.optional(id),
  // Host preset copy is translated by the viewer; a rename retires this presentation marker.
  titleKey: z.optional(id),
  frameStyle: z._default(frameStyle, 'card'), dividers: z._default(z.enum(['hairline', 'none']), 'hairline'),
  context: z.optional(WidgetInputBindingsV1Schema), area: z.optional(WidgetProjectAreaV1Schema),
}));
export type WidgetLayoutGroupV1 = z.infer<typeof WidgetLayoutGroupV1Schema>;
export const WidgetLayoutItemV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [WidgetLayoutWidgetV1Schema, WidgetLayoutGroupV1Schema]));
export type WidgetLayoutItemV1 = z.infer<typeof WidgetLayoutItemV1Schema>;
export function getWidgetLayoutItemIdV1(item: WidgetLayoutItemV1): string { return item.kind === 'widget' ? item.instance.id : item.id; }
export function flattenWidgetLayoutWidgetsV1(items: readonly WidgetLayoutItemV1[]): WidgetLayoutWidgetV1[] {
  return items.flatMap(item => item.kind === 'widget' ? [item] : item.children);
}
export function findWidgetLayoutItemV1(items: readonly WidgetLayoutItemV1[], itemId: string): WidgetLayoutItemV1 | undefined {
  return items.find(item => getWidgetLayoutItemIdV1(item) === itemId) ?? flattenWidgetLayoutWidgetsV1(items).find(item => item.instance.id === itemId);
}
export function findWidgetLayoutParentV1(items: readonly WidgetLayoutItemV1[], itemId: string): WidgetLayoutGroupV1 | undefined {
  return items.find((item): item is WidgetLayoutGroupV1 => item.kind === 'group' && item.children.some(child => child.instance.id === itemId));
}
export const WidgetLayoutItemsV1Schema = lazyZodSchema(() => z.array(WidgetLayoutItemV1Schema).check(z.superRefine((items, ctx) => {
  const ids = new Set<string>();
  for (const item of items) {
    for (const itemId of item.kind === 'group' ? [item.id, ...item.children.map(child => child.instance.id)] : [item.instance.id]) {
      if (ids.has(itemId)) ctx.addIssue({ code: 'custom', message: 'Duplicate layout item identity' });
      ids.add(itemId);
    }
    if (item.kind === 'group' && !resolveWidgetGroupWidthFitV1(item.children).availableWidths.includes(item.width)) {
      ctx.addIssue({ code: 'custom', message: 'Group width cannot fit child' });
    }
  }
})));
export const WidgetLayoutItemsV1StoredSchema = createStoredReadSchema(WidgetLayoutItemsV1Schema);
export const WidgetLayoutItemIntentV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('group_create'), groupId: id, instanceIds: z.array(id).check(z.minLength(1)), width: z.optional(WidgetGroupWidthV1Schema), title: z.optional(id), context: z.optional(WidgetInputBindingsV1Schema) }),
  z.strictObject({ kind: z.literal('group_add'), group: WidgetLayoutGroupV1Schema, toIndex: z.optional(index) }),
  z.strictObject({ kind: z.literal('group_ungroup'), instanceId: id }),
  z.strictObject({ kind: z.literal('group_set'), instanceId: id, width: z.optional(WidgetGroupWidthV1Schema), dividers: z.optional(z.enum(['hairline', 'none'])) }),
  z.strictObject({ kind: z.literal('group_inputs'), instanceId: id, bindings: WidgetInputBindingsV1Schema }),
  z.strictObject({ kind: z.literal('add'), instance: WidgetInstanceV1Schema, groupId: z.optional(id), toIndex: z.optional(index), size: z.optional(WidgetGridSizeV1Schema), frameStyle: z.optional(frameStyle), area: z.optional(WidgetProjectAreaV1Schema) }),
  z.strictObject({ kind: z.literal('remove'), instanceId: id }),
  z.strictObject({ kind: z.literal('move'), instanceId: id, toIndex: index, groupId: z.optional(z.nullable(id)), area: z.optional(WidgetProjectAreaV1Schema) }),
  z.strictObject({ kind: z.literal('rename'), instanceId: id, displayName: z.nullable(id) }),
  z.strictObject({ kind: z.literal('size'), instanceId: id, size: WidgetGridSizeV1Schema }),
  z.strictObject({ kind: z.literal('width'), instanceId: id, width: WidgetGroupWidthV1Schema }),
  z.strictObject({ kind: z.literal('frame'), instanceId: id, frameStyle: z.nullable(frameStyle) }),
  z.strictObject({ kind: z.literal('inputs'), instanceId: id, bindings: WidgetInputBindingsV1Schema, paths: z.optional(z.array(InputPathSchema)) }),
  z.strictObject({ kind: z.literal('inputs_reset'), instanceId: id, paths: z.optional(z.array(InputPathSchema)) }),
  z.strictObject({ kind: z.literal('network'), instanceId: id, network: UiSurfaceNetworkRequestV1Schema }),
]));
export type WidgetLayoutItemIntentV1 = z.infer<typeof WidgetLayoutItemIntentV1Schema>;
export class WidgetLayoutMutationErrorV1 extends Error {
  constructor(readonly code: string, readonly blockingChildId?: string) { super(code); this.name = 'WidgetLayoutMutationErrorV1'; }
}
function assertFit(group: WidgetLayoutGroupV1) {
  const fit = resolveWidgetGroupWidthFitV1(group.children).widths.find(choice => choice.width === group.width)!;
  if (!fit.available) throw new WidgetLayoutMutationErrorV1('widget_group_width_no_fit', fit.blockingChildId);
}
/** One placement rule set; Home retains built-ins and areas retain Artifact custody. */
export function applyWidgetLayoutItemIntentV1(current: readonly WidgetLayoutItemV1[], raw: WidgetLayoutItemIntentV1): WidgetLayoutItemV1[] {
  const intent = WidgetLayoutItemIntentV1Schema.parse(raw);
  let items = [...current];
  const take = (itemId: string): WidgetLayoutItemV1 => {
    const at = items.findIndex(item => getWidgetLayoutItemIdV1(item) === itemId);
    if (at >= 0) return items.splice(at, 1)[0]!;
    const parent = findWidgetLayoutParentV1(items, itemId);
    if (!parent) throw new WidgetLayoutMutationErrorV1('widget_instance_not_found');
    const child = parent.children.find(item => item.instance.id === itemId)!;
    items = items.flatMap(item => item !== parent ? [item] : parent.children.length === 1 ? [] : [{ ...parent, children: parent.children.filter(item => item !== child) }]);
    // While grouped, the parent owns Project placement. Leaving must not restore
    // the child's stale pre-group area after the whole group has moved.
    return parent.area ? { ...child, area: parent.area } : child;
  };
  if (intent.kind === 'add') {
    const entry: WidgetLayoutWidgetV1 = { kind: 'widget', instance: intent.instance, ...(intent.size ? { size: intent.size } : {}), ...(intent.frameStyle ? { frameStyle: intent.frameStyle } : {}), ...(intent.area ? { area: intent.area } : {}) };
    if (intent.groupId) {
      const group = items.find((item): item is WidgetLayoutGroupV1 => item.kind === 'group' && item.id === intent.groupId);
      if (!group) throw new WidgetLayoutMutationErrorV1('widget_group_not_found');
      const children = [...group.children]; children.splice(intent.toIndex ?? children.length, 0, entry);
      const next = { ...group, children }; assertFit(next);
      items = items.map(item => item === group ? next : item);
    } else items.splice(intent.toIndex ?? items.length, 0, entry);
  } else if (intent.kind === 'group_add') {
    assertFit(intent.group);
    items.splice(intent.toIndex ?? items.length, 0, intent.group);
  } else if (intent.kind === 'group_create') {
    if (new Set(intent.instanceIds).size !== intent.instanceIds.length || findWidgetLayoutItemV1(items, intent.groupId)) throw new WidgetLayoutMutationErrorV1('widget_instance_already_exists');
    const at = items.findIndex(item => intent.instanceIds.includes(getWidgetLayoutItemIdV1(item)) || item.kind === 'group' && item.children.some(child => intent.instanceIds.includes(child.instance.id)));
    const children = intent.instanceIds.map(itemId => {
      const item = take(itemId);
      if (item.kind !== 'widget') throw new WidgetLayoutMutationErrorV1('widget_group_nesting_forbidden');
      return item;
    });
    const group = WidgetLayoutGroupV1Schema.parse({ kind: 'group', id: intent.groupId, children, width: intent.width ?? 'full', ...(intent.title ? { title: intent.title } : {}), ...(intent.context ? { context: intent.context } : {}), ...(children[0]?.area ? { area: children[0].area } : {}) });
    assertFit(group);
    items.splice(Math.max(0, at), 0, group);
  } else {
    const item = findWidgetLayoutItemV1(items, intent.instanceId);
    if (!item) throw new WidgetLayoutMutationErrorV1('widget_instance_not_found');
    if (intent.kind === 'remove') take(intent.instanceId);
    else if (intent.kind === 'move') {
      const parent = findWidgetLayoutParentV1(items, intent.instanceId);
      const groupId = intent.groupId === undefined ? parent?.id : intent.groupId;
      const moving = take(intent.instanceId);
      if (groupId) {
        if (moving.kind === 'group') throw new WidgetLayoutMutationErrorV1('widget_group_nesting_forbidden');
        const target = items.find(item => item.kind === 'group' && item.id === groupId);
        // Reordering the only child retains its existing parent instead of destroying it.
        if (!target && parent?.id === groupId) items.splice(current.findIndex(item => item === parent), 0, parent);
        const group = items.find((item): item is WidgetLayoutGroupV1 => item.kind === 'group' && item.id === groupId);
        if (!group) throw new WidgetLayoutMutationErrorV1('widget_group_not_found');
        const children = group.children.filter(child => child.instance.id !== intent.instanceId);
        children.splice(intent.toIndex, 0, moving);
        const next = { ...group, children }; assertFit(next);
        items = items.map(item => item === group ? next : item);
      } else items.splice(intent.toIndex, 0, { ...moving, ...(intent.area ? { area: intent.area } : {}) });
    } else if (intent.kind === 'group_ungroup') {
      if (item.kind !== 'group') throw new WidgetLayoutMutationErrorV1('widget_group_not_found');
      const at = items.indexOf(item); items.splice(at, 1, ...item.children.map(child => ({ ...child, ...(item.area ? { area: item.area } : {}) })));
    } else {
      let next: WidgetLayoutItemV1;
      if (item.kind === 'group') {
        switch (intent.kind) {
          case 'group_set': next = { ...item, ...(intent.width ? { width: intent.width } : {}), ...(intent.dividers ? { dividers: intent.dividers } : {}) }; break;
          case 'group_inputs': next = { ...item, context: intent.bindings }; break;
          case 'rename': { const { title: _old, titleKey: _preset, ...rest } = item; next = { ...rest, ...(intent.displayName ? { title: intent.displayName } : {}) }; break; }
          case 'width': next = { ...item, width: intent.width }; break;
          case 'frame': next = { ...item, frameStyle: intent.frameStyle ?? 'card' }; break;
          default: throw new WidgetLayoutMutationErrorV1('widget_group_operation_unsupported');
        }
        assertFit(next);
      } else {
        switch (intent.kind) {
          case 'rename': { const { displayName: _old, ...rest } = item.instance; next = { ...item, instance: { ...rest, ...(intent.displayName ? { displayName: intent.displayName } : {}) } }; break; }
          case 'size': next = { ...item, size: intent.size }; break;
          case 'frame': { const { frameStyle: _old, ...rest } = item; next = { ...rest, ...(intent.frameStyle ? { frameStyle: intent.frameStyle } : {}) }; break; }
          case 'inputs': next = { ...item, instance: { ...item.instance, bindings: setWidgetInputBindingsV1(item.instance.bindings, intent.bindings, intent.paths) } }; break;
          case 'inputs_reset': next = { ...item, instance: { ...item.instance, bindings: resetWidgetInputBindingsV1(item.instance.bindings, intent.paths) } }; break;
          case 'network': next = { ...item, instance: { ...item.instance, networkOverride: intent.network } }; break;
          default: throw new WidgetLayoutMutationErrorV1('widget_group_not_found');
        }
      }
      const parent = findWidgetLayoutParentV1(items, intent.instanceId);
      if (parent && next.kind === 'widget') {
        const updatedChild = next;
        const updated = { ...parent, children: parent.children.map(child => child === item ? updatedChild : child) }; assertFit(updated);
        items = items.map(item => item === parent ? updated : item);
      } else items = items.map(candidate => candidate === item ? next : candidate);
    }
  }
  if (!WidgetLayoutItemsV1Schema.safeParse(items).success) throw new WidgetLayoutMutationErrorV1('widget_instance_already_exists');
  return sameStrictJsonValue(items, current) ? current as WidgetLayoutItemV1[] : items;
}
