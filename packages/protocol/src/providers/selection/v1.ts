import { z } from 'zod';

import { decodeBase64, encodeBase64 } from '../../crypto/base64.js';
import { ProviderAgentTargetKeySchema, ProviderConnectionIdSchema, ProviderModelIdSchema } from '../ids.js';

const NativeModelRefSchema = z.object({
  agentTargetKey: ProviderAgentTargetKeySchema,
  providerConnectionId: z.null(),
  modelId: ProviderModelIdSchema,
}).strict();
const ConnectionModelRefSchema = z.object({
  agentTargetKey: ProviderAgentTargetKeySchema,
  providerConnectionId: ProviderConnectionIdSchema,
  modelId: ProviderModelIdSchema,
}).strict();
export const ProviderBoundModelRefSchema = z.union([NativeModelRefSchema, ConnectionModelRefSchema]);
export type ProviderBoundModelRef = z.infer<typeof ProviderBoundModelRefSchema>;

export const SessionModelSelectionV1Schema = z.object({
  v: z.literal(1),
  ref: ProviderBoundModelRefSchema,
  updatedAt: z.number().finite().nonnegative(),
}).strict();
export type SessionModelSelectionV1 = z.infer<typeof SessionModelSelectionV1Schema>;

export const SessionModelSelectionIntentV1Schema = z.object({
  v: z.literal(1),
  updatedAt: z.number().finite().nonnegative(),
  selection: ProviderBoundModelRefSchema.nullable(),
}).strict();
export type SessionModelSelectionIntentV1 = z.infer<typeof SessionModelSelectionIntentV1Schema>;

/**
 * Converts a flat model-selection boundary into the canonical structured ref.
 * The legacy `default` reset sentinel is meaningful only for a native
 * selection; a provider is allowed to expose a literal model named `default`.
 */
export function resolveSessionModelSelectionInputRefV1(input: Readonly<{
  agentTargetKey: string;
  providerConnectionId?: string | null;
  modelId: string;
}>): ProviderBoundModelRef | null {
  const agentTargetKey = ProviderAgentTargetKeySchema.parse(input.agentTargetKey);
  const providerConnectionId = input.providerConnectionId == null
    ? null
    : ProviderConnectionIdSchema.parse(input.providerConnectionId);
  const normalizedModelId = input.modelId.trim();
  if (!normalizedModelId || (normalizedModelId === 'default' && providerConnectionId === null)) {
    if (providerConnectionId !== null) {
      ProviderModelIdSchema.parse(normalizedModelId);
    }
    return null;
  }
  return ProviderBoundModelRefSchema.parse({
    agentTargetKey,
    providerConnectionId,
    modelId: normalizedModelId,
  });
}

const LegacyModelOverrideV1Schema = z.object({
  v: z.literal(1),
  updatedAt: z.number().finite().nonnegative(),
  modelId: z.string().nullable(),
}).passthrough();

export type SessionModelSelectionResolutionErrorCode =
  | 'model_selection_agent_target_unknown'
  | 'model_selection_agent_target_mismatch';

export class SessionModelSelectionResolutionError extends Error {
  readonly code: SessionModelSelectionResolutionErrorCode;

  constructor(code: SessionModelSelectionResolutionErrorCode) {
    super(code === 'model_selection_agent_target_unknown'
      ? 'Model selection agent target is unavailable'
      : 'Model selection agent target mismatch');
    this.name = 'SessionModelSelectionResolutionError';
    this.code = code;
  }
}

export function resolveSessionModelSelectionIntentV1(input: Readonly<{
  canonical: unknown;
  legacy: unknown;
  agentTargetKey: string;
}>): SessionModelSelectionIntentV1 | null {
  const parsedAgentTargetKey = ProviderAgentTargetKeySchema.safeParse(input.agentTargetKey);
  if (!parsedAgentTargetKey.success) {
    throw new SessionModelSelectionResolutionError('model_selection_agent_target_unknown');
  }
  const agentTargetKey = parsedAgentTargetKey.data;
  const canonical = SessionModelSelectionIntentV1Schema.safeParse(input.canonical);
  if (canonical.success
    && canonical.data.selection !== null
    && canonical.data.selection.agentTargetKey !== agentTargetKey) {
    throw new SessionModelSelectionResolutionError('model_selection_agent_target_mismatch');
  }

  const legacy = LegacyModelOverrideV1Schema.safeParse(input.legacy);
  const legacyIntent: SessionModelSelectionIntentV1 | null = legacy.success
    ? {
      v: 1,
      updatedAt: legacy.data.updatedAt,
      selection: legacy.data.modelId === null || legacy.data.modelId === 'default'
        ? null
        : ProviderBoundModelRefSchema.parse({
          agentTargetKey,
          providerConnectionId: null,
          modelId: legacy.data.modelId,
        }),
    }
    : null;

  if (!canonical.success) return legacyIntent;
  if (!legacyIntent || canonical.data.updatedAt >= legacyIntent.updatedAt) return canonical.data;
  return legacyIntent;
}

