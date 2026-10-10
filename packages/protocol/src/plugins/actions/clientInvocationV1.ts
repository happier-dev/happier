import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { PluginContributionIdentityV1Schema } from '../contributionIdentity.js';
import { PluginUiRuntimeOccurrenceIdV1Schema } from '../ui/targetedContributions.js';
import { AgentRuntimeJsonValueV1Schema } from '../../runtime/agentSessionV1.js';
import { asProtocolZod } from './internalProtocolZodAdapter.js';

/** Host-origin reverse RPC; the answering UI retains Action admission and execution. */
export const UiContributedActionExecuteRequestV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  action: asProtocolZod(PluginContributionIdentityV1Schema),
  input: AgentRuntimeJsonValueV1Schema,
  surface: z.enum(['agent', 'mcp', 'cli']),
  expectedContributorOccurrenceId: asProtocolZod(PluginUiRuntimeOccurrenceIdV1Schema),
  defaultSessionId: z.string().trim().min(1).optional(),
  requiredDangerLevel: z.literal('safe').optional(),
}).strict());
export type UiContributedActionExecuteRequestV1 = z.infer<
  typeof UiContributedActionExecuteRequestV1Schema
>;

export const UiContributedActionExecuteResponseV1Schema = lazyZodSchema(() => z.union([
  z.object({ ok: z.literal(true), result: AgentRuntimeJsonValueV1Schema }).strict(),
  z.object({
    ok: z.literal(false), errorCode: z.string().trim().min(1), error: z.string(),
    retryable: z.boolean().optional(), data: AgentRuntimeJsonValueV1Schema.optional(),
    actionHandlerInvocation: z.literal('notStarted').optional(),
  }).strict(),
]));
export type UiContributedActionExecuteResponseV1 = z.infer<
  typeof UiContributedActionExecuteResponseV1Schema
>;
