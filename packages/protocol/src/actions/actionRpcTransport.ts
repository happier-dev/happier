import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { PluginIdSchema } from '../plugins/pluginId.js';
import { PluginContributionLocalIdSchema } from '../plugins/contributionIdentity.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';

import {
  ExternalActionTargetV1Schema,
  type ExternalActionTargetV1,
} from './externalActionApi.js';

/**
 * Strict host-to-daemon Action request wrapper for transport-owned routing
 * facts. `input` remains the complete semantic Action input; target metadata
 * is opened only by the generic RPC ingress and is never passed to an Action
 * input schema.
 */
export const TargetedActionRpcRequestV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  kind: z.literal('targeted_action_rpc'),
  input: z.unknown(),
  target: ExternalActionTargetV1Schema,
  /** Invoking host attribution; only the Account-authenticated Session route consumes it. */
  pluginCaller: z.optional(z.strictObject({
    pluginId: asProtocolZod(PluginIdSchema),
    contributionLocalId: asProtocolZod(PluginContributionLocalIdSchema),
  })),
  /** The caller's invoking Session (host context `defaultSessionId`), e.g. a Run's origin. */
  defaultSessionId: z.optional(z.string().check(z.trim(), z.minLength(1))),
}).check(z.superRefine((value, context) => {
  if (!Object.prototype.hasOwnProperty.call(value, 'input')) {
    context.addIssue({
      code: "custom",
      path: ['input'],
      message: 'input is required',
    });
  }
  if (value.pluginCaller && value.target.kind !== 'session') {
    context.addIssue({ code: 'custom', path: ['pluginCaller'], message: 'Plugin attribution requires a Session target' });
  }
})));

export type TargetedActionRpcRequestV1 = z.infer<typeof TargetedActionRpcRequestV1Schema>;

export function createTargetedActionRpcRequestV1(
  input: unknown,
  target: ExternalActionTargetV1,
  context: Readonly<{
    defaultSessionId?: string | null;
    pluginCaller?: TargetedActionRpcRequestV1['pluginCaller'];
  }> = {},
): TargetedActionRpcRequestV1 {
  return TargetedActionRpcRequestV1Schema.parse({
    v: 1,
    kind: 'targeted_action_rpc',
    input,
    target,
    ...(context.defaultSessionId ? { defaultSessionId: context.defaultSessionId } : {}),
    ...(context.pluginCaller ? { pluginCaller: context.pluginCaller } : {}),
  });
}
