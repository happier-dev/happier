import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import {
  BackendTargetKeySchema,
  BackendTargetRefSchema,
  parseBackendTargetKey,
  type BackendTargetRefV1,
} from './backendTargetRef.js';
import { hasLegacyCustomAcpConcreteBackendId } from './compat/customAcp.js';
import {
  PluginContributionIdentityV1Schema,
  buildQualifiedPluginContributionKey,
  parseQualifiedPluginContributionKey,
  resolveAgentIdFromPersistedContributionIdentityV1,
  resolvePersistedContributionIdentityV1FromAgentId,
  type PluginContributionIdentityV1,
} from '../../plugins/contributionIdentity.js';
import {
  AgentExecutionTargetV1Schema,
  CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1,
  type AgentExecutionTargetV1,
} from '../../agents/executionTargetV1.js';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES_V1 } from '../../generated/agents/bundledAgentIdentitiesV1.js';

/**
 * A bundled Agent's contribution identity from its routing id. This is what
 * gives a bundled Agent exactly one target key: a writer holding the routing
 * ref (`{ kind: 'backend', backendId: 'claude' }`) and one holding the Agent
 * execution target both key it `agent:<pluginId>/<localId>`.
 */
function resolveBundledAgentIdentityV1(backendId: string): PluginContributionIdentityV1 | null {
  if (!Object.hasOwn(BUNDLED_AGENT_CONTRIBUTION_IDENTITIES_V1, backendId)) return null;
  const identity = BUNDLED_AGENT_CONTRIBUTION_IDENTITIES_V1[backendId]!;
  return { pluginId: identity.pluginId, localId: identity.localId };
}

/** The bundled routing id a canonical Agent key names, for callers that route by it. */
function resolveBundledAgentRoutingIdV1(identity: PluginContributionIdentityV1): string | null {
  const persistedAgentId = resolveAgentIdFromPersistedContributionIdentityV1(identity);
  if (persistedAgentId) return persistedAgentId;
  for (const [agentId, candidate] of Object.entries(BUNDLED_AGENT_CONTRIBUTION_IDENTITIES_V1)) {
    if (candidate.pluginId === identity.pluginId && candidate.localId === identity.localId) return agentId;
  }
  return null;
}

export const BackendTargetSourceKindV2Schema = lazyZodSchema(() => z.enum(['built_in', 'configured']));
export type BackendTargetSourceKindV2 = z.infer<typeof BackendTargetSourceKindV2Schema>;

export const BackendTargetRefV2Schema = lazyZodSchema(() => z.object({
  kind: z.literal('backend'),
  backendId: z.string().min(1),
  configuredBackendId: z.string().min(1).optional(),
  sourceKind: BackendTargetSourceKindV2Schema.optional(),
}).superRefine((value, ctx) => {
  if (hasLegacyCustomAcpConcreteBackendId({
    backendId: value.backendId,
    configuredBackendId: value.configuredBackendId,
  })) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['backendId'],
      message: 'backendTarget must identify a concrete backend',
    });
    return;
  }
  if (value.sourceKind === 'configured' && !value.configuredBackendId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['configuredBackendId'],
      message: 'configuredBackendId is required when sourceKind is configured',
    });
  }
}));
export type BackendTargetRefV2 = z.infer<typeof BackendTargetRefV2Schema>;

/**
 * Compatibility name for persisted backend-target readers and writers.
 * The canonical model is AgentExecutionTargetV1.
 */
export const PersistedAgentTargetRefV1Schema = AgentExecutionTargetV1Schema;
export type PersistedAgentTargetRefV1 = AgentExecutionTargetV1;

export const PersistedBackendTargetRefV2Schema = lazyZodSchema(() => z.union([
  BackendTargetRefV2Schema,
  PersistedAgentTargetRefV1Schema,
]));
export type PersistedBackendTargetRefV2 = z.infer<typeof PersistedBackendTargetRefV2Schema>;

function isBackendTargetKeyV2(value: string): boolean {
  if (/^backend:[^:]+(?::configured:[^:]+)?$/.test(value)) return true;
  if (!value.startsWith('agent:')) return false;
  const [qualifiedIdentity, encodedDefinitionId, ...extra] = value.slice('agent:'.length).split(':definition:');
  if (extra.length > 0) return false;
  if (!qualifiedIdentity) return false;
  const separatorIndex = qualifiedIdentity.indexOf('/');
  if (separatorIndex <= 0) return false;
  const parsedIdentity = PluginContributionIdentityV1Schema.safeParse({
    pluginId: qualifiedIdentity.slice(0, separatorIndex),
    localId: qualifiedIdentity.slice(separatorIndex + 1),
  });
  if (!parsedIdentity.success || buildQualifiedPluginContributionKey(parsedIdentity.data) !== qualifiedIdentity) return false;
  try {
    const definitionId = encodedDefinitionId === undefined ? undefined : decodeURIComponent(encodedDefinitionId);
    return (encodedDefinitionId === undefined || encodeURIComponent(definitionId!) === encodedDefinitionId)
      && AgentExecutionTargetV1Schema.safeParse({ kind: 'agent', identity: parsedIdentity.data,
        ...(definitionId === undefined ? {} : { definitionId }) }).success;
  } catch {
    return false;
  }
}

