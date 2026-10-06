import { z } from 'zod';
import { AnchoredListPositionV1Schema, resolveAnchoredListMoveV1 } from '../actions/anchoredListOrderV1.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { WidgetInstanceV1Schema as InstanceSchema, WidgetInputBindingsV1Schema as BindingsSchema, type WidgetInstanceV1 } from '../widgets/widgetInstanceV1.js';
const WidgetInstanceV1Schema = z.lazy(() => InstanceSchema);
const WidgetInputBindingsV1Schema = z.lazy(() => BindingsSchema);
import { isSameWidgetDefinitionV1, widgetCandidateDefinitionV1, type WidgetCandidateIdentityV1 } from '../widgets/builtinWidgetDescriptorV1.js';

const id = z.string().min(1);
const sectionSchema = z.object({ frameStyle: z.enum(['card', 'plain']).optional(), width: z.enum(['half', 'full']).optional() });
const layoutShape = {
    v: z.literal(1), order: z.array(id), hidden: z.array(id), instances: z.array(WidgetInstanceV1Schema),
    sections: z.record(id, sectionSchema.strict()).optional(),
};
function validateInstances(layout: Readonly<{ instances: readonly WidgetInstanceV1[] }>, ctx: z.RefinementCtx) {
    if (new Set(layout.instances.map(instance => instance.id)).size !== layout.instances.length) {
        ctx.addIssue({ code: 'custom', path: ['instances'], message: 'Duplicate widget instance identity' });
    }
}
export const HomeHubLayoutV1Schema = z.object(layoutShape).strict().superRefine(validateInstances);
const storedLayoutSchema = createStoredReadSchema(z.object({
    ...layoutShape,
    v: layoutShape.v.default(1),
    order: layoutShape.order.default([]),
    hidden: layoutShape.hidden.default([]),
    instances: layoutShape.instances.default([]),
    sections: z.record(id, sectionSchema).optional(),
}).superRefine(validateInstances));
export type HomeHubLayoutValue = z.infer<typeof HomeHubLayoutV1Schema>;
export type HomeHubLayoutV1 = HomeHubLayoutValue;
const positionSchema = z.union([AnchoredListPositionV1Schema, z.object({ nativeIndex: z.number().int().nonnegative() }).strict()]);
export const HomeHubLayoutIntentSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('move'), sectionId: id, step: z.union([z.literal(-1), z.literal(1)]) }).strict(),
    z.object({ kind: z.literal('move_to'), sectionId: id, position: positionSchema }).strict(),
    z.object({ kind: z.literal('reorder'), sectionIds: z.array(id) }).strict(),
    z.object({ kind: z.literal('visibility'), sectionId: id, hidden: z.boolean() }).strict(),
    z.object({ kind: z.literal('frameStyle'), sectionId: id, frameStyle: z.enum(['card', 'plain']).nullable() }).strict(),
    z.object({ kind: z.literal('setup_visibility'), stepId: z.string().trim().min(1), hidden: z.boolean() }).strict(),
    z.object({ kind: z.literal('restore_setup') }).strict(), z.object({ kind: z.literal('reset') }).strict(),
    z.object({ kind: z.literal('widget_add'), instance: WidgetInstanceV1Schema, position: positionSchema.optional(),
        width: z.enum(['half', 'full']).optional(), frameStyle: z.enum(['card', 'plain']).optional() }).strict(),
    z.object({ kind: z.literal('widget_remove'), instanceId: id, expectedInstance: WidgetInstanceV1Schema.optional(),
        expectedPresentation: z.object({ width: z.enum(['half', 'full']).optional(), frameStyle: z.enum(['card', 'plain']).nullable(),
            nativeIndex: z.number().int().nonnegative(), hidden: z.boolean().optional() }).strict().optional() }).strict(),
    z.object({ kind: z.literal('widget_rename'), instanceId: id, displayName: z.string().trim().min(1).optional() }).strict(),
    z.object({ kind: z.literal('widget_inputs'), instanceId: id, bindings: WidgetInputBindingsV1Schema }).strict(),
    z.object({ kind: z.literal('widget_width'), instanceId: id, width: z.enum(['half', 'full']) }).strict(),
]);
export type HomeHubLayoutIntent = z.infer<typeof HomeHubLayoutIntentSchema>;
export type HomeHubBuiltinDefinition = Readonly<{ id: string; hideable: boolean; defaultHidden?: boolean; afterWidgets?: boolean; card?: boolean }>;
/** The UI renderer table and daemon consume these same built-in layout rules. */
export const HOME_HUB_BUILTIN_DEFINITIONS: readonly HomeHubBuiltinDefinition[] = Object.freeze([
    { id: 'start', hideable: false }, { id: 'attention', hideable: false }, { id: 'setup', hideable: true },
    { id: 'automations', hideable: true, afterWidgets: true, card: true },
    { id: 'machines', hideable: true, afterWidgets: true, defaultHidden: true },
    { id: 'usage', hideable: true, afterWidgets: true },
]);
export type HomeHubWidgetInput = WidgetCandidateIdentityV1 & Readonly<{ key: string; homeDefault: 'shown' | 'available' }>;
export type HomeHubSection<W extends HomeHubWidgetInput = HomeHubWidgetInput> =
    | Readonly<{ kind: 'builtin'; id: string; hidden: boolean; hideable: boolean; frameStyle?: 'card' | 'plain' }>
    | Readonly<{ kind: 'widget'; id: string; instance: WidgetInstanceV1; widget?: W; hidden: false; hideable: true; width: 'half' | 'full'; frameStyle?: 'card' | 'plain' }>;
