import { PLUGIN_EXECUTION_ORIGIN_ACTION_IDS } from './pluginExecutionOriginActionIdsV1.js';
export { PLUGIN_EXECUTION_ORIGIN_ACTION_IDS } from './pluginExecutionOriginActionIdsV1.js';
import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { PluginIdSchema } from '../plugins/pluginId.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { PluginMachineExecutionOriginV1Schema, getPluginMachineExecutionOriginRef } from '../machines/administration/pluginMachineExecutionOriginV1.js';
import { MachineAdministrationTargetV1Schema } from '../account/settings/machineAdministrationSelectionsV1.js';
export type PluginExecutionOriginActionId = typeof PLUGIN_EXECUTION_ORIGIN_ACTION_IDS[number];
export const PluginExecutionOriginActionIdSchema = lazyZodSchema(() => z.enum(PLUGIN_EXECUTION_ORIGIN_ACTION_IDS));
const contextualTarget = lazyZodSchema(() => z.strictObject({ commandId: z.string().check(z.minLength(1)) }));
const base = lazyZodSchema(() => z.strictObject({ pluginId: asProtocolZod(PluginIdSchema),
  clientId: z.optional(z.string().check(z.minLength(1))), contextualTarget: z.optional(contextualTarget) }));
const set = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(base, { origin: PluginMachineExecutionOriginV1Schema })).check(z.superRefine((input, ctx) => {
  if (getPluginMachineExecutionOriginRef(input.origin).pluginId !== input.pluginId) {
    ctx.addIssue({ code: 'custom', path: ['origin'], message: 'Origin must belong to the selected plugin' });
  }
})));
export const PluginExecutionOriginActionInputSchemas = {
  'plugins.execution_origin.list': lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(base, { contextual: z.optional(z.literal(true)) }))),
  'plugins.execution_origin.set': set,
  'plugins.execution_origin.clear': base,
} as const;

// All envelopes and nested authority-bearing references are closed. These
// Local preferences carry only a Home-qualified Machine. Contextual addresses name only
// the answering client's incumbent opaque mounted-command record.
const unavailable = lazyZodSchema(() => z.strictObject({ status: z.literal('unavailable') }));
const mutation = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('applied') }),
  unavailable,
]));
const selection = lazyZodSchema(() => z.strictObject({
  status: z.literal('available'),
  answeringClientId: z.optional(z.string().check(z.minLength(1))),
  answeringClientIds: z.optional(z.array(z.string().check(z.minLength(1)))),
  storedTarget: z.optional(z.nullable(MachineAdministrationTargetV1Schema)),
  storedOrigin: z.nullable(PluginMachineExecutionOriginV1Schema),
  selectedOrigin: z.nullable(PluginMachineExecutionOriginV1Schema),
  selectionSource: z.nullable(z.enum(['auto', 'pinned'])),
  candidates: z.array(z.strictObject({ origin: PluginMachineExecutionOriginV1Schema,
    version: z.string().check(z.minLength(1)), selectable: z.boolean() })),
}));
export type PluginExecutionOriginContextualSelection = z.infer<typeof selection>;
export const PluginExecutionOriginActionOutputSchemas = {
  'plugins.execution_origin.list': lazyZodSchema(() => z.union([unavailable,
    selection,
    z.strictObject({ status: z.literal('available'), answeringClientId: z.optional(z.string().check(z.minLength(1))),
      answeringClientIds: z.optional(z.array(z.string().check(z.minLength(1)))), contextualTargets: z.array(z.strictObject({ commandId: z.string().check(z.minLength(1)),
      serverIdentityId: z.string().check(z.minLength(1)), machineId: z.string().check(z.minLength(1)) })) }),
  ])),
  'plugins.execution_origin.set': mutation,
  'plugins.execution_origin.clear': mutation,
} as const;
