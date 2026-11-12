import { lazyDefinition, lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { projectZodProtocolSchema } from '../../plugins/actions/internalProtocolZodAdapter.js';

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
export function resolveBundledAgentRoutingIdV1(identity: PluginContributionIdentityV1): string | null {
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
  backendId: z.string().check(z.minLength(1)),
  configuredBackendId: z.optional(z.string().check(z.minLength(1))),
  sourceKind: z.optional(BackendTargetSourceKindV2Schema),
}).check(z.superRefine((value, ctx) => {
  if (hasLegacyCustomAcpConcreteBackendId({
    backendId: value.backendId,
    configuredBackendId: value.configuredBackendId,
  })) {
    ctx.addIssue({
      code: "custom",
      path: ['backendId'],
      message: 'backendTarget must identify a concrete backend',
    });
    return;
  }
  if (value.sourceKind === 'configured' && !value.configuredBackendId) {
    ctx.addIssue({
      code: "custom",
      path: ['configuredBackendId'],
      message: 'configuredBackendId is required when sourceKind is configured',
    });
  }
  if (!value.configuredBackendId) {
    if (value.backendId.includes(':')) {
      ctx.addIssue({
        code: "custom",
        path: ['backendId'],
        message: 'backendId cannot contain target-key delimiters',
      });
    }
    const identity = resolveBundledAgentIdentityV1(value.backendId) ?? parseQualifiedPluginContributionKey(value.backendId);
    if (identity && !AgentExecutionTargetV1Schema.safeParse({ kind: 'agent', identity }).success) {
      ctx.addIssue({
        code: "custom",
        path: ['backendId'],
        message: 'backendTarget must identify an executable Agent',
      });
    }
  }
})));
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
  if (/^backend:[^:]+(?::configured:[^:]+)?$/.test(value)) {
    const [backendId, configuredBackendId] = value.slice('backend:'.length).split(':configured:');
    return BackendTargetRefV2Schema.safeParse({
      kind: 'backend',
      backendId,
      ...(configuredBackendId === undefined ? {} : { configuredBackendId }),
    }).success;
  }
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
  .string().check(z.refine(isBackendTargetKeyV2, 'Invalid V2 backend target key')));
export type BackendTargetKeyV2 = z.infer<typeof BackendTargetKeyV2Schema>;
export const BackendTargetKeyV2ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(BackendTargetKeyV2Schema));

export function buildBackendTargetKeyV2(target: BackendTargetRefV2 | AgentExecutionTargetV1): BackendTargetKeyV2 {
  // Route by the declared discriminant before admission. Probing the Agent
  // schema with a backend ref asks its neutral identity parser to normalize
  // undefined, constructing discarded strict-JSON and Protocol errors.
  if (target?.kind === 'agent') {
    const parsedAgentTarget = AgentExecutionTargetV1Schema.parse(target);
    return BackendTargetKeyV2Schema.parse(
      `agent:${buildQualifiedPluginContributionKey(parsedAgentTarget.identity)}${parsedAgentTarget.definitionId === undefined
        ? '' : `:definition:${encodeURIComponent(parsedAgentTarget.definitionId)}`}`,
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

export const BackendTargetKeyV2InputSchema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(normalizeBackendTargetKeyV2Input), BackendTargetKeyV2Schema));

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
  if (typeof input !== 'string') {
    return buildBackendTargetKeyV2(input.kind === 'backend' || input.kind === 'agent'
      ? input : readBackendTargetRefV2(input));
  }
  const canonicalKey = BackendTargetKeyV2Schema.safeParse(input);
  if (canonicalKey.success) {
    if (typeof input === 'string' && input.startsWith('backend:')) {
      return buildBackendTargetKeyV2(parseBackendTargetKeyV2(input));
    }
    return canonicalKey.data;
  }
  return buildBackendTargetKeyV2(readBackendTargetRefV2(input));
}

/**
 * Presentation and persisted-data reads classify invalid targets as unresolved.
 * Construction and request/write admission keep using the strict owner above.
 * Unexpected source failures are not target validation failures.
 */
export function readBackendTargetKeyV2(input: unknown): BackendTargetKeyV2 | null {
  try {
    // Select the existing validator by carrier kind. Union probing asks the
    // neutral Agent identity adapter to admit missing identity for valid keys
    // and historical refs, allocating discarded ProtocolValidationErrors.
    if (typeof input === 'string') {
      const canonicalKey = BackendTargetKeyV2Schema.safeParse(input);
      return resolveBackendTargetKeyV2(canonicalKey.success ? canonicalKey.data : BackendTargetKeySchema.parse(input));
    }
    const kind = input !== null && typeof input === 'object' && 'kind' in input ? input.kind : null;
    return resolveBackendTargetKeyV2(kind === 'backend' ? BackendTargetRefV2Schema.parse(input)
      : kind === 'agent' ? PersistedAgentTargetRefV1Schema.parse(input) : BackendTargetRefSchema.parse(input));
  } catch (error) {
    if (!(error instanceof z.core.$ZodError)) throw error;
    return null;
  }
}

export function backendTargetKeysMatch(left: BackendTargetRefV2Input, right: BackendTargetRefV2Input): boolean {
  const leftKey = readBackendTargetKeyV2(left);
  return leftKey !== null && leftKey === readBackendTargetKeyV2(right);
}
