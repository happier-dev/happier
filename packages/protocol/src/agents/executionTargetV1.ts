import { lazyDefinition, lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

import { buildQualifiedPluginContributionKey, PluginContributionIdentityV1Schema, type PluginContributionIdentityV1 } from '../plugins/contributionIdentity.js';
import { asProtocolZod, projectZodProtocolSchema } from "../plugins/actions/internalProtocolZodAdapter.js";
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
const CurrentAgentExecutionTargetV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('agent'),
  identity: asProtocolZod(PluginContributionIdentityV1Schema),
  definitionId: z.optional(z.string().check(z.minLength(1))),
}).check(z.superRefine((target, ctx) => {
  const isCustomAcp = isCustomAcpAgentContributionIdentityV1(target.identity);
  if (isCustomAcp !== (target.definitionId !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['definitionId'],
      message: isCustomAcp ? 'Custom ACP Agent requires a configured definition' : 'Agent does not accept a configured ACP definition' });
  }
})));

export const AgentExecutionTargetV1Schema = defineStoredReadProjection(
  lazyZodSchema(() => CurrentAgentExecutionTargetV1Schema),
  () => AgentExecutionTargetV1StoredSchema,
);
export type AgentExecutionTargetV1 = z.infer<typeof AgentExecutionTargetV1Schema>;
export const AgentExecutionTargetV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(AgentExecutionTargetV1Schema));

export type ConfiguredAcpAgentSelectionV1 = Readonly<{
  agentId: string;
  agentTarget: Readonly<{ kind: 'agent'; identity: typeof CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1; definitionId: string }>;
  runtimeDescriptorV1: Readonly<{ v: 1; agentId: string; agent: Readonly<{ definitionId: string }> }>;
  runtimeAuthorityAgentId: string;
  flavor: string;
}>;

/** One configured instance's current identity, shared by launch and install projections. */
export function buildConfiguredAcpAgentSelectionV1(definitionId: string): ConfiguredAcpAgentSelectionV1 {
  const agentId = buildQualifiedPluginContributionKey(CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1);
  const agentTarget = { kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId } as const satisfies AgentExecutionTargetV1;
  return {
    agentId, agentTarget,
    runtimeDescriptorV1: { v: 1 as const, agentId, agent: { definitionId } },
    runtimeAuthorityAgentId: agentId,
    flavor: agentId,
  };
}

/** Executable catalog choices: Custom ACP declares a container for configured definitions. */
export function listAgentExecutionTargetsV1(
  identity: PluginContributionIdentityV1,
  definitionIds: readonly string[] = [],
): AgentExecutionTargetV1[] {
  return isCustomAcpAgentContributionIdentityV1(identity)
    ? definitionIds.map((definitionId) => ({ kind: 'agent', identity, definitionId }))
    : [{ kind: 'agent', identity }];
}

/** Genuine 0.2 stored selection ingress, never request/write admission. */
export const AgentExecutionTargetV1StoredSchema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => {
  if (value && typeof value === 'object' && !Array.isArray(value)
    && 'kind' in value && value.kind === 'configuredAcpBackend' && 'backendId' in value) {
    return { kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: value.backendId };
  }
  return value;
}), createStoredReadSchema(CurrentAgentExecutionTargetV1Schema)));
