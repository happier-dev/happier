import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { WidgetInstanceActionInputSchemasV1, WidgetInstanceActionOutputSchemasV1 } from '../../widgets/actionsV1.js';
import { WIDGET_INPUTS_GET_ACTION_ID_V1, WIDGET_INPUTS_RESET_ACTION_ID_V1, WIDGET_REFRESH_ACTION_ID_V1, WIDGET_REMOVE_ACTION_ID_V1 } from '../../widgets/instanceIdsV1.js';
import type { WidgetSurfaceRefV1 } from '../../widgets/widgetInstanceV1.js';
import { WidgetProjectAreaV1Schema } from '../../widgets/widgetPresentationV1.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { ActionExecuteFailureSchema, ActionApprovalRequestCreatedResultSchema } from '../../actions/actionExecutionResult.js';
import { WidgetAreaLayoutV1Schema, WidgetAreaPresetUndoV1Schema } from '../../widgets/widgetSurfaceArtifactV1.js';

const input = WidgetInstanceActionInputSchemasV1;
const [widgetSizeInput, groupWidthInput] = input['widgets.item.size.set']._zod.def.options;
const instanceId = z.string().check(z.trim(), z.minLength(1));
const layoutId = z.string().check(z.trim(), z.minLength(1));
// A reset's saved content is portable within this declared area; its routing is always host-owned.
const localUndo = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(WidgetAreaPresetUndoV1Schema, { surface: true }), {
    layoutId: z.optional(layoutId), previousLayout: z.omit(WidgetAreaLayoutV1Schema, { surface: true }),
})));
/** Authors name an area/instance, never a Home, Account, page, machine or access callback. */
export const PluginUiWidgetAreaOperationV1Schema = z.union([
    z.strictObject({ actionId: z.literal('widgets.area.layout.list') }),
    z.strictObject(z.extend(z.omit(input['widgets.area.layout.create'], { surface: true, fromSurface: true }), { actionId: z.literal('widgets.area.layout.create'), fromLayoutId: z.optional(z.nullable(layoutId)) }).shape),
    z.strictObject({ actionId: z.literal('widgets.area.layout.select'), layoutId: z.optional(z.nullable(layoutId)) }),
    z.strictObject(z.extend(z.omit(input['widgets.area.layout.rename'], { surface: true }), { actionId: z.literal('widgets.area.layout.rename') }).shape),
    z.strictObject(z.extend(z.omit(input['widgets.area.layout.reorder'], { surface: true }), { actionId: z.literal('widgets.area.layout.reorder') }).shape),
    z.strictObject(z.extend(z.omit(input['widgets.area.layout.delete'], { surface: true }), { actionId: z.literal('widgets.area.layout.delete') }).shape),
    z.strictObject(z.extend(z.omit(input['widgets.area.layout.reset'], { surface: true }), { actionId: z.literal('widgets.area.layout.reset') }).shape),
    z.strictObject({ actionId: z.literal('widgets.area.layout.undo'), capture: localUndo }),
    z.strictObject(z.extend(z.omit(input['widgets.catalog.list'], { surface: true }), { actionId: z.literal('widgets.catalog.list') }).shape),
    z.strictObject({ actionId: z.literal('widgets.item.list') }),
    z.strictObject(z.extend(z.omit(input['widgets.item.add'], { surface: true, placement: true }), { actionId: z.literal('widgets.item.add') }).shape),
    z.strictObject(z.extend(z.omit(input['widgets.group.add'], { surface: true }), { actionId: z.literal('widgets.group.add') }).shape),
    z.strictObject(z.extend(z.omit(input['widgets.group.create'], { surface: true }), { actionId: z.literal('widgets.group.create') }).shape),
    z.strictObject({ actionId: z.literal('widgets.group.ungroup'), instanceId }),
    z.strictObject(z.extend(z.omit(input['widgets.group.set'], { ref: true }), { actionId: z.literal('widgets.group.set'), instanceId }).shape),
    z.strictObject(z.extend(z.omit(input['widgets.group.inputs.set'], { ref: true }), { actionId: z.literal('widgets.group.inputs.set'), instanceId }).shape),
    ...([WIDGET_REMOVE_ACTION_ID_V1, WIDGET_INPUTS_GET_ACTION_ID_V1, WIDGET_INPUTS_RESET_ACTION_ID_V1, WIDGET_REFRESH_ACTION_ID_V1] as const)
        .map(actionId => z.strictObject({ actionId: z.literal(actionId), instanceId })),
    z.strictObject({ actionId: z.literal('widgets.item.move'), instanceId, toIndex: z.number().check(z.int(), z.nonnegative(), z.int()), area: z.optional(WidgetProjectAreaV1Schema), groupId: z.optional(z.nullable(instanceId)) }),
    z.strictObject(z.extend(z.omit(input['widgets.item.rename'], { ref: true }), { actionId: z.literal('widgets.item.rename'), instanceId }).shape),
    z.strictObject(z.extend(z.omit(widgetSizeInput, { ref: true }), { actionId: z.literal('widgets.item.size.set'), instanceId }).shape),
    z.strictObject(z.extend(z.omit(groupWidthInput, { ref: true }), { actionId: z.literal('widgets.item.size.set'), instanceId }).shape),
    z.strictObject(z.extend(z.omit(input['widgets.item.frame.set'], { ref: true }), { actionId: z.literal('widgets.item.frame.set'), instanceId }).shape),
    z.strictObject(z.extend(z.omit(input['widgets.item.network.set'], { ref: true }), { actionId: z.literal('widgets.item.network.set'), instanceId }).shape),
    z.strictObject(z.extend(z.omit(input['widgets.item.inputs.validate'], { ref: true }), { actionId: z.literal('widgets.item.inputs.validate'), instanceId }).shape),
    z.strictObject(z.extend(z.omit(input['widgets.item.inputs.set'], { ref: true }), { actionId: z.literal('widgets.item.inputs.set'), instanceId }).shape),
]);
export type PluginUiWidgetAreaOperationV1 = z.infer<typeof PluginUiWidgetAreaOperationV1Schema>;

