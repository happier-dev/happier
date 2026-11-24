import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ActionExecuteResultSchema } from '../../actions/actionExecutionResult.js';
import { PluginUiJsonValueV1Schema } from '../contributions/ui/json.js';
import { PluginUiMountedActionReferenceV1Schema } from './hostApiRequests.js';
import { PluginUiIconTokenV1Schema } from '../contributions/ui/tokens.js';

const Id = z.string().check(z.trim(), z.minLength(1));

/** Closed V1 presentation; it grants neither execution nor gesture authority. */
export const PluginUiActionControlPresentationV1Schema = lazyZodSchema(() => z.strictObject({
  title: Id,
  accessibilityLabel: z.optional(Id),
  disabled: z.optional(z.boolean()),
  variant: z.optional(z.enum(['primary', 'secondary', 'plain', 'destructive'])),
  /** The control's leading glyph, from the portable icon vocabulary. */
  icon: z.optional(PluginUiIconTokenV1Schema),
  /** One line under the title: the host draws the control as a pressable row instead of a button. */
  description: z.optional(Id),
  /** A row that leads somewhere (a Composer, a page) ends in the host's disclosure chevron. */
  disclosure: z.optional(z.boolean()),
}));
export type PluginUiActionControlPresentationV1 = z.infer<typeof PluginUiActionControlPresentationV1Schema>;
export const PluginUiActionControlPreparationV1Schema = lazyZodSchema(() => z.strictObject({
  input: z.optional(PluginUiJsonValueV1Schema),
}));
export type PluginUiActionControlPreparationV1 = z.infer<typeof PluginUiActionControlPreparationV1Schema>;

/** Reuse the executor's full settlement envelope instead of narrowing its custody. */
export const PluginUiActionControlExecutionV1Schema = ActionExecuteResultSchema;
export type PluginUiActionControlExecutionV1 = z.infer<typeof PluginUiActionControlExecutionV1Schema>;

/** All requests are closed. Only a host-owned pending gesture accepts prepared input. */
export const PluginUiActionControlRequestV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('bind'), subscriptionId: Id,
    action: PluginUiMountedActionReferenceV1Schema, presentation: PluginUiActionControlPresentationV1Schema }),
  z.strictObject({ kind: z.literal('update'), subscriptionId: Id, presentation: PluginUiActionControlPresentationV1Schema }),
  z.strictObject({ kind: z.literal('prepared'), subscriptionId: Id, requestId: Id,
    preparation: z.nullable(PluginUiActionControlPreparationV1Schema) }),
]));
export type PluginUiActionControlRequestV1 = z.infer<typeof PluginUiActionControlRequestV1Schema>;

/** Correlation identifies one preparation, never authority a plugin can spend. */
export const PluginUiActionControlEventV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('prepare'), requestId: Id }),
  z.strictObject({ kind: z.literal('settled'), requestId: Id, execution: PluginUiActionControlExecutionV1Schema }),
]));
export type PluginUiActionControlEventV1 = z.infer<typeof PluginUiActionControlEventV1Schema>;
