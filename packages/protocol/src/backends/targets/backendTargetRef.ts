import { z } from 'zod';
import { hasLegacyCustomAcpConcreteBackendId } from './compat/customAcp.js';

/**
 * Compatibility-only V1 backend-target carrier.
 *
 * Canonical active protocol/backend-target truth is `BackendTargetRefV2` under `backendTargetRefV2.ts`.
 * This file remains only as an explicit bounded compatibility seam for older callers and payloads.
 */
export const LegacyBackendTargetKindSchema = z.enum(['builtInAgent', 'configuredAcpBackend']);
export type LegacyBackendTargetKind = z.infer<typeof LegacyBackendTargetKindSchema>;

const LegacyBuiltInAgentTargetSchema = z.object({
  kind: z.literal('builtInAgent'),
  agentId: z.string().min(1),
}).superRefine((value, ctx) => {
  if (!hasLegacyCustomAcpConcreteBackendId({ backendId: value.agentId })) {
    return;
  }

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['agentId'],
    message: 'backendTarget must identify a concrete backend',
  });
});

const LegacyConfiguredAcpBackendTargetSchema = z.object({
  kind: z.literal('configuredAcpBackend'),
  backendId: z.string().min(1),
}).superRefine((value, ctx) => {
  if (!hasLegacyCustomAcpConcreteBackendId({ configuredBackendId: value.backendId })) {
    return;
  }

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['backendId'],
    message: 'backendTarget must identify a concrete backend',
  });
});

export const LegacyBackendTargetRefSchema = z.union([
  LegacyBuiltInAgentTargetSchema,
  LegacyConfiguredAcpBackendTargetSchema,
]);
export type LegacyBackendTargetRefV1 = z.infer<typeof LegacyBackendTargetRefSchema>;

export const LegacyBackendTargetKeySchema = z
  .string()
  .regex(/^(agent|acpBackend):.+$/, 'Invalid backend target key')
  .superRefine((value, ctx) => {
    const rawId = value.startsWith('agent:')
      ? value.slice('agent:'.length)
      : value.startsWith('acpBackend:')
        ? value.slice('acpBackend:'.length)
        : '';
    if (!rawId || !hasLegacyCustomAcpConcreteBackendId({
      ...(value.startsWith('agent:') ? { backendId: rawId } : { configuredBackendId: rawId }),
    })) {
      return;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'backendTarget must identify a concrete backend',
    });
  });
export type LegacyBackendTargetKey = z.infer<typeof LegacyBackendTargetKeySchema>;

export function buildLegacyBackendTargetKey(target: LegacyBackendTargetRefV1): LegacyBackendTargetKey {
  return target.kind === 'builtInAgent'
    ? LegacyBackendTargetKeySchema.parse(`agent:${target.agentId}`)
    : LegacyBackendTargetKeySchema.parse(`acpBackend:${target.backendId}`);
}

export function parseLegacyBackendTargetKey(key: string): LegacyBackendTargetRefV1 {
  const parsed = LegacyBackendTargetKeySchema.parse(key);
  if (parsed.startsWith('agent:')) {
    return LegacyBackendTargetRefSchema.parse({ kind: 'builtInAgent', agentId: parsed.slice('agent:'.length) });
  }
  return LegacyBackendTargetRefSchema.parse({ kind: 'configuredAcpBackend', backendId: parsed.slice('acpBackend:'.length) });
}

export function isLegacyBuiltInAgentTarget(
  target: LegacyBackendTargetRefV1,
): target is z.infer<typeof LegacyBuiltInAgentTargetSchema> {
  return target.kind === 'builtInAgent';
}

export function isLegacyConfiguredAcpBackendTarget(
  target: LegacyBackendTargetRefV1,
): target is z.infer<typeof LegacyConfiguredAcpBackendTargetSchema> {
  return target.kind === 'configuredAcpBackend';
}

export const BackendTargetKindSchema = LegacyBackendTargetKindSchema;
export type BackendTargetKind = LegacyBackendTargetKind;
export const BackendTargetRefSchema = LegacyBackendTargetRefSchema;
export type BackendTargetRefV1 = LegacyBackendTargetRefV1;
export const BackendTargetKeySchema = LegacyBackendTargetKeySchema;
export type BackendTargetKey = LegacyBackendTargetKey;
export const buildBackendTargetKey = buildLegacyBackendTargetKey;
export const parseBackendTargetKey = parseLegacyBackendTargetKey;
export const isBuiltInAgentTarget = isLegacyBuiltInAgentTarget;
export const isConfiguredAcpBackendTarget = isLegacyConfiguredAcpBackendTarget;
