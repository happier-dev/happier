import { z } from 'zod';

import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";

/**
 * The durable selection of an executable Agent contribution.
 *
 * Runtime routing may derive legacy backend identifiers at its compatibility
 * boundary, but persisted and author-facing Agent targets remain qualified
 * plugin contribution identities.
 */
export const AgentExecutionTargetV1Schema = z.object({
  kind: z.literal('agent'),
  identity: asProtocolZod(PluginContributionIdentityV1Schema),
}).strict();
export type AgentExecutionTargetV1 = z.infer<typeof AgentExecutionTargetV1Schema>;
