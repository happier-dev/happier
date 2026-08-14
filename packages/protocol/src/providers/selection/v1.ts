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

export const SessionActiveModelSelectionV1Schema = z.object({
  v: z.literal(1),
  selection: ProviderBoundModelRefSchema,
  source: z.enum(['runtime_readback', 'runtime_apply']),
  runner: z.object({
    pid: z.number().int().positive(),
    processStartTimeMs: z.number().int().nonnegative(),
  }).strict(),
}).strict();
export type SessionActiveModelSelectionV1 = z.infer<
  typeof SessionActiveModelSelectionV1Schema
>;

export const SESSION_APPLIED_MODEL_V1_METADATA_KEY = 'sessionAppliedModelV1';

/**
 * Last model attached to an exact provider-accepted new-turn input.
 *
 * `provider` + `modelId` are the Remote Dev predecessor projection. Dev adds the
 * structured selection so provider-connection identity is not lost. Remote Dev
 * readers ignore the additive field and Dev readers accept predecessor records
 * without it.
 */
export const SessionAppliedModelV1Schema = z.object({
  v: z.literal(1),
  provider: z.string().min(1).max(256),
  updatedAt: z.number().finite().nonnegative(),
  modelId: ProviderModelIdSchema,
  selection: ProviderBoundModelRefSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.selection && value.selection.modelId !== value.modelId) {
    ctx.addIssue({
      code: 'custom',
      path: ['selection', 'modelId'],
      message: 'Structured applied-model selection must match modelId',
    });
  }
});
export type SessionAppliedModelV1 = z.infer<typeof SessionAppliedModelV1Schema>;

export const SESSION_MESSAGE_MODEL_SELECTION_V1_META_KEY = 'modelSelectionV1';

export const SessionMessageModelSelectionV1Schema = SessionModelSelectionV1Schema.superRefine(
  (selection, ctx) => {
    if (selection.ref.providerConnectionId === null && selection.ref.modelId === 'default') {
      ctx.addIssue({
        code: 'custom',
        path: ['ref', 'modelId'],
        message: 'Native per-message model selection cannot use the legacy default reset token',
      });
    }
  },
);

export type SessionMessageModelSelectionV1ReadResult =
  | Readonly<{ status: 'absent' }>
  | Readonly<{ status: 'invalid' }>
  | Readonly<{ status: 'valid'; selection: SessionModelSelectionV1 }>;

/**
 * Reads the additive, structured per-message selection seam. The discriminated
 * result lets current readers fail closed when the key is present but malformed,
 * rather than falling back to an ambiguous legacy `model` value.
 */
export function readSessionMessageModelSelectionV1(
  meta: unknown,
): SessionMessageModelSelectionV1ReadResult {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return { status: 'absent' };
  const record = meta as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, SESSION_MESSAGE_MODEL_SELECTION_V1_META_KEY)) {
    return { status: 'absent' };
  }
  const parsed = SessionMessageModelSelectionV1Schema.safeParse(
    record[SESSION_MESSAGE_MODEL_SELECTION_V1_META_KEY],
  );
  return parsed.success
    ? { status: 'valid', selection: parsed.data }
    : { status: 'invalid' };
}

export function withSessionMessageModelSelectionV1(
  meta: Readonly<Record<string, unknown>> | null | undefined,
  selection: SessionModelSelectionV1,
): Record<string, unknown> & { modelSelectionV1: SessionModelSelectionV1 } {
  const parsed = SessionMessageModelSelectionV1Schema.parse(selection);
  const next: Record<string, unknown> & { modelSelectionV1: SessionModelSelectionV1 } = {
    ...(meta ?? {}),
    [SESSION_MESSAGE_MODEL_SELECTION_V1_META_KEY]: parsed,
  };
  const legacyModel = projectSessionMessageModelSelectionToLegacyModelV1(parsed);
  if (legacyModel === undefined) {
    delete next.model;
  } else {
    next.model = legacyModel;
  }
  return next;
}

/**
 * Projects a structured per-message selection onto the released providerless
 * message seam. Old readers receive native models only; provider-bound choices
 * and the legacy `default` reset token are omitted so they degrade closed.
 */
export function projectSessionMessageModelSelectionToLegacyModelV1(
  value: SessionModelSelectionV1,
): string | undefined {
  const selection = SessionModelSelectionV1Schema.parse(value);
  return selection.ref.providerConnectionId === null && selection.ref.modelId !== 'default'
    ? selection.ref.modelId
    : undefined;
}

export const SessionModelSelectionIntentV1Schema = z.object({
  v: z.literal(1),
  updatedAt: z.number().finite().nonnegative(),
  selection: ProviderBoundModelRefSchema.nullable(),
}).strict();
export type SessionModelSelectionIntentV1 = z.infer<typeof SessionModelSelectionIntentV1Schema>;