export function parseSessionModelSelectionV1(
  value: unknown,
  legacy: Readonly<{ agentTargetKey: string; updatedAt: number }>,
): SessionModelSelectionV1 {
  const parsed = SessionModelSelectionV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (typeof value === 'string') {
    return SessionModelSelectionV1Schema.parse({
      v: 1,
      ref: { agentTargetKey: legacy.agentTargetKey, providerConnectionId: null, modelId: value },
      updatedAt: legacy.updatedAt,
    });
  }
  throw new Error('Invalid session model selection');
}

export const ModelVisibilityRefV1Schema = z.union([
  z.object({ scope: z.literal('agent'), agentTargetKey: ProviderAgentTargetKeySchema, providerConnectionId: z.null(), modelId: ProviderModelIdSchema }).strict(),
  z.object({ scope: z.literal('agent'), agentTargetKey: ProviderAgentTargetKeySchema, providerConnectionId: ProviderConnectionIdSchema, modelId: ProviderModelIdSchema }).strict(),
  z.object({ scope: z.literal('allAgents'), providerConnectionId: ProviderConnectionIdSchema, modelId: ProviderModelIdSchema }).strict(),
]);
export type ModelVisibilityRefV1 = z.infer<typeof ModelVisibilityRefV1Schema>;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const SESSION_MODEL_SELECTION_V1_TRANSPORT_PREFIX = 'sms1:';
const SESSION_MODEL_SELECTION_V1_TRANSPORT_MAX_LENGTH = 4096;

/**
 * Canonical non-secret transport for carrying a complete model selection through
 * child-process argv without delimiter ambiguity or provider-connection loss.
 */
export function serializeSessionModelSelectionV1(selection: SessionModelSelectionV1): string {
  const parsed = SessionModelSelectionV1Schema.parse(selection);
  return `${SESSION_MODEL_SELECTION_V1_TRANSPORT_PREFIX}${encodeBase64(
    encoder.encode(JSON.stringify(parsed)),
    'base64url',
  ).replace(/=+$/u, '')}`;
}

export function deserializeSessionModelSelectionV1(value: string): SessionModelSelectionV1 {
  if (
    !value.startsWith(SESSION_MODEL_SELECTION_V1_TRANSPORT_PREFIX)
    || value.length > SESSION_MODEL_SELECTION_V1_TRANSPORT_MAX_LENGTH
  ) {
    throw new Error('Invalid session model selection transport');
  }
  try {
    const parsed = SessionModelSelectionV1Schema.parse(JSON.parse(decoder.decode(decodeBase64(
      value.slice(SESSION_MODEL_SELECTION_V1_TRANSPORT_PREFIX.length),
      'base64url',
    ))) as unknown);
    if (serializeSessionModelSelectionV1(parsed) !== value) {
      throw new Error('Invalid session model selection transport');
    }
    return parsed;
  } catch {
    throw new Error('Invalid session model selection transport');
  }
}

export function serializeModelVisibilityRefV1(ref: ModelVisibilityRefV1): string {
  const parsed = ModelVisibilityRefV1Schema.parse(ref);
  const tuple = parsed.scope === 'allAgents'
    ? [parsed.scope, null, parsed.providerConnectionId, parsed.modelId]
    : [parsed.scope, parsed.agentTargetKey, parsed.providerConnectionId, parsed.modelId];
  return `mvr1:${encodeBase64(encoder.encode(JSON.stringify(tuple)), 'base64url').replace(/=+$/u, '')}`;
}

export function deserializeModelVisibilityRefV1(key: string): ModelVisibilityRefV1 {
  if (!key.startsWith('mvr1:')) throw new Error('Invalid model visibility key');
  const tuple = JSON.parse(decoder.decode(decodeBase64(key.slice(5), 'base64url'))) as unknown;
  if (!Array.isArray(tuple) || tuple.length !== 4) throw new Error('Invalid model visibility tuple');
  const [scope, agentTargetKey, providerConnectionId, modelId] = tuple;
  const parsed = ModelVisibilityRefV1Schema.parse(scope === 'allAgents'
    ? { scope, providerConnectionId, modelId }
    : { scope, agentTargetKey, providerConnectionId, modelId });
  if (serializeModelVisibilityRefV1(parsed) !== key) throw new Error('Invalid model visibility key');
  return parsed;
}
