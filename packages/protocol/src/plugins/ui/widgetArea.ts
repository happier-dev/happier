import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { WidgetInstanceActionInputSchemasV1, WidgetInstanceActionOutputSchemasV1 } from '../../widgets/actionsV1.js';
import type { WidgetSurfaceRefV1 } from '../../widgets/widgetInstanceV1.js';
import { WidgetProjectAreaV1Schema } from '../../widgets/widgetPresentationV1.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { ActionExecuteFailureSchema, ActionApprovalRequestCreatedResultSchema } from '../../actions/actionExecutionResult.js';
import { WidgetAreaLayoutV1Schema, WidgetAreaPresetUndoV1Schema } from '../../widgets/widgetSurfaceArtifactV1.js';

const input = WidgetInstanceActionInputSchemasV1;
const [widgetSizeInput, groupWidthInput] = input['widgets.item.size.set'].options;
const instanceId = z.string().trim().min(1);
const layoutId = z.string().trim().min(1);
// A reset's saved content is portable within this declared area; its routing is always host-owned.
const localUndo = lazyZodSchema(() => WidgetAreaPresetUndoV1Schema.omit({ surface: true }).extend({
    layoutId: layoutId.optional(), previousLayout: WidgetAreaLayoutV1Schema.omit({ surface: true }),
}).strict());
/** Authors name an area/instance, never a Home, Account, page, machine or access callback. */
export const PluginUiWidgetAreaOperationV1Schema = z.union([
    z.object({ actionId: z.literal('widgets.area.layout.list') }).strict(),
    input['widgets.area.layout.create'].omit({ surface: true, fromSurface: true }).extend({ actionId: z.literal('widgets.area.layout.create'), fromLayoutId: layoutId.nullable().optional() }).strict(),
    z.object({ actionId: z.literal('widgets.area.layout.select'), layoutId: layoutId.nullable().optional() }).strict(),
    input['widgets.area.layout.rename'].omit({ surface: true }).extend({ actionId: z.literal('widgets.area.layout.rename') }).strict(),
    input['widgets.area.layout.reorder'].omit({ surface: true }).extend({ actionId: z.literal('widgets.area.layout.reorder') }).strict(),
    input['widgets.area.layout.delete'].omit({ surface: true }).extend({ actionId: z.literal('widgets.area.layout.delete') }).strict(),
    input['widgets.area.layout.reset'].omit({ surface: true }).extend({ actionId: z.literal('widgets.area.layout.reset') }).strict(),
    z.object({ actionId: z.literal('widgets.area.layout.undo'), capture: localUndo }).strict(),
    input['widgets.catalog.list'].omit({ surface: true }).extend({ actionId: z.literal('widgets.catalog.list') }).strict(),
    z.object({ actionId: z.literal('widgets.item.list') }).strict(),
    input['widgets.item.add'].omit({ surface: true, placement: true }).extend({ actionId: z.literal('widgets.item.add') }).strict(),
    input['widgets.group.add'].omit({ surface: true }).extend({ actionId: z.literal('widgets.group.add') }).strict(),
    input['widgets.group.create'].omit({ surface: true }).extend({ actionId: z.literal('widgets.group.create') }).strict(),
    z.object({ actionId: z.literal('widgets.group.ungroup'), instanceId }).strict(),
    input['widgets.group.set'].omit({ ref: true }).extend({ actionId: z.literal('widgets.group.set'), instanceId }).strict(),
    input['widgets.group.inputs.set'].omit({ ref: true }).extend({ actionId: z.literal('widgets.group.inputs.set'), instanceId }).strict(),
    ...(['widgets.item.remove', 'widgets.item.inputs.get', 'widgets.item.inputs.reset', 'widgets.item.refresh'] as const).map(actionId => z.object({ actionId: z.literal(actionId), instanceId }).strict()),
    z.object({ actionId: z.literal('widgets.item.move'), instanceId, toIndex: z.number().int().nonnegative().safe(), area: WidgetProjectAreaV1Schema.optional(), groupId: instanceId.nullable().optional() }).strict(),
    input['widgets.item.rename'].omit({ ref: true }).extend({ actionId: z.literal('widgets.item.rename'), instanceId }).strict(),
    widgetSizeInput.omit({ ref: true }).extend({ actionId: z.literal('widgets.item.size.set'), instanceId }).strict(),
    groupWidthInput.omit({ ref: true }).extend({ actionId: z.literal('widgets.item.size.set'), instanceId }).strict(),
    input['widgets.item.frame.set'].omit({ ref: true }).extend({ actionId: z.literal('widgets.item.frame.set'), instanceId }).strict(),
    input['widgets.item.inputs.validate'].omit({ ref: true }).extend({ actionId: z.literal('widgets.item.inputs.validate'), instanceId }).strict(),
    input['widgets.item.inputs.set'].omit({ ref: true }).extend({ actionId: z.literal('widgets.item.inputs.set'), instanceId }).strict(),
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
    'widgets.item.rename': true, 'widgets.item.size.set': true, 'widgets.item.frame.set': true,
    'widgets.item.inputs.get': false, 'widgets.item.inputs.validate': false,
    'widgets.item.inputs.set': true, 'widgets.item.inputs.reset': true, 'widgets.item.refresh': false,
} satisfies Record<PluginUiWidgetAreaOperationV1['actionId'], boolean>;
export function pluginUiWidgetAreaOperationHasOutwardEffectV1(operation: PluginUiWidgetAreaOperationV1): boolean {
    return outwardEffects[operation.actionId];
}
export const PluginUiWidgetAreaRequestV1Schema = z.object({
    area: z.string().trim().min(1), layoutId: layoutId.optional(), context: z.record(z.string(), StrictJsonValueSchema).optional(), operation: PluginUiWidgetAreaOperationV1Schema,
}).strict();
export type PluginUiWidgetAreaRequestV1 = z.infer<typeof PluginUiWidgetAreaRequestV1Schema>;
const outputs = WidgetInstanceActionOutputSchemasV1;
export const PluginUiWidgetAreaResultV1Schema = z.union([ActionExecuteFailureSchema,
    z.object({ ok: z.literal(true), result: z.union([
        outputs['widgets.catalog.list'], outputs['widgets.item.list'], outputs['widgets.item.add'],
        outputs['widgets.item.inputs.get'], outputs['widgets.item.inputs.validate'], outputs['widgets.item.refresh'],
        outputs['widgets.area.layout.list'], outputs['widgets.area.layout.create'], outputs['widgets.area.layout.delete'], outputs['widgets.area.layout.reset'],
        ActionApprovalRequestCreatedResultSchema,
    ]) }).strict(),
]);
export type PluginUiWidgetAreaResultV1 = z.infer<typeof PluginUiWidgetAreaResultV1Schema>;
