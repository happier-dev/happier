import { z } from 'zod';

import { PluginIdSchema } from './pluginId.js';

export const PluginContributionLocalIdSchema = z.string().regex(
  /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/,
  'Contribution local ids must contain lowercase alphanumeric segments separated by hyphens or slashes.',
);

export const PluginContributionIdentityV1Schema = z.object({
  pluginId: PluginIdSchema,
  localId: PluginContributionLocalIdSchema,
}).strict();
export type PluginContributionIdentityV1 = z.infer<typeof PluginContributionIdentityV1Schema>;

const LEGACY_OH_MY_PI_AGENT_ID = 'ohMyPi';
const OH_MY_PI_AGENT_IDENTITY = Object.freeze({
  pluginId: 'happier.agent.ohmypi',
  localId: 'ohmypi',
} satisfies PluginContributionIdentityV1);

export function createPluginContributionIdentity(
  input: PluginContributionIdentityV1,
): PluginContributionIdentityV1 {
  return PluginContributionIdentityV1Schema.parse(input);
}

export function buildQualifiedPluginContributionKey(identity: PluginContributionIdentityV1): string {
  return `${identity.pluginId}/${identity.localId}`;
}

/**
 * Exact, bounded import for the scheduled predecessor's durable Oh My Pi Agent id.
 *
 * The flat value is accepted only at persistence ingress. It is not a catalog alias,
 * and the strict writer below never emits it.
 */
export function readPersistedAgentContributionIdentityV1(
  value: unknown,
): PluginContributionIdentityV1 | null {
  if (value === LEGACY_OH_MY_PI_AGENT_ID) {
    return { ...OH_MY_PI_AGENT_IDENTITY };
  }
  const parsed = PluginContributionIdentityV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function writePersistedAgentContributionIdentityV1(
  identity: PluginContributionIdentityV1,
): PluginContributionIdentityV1 {
  return PluginContributionIdentityV1Schema.parse(identity);
}

/**
 * Resolves the current in-memory/catalog routing id for an imported durable identity.
 * Unknown plugin identities stay unresolved rather than manufacturing an alias.
 */
export function resolveAgentIdFromPersistedContributionIdentityV1(
  identity: PluginContributionIdentityV1,
): string | null {
  const parsed = PluginContributionIdentityV1Schema.safeParse(identity);
  if (!parsed.success) return null;
  return parsed.data.pluginId === OH_MY_PI_AGENT_IDENTITY.pluginId
    && parsed.data.localId === OH_MY_PI_AGENT_IDENTITY.localId
    ? LEGACY_OH_MY_PI_AGENT_ID
    : null;
}

export function resolvePersistedContributionIdentityV1FromAgentId(
  agentId: string,
): PluginContributionIdentityV1 | null {
  return agentId === LEGACY_OH_MY_PI_AGENT_ID
    ? { ...OH_MY_PI_AGENT_IDENTITY }
    : null;
}