function layoutSurface(surface: WidgetSurfaceRefV1, selected: string | null | undefined): WidgetSurfaceRefV1 {
    const owner = surface.owner;
    if (owner.kind !== 'project' && owner.kind !== 'corePage' && owner.kind !== 'pluginArea') return surface;
    const { layoutId: _previous, ...base } = owner;
    return { ...surface, owner: { ...base, ...(selected ? { layoutId: selected } : {}) } };
}

/** The host supplies identity; an area operation cannot select another Home or owner. */
export function buildWidgetAreaActionInputV1(operation: PluginUiWidgetAreaOperationV1, surface: WidgetSurfaceRefV1) {
    if (operation.actionId === 'widgets.area.layout.select') return { surface: layoutSurface(surface, operation.layoutId) };
    if (operation.actionId === 'widgets.area.layout.create') {
        const { actionId: _actionId, fromLayoutId, ...fields } = operation;
        return { ...fields, surface, ...(fromLayoutId === undefined ? {} : { fromSurface: layoutSurface(surface, fromLayoutId) }) };
    }
    if (operation.actionId === 'widgets.area.layout.undo') {
        const selected = layoutSurface(surface, operation.capture.layoutId);
        return { capture: { surface: selected, previousLayout: { ...operation.capture.previousLayout, surface: selected }, expectedRevision: operation.capture.expectedRevision } };
    }
    const { actionId: _actionId, ...fields } = operation;
    if (!('instanceId' in fields)) return { ...fields, surface };
    const { instanceId, ...input } = fields;
    return { ...input, ref: { surface, instanceId } };
}
/** Shared host/carrier settlement classification; reads never survive retirement. */
const outwardEffects = {
    'widgets.area.layout.list': false, 'widgets.area.layout.select': true,
    'widgets.area.layout.create': true, 'widgets.area.layout.rename': true, 'widgets.area.layout.reorder': true,
    'widgets.area.layout.delete': true, 'widgets.area.layout.reset': true, 'widgets.area.layout.undo': true,
    'widgets.catalog.list': false, 'widgets.item.list': false,
    'widgets.item.add': true, 'widgets.item.remove': true, 'widgets.item.move': true,
    'widgets.group.add': true, 'widgets.group.create': true, 'widgets.group.ungroup': true,
    'widgets.group.set': true, 'widgets.group.inputs.set': true,
    'widgets.item.rename': true, 'widgets.item.size.set': true, 'widgets.item.frame.set': true, 'widgets.item.network.set': true,
    'widgets.item.inputs.get': false, 'widgets.item.inputs.validate': false,
    'widgets.item.inputs.set': true, 'widgets.item.inputs.reset': true, 'widgets.item.refresh': false,
} satisfies Record<PluginUiWidgetAreaOperationV1['actionId'], boolean>;
export function pluginUiWidgetAreaOperationHasOutwardEffectV1(operation: PluginUiWidgetAreaOperationV1): boolean {
    return outwardEffects[operation.actionId];
}
export const PluginUiWidgetAreaRequestV1Schema = z.strictObject({
    area: z.string().check(z.trim(), z.minLength(1)), layoutId: z.optional(layoutId), context: z.optional(z.record(z.string(), StrictJsonValueSchema)), operation: PluginUiWidgetAreaOperationV1Schema,
});
export type PluginUiWidgetAreaRequestV1 = z.infer<typeof PluginUiWidgetAreaRequestV1Schema>;
const outputs = WidgetInstanceActionOutputSchemasV1;
export const PluginUiWidgetAreaResultV1Schema = z.union([ActionExecuteFailureSchema,
    z.strictObject({ ok: z.literal(true), result: z.union([
        outputs['widgets.catalog.list'], outputs['widgets.item.list'], outputs['widgets.item.add'],
        outputs['widgets.item.inputs.get'], outputs['widgets.item.inputs.validate'], outputs['widgets.item.refresh'],
        outputs['widgets.area.layout.list'], outputs['widgets.area.layout.create'], outputs['widgets.area.layout.delete'], outputs['widgets.area.layout.reset'],
        ActionApprovalRequestCreatedResultSchema,
    ]) }),
]);
export type PluginUiWidgetAreaResultV1 = z.infer<typeof PluginUiWidgetAreaResultV1Schema>;