export const BackendTargetKeyV2Schema = lazyZodSchema(() => z
  .string()
  .refine(isBackendTargetKeyV2, 'Invalid V2 backend target key'));
export type BackendTargetKeyV2 = z.infer<typeof BackendTargetKeyV2Schema>;

export function buildBackendTargetKeyV2(target: BackendTargetRefV2 | AgentExecutionTargetV1): BackendTargetKeyV2 {
  const parsedAgentTarget = AgentExecutionTargetV1Schema.safeParse(target);
  if (parsedAgentTarget.success) {
    return BackendTargetKeyV2Schema.parse(
      `agent:${buildQualifiedPluginContributionKey(parsedAgentTarget.data.identity)}${parsedAgentTarget.data.definitionId === undefined
        ? '' : `:definition:${encodeURIComponent(parsedAgentTarget.data.definitionId)}`}`,
    );
  }
  const parsedTarget = BackendTargetRefV2Schema.parse(target);
  if (parsedTarget.configuredBackendId) {
    return buildBackendTargetKeyV2({ kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1,
      definitionId: parsedTarget.configuredBackendId });
  }
  if (!parsedTarget.configuredBackendId && parsedTarget.sourceKind !== 'configured') {
    const identity = resolveBundledAgentIdentityV1(parsedTarget.backendId)
      ?? parseQualifiedPluginContributionKey(parsedTarget.backendId);
    if (identity) {
      return BackendTargetKeyV2Schema.parse(
        `agent:${buildQualifiedPluginContributionKey(identity)}`,
      );
    }
  }
  return BackendTargetKeyV2Schema.parse(`backend:${parsedTarget.backendId}`);
}

export function parseBackendTargetKeyV2(key: string): PersistedBackendTargetRefV2 {
  const parsed = BackendTargetKeyV2Schema.parse(key);
  if (parsed.startsWith('agent:')) {
    const [qualifiedIdentity, encodedDefinitionId] = parsed.slice('agent:'.length).split(':definition:');
    if (!qualifiedIdentity) throw new Error('Agent target identity is required');
    const separatorIndex = qualifiedIdentity.indexOf('/');
    const identity = PluginContributionIdentityV1Schema.parse({
      pluginId: qualifiedIdentity.slice(0, separatorIndex),
      localId: qualifiedIdentity.slice(separatorIndex + 1),
    });
    return PersistedAgentTargetRefV1Schema.parse({
      kind: 'agent',
      identity,
      ...(encodedDefinitionId === undefined ? {} : { definitionId: decodeURIComponent(encodedDefinitionId) }),
    });
  }
  const configuredMarker = ':configured:';
  const withoutPrefix = parsed.slice('backend:'.length);
  const configuredIndex = withoutPrefix.indexOf(configuredMarker);

  if (configuredIndex === -1) {
    return BackendTargetRefV2Schema.parse({
      kind: 'backend',
      backendId: withoutPrefix,
      sourceKind: 'built_in',
    });
  }

  return BackendTargetRefV2Schema.parse({
    kind: 'backend',
    backendId: withoutPrefix.slice(0, configuredIndex),
    configuredBackendId: withoutPrefix.slice(configuredIndex + configuredMarker.length),
    sourceKind: 'configured',
  });
}

export function normalizeBackendTargetKeyV2Input(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  try {
    return buildBackendTargetKeyV2(readBackendTargetRefV2(input as BackendTargetRefV2Input));
  } catch {
    return input;
  }
}

export const BackendTargetKeyV2InputSchema = lazyZodSchema(() => z.preprocess(
  normalizeBackendTargetKeyV2Input,
  BackendTargetKeyV2Schema,
));

export const BackendTargetRefV2InputSchema = lazyZodSchema(() => z.union([
  BackendTargetRefV2Schema,
  PersistedAgentTargetRefV1Schema,
  BackendTargetKeyV2Schema,
  BackendTargetRefSchema,
  BackendTargetKeySchema,
]));
export type BackendTargetRefV2Input = z.infer<typeof BackendTargetRefV2InputSchema>;

