import { z } from 'zod';

import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';

/**
 * One selectable Agent or configured ACP backend projected by
 * `agents.backends.list`.
 *
 * Catalog Agent rows retain the stable contribution identity needed to select
 * the Agent without deriving it from presentation fields. Configured ACP rows
 * remain selectable through `backendId` and intentionally need not have one.
 */
export const AgentBackendInventoryItemSchema = z.object({
  targetKey: z.string().min(1),
  label: z.string().min(1),
  enabled: z.boolean(),
  agentId: z.string().min(1).optional(),
  identity: asProtocolZod(PluginContributionIdentityV1Schema).optional(),
  backendId: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
}).strict();
export type AgentBackendInventoryItem = z.output<typeof AgentBackendInventoryItemSchema>;

export const AgentsBackendsListOutputSchema = z.object({
  items: z.array(AgentBackendInventoryItemSchema),
}).strict();
export type AgentsBackendsListOutput = z.output<typeof AgentsBackendsListOutputSchema>;