export type ResolvedHomeHubLayout<W extends HomeHubWidgetInput = HomeHubWidgetInput> = Readonly<{ sections: readonly HomeHubSection<W>[]; available: readonly W[] }>;
export function isHomeHubCardSection(section: HomeHubSection): boolean {
    return section.kind === 'widget' || HOME_HUB_BUILTIN_DEFINITIONS.find(builtin => builtin.id === section.id)?.card === true;
}
export const HOME_HUB_DEFAULT_LAYOUT: HomeHubLayoutValue = { v: 1, order: [], hidden: [], instances: [] };
/** Normalize stored personal layout content without persisting recovery defaults. */
export function normalizeHomeHubLayoutV1(value: unknown): HomeHubLayoutValue {
    const parsed = storedLayoutSchema.safeParse(value);
    return parsed.success ? parsed.data : HOME_HUB_DEFAULT_LAYOUT;
}
const SETUP_PREFIX = 'setup:';
/** Only defaults derive an identity from a declaration. Explicit copies have independent ids. */
export function homeHubDefaultWidgetInstanceId(key: string): string { return 'default:' + key; }
function instances(layout: HomeHubLayoutValue, widgets: readonly HomeHubWidgetInput[]): WidgetInstanceV1[] {
    const projected = [...layout.instances];
    for (const widget of widgets) {
        const instanceId = homeHubDefaultWidgetInstanceId(widget.key);
        if (widget.homeDefault !== 'shown' || projected.some(instance => instance.id === instanceId) || layout.hidden.includes(instanceId)) continue;
        projected.push({ v: 1, id: instanceId, definition: widgetCandidateDefinitionV1(widget), bindings: {} });
    }
    return projected;
}
function placedIds(layout: HomeHubLayoutValue, builtins: readonly HomeHubBuiltinDefinition[], projected: readonly WidgetInstanceV1[]): string[] {
    const stored = [...new Set(layout.order)];
    const missing = (section: HomeHubBuiltinDefinition) => !stored.includes(section.id);
    const placed = [...stored, ...builtins.filter(section => !section.afterWidgets && missing(section)).map(section => section.id)];
    const added = projected.map(instance => instance.id).filter(instanceId => !stored.includes(instanceId));
    const after = new Set(builtins.filter(section => section.afterWidgets).map(section => section.id));
    const end = placed.findIndex(sectionId => after.has(sectionId));
    if (end < 0) placed.push(...added); else placed.splice(end, 0, ...added);
    return [...placed, ...builtins.filter(section => section.afterWidgets && missing(section)).map(section => section.id)];
}
export function resolveHomeHubLayout<W extends HomeHubWidgetInput>(layout: HomeHubLayoutValue, builtins: readonly HomeHubBuiltinDefinition[], widgets: readonly W[]): ResolvedHomeHubLayout<W> {
    const projected = instances(layout, widgets);
    const sectionById = new Map(builtins.map(section => [section.id, section]));
    const instanceById = new Map(projected.map(instance => [instance.id, instance]));
    const sections: HomeHubSection<W>[] = [];
    for (const sectionId of placedIds(layout, builtins, projected)) {
        const frameStyle = layout.sections?.[sectionId]?.frameStyle;
        const frame = frameStyle ? { frameStyle } : {};
        const builtin = sectionById.get(sectionId);
        if (builtin) {
            const hidden = builtin.hideable && (layout.hidden.includes(sectionId) || (builtin.defaultHidden === true && !layout.order.includes(sectionId)));
            sections.push({ kind: 'builtin', id: sectionId, hidden, hideable: builtin.hideable, ...frame });
            continue;
        }
        const instance = instanceById.get(sectionId);
        if (!instance || layout.hidden.includes(sectionId)) continue;
        const definition = instance.definition;
        const widget = widgets.find(candidate => isSameWidgetDefinitionV1(widgetCandidateDefinitionV1(candidate), definition));
        sections.push({ kind: 'widget', id: sectionId, instance, ...(widget ? { widget } : {}), hidden: false, hideable: true, width: layout.sections?.[sectionId]?.width ?? 'half', ...frame });
    }
    return { sections, available: widgets };
}
function materialize(layout: HomeHubLayoutValue, builtins: readonly HomeHubBuiltinDefinition[], widgets: readonly HomeHubWidgetInput[]): HomeHubLayoutValue {
    const projected = instances(layout, widgets);
    const stillOff = builtins.filter(section => section.hideable && section.defaultHidden && !layout.order.includes(section.id) && !layout.hidden.includes(section.id)).map(section => section.id);
    return { ...layout, instances: projected, order: placedIds(layout, builtins, projected), hidden: [...layout.hidden, ...stillOff] };
}
export type HomeHubWidgetPresentationV1 = Readonly<{
    width: 'half' | 'full'; frameStyle: 'card' | 'plain' | null; nativeIndex: number; hidden: boolean;
}>;
function captureMaterializedWidgetPresentation(layout: HomeHubLayoutValue, instanceId: string): HomeHubWidgetPresentationV1 {
    if (!layout.instances.some(instance => instance.id === instanceId)) throw new HomeHubMutationErrorV1('widget_instance_not_found');
    const presentation = layout.sections?.[instanceId];
    return { width: presentation?.width ?? 'half', frameStyle: presentation?.frameStyle ?? null,
        nativeIndex: layout.order.indexOf(instanceId), hidden: layout.hidden.includes(instanceId) };
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
    if (section.kind === 'widget' && hidden) return applyHomeHubLayoutIntent(layout, builtins, widgets, { kind: 'widget_remove', instanceId: sectionId });
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
    if (!resolveHomeHubLayout(layout, builtins, widgets).sections.some(section => section.id === sectionId)) throw new HomeHubMutationErrorV1('home_hub_section_not_found');
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
export function applyHomeHubLayoutIntent(layout: HomeHubLayoutValue, builtins: readonly HomeHubBuiltinDefinition[], widgets: readonly HomeHubWidgetInput[], intent: HomeHubLayoutIntent): HomeHubLayoutValue {
    switch (intent.kind) {
        case 'move': return moveHomeHubSection(layout, builtins, widgets, intent.sectionId, intent.step);
        case 'move_to': {
            if ('nativeIndex' in intent.position) {
                const base = materialize(layout, builtins, widgets);
                if (!builtins.some(section => section.id === intent.sectionId) && !base.instances.some(instance => instance.id === intent.sectionId)) {
                    throw new HomeHubMutationErrorV1('home_hub_section_not_found');
                }
                const order = base.order.filter(sectionId => sectionId !== intent.sectionId);
                order.splice(intent.position.nativeIndex, 0, intent.sectionId);
                return sameIds(base.order, order) ? layout : { ...base, order };
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
        case 'reset': return layout.order.length || layout.hidden.length || layout.instances.length || layout.sections ? HOME_HUB_DEFAULT_LAYOUT : layout;
        case 'widget_add': {
            const base = materialize(layout, builtins, widgets);
            if (builtins.some(section => section.id === intent.instance.id) || base.instances.some(instance => instance.id === intent.instance.id)) throw new HomeHubMutationErrorV1('widget_instance_exists');
            const presentation = {
                ...(intent.width ? { width: intent.width } : {}),
                ...(intent.frameStyle ? { frameStyle: intent.frameStyle } : {}),
            };
            const next = { ...base, instances: [...base.instances, intent.instance], order: [...base.order.filter(id => id !== intent.instance.id), intent.instance.id], hidden: base.hidden.filter(id => id !== intent.instance.id),
                ...(Object.keys(presentation).length ? { sections: { ...base.sections, [intent.instance.id]: { ...base.sections?.[intent.instance.id], ...presentation } } } : {}) };
            return intent.position ? applyHomeHubLayoutIntent(next, builtins, widgets, { kind: 'move_to', sectionId: intent.instance.id, position: intent.position }) : next;
        }
        default: {
            const base = materialize(layout, builtins, widgets);
            const instance = base.instances.find(instance => instance.id === intent.instanceId);
            if (!instance) throw new HomeHubMutationErrorV1('widget_instance_not_found');
            if (intent.kind === 'widget_remove') {
                if (intent.expectedInstance && !sameStrictJsonValue(instance, intent.expectedInstance)) {
                    throw new HomeHubMutationErrorV1('widget_instance_changed');
                }
                const expected = intent.expectedPresentation;
                const presentation = captureMaterializedWidgetPresentation(base, instance.id);
                if (expected && (
                    (expected.width !== undefined && expected.width !== presentation.width)
                    || expected.frameStyle !== presentation.frameStyle
                    || expected.nativeIndex !== presentation.nativeIndex
                    || (expected.hidden !== undefined && expected.hidden !== presentation.hidden)
                )) {
                    throw new HomeHubMutationErrorV1('widget_placement_changed');
                }
                const sections = { ...base.sections }; delete sections[instance.id]; const { sections: _previous, ...rest } = base;
                return { ...rest, instances: base.instances.filter(other => other.id !== instance.id), order: base.order.filter(id => id !== instance.id),
                    hidden: [...base.hidden.filter(id => id !== instance.id), ...(instance.id.startsWith('default:') ? [instance.id] : [])], ...(Object.keys(sections).length ? { sections } : {}) };
            }
            if (intent.kind === 'widget_width') {
                if ((layout.sections?.[instance.id]?.width ?? 'half') === intent.width) return layout;
                return { ...base, sections: { ...base.sections, [instance.id]: { ...base.sections?.[instance.id], width: intent.width } } };
            }
            let next: WidgetInstanceV1;
            if (intent.kind === 'widget_inputs') next = { ...instance, bindings: intent.bindings };
            else { const { displayName: _old, ...rest } = instance; next = { ...rest, ...(intent.displayName ? { displayName: intent.displayName } : {}) }; }
            if (sameStrictJsonValue(next, instance)) return layout;
            return { ...base, instances: base.instances.map(other => other.id === instance.id ? next : other) };
        }
    }
}
export function buildHomeHubLayoutResult(layout: HomeHubLayoutValue, builtins: readonly HomeHubBuiltinDefinition[], widgets: readonly HomeHubWidgetInput[]) {
    const resolved = resolveHomeHubLayout(layout, builtins, widgets);
    return { layout, sections: resolved.sections.map(section => {
        if (section.kind === 'builtin') return section;
        const { widget: _widget, ...value } = section; return value;
    }), availableWidgetIds: widgets.map(widget => widget.key), hiddenSetupStepIds: listHiddenHomeSetupSteps(layout) };
}
