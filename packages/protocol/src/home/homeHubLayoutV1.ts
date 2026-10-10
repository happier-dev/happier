import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { AnchoredListPositionV1Schema, resolveAnchoredListMoveV1 } from '../actions/anchoredListOrderV1.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { WidgetInstanceV1Schema as InstanceSchema, WidgetInputBindingsV1Schema as BindingsSchema, type WidgetInstanceV1 } from '../widgets/widgetInstanceV1.js';
import { WidgetLayoutItemsV1Schema, WidgetLayoutItemIntentV1Schema, applyWidgetLayoutItemIntentV1, flattenWidgetLayoutWidgetsV1, findWidgetLayoutItemV1, getWidgetLayoutItemIdV1, WidgetLayoutMutationErrorV1, type WidgetLayoutItemV1, type WidgetLayoutWidgetV1, type WidgetLayoutGroupV1, type WidgetLayoutItemIntentV1 } from '../widgets/widgetLayoutItemV1.js';
import { InputPathSchema } from '../inputs/inputFields.js';
const WidgetInstanceV1Schema = z.lazy(() => InstanceSchema);
const WidgetInputBindingsV1Schema = z.lazy(() => BindingsSchema);
import { isSameWidgetDefinitionV1, widgetCandidateDefinitionV1, type WidgetCandidateIdentityV1 } from '../widgets/builtinWidgetDescriptorV1.js';
import { WidgetGridSizeV1Schema, WIDGET_SIZE_POLICY_V1, normalizeWidgetSizeForSurfaceV1, type WidgetSizeDeclarationV1, type WidgetSizeV1 } from '../widgets/widgetPresentationV1.js';

