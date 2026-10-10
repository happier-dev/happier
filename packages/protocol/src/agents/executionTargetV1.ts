import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";
import { createStoredReadSchema, defineStoredReadProjection } from '../json/storedReadSchema.js';

/** One declared executable contribution; configured definitions are its instances. */
export const CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 = Object.freeze({
  pluginId: 'happier.agent.custom-acp',
  localId: 'custom-acp',
});

export function isCustomAcpAgentContributionIdentityV1(identity: unknown): identity is typeof CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 {
  return identity !== null && typeof identity === 'object' && 'pluginId' in identity && 'localId' in identity
    && identity.pluginId === CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.pluginId
    && identity.localId === CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.localId;
}

/**
 * The durable selection of an executable Agent contribution.
 *
 * Runtime routing may derive legacy backend identifiers at its compatibility
 * boundary, but persisted and author-facing Agent targets remain qualified
 * plugin contribution identities.
 */
const CurrentAgentExecutionTargetV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('agent'),
  identity: asProtocolZod(PluginContributionIdentityV1Schema),
  definitionId: z.string().min(1).optional(),
}).strict().superRefine((target, ctx) => {
  const isCustomAcp = isCustomAcpAgentContributionIdentityV1(target.identity);
  if (isCustomAcp !== (target.definitionId !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['definitionId'],
      message: isCustomAcp ? 'Custom ACP Agent requires a configured definition' : 'Agent does not accept a configured ACP definition' });
  }
}));

export const AgentExecutionTargetV1Schema = defineStoredReadProjection(
  lazyZodSchema(() => CurrentAgentExecutionTargetV1Schema),
  () => AgentExecutionTargetV1StoredSchema,
);
export type AgentExecutionTargetV1 = z.infer<typeof AgentExecutionTargetV1Schema>;

/** Genuine 0.2 stored selection ingress, never request/write admission. */
export const AgentExecutionTargetV1StoredSchema = lazyZodSchema(() => z.preprocess((value) => {
  if (value && typeof value === 'object' && !Array.isArray(value)
    && 'kind' in value && value.kind === 'configuredAcpBackend' && 'backendId' in value) {
    return { kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: value.backendId };
  }
  return value;
}, createStoredReadSchema(CurrentAgentExecutionTargetV1Schema)));