export type LegacyModelOverrideProjectionV1 = Readonly<{
  v: 1;
  updatedAt: number;
  modelId: string;
}>;

/**
 * Projects canonical model intent onto the released providerless metadata seam.
 * Native selections and clears remain representable; provider-bound selections
 * are omitted because old readers cannot preserve their connection identity.
 *
 * Remove only after every supported CLI/web reader consumes the canonical
 * intent and the mixed-version rollback window for `modelOverrideV1` is closed.
 */
export function projectSessionModelSelectionIntentToLegacyModelOverrideV1(
  value: SessionModelSelectionIntentV1,
): LegacyModelOverrideProjectionV1 | undefined {
  const intent = SessionModelSelectionIntentV1Schema.parse(value);
  if (intent.selection && intent.selection.providerConnectionId !== null) return undefined;
  const modelId = intent.selection?.modelId ?? 'default';
  return { v: 1, updatedAt: intent.updatedAt, modelId };
}

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

type NormalizedLegacyModelSelectionIntentV1 = Readonly<{
  updatedAt: number;
  modelId: string | null;
}>;

function normalizeLegacyModelSelectionIntentV1(value: unknown): NormalizedLegacyModelSelectionIntentV1 | null {
  const legacy = LegacyModelOverrideV1Schema.safeParse(value);
  if (!legacy.success) return null;

  const modelId = legacy.data.modelId?.trim() ?? null;
  if (modelId === null || modelId === 'default') {
    return { updatedAt: legacy.data.updatedAt, modelId: null };
  }
  if (!modelId) return null;

  const parsedModelId = ProviderModelIdSchema.safeParse(modelId);
  return parsedModelId.success
    ? { updatedAt: legacy.data.updatedAt, modelId: parsedModelId.data }
    : null;
}

type EffectiveModelSelectionIntentSourceV1 =
  | Readonly<{ kind: 'canonical'; intent: SessionModelSelectionIntentV1 }>
  | Readonly<{ kind: 'legacy'; intent: NormalizedLegacyModelSelectionIntentV1 }>;

function selectEffectiveModelSelectionIntentSourceV1(
  canonical: SessionModelSelectionIntentV1 | null,
  legacy: NormalizedLegacyModelSelectionIntentV1 | null,
): EffectiveModelSelectionIntentSourceV1 | null {
  if (canonical?.selection && canonical.selection.providerConnectionId !== null) {
    return { kind: 'canonical', intent: canonical };
  }
  if (canonical && (!legacy || canonical.updatedAt >= legacy.updatedAt)) {
    return { kind: 'canonical', intent: canonical };
  }
  return legacy ? { kind: 'legacy', intent: legacy } : null;
}

export function sessionModelSelectionIntentRequiresAgentTargetV1(input: Readonly<{
  canonical: unknown;
  legacy: unknown;
}>): boolean {
  const canonical = SessionModelSelectionIntentV1Schema.safeParse(input.canonical);
  const normalizedCanonical = canonical.success ? canonical.data : null;
  const legacy = normalizeLegacyModelSelectionIntentV1(input.legacy);
  const source = selectEffectiveModelSelectionIntentSourceV1(normalizedCanonical, legacy);
  if (!source) return false;
  return source.kind === 'canonical'
    ? source.intent.selection !== null
    : source.intent.modelId !== null;
}

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
  const canonical = SessionModelSelectionIntentV1Schema.safeParse(input.canonical);
  const normalizedCanonical = canonical.success ? canonical.data : null;
  const legacy = normalizeLegacyModelSelectionIntentV1(input.legacy);
  const source = selectEffectiveModelSelectionIntentSourceV1(normalizedCanonical, legacy);
  if (!source) return null;
  if (source.kind === 'canonical' && source.intent.selection === null) return source.intent;
  if (source.kind === 'legacy' && source.intent.modelId === null) {
    return { v: 1, updatedAt: source.intent.updatedAt, selection: null };
  }

  const parsedAgentTargetKey = ProviderAgentTargetKeySchema.safeParse(input.agentTargetKey);
  if (!parsedAgentTargetKey.success) {
    throw new SessionModelSelectionResolutionError('model_selection_agent_target_unknown');
  }
  const agentTargetKey = parsedAgentTargetKey.data;
  if (source.kind === 'canonical') {
    if (source.intent.selection !== null
      && source.intent.selection.agentTargetKey !== agentTargetKey) {
      throw new SessionModelSelectionResolutionError('model_selection_agent_target_mismatch');
    }
    return source.intent;
  }
  return {
    v: 1,
    updatedAt: source.intent.updatedAt,
    selection: ProviderBoundModelRefSchema.parse({
      agentTargetKey,
      providerConnectionId: null,
      modelId: source.intent.modelId,
    }),
  };
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
