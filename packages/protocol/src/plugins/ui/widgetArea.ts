import { z } from 'zod';
import { WidgetInstanceActionInputSchemasV1, WidgetInstanceActionOutputSchemasV1 } from '../../widgets/actionsV1.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { ActionExecuteFailureSchema, ActionApprovalRequestCreatedResultSchema } from '../../actions/actionExecutionResult.js';

const input = WidgetInstanceActionInputSchemasV1;
const instanceId = z.string().trim().min(1);
/** Authors name an area/instance, never a Home, Account, page, machine or access callback. */
export const PluginUiWidgetAreaOperationV1Schema = z.discriminatedUnion('actionId', [
    input['widgets.catalog.list'].omit({ surface: true }).extend({ actionId: z.literal('widgets.catalog.list') }).strict(),
    z.object({ actionId: z.literal('widgets.instance.list') }).strict(),
    input['widgets.instance.add'].omit({ surface: true, placement: true }).extend({ actionId: z.literal('widgets.instance.add') }).strict(),
    ...(['widgets.instance.remove', 'widgets.instance.inputs.get', 'widgets.instance.inputs.reset', 'widgets.instance.refresh'] as const).map(actionId => z.object({ actionId: z.literal(actionId), instanceId }).strict()),
    z.object({ actionId: z.literal('widgets.instance.move'), instanceId, toIndex: z.number().int().nonnegative().safe() }).strict(),
    input['widgets.instance.rename'].omit({ ref: true }).extend({ actionId: z.literal('widgets.instance.rename'), instanceId }).strict(),
    input['widgets.instance.size.set'].omit({ ref: true }).extend({ actionId: z.literal('widgets.instance.size.set'), instanceId }).strict(),
    input['widgets.instance.frame.set'].omit({ ref: true }).extend({ actionId: z.literal('widgets.instance.frame.set'), instanceId }).strict(),
    input['widgets.instance.inputs.validate'].omit({ ref: true }).extend({ actionId: z.literal('widgets.instance.inputs.validate'), instanceId }).strict(),
    input['widgets.instance.inputs.set'].omit({ ref: true }).extend({ actionId: z.literal('widgets.instance.inputs.set'), instanceId }).strict(),
]);
export type PluginUiWidgetAreaOperationV1 = z.infer<typeof PluginUiWidgetAreaOperationV1Schema>;
/** Shared host/carrier settlement classification; reads never survive retirement. */
const outwardEffects = {
    'widgets.catalog.list': false, 'widgets.instance.list': false,
    'widgets.instance.add': true, 'widgets.instance.remove': true, 'widgets.instance.move': true,
    'widgets.instance.rename': true, 'widgets.instance.size.set': true, 'widgets.instance.frame.set': true,
    'widgets.instance.inputs.get': false, 'widgets.instance.inputs.validate': false,
    'widgets.instance.inputs.set': true, 'widgets.instance.inputs.reset': true, 'widgets.instance.refresh': false,
} satisfies Record<PluginUiWidgetAreaOperationV1['actionId'], boolean>;
export function pluginUiWidgetAreaOperationHasOutwardEffectV1(operation: PluginUiWidgetAreaOperationV1): boolean {
    return outwardEffects[operation.actionId];
}
export const PluginUiWidgetAreaRequestV1Schema = z.object({
    area: z.string().trim().min(1), context: z.record(z.string(), StrictJsonValueSchema).optional(), operation: PluginUiWidgetAreaOperationV1Schema,
}).strict();
export type PluginUiWidgetAreaRequestV1 = z.infer<typeof PluginUiWidgetAreaRequestV1Schema>;
const outputs = WidgetInstanceActionOutputSchemasV1;
export const PluginUiWidgetAreaResultV1Schema = z.union([ActionExecuteFailureSchema,
    z.object({ ok: z.literal(true), result: z.union([
        outputs['widgets.catalog.list'], outputs['widgets.instance.list'], outputs['widgets.instance.add'],
        outputs['widgets.instance.inputs.get'], outputs['widgets.instance.inputs.validate'], outputs['widgets.instance.refresh'],
        ActionApprovalRequestCreatedResultSchema,
    ]) }).strict(),
]);
export type PluginUiWidgetAreaResultV1 = z.infer<typeof PluginUiWidgetAreaResultV1Schema>;