const id = z.string().min(1);
const sectionSchema = lazyZodSchema(() => z.object({ frameStyle: z.enum(['card', 'plain']).optional() }));
const layoutShape = {
    v: z.literal(1), order: z.array(id), hidden: z.array(id), items: WidgetLayoutItemsV1Schema,
    sections: z.record(id, sectionSchema.strict()).optional(),
};
export const HomeHubLayoutV1Schema = lazyZodSchema(() => z.object(layoutShape).strict());
const storedLayoutSchema = createStoredReadSchema(z.object({
    ...layoutShape,
    v: layoutShape.v.default(1),
    order: layoutShape.order.default([]),
    hidden: layoutShape.hidden.default([]),
    items: layoutShape.items.default([]),
    sections: z.record(id, sectionSchema).optional(),
}));
export type HomeHubLayoutValue = z.infer<typeof HomeHubLayoutV1Schema>;
export type HomeHubLayoutV1 = HomeHubLayoutValue;
const positionSchema = lazyZodSchema(() => z.union([AnchoredListPositionV1Schema, z.object({ nativeIndex: z.number().int().nonnegative() }).strict()]));
const homeIntentSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('move'), sectionId: id, step: z.union([z.literal(-1), z.literal(1)]) }).strict(),
    z.object({ kind: z.literal('move_to'), sectionId: id, position: positionSchema }).strict(),
    z.object({ kind: z.literal('reorder'), sectionIds: z.array(id) }).strict(),
    z.object({ kind: z.literal('visibility'), sectionId: id, hidden: z.boolean() }).strict(),
    z.object({ kind: z.literal('frameStyle'), sectionId: id, frameStyle: z.enum(['card', 'plain']).nullable() }).strict(),
    z.object({ kind: z.literal('setup_visibility'), stepId: z.string().trim().min(1), hidden: z.boolean() }).strict(),
    z.object({ kind: z.literal('restore_setup') }).strict(), z.object({ kind: z.literal('reset') }).strict(),
    z.object({ kind: z.literal('widget_add'), instance: WidgetInstanceV1Schema, position: positionSchema.optional(),
        size: WidgetGridSizeV1Schema.optional(), frameStyle: z.enum(['card', 'plain']).optional(), groupId: id.optional() }).strict(),
    z.object({ kind: z.literal('widget_remove'), instanceId: id, expectedInstance: WidgetInstanceV1Schema.optional(),
        expectedPresentation: z.object({ size: WidgetGridSizeV1Schema.optional(), frameStyle: z.enum(['card', 'plain']).nullable(),
            nativeIndex: z.number().int().nonnegative(), hidden: z.boolean().optional(), groupId: id.nullable().optional() }).strict().optional() }).strict(),
    z.object({ kind: z.literal('widget_rename'), instanceId: id, displayName: z.string().trim().min(1).optional() }).strict(),
    z.object({ kind: z.literal('widget_inputs'), instanceId: id, bindings: WidgetInputBindingsV1Schema, paths: z.array(InputPathSchema).optional() }).strict(),
    z.object({ kind: z.literal('widget_inputs_reset'), instanceId: id, paths: z.array(InputPathSchema).optional() }).strict(),
    z.object({ kind: z.literal('widget_size'), instanceId: id, size: WidgetGridSizeV1Schema }).strict(),
]));
export const HomeHubLayoutIntentSchema = lazyZodSchema(() => z.union([homeIntentSchema, WidgetLayoutItemIntentV1Schema]));
export type HomeHubLayoutIntent = z.infer<typeof HomeHubLayoutIntentSchema>;
export type HomeHubBuiltinDefinition = Readonly<{ id: string; hideable: boolean; defaultHidden?: boolean; afterWidgets?: boolean; card?: boolean }>;
/** The UI renderer table and daemon consume these same built-in layout rules. */
export const HOME_HUB_BUILTIN_DEFINITIONS: readonly HomeHubBuiltinDefinition[] = Object.freeze([
    { id: 'start', hideable: false }, { id: 'attention', hideable: false }, { id: 'setup', hideable: true },
    { id: 'automations', hideable: true, afterWidgets: true, card: true },
    { id: 'machines', hideable: true, afterWidgets: true, defaultHidden: true },
    { id: 'usage', hideable: true, afterWidgets: true },
]);
export type HomeHubWidgetInput = WidgetCandidateIdentityV1 & Readonly<{
    key: string; homeDefault: 'shown' | 'available'; sizeDeclaration?: WidgetSizeDeclarationV1;
}>;
export type HomeHubSection<W extends HomeHubWidgetInput = HomeHubWidgetInput> =
    | Readonly<{ kind: 'builtin'; id: string; hidden: boolean; hideable: boolean; frameStyle?: 'card' | 'plain' }>
    | HomeHubWidgetSection<W>
    | Readonly<{ kind: 'group'; id: string; group: WidgetLayoutGroupV1; children: readonly HomeHubWidgetSection<W>[]; hidden: false; hideable: true; frameStyle: 'card' | 'plain' }>;
