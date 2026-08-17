import { z } from 'zod';

import {
  defineProtocolObject,
  defineProtocolString,
  type ProtocolComposableSchema,
} from './actions/jsonSchemaValidation.js';
import type { PluginJsonSchemaV2 } from './contributions/publicTypes.js';
import {
  MAX_PLUGIN_IDENTIFIER_BYTES,
  PluginIdJsonSchema,
  PluginIdSchema,
} from './pluginId.js';

const PLUGIN_CONTRIBUTION_LOCAL_ID_PATTERN = '^[a-z0-9]+(?:[-/][a-z0-9]+)*$';
const PLUGIN_CONTRIBUTION_PROTOCOL_ID_V1_PATTERN = '^(?:[a-z0-9]+(?:[-/][a-z0-9]+)*|(?!(?:[a-z0-9-]+\\.)*(?:__proto__|constructor|prototype)(?:\\.|/))[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/[a-z0-9]+(?:[-/][a-z0-9]+)*)$';
const PluginContributionOperationRoleV1Pattern = /^[a-z0-9][A-Za-z0-9]*(?:[-/][a-z0-9][A-Za-z0-9]*)*$/u;

export const PluginContributionLocalIdSchema = defineProtocolString({
  minLength: 1,
  maxLength: MAX_PLUGIN_IDENTIFIER_BYTES,
  pattern: PLUGIN_CONTRIBUTION_LOCAL_ID_PATTERN,
});
export type PluginContributionLocalId = ReturnType<typeof PluginContributionLocalIdSchema.parse>;

/**
 * Operation roles are protocol-owned keys, not contributor-local ids. They
 * retain the established local separators while allowing lower-camel protocol
 * roles such as `connectionTest`.
 */
export const PluginContributionOperationRoleV1Schema = z.string()
  .max(MAX_PLUGIN_IDENTIFIER_BYTES)
  .regex(
    PluginContributionOperationRoleV1Pattern,
    'Contribution operation roles must contain lower-camel alphanumeric segments separated by hyphens or slashes.',
  );
export type PluginContributionOperationRoleV1 = z.infer<typeof PluginContributionOperationRoleV1Schema>;

/**
 * Targeted protocol identifiers retain the existing local-id dialect while
 * admitting an explicitly namespaced Plugin id followed by one local id.
 */
export const PluginContributionProtocolIdV1Schema = defineProtocolString({
  minLength: 1,
  maxLength: MAX_PLUGIN_IDENTIFIER_BYTES,
  pattern: PLUGIN_CONTRIBUTION_PROTOCOL_ID_V1_PATTERN,
});
export type PluginContributionProtocolIdV1 = ReturnType<typeof PluginContributionProtocolIdV1Schema.parse>;

export const ManagedServiceLocalIdSchema = PluginContributionLocalIdSchema;
export type ManagedServiceLocalId = ReturnType<typeof ManagedServiceLocalIdSchema.parse>;

const PluginContributionLocalIdJsonSchema = {
  type: 'string',
  minLength: 1,
  maxLength: MAX_PLUGIN_IDENTIFIER_BYTES,
  pattern: PLUGIN_CONTRIBUTION_LOCAL_ID_PATTERN,
} satisfies PluginJsonSchemaV2;

/** Canonical portable JSON-schema fragment for one fully qualified contribution. */
export const PluginContributionIdentityV1JsonSchema = {
  type: 'object',
  properties: {
    pluginId: PluginIdJsonSchema,
    localId: PluginContributionLocalIdJsonSchema,
  },
  required: ['pluginId', 'localId'],
  additionalProperties: false,
} satisfies PluginJsonSchemaV2;

export const PluginContributionIdentityV1Schema: ProtocolComposableSchema<{
  pluginId: string;
  localId: string;
}> = defineProtocolObject({
  pluginId: PluginIdSchema,
  localId: PluginContributionLocalIdSchema,
}, { policy: 'closed' });
export type PluginContributionIdentityV1 = ReturnType<typeof PluginContributionIdentityV1Schema.parse>;

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
