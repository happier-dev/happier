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
  resolveAgentIdFromPersistedContributionIdentityV1,
  resolvePersistedContributionIdentityV1FromAgentId,
} from '../../plugins/contributionIdentity.js';
import {
  AgentExecutionTargetV1Schema,
  type AgentExecutionTargetV1,
} from '../../agents/executionTargetV1.js';

export const BackendTargetSourceKindV2Schema = z.enum(['built_in', 'configured']);
export type BackendTargetSourceKindV2 = z.infer<typeof BackendTargetSourceKindV2Schema>;

export const BackendTargetRefV2Schema = z.object({
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
});
export type BackendTargetRefV2 = z.infer<typeof BackendTargetRefV2Schema>;

/**
 * Compatibility name for persisted backend-target readers and writers.
 * The canonical model is AgentExecutionTargetV1.
 */
export const PersistedAgentTargetRefV1Schema = AgentExecutionTargetV1Schema;
export type PersistedAgentTargetRefV1 = AgentExecutionTargetV1;

export const PersistedBackendTargetRefV2Schema = z.union([
  BackendTargetRefV2Schema,
  PersistedAgentTargetRefV1Schema,
]);
export type PersistedBackendTargetRefV2 = z.infer<typeof PersistedBackendTargetRefV2Schema>;

function isBackendTargetKeyV2(value: string): boolean {
  if (/^backend:[^:]+(?::configured:[^:]+)?$/.test(value)) return true;
  if (!value.startsWith('agent:')) return false;
  const qualifiedIdentity = value.slice('agent:'.length);
  const separatorIndex = qualifiedIdentity.indexOf('/');
  if (separatorIndex <= 0) return false;
  const parsedIdentity = PluginContributionIdentityV1Schema.safeParse({
    pluginId: qualifiedIdentity.slice(0, separatorIndex),
    localId: qualifiedIdentity.slice(separatorIndex + 1),
  });
  return parsedIdentity.success
    && buildQualifiedPluginContributionKey(parsedIdentity.data) === qualifiedIdentity;
}

export const BackendTargetKeyV2Schema = z
  .string()
  .refine(isBackendTargetKeyV2, 'Invalid V2 backend target key');
export type BackendTargetKeyV2 = z.infer<typeof BackendTargetKeyV2Schema>;

export function buildBackendTargetKeyV2(target: BackendTargetRefV2): BackendTargetKeyV2 {
  const parsedTarget = BackendTargetRefV2Schema.parse(target);
  if (!parsedTarget.configuredBackendId && parsedTarget.sourceKind !== 'configured') {
    const identity = resolvePersistedContributionIdentityV1FromAgentId(parsedTarget.backendId);
    if (identity) {
      return BackendTargetKeyV2Schema.parse(
        `agent:${buildQualifiedPluginContributionKey(identity)}`,
      );
    }
  }
  const suffix = parsedTarget.configuredBackendId ? `:configured:${parsedTarget.configuredBackendId}` : '';
  return BackendTargetKeyV2Schema.parse(`backend:${parsedTarget.backendId}${suffix}`);
}

export function parseBackendTargetKeyV2(key: string): BackendTargetRefV2 {
  const parsed = BackendTargetKeyV2Schema.parse(key);
  if (parsed.startsWith('agent:')) {
    const qualifiedIdentity = parsed.slice('agent:'.length);
    const separatorIndex = qualifiedIdentity.indexOf('/');
    const identity = PluginContributionIdentityV1Schema.parse({
      pluginId: qualifiedIdentity.slice(0, separatorIndex),
      localId: qualifiedIdentity.slice(separatorIndex + 1),
    });
    const agentId = resolveAgentIdFromPersistedContributionIdentityV1(identity);
    if (!agentId) {
      throw new Error('Unknown persisted Agent contribution identity');
    }
    return BackendTargetRefV2Schema.parse({
      kind: 'backend',
      backendId: agentId,
      sourceKind: 'built_in',
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

export const BackendTargetKeyV2InputSchema = z.preprocess(
  normalizeBackendTargetKeyV2Input,
  BackendTargetKeyV2Schema,
);

export const BackendTargetRefV2InputSchema = z.union([
  BackendTargetRefV2Schema,
  PersistedAgentTargetRefV1Schema,
  BackendTargetKeyV2Schema,
  BackendTargetRefSchema,
  BackendTargetKeySchema,
]);
export type BackendTargetRefV2Input = z.infer<typeof BackendTargetRefV2InputSchema>;

export function readBackendTargetRefV2(input: BackendTargetRefV2Input): BackendTargetRefV2 {
  if (typeof input === 'string') {
    const parsedV2Key = BackendTargetKeyV2Schema.safeParse(input);
    if (parsedV2Key.success) {
      return parseBackendTargetKeyV2(parsedV2Key.data);
    }
    return convertBackendTargetRefV1ToV2(parseBackendTargetKey(input));
  }

  if (input.kind === 'backend') {
    return BackendTargetRefV2Schema.parse(input);
  }

  if (input.kind === 'agent' && 'identity' in input) {
    const persisted = PersistedAgentTargetRefV1Schema.parse(input);
    const agentId = resolveAgentIdFromPersistedContributionIdentityV1(persisted.identity);
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
