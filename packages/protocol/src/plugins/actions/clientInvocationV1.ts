import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { PluginContributionIdentityV1Schema } from '../contributionIdentity.js';
import { PluginUiRuntimeOccurrenceIdV1Schema } from '../ui/targetedContributions.js';
import { AgentRuntimeJsonValueV1Schema } from '../../runtime/agentSessionV1.js';
import { asProtocolZod } from './internalProtocolZodAdapter.js';
import { MessageActionReferenceV1Schema } from '../../sessions/messages/messageActionReferenceV1.js';

/** Host-origin reverse RPC; the answering UI retains Action admission and execution. */
export const UiContributedActionExecuteRequestV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  action: asProtocolZod(PluginContributionIdentityV1Schema),
  input: AgentRuntimeJsonValueV1Schema,
  messageActionReference: z.optional(MessageActionReferenceV1Schema),
  surface: z.enum(['agent', 'mcp', 'cli']),
  expectedContributorOccurrenceId: asProtocolZod(PluginUiRuntimeOccurrenceIdV1Schema),
  defaultSessionId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  requiredDangerLevel: z.optional(z.literal('safe')),
}));
export type UiContributedActionExecuteRequestV1 = z.infer<
  typeof UiContributedActionExecuteRequestV1Schema
>;

export const UiContributedActionExecuteResponseV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true), result: AgentRuntimeJsonValueV1Schema }),
  z.strictObject({
    ok: z.literal(false), errorCode: z.string().check(z.trim(), z.minLength(1)), error: z.string(),
    retryable: z.optional(z.boolean()), data: z.optional(AgentRuntimeJsonValueV1Schema),
    actionHandlerInvocation: z.optional(z.literal('notStarted')),
  }),
]));
export type UiContributedActionExecuteResponseV1 = z.infer<
  typeof UiContributedActionExecuteResponseV1Schema
>;