export type HomeHubWidgetSection<W extends HomeHubWidgetInput = HomeHubWidgetInput> = Readonly<{ kind: 'widget'; id: string; instance: WidgetInstanceV1; widget?: W; hidden: false; hideable: true; size: WidgetSizeV1; frameStyle?: 'card' | 'plain' }>;
export type ResolvedHomeHubLayout<W extends HomeHubWidgetInput = HomeHubWidgetInput> = Readonly<{
    /** Owner-native order, including retained unresolved slots; sections are its renderable projection. */
    order: readonly string[];
    sections: readonly HomeHubSection<W>[];
    available: readonly W[];
}>;
export function isHomeHubCardSection(section: HomeHubSection): boolean {
    return section.kind !== 'builtin' || HOME_HUB_BUILTIN_DEFINITIONS.find(builtin => builtin.id === section.id)?.card === true;
}
export const HOME_HUB_DEFAULT_LAYOUT: HomeHubLayoutValue = { v: 1, order: [], hidden: [], items: [] };
/** Normalize stored personal layout content without persisting recovery defaults. */
export function normalizeHomeHubLayoutV1(value: unknown): HomeHubLayoutValue {
    const parsed = storedLayoutSchema.safeParse(value);
    return parsed.success ? parsed.data : HOME_HUB_DEFAULT_LAYOUT;
}
const SETUP_PREFIX = 'setup:';
/** Only defaults derive an identity from a declaration. Explicit copies have independent ids. */
export function homeHubDefaultWidgetInstanceId(key: string): string { return 'default:' + key; }
function items(layout: HomeHubLayoutValue, widgets: readonly HomeHubWidgetInput[]): WidgetLayoutItemV1[] {
    const projected = [...layout.items];
    const existing = new Set([...projected.map(getWidgetLayoutItemIdV1), ...flattenWidgetLayoutWidgetsV1(projected).map(item => item.instance.id)]);
    for (const widget of widgets) {
        const instanceId = homeHubDefaultWidgetInstanceId(widget.key);
        if (widget.homeDefault !== 'shown' || existing.has(instanceId) || layout.hidden.includes(instanceId)) continue;
        projected.push({ kind: 'widget', instance: { v: 1, id: instanceId, definition: widgetCandidateDefinitionV1(widget), bindings: {} } });
    }
    return projected;
}
function placedIds(layout: HomeHubLayoutValue, builtins: readonly HomeHubBuiltinDefinition[], projected: readonly WidgetLayoutItemV1[]): string[] {
    const childIds = new Set(projected.flatMap(item => item.kind === 'group' ? item.children.map(child => child.instance.id) : []));
    const stored = [...new Set(layout.order)].filter(id => !childIds.has(id));
    const missing = (section: HomeHubBuiltinDefinition) => !stored.includes(section.id);
    const placed = [...stored, ...builtins.filter(section => !section.afterWidgets && missing(section)).map(section => section.id)];
    const added = projected.map(getWidgetLayoutItemIdV1).filter(instanceId => !stored.includes(instanceId));
    const after = new Set(builtins.filter(section => section.afterWidgets).map(section => section.id));
    const end = placed.findIndex(sectionId => after.has(sectionId));
    if (end < 0) placed.push(...added); else placed.splice(end, 0, ...added);
    return [...placed, ...builtins.filter(section => section.afterWidgets && missing(section)).map(section => section.id)];
}
/** Loaded descriptor metadata refines presentation only; the saved personal intent remains unchanged. */
export function resolveHomeHubWidgetSizeV1(instance: WidgetInstanceV1, size: WidgetSizeV1 | undefined,
    declaration?: WidgetSizeDeclarationV1): WidgetSizeV1 {
    const declared = declaration ?? (instance.definition.kind === 'inline' ? instance.definition.definition.sizeDeclaration : undefined);
    return normalizeWidgetSizeForSurfaceV1('home', size, declared)!;
}
export function resolveHomeHubLayout<W extends HomeHubWidgetInput>(layout: HomeHubLayoutValue, builtins: readonly HomeHubBuiltinDefinition[], widgets: readonly W[]): ResolvedHomeHubLayout<W> {
    const projected = items(layout, widgets);
    const sectionById = new Map(builtins.map(section => [section.id, section]));
    const itemById = new Map(projected.map(item => [getWidgetLayoutItemIdV1(item), item]));
    const projectWidget = (item: WidgetLayoutWidgetV1, inGroup = false): HomeHubWidgetSection<W> => {
        const instance = item.instance;
        const widget = widgets.find(candidate => isSameWidgetDefinitionV1(widgetCandidateDefinitionV1(candidate), instance.definition));
        return { kind: 'widget', id: instance.id, instance, ...(widget ? { widget } : {}), hidden: false, hideable: true,
            size: resolveHomeHubWidgetSizeV1(instance, item.size, widget?.sizeDeclaration), ...(inGroup ? { frameStyle: 'plain' } as const : item.frameStyle ? { frameStyle: item.frameStyle } : {}) };
    };
    const sections: HomeHubSection<W>[] = [];
    const order = placedIds(layout, builtins, projected);
    for (const sectionId of order) {
        const frameStyle = layout.sections?.[sectionId]?.frameStyle;
        const frame = frameStyle ? { frameStyle } : {};
        const builtin = sectionById.get(sectionId);
        if (builtin) {
            const hidden = builtin.hideable && (layout.hidden.includes(sectionId) || (builtin.defaultHidden === true && !layout.order.includes(sectionId)));
            sections.push({ kind: 'builtin', id: sectionId, hidden, hideable: builtin.hideable, ...frame });
            continue;
        }
        const item = itemById.get(sectionId);
        if (!item || layout.hidden.includes(sectionId)) continue;
        if (item.kind === 'widget') sections.push(projectWidget(item));
        else {
            const children = item.children.map(child => projectWidget(child, true));
            sections.push({ kind: 'group', id: item.id, group: { ...item, children: item.children.map((child, index) => ({ ...child, size: children[index]!.size })) },
                children, hidden: false, hideable: true, frameStyle: item.frameStyle });
        }
    }
    return { order, sections, available: widgets };
}
function materialize(layout: HomeHubLayoutValue, builtins: readonly HomeHubBuiltinDefinition[], widgets: readonly HomeHubWidgetInput[]): HomeHubLayoutValue {
    const projected = items(layout, widgets);
    const order = placedIds(layout, builtins, projected);
    projected.sort((left, right) => order.indexOf(getWidgetLayoutItemIdV1(left)) - order.indexOf(getWidgetLayoutItemIdV1(right)));
    const stillOff = builtins.filter(section => section.hideable && section.defaultHidden && !layout.order.includes(section.id) && !layout.hidden.includes(section.id)).map(section => section.id);
    return { ...layout, items: projected, order, hidden: [...layout.hidden, ...stillOff] };
}
export type HomeHubWidgetPresentationV1 = Readonly<{
    size: WidgetSizeV1; frameStyle: 'card' | 'plain' | null; nativeIndex: number; hidden: boolean; groupId?: string | null;
}>;
function captureMaterializedWidgetPresentation(layout: HomeHubLayoutValue, instanceId: string): HomeHubWidgetPresentationV1 {
    const item = findWidgetLayoutItemV1(layout.items, instanceId);
    if (!item || item.kind !== 'widget') throw new HomeHubMutationErrorV1('widget_instance_not_found');
    const group = layout.items.find(item => item.kind === 'group' && item.children.some(child => child.instance.id === instanceId));
    return { size: item.size ?? WIDGET_SIZE_POLICY_V1.home.defaultSize, frameStyle: item.frameStyle ?? null,
        nativeIndex: group?.kind === 'group' ? group.children.findIndex(child => child.instance.id === instanceId) : layout.order.indexOf(instanceId),
        hidden: layout.hidden.includes(instanceId), groupId: group ? getWidgetLayoutItemIdV1(group) : null };
}
/** Captures native placement without persisting projected defaults or dropping unresolved order slots. */
export function captureHomeHubWidgetPresentationV1(layout: HomeHubLayoutValue, builtins: readonly HomeHubBuiltinDefinition[], widgets: readonly HomeHubWidgetInput[], instanceId: string): HomeHubWidgetPresentationV1 {
    return captureMaterializedWidgetPresentation(materialize(layout, builtins, widgets), instanceId);
}
function sameIds(left: readonly string[], right: readonly string[]) { return left.length === right.length && left.every((id, index) => id === right[index]); }
export function reorderHomeHubSections(layout: HomeHubLayoutValue, builtins: readonly HomeHubBuiltinDefinition[], widgets: readonly HomeHubWidgetInput[], orderedIds: readonly string[]): HomeHubLayoutValue {
    const visible = resolveHomeHubLayout(layout, builtins, widgets).sections.map(section => section.id);
    if (orderedIds.length !== visible.length || new Set(orderedIds).size !== visible.length || !visible.every(sectionId => orderedIds.includes(sectionId))) throw new HomeHubMutationErrorV1('home_hub_order_incomplete');
    if (sameIds(visible, orderedIds)) return layout;
    const base = materialize(layout, builtins, widgets); const slots = new Set(visible); let next = 0;
    return { ...base, order: base.order.map(sectionId => slots.has(sectionId) ? orderedIds[next++]! : sectionId) };
}
export function moveHomeHubSection(layout: HomeHubLayoutValue, builtins: readonly HomeHubBuiltinDefinition[], widgets: readonly HomeHubWidgetInput[], sectionId: string, step: -1 | 1): HomeHubLayoutValue {
    const visible = resolveHomeHubLayout(layout, builtins, widgets).sections.map(section => section.id);
    const from = visible.indexOf(sectionId); const neighbour = visible[from + step];
    if (from < 0) throw new HomeHubMutationErrorV1('home_hub_section_not_found');
    if (neighbour === undefined) return layout;
    visible[from] = neighbour; visible[from + step] = sectionId;
    return reorderHomeHubSections(layout, builtins, widgets, visible);
}
export function setHomeHubSectionHidden(layout: HomeHubLayoutValue, builtins: readonly HomeHubBuiltinDefinition[], widgets: readonly HomeHubWidgetInput[], sectionId: string, hidden: boolean): HomeHubLayoutValue {
    const section = resolveHomeHubLayout(layout, builtins, widgets).sections.find(section => section.id === sectionId);
    if (!section) throw new HomeHubMutationErrorV1('home_hub_section_not_found');
    if (!section.hideable || section.hidden === hidden) return layout;
    if (section.kind !== 'builtin' && hidden) return applyHomeHubLayoutIntent(layout, builtins, widgets, { kind: 'remove', instanceId: sectionId });
    const base = materialize(layout, builtins, widgets);
    return { ...base, hidden: hidden ? [...base.hidden, sectionId] : base.hidden.filter(id => id !== sectionId) };
}
export function listHiddenHomeSetupSteps(layout: HomeHubLayoutValue): string[] { return layout.hidden.filter(id => id.startsWith(SETUP_PREFIX)).map(id => id.slice(SETUP_PREFIX.length)); }
export function setHomeSetupStepHidden(layout: HomeHubLayoutValue, stepId: string, hidden: boolean): HomeHubLayoutValue {
    const id = SETUP_PREFIX + stepId;
    if (layout.hidden.includes(id) === hidden) return layout;
    return { ...layout, hidden: hidden ? [...layout.hidden, id] : layout.hidden.filter(candidate => candidate !== id) };
}
export function showAllHomeSetupSteps(layout: HomeHubLayoutValue): HomeHubLayoutValue {
    const hidden = layout.hidden.filter(id => !id.startsWith(SETUP_PREFIX));
    return hidden.length === layout.hidden.length ? layout : { ...layout, hidden };
}
export function setHomeHubSectionFrameStyle(layout: HomeHubLayoutValue, builtins: readonly HomeHubBuiltinDefinition[], widgets: readonly HomeHubWidgetInput[], sectionId: string, frameStyle: 'card' | 'plain' | null): HomeHubLayoutValue {
    const item = findWidgetLayoutItemV1(items(layout, widgets), sectionId);
    if (item) return applyItemIntent(layout, builtins, widgets, { kind: 'frame', instanceId: sectionId, frameStyle });
    if (!builtins.some(section => section.id === sectionId)) throw new HomeHubMutationErrorV1('home_hub_section_not_found');
    if (layout.sections?.[sectionId]?.frameStyle === (frameStyle ?? undefined)) return layout;
    const base = materialize(layout, builtins, widgets); const sections = { ...base.sections };
    const { frameStyle: _old, ...other } = sections[sectionId] ?? {};
    if (frameStyle) sections[sectionId] = { ...other, frameStyle };
    else if (Object.keys(other).length) sections[sectionId] = other; else delete sections[sectionId];
    const { sections: _previous, ...rest } = base;
    return Object.keys(sections).length ? { ...rest, sections } : rest;
}
export class HomeHubMutationErrorV1 extends Error {
    constructor(readonly code: string) { super(code); this.name = 'HomeHubMutationErrorV1'; }
}
function applyItemIntent(layout: HomeHubLayoutValue, builtins: readonly HomeHubBuiltinDefinition[], widgets: readonly HomeHubWidgetInput[], intent: WidgetLayoutItemIntentV1): HomeHubLayoutValue {
    const base = materialize(layout, builtins, widgets);
    const normalizeChild = (child: WidgetLayoutWidgetV1): WidgetLayoutWidgetV1 => {
        const candidate = widgets.find(widget => isSameWidgetDefinitionV1(widgetCandidateDefinitionV1(widget), child.instance.definition));
        const size = resolveHomeHubWidgetSizeV1(child.instance, child.size, candidate?.sizeDeclaration);
        return size === child.size ? child : { ...child, size };
    };
    const affectedIds = new Set(intent.kind === 'group_create' ? intent.instanceIds
        : intent.kind === 'move' && intent.groupId ? [intent.instanceId, intent.groupId]
        : intent.kind === 'add' && intent.groupId ? [intent.groupId]
        : intent.kind === 'width' || intent.kind === 'group_set' && intent.width ? [intent.instanceId] : []);
    const reducerItems = affectedIds.size ? base.items.map(item => {
        if (item.kind === 'widget') return affectedIds.has(item.instance.id) ? normalizeChild(item) : item;
        const children = item.children.map(child => affectedIds.has(item.id) || affectedIds.has(child.instance.id) ? normalizeChild(child) : child);
        return children.every((child, index) => child === item.children[index]) ? item : { ...item, children };
    }) : base.items;
    const normalizedIntent = intent.kind === 'group_add' ? { ...intent, group: { ...intent.group, children: intent.group.children.map(normalizeChild) } }
        : intent.kind === 'add' && intent.groupId ? { ...intent, size: normalizeChild({ kind: 'widget', instance: intent.instance, ...(intent.size ? { size: intent.size } : {}) }).size } : intent;
    if (intent.kind === 'group_create' && builtins.some(builtin => builtin.id === intent.groupId)
        || intent.kind === 'group_add' && builtins.some(builtin => builtin.id === intent.group.id || intent.group.children.some(child => child.instance.id === builtin.id))
        || intent.kind === 'add' && builtins.some(builtin => builtin.id === intent.instance.id)) throw new HomeHubMutationErrorV1('widget_instance_exists');
    let nextItems: WidgetLayoutItemV1[];
    try { nextItems = applyWidgetLayoutItemIntentV1(reducerItems, normalizedIntent); }
    catch (error) { if (error instanceof WidgetLayoutMutationErrorV1) throw new HomeHubMutationErrorV1(error.code === 'widget_instance_already_exists' ? 'widget_instance_exists' : error.code); throw error; }
    if (sameStrictJsonValue(nextItems, base.items)) return layout;
    const beforeIds = base.items.map(getWidgetLayoutItemIdV1);
    const afterIds = nextItems.map(getWidgetLayoutItemIdV1);
    const removed = new Set(beforeIds.filter(id => !afterIds.includes(id)));
    let order = base.order.filter(id => !removed.has(id));
    if (intent.kind === 'group_create') {
        const first = Math.min(...intent.instanceIds.map(id => base.order.indexOf(id)).filter(index => index >= 0));
        const index = Number.isFinite(first) ? base.order.slice(0, first).filter(id => !removed.has(id)).length : order.length;
        order.splice(index, 0, intent.groupId);
    } else if (intent.kind === 'group_ungroup') {
        const group = base.items.find(item => item.kind === 'group' && item.id === intent.instanceId);
        if (group?.kind === 'group') {
            const index = base.order.indexOf(group.id);
            order.splice(index < 0 ? order.length : index, 0, ...group.children.map(child => child.instance.id));
        }
    } else {
        for (const id of afterIds.filter(id => !beforeIds.includes(id))) {
            const dissolvedParent = base.items.find(item => item.kind === 'group' && removed.has(item.id) && item.children.some(child => child.instance.id === id));
            if (dissolvedParent?.kind === 'group') {
                const slot = base.order.indexOf(dissolvedParent.id);
                order.splice(slot < 0 ? order.length : base.order.slice(0, slot).filter(id => !removed.has(id)).length, 0, id);
                continue;
            }
            const index = afterIds.indexOf(id);
            const previous = afterIds[index - 1];
            const anchor = previous ? order.indexOf(previous) : -1;
            order.splice(anchor < 0 ? order.length : anchor + 1, 0, id);
        }
    }
    if (intent.kind === 'move' && intent.groupId === null) {
        const previousSlot = order.indexOf(intent.instanceId);
        order = order.filter(id => id !== intent.instanceId);
        const destination = afterIds[intent.toIndex + 1];
        const anchor = destination ? order.indexOf(destination) : -1;
        const previousId = afterIds[intent.toIndex - 1];
        const previous = previousId ? order.indexOf(previousId) : -1;
        order.splice(anchor >= 0 ? anchor : previous >= 0 ? previous + 1 : previousSlot >= 0 ? previousSlot : order.length, 0, intent.instanceId);
    }
    if (intent.kind === 'move' || intent.kind === 'group_add' || intent.kind === 'add') {
        const slots = new Set(afterIds); let index = 0;
        order = order.map(id => slots.has(id) ? afterIds[index++]! : id);
    }
    const removedWidgets = flattenWidgetLayoutWidgetsV1(base.items).filter(item => !findWidgetLayoutItemV1(nextItems, item.instance.id));
    const hidden = [...base.hidden.filter(id => !afterIds.includes(id)), ...removedWidgets.map(item => item.instance.id).filter(id => id.startsWith('default:') && !base.hidden.includes(id))];
    return { ...base, items: nextItems, order: [...new Set(order)], hidden };
}
export function applyHomeHubLayoutIntent(layout: HomeHubLayoutValue, builtins: readonly HomeHubBuiltinDefinition[], widgets: readonly HomeHubWidgetInput[], intent: HomeHubLayoutIntent): HomeHubLayoutValue {
    const itemIntent = WidgetLayoutItemIntentV1Schema.safeParse(intent);
    if (itemIntent.success) return applyItemIntent(layout, builtins, widgets, itemIntent.data);
    switch (intent.kind) {
        case 'move': return 'sectionId' in intent ? moveHomeHubSection(layout, builtins, widgets, intent.sectionId, intent.step) : layout;
        case 'move_to': {
            if ('nativeIndex' in intent.position) {
                let base = materialize(layout, builtins, widgets);
                const grouped = base.items.some(item => item.kind === 'group' && item.children.some(child => child.instance.id === intent.sectionId));
                if (grouped) {
                    base = applyItemIntent(base, builtins, widgets, { kind: 'move', instanceId: intent.sectionId, groupId: null, toIndex: 0 });
                }
                if (!builtins.some(section => section.id === intent.sectionId) && !base.items.some(item => getWidgetLayoutItemIdV1(item) === intent.sectionId)) {
                    throw new HomeHubMutationErrorV1('home_hub_section_not_found');
                }
                const order = base.order.filter(sectionId => sectionId !== intent.sectionId);
                order.splice(intent.position.nativeIndex, 0, intent.sectionId);
                return !grouped && sameIds(base.order, order) ? layout : { ...base, order };
            }
            const ids = resolveHomeHubLayout(layout, builtins, widgets).sections.map(section => section.id);
            if (!ids.includes(intent.sectionId)) throw new HomeHubMutationErrorV1('home_hub_section_not_found');
            const order = resolveAnchoredListMoveV1(ids, intent.sectionId, intent.position);
            if (!order) throw new HomeHubMutationErrorV1('home_hub_anchor_not_found');
            return reorderHomeHubSections(layout, builtins, widgets, order);
        }
        case 'reorder': return reorderHomeHubSections(layout, builtins, widgets, intent.sectionIds);
        case 'visibility': return setHomeHubSectionHidden(layout, builtins, widgets, intent.sectionId, intent.hidden);
        case 'frameStyle': return setHomeHubSectionFrameStyle(layout, builtins, widgets, intent.sectionId, intent.frameStyle);
        case 'setup_visibility': {
            const next = setHomeSetupStepHidden(layout, intent.stepId, intent.hidden);
            return next === layout ? layout : materialize(next, builtins, widgets);
        }
        case 'restore_setup': {
            const next = showAllHomeSetupSteps(layout);
            return next === layout ? layout : materialize(next, builtins, widgets);
        }
        case 'reset': return layout.order.length || layout.hidden.length || layout.items.length || layout.sections ? HOME_HUB_DEFAULT_LAYOUT : layout;
        case 'widget_add': {
            const base = materialize(layout, builtins, widgets);
            const presentation = {
                ...(intent.size ? { size: intent.size } : {}),
                ...(intent.frameStyle ? { frameStyle: intent.frameStyle } : {}),
            };
            if (intent.groupId) {
                const group = base.items.find(item => item.kind === 'group' && item.id === intent.groupId);
                if (group?.kind !== 'group') throw new HomeHubMutationErrorV1('widget_group_not_found');
                let toIndex: number | undefined;
                const position = intent.position;
                if (position) {
                    if ('nativeIndex' in position) toIndex = position.nativeIndex;
                    else if (position.anchorId === null) toIndex = position.placement === 'before' ? 0 : group.children.length;
                    else {
                        const anchor = group.children.findIndex(child => child.instance.id === position.anchorId);
                        if (anchor < 0) throw new HomeHubMutationErrorV1('home_hub_anchor_not_found');
                        toIndex = anchor + (position.placement === 'after' ? 1 : 0);
                    }
                }
                return applyItemIntent(layout, builtins, widgets, { kind: 'add', instance: intent.instance, groupId: intent.groupId, ...presentation, ...(toIndex === undefined ? {} : { toIndex }) });
            }
            const added = applyItemIntent(layout, builtins, widgets, { kind: 'add', instance: intent.instance, ...presentation });
            const next = { ...added, order: [...added.order.filter(id => id !== intent.instance.id), intent.instance.id] };
            return intent.position ? applyHomeHubLayoutIntent(next, builtins, widgets, { kind: 'move_to', sectionId: intent.instance.id, position: intent.position }) : next;
        }
        case 'widget_remove': case 'widget_size': case 'widget_inputs': case 'widget_inputs_reset': case 'widget_rename': {
            const base = materialize(layout, builtins, widgets);
            const item = findWidgetLayoutItemV1(base.items, intent.instanceId);
            if (!item || item.kind !== 'widget') throw new HomeHubMutationErrorV1('widget_instance_not_found');
            const instance = item.instance;
            if (intent.kind === 'widget_remove') {
                if (intent.expectedInstance && !sameStrictJsonValue(instance, intent.expectedInstance)) {
                    throw new HomeHubMutationErrorV1('widget_instance_changed');
                }
                const expected = intent.expectedPresentation;
                const presentation = captureMaterializedWidgetPresentation(base, instance.id);
                if (expected && (
                    (expected.size !== undefined && expected.size !== presentation.size)
                    || expected.frameStyle !== presentation.frameStyle
                    || expected.nativeIndex !== presentation.nativeIndex
                    || (expected.hidden !== undefined && expected.hidden !== presentation.hidden)
                    || (expected.groupId !== undefined && expected.groupId !== presentation.groupId)
                )) {
                    throw new HomeHubMutationErrorV1('widget_placement_changed');
                }
                return applyItemIntent(layout, builtins, widgets, { kind: 'remove', instanceId: instance.id });
            }
            if (intent.kind === 'widget_size') {
                return applyItemIntent(layout, builtins, widgets, { kind: 'size', instanceId: instance.id, size: intent.size });
            }
            if (intent.kind === 'widget_inputs') return applyItemIntent(layout, builtins, widgets, { kind: 'inputs', instanceId: instance.id, bindings: intent.bindings, ...(intent.paths ? { paths: intent.paths } : {}) });
            if (intent.kind === 'widget_inputs_reset') return applyItemIntent(layout, builtins, widgets, { kind: 'inputs_reset', instanceId: instance.id, ...(intent.paths ? { paths: intent.paths } : {}) });
            return applyItemIntent(layout, builtins, widgets, { kind: 'rename', instanceId: instance.id, displayName: intent.displayName ?? null });
        }
        default: return layout;
    }
}
export function buildHomeHubLayoutResult(layout: HomeHubLayoutValue, builtins: readonly HomeHubBuiltinDefinition[], widgets: readonly HomeHubWidgetInput[]) {
    const resolved = resolveHomeHubLayout(layout, builtins, widgets);
    return { layout, sections: resolved.sections.map(section => {
        if (section.kind === 'builtin') return section;
        if (section.kind === 'group') return { ...section, children: section.children.map(({ widget: _widget, ...child }) => child) };
        const { widget: _widget, ...value } = section; return value;
    }), availableWidgetIds: widgets.map(widget => widget.key), hiddenSetupStepIds: listHiddenHomeSetupSteps(layout) };
}