export function readBackendTargetRefV2(input: BackendTargetRefV2Input): BackendTargetRefV2 {
  if (typeof input === 'string') {
    const parsedV2Key = BackendTargetKeyV2Schema.safeParse(input);
    if (parsedV2Key.success) {
      const parsedTarget = parseBackendTargetKeyV2(parsedV2Key.data);
      if (parsedTarget.kind === 'backend') {
        return parsedTarget;
      }
      if (parsedTarget.definitionId) {
        return BackendTargetRefV2Schema.parse({ kind: 'backend', backendId: parsedTarget.definitionId,
          configuredBackendId: parsedTarget.definitionId, sourceKind: 'configured' });
      }
      const agentId = resolveBundledAgentRoutingIdV1(parsedTarget.identity);
      if (!agentId) {
        throw new Error('Qualified Agent identity requires host catalog resolution');
      }
      return BackendTargetRefV2Schema.parse({
        kind: 'backend',
        backendId: agentId,
        sourceKind: 'built_in',
      });
    }
    return convertBackendTargetRefV1ToV2(parseBackendTargetKey(input));
  }

  if (input.kind === 'backend') {
    return BackendTargetRefV2Schema.parse(input);
  }

  if (input.kind === 'agent' && 'identity' in input) {
    const persisted = PersistedAgentTargetRefV1Schema.parse(input);
    if (persisted.definitionId) {
      return BackendTargetRefV2Schema.parse({ kind: 'backend', backendId: persisted.definitionId,
        configuredBackendId: persisted.definitionId, sourceKind: 'configured' });
    }
    const agentId = resolveBundledAgentRoutingIdV1(persisted.identity);
    if (!agentId) {
      throw new Error('Unknown persisted Agent contribution identity');
    }
    return BackendTargetRefV2Schema.parse({
      kind: 'backend',
      backendId: agentId,
      sourceKind: 'built_in',
    });
  }

  return convertBackendTargetRefV1ToV2(BackendTargetRefSchema.parse(input));
}

export function writePersistedBackendTargetRefV2(
  target: BackendTargetRefV2,
): PersistedBackendTargetRefV2 {
  const parsedTarget = BackendTargetRefV2Schema.parse(target);
  if (parsedTarget.configuredBackendId) {
    return PersistedAgentTargetRefV1Schema.parse({ kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1,
      definitionId: parsedTarget.configuredBackendId });
  }
  if (!parsedTarget.configuredBackendId && parsedTarget.sourceKind !== 'configured') {
    const identity = resolvePersistedContributionIdentityV1FromAgentId(parsedTarget.backendId);
    if (identity) {
      return PersistedAgentTargetRefV1Schema.parse({
        kind: 'agent',
        identity,
      });
    }
  }
  return parsedTarget;
}

export function convertBackendTargetRefV2ToV1(target: BackendTargetRefV2): BackendTargetRefV1 {
  const parsedTarget = BackendTargetRefV2Schema.parse(target);
  if (parsedTarget.sourceKind === 'configured' || parsedTarget.configuredBackendId) {
    return BackendTargetRefSchema.parse({
      kind: 'configuredAcpBackend',
      backendId: parsedTarget.configuredBackendId ?? parsedTarget.backendId,
    });
  }

  return BackendTargetRefSchema.parse({
    kind: 'builtInAgent',
    agentId: parsedTarget.backendId,
  });
}

export function normalizeBackendTargetRefV2InputToV1(input: unknown): unknown {
  if (input === null || input === undefined) {
    return input;
  }

  try {
    return convertBackendTargetRefV2ToV1(readBackendTargetRefV2(input as BackendTargetRefV2Input));
  } catch {
    return input;
  }
}

export function normalizeBackendTargetRefV2InputToV2(input: unknown): unknown {
  if (input === null || input === undefined) {
    return input;
  }

  try {
    return readBackendTargetRefV2(input as BackendTargetRefV2Input);
  } catch {
    return input;
  }
}

function convertBackendTargetRefV1ToV2(input: BackendTargetRefV1): BackendTargetRefV2 {
  if (input.kind === 'builtInAgent') {
    // V1 still uses `builtInAgent.agentId` as the only non-configured carrier on some
    // compatibility surfaces, including plugin backend ids. Preserve that input shape
    // here, but do not treat it as proof that the backend is a built-in catalog agent.
    return BackendTargetRefV2Schema.parse({
      kind: 'backend',
      backendId: input.agentId,
      sourceKind: 'built_in',
    });
  }

  return BackendTargetRefV2Schema.parse({
    kind: 'backend',
    backendId: input.backendId,
    configuredBackendId: input.backendId,
    sourceKind: 'configured',
  });
}

export function formatBackendTargetKeyV2(target: PersistedBackendTargetRefV2): BackendTargetKeyV2 {
  return buildBackendTargetKeyV2(target);
}

/** Normalize persisted routing references and current Agent identities at their owner. */
export function resolveBackendTargetKeyV2(input: BackendTargetRefV2Input): BackendTargetKeyV2 {
  const canonicalTarget = PersistedBackendTargetRefV2Schema.safeParse(input);
  if (canonicalTarget.success) return buildBackendTargetKeyV2(canonicalTarget.data);
  const canonicalKey = BackendTargetKeyV2Schema.safeParse(input);
  if (canonicalKey.success) {
    if (typeof input === 'string' && input.startsWith('backend:')) {
      try { return buildBackendTargetKeyV2(parseBackendTargetKeyV2(input)); }
      catch { return canonicalKey.data; }
    }
    return canonicalKey.data;
  }
  return buildBackendTargetKeyV2(readBackendTargetRefV2(input));
}

export function backendTargetKeysMatch(left: BackendTargetRefV2Input, right: BackendTargetRefV2Input): boolean {
  try { return resolveBackendTargetKeyV2(left) === resolveBackendTargetKeyV2(right); }
  catch { return false; }
}
