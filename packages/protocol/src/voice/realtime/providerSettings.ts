import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { z } from '../../zodRuntimePolicy.js';

import { SavedSecretSlotBindingsV1Schema } from '../../providers/settings/v1.js';
import {
  PluginContributionIdentityV1Schema,
  buildQualifiedPluginContributionKey,
} from '../../plugins/contributionIdentity.js';
import { VoiceCredentialSlotIdSchema } from '../../plugins/contributions/voiceProviders.js';
import { PluginJsonValueV2Schema } from '../../plugins/contributions/jsonSchema.js';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";
import { SecretStringV1Schema, type SecretStringV1 } from '../../crypto/settingsSecretStringSchemasV1.js';
import { parseSavedSecretRefV1, type SavedSecretRefV1 } from '../../account/settings/savedSecretReferenceV1.js';

const RESERVED_PROVIDER_IDS = new Set(['constructor', 'prototype']);

const LegacyVoiceProviderIdSchema = lazyZodSchema(() => z
  .string().check(z.minLength(1), z.maxLength(64), z.regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/), z.refine((providerId) => !RESERVED_PROVIDER_IDS.has(providerId), {
    message: 'Reserved provider identifier',
  })));

export const VoiceProviderIdSchema = lazyZodSchema(() => z.string().check(z.minLength(3), z.maxLength(256), z.refine((providerId) => {
  const separator = providerId.indexOf('/');
  if (separator <= 0 || separator === providerId.length - 1) return false;
  const identity = PluginContributionIdentityV1Schema.safeParse({
    pluginId: providerId.slice(0, separator),
    localId: providerId.slice(separator + 1),
  });
  return identity.success && buildQualifiedPluginContributionKey(identity.data) === providerId;
}, { message: 'Voice provider ids must be canonical qualified Plugin contribution keys' })));

export type VoiceProviderId = z.infer<typeof VoiceProviderIdSchema>;

const LegacyVoiceCredentialBindingBaseV1Schema = lazyZodSchema(() => z.strictObject({
  credentialBindings: SavedSecretSlotBindingsV1Schema,
  approvedRecipientContractDigest: z.optional(z.string().check(z.regex(/^sha256:[a-f0-9]{64}$/u))),
}));

export const LegacyVoiceCredentialBindingV1Schema = lazyZodSchema(() => z.extend(LegacyVoiceCredentialBindingBaseV1Schema, {
  providerId: LegacyVoiceProviderIdSchema,
}));

/** The actual predecessor ingress grammar, not a ceiling on the full census. */
export const PredecessorVoiceCredentialBindingV1Schema = lazyZodSchema(() => z.extend(LegacyVoiceCredentialBindingBaseV1Schema, {
  providerId: z.union([LegacyVoiceProviderIdSchema, VoiceProviderIdSchema]),
}).check(z.superRefine((value, context) => {
  if (Object.keys(value.credentialBindings.byMachineId ?? {}).length > 2_048) {
    context.addIssue({ code: 'custom', path: ['credentialBindings', 'byMachineId'], message: 'Too many machine secret-binding branches' });
  }
})));
export type PredecessorVoiceCredentialBindingV1 = Readonly<z.infer<typeof PredecessorVoiceCredentialBindingV1Schema>>;

export type LegacyVoiceCredentialMigrationCandidateV1 = Readonly<{
  providerId: string; slotId: string; path: readonly string[]; canonicalPath?: readonly string[];
}>;

/** Exact predecessor adapters, including its selected speech-adapter priority. */
export function listLegacyVoiceCredentialMigrationCandidatesV1(rawVoiceProviderId: unknown): readonly LegacyVoiceCredentialMigrationCandidateV1[] {
  const selectedSpeechAdapter = rawVoiceProviderId === 'local_direct' || rawVoiceProviderId === 'local_conversation'
    ? rawVoiceProviderId : null;
  const speechAdapterIds = selectedSpeechAdapter === null ? ['local_direct', 'local_conversation'] as const
    : [selectedSpeechAdapter, selectedSpeechAdapter === 'local_direct' ? 'local_conversation' : 'local_direct'] as const;
  return [
    { providerId: 'realtime_elevenlabs', slotId: 'api_key', path: ['realtime_elevenlabs', 'byo', 'apiKey'], canonicalPath: ['providers', 'happier.voice.elevenlabs/realtime-elevenlabs', 'config', 'byo', 'apiKey'] },
    { providerId: 'google_gemini', slotId: 'api_key', path: ['local_direct', 'stt', 'googleGemini', 'apiKey'] },
    { providerId: 'google_cloud', slotId: 'api_key', path: ['local_direct', 'tts', 'googleCloud', 'apiKey'] },
    ...speechAdapterIds.flatMap(adapterId => [
      { providerId: 'happier.voice.openai-compat/stt', slotId: 'api_key', path: [adapterId, 'stt', 'openaiCompat', 'apiKey'] },
      { providerId: 'happier.voice.openai-compat/tts', slotId: 'api_key', path: [adapterId, 'tts', 'openaiCompat', 'apiKey'] },
    ]),
    { providerId: 'openai_compat', slotId: 'chat_api_key', path: ['local_conversation', 'agent', 'openaiCompat', 'chatApiKey'], canonicalPath: ['providers', 'local_conversation', 'config', 'agent', 'openaiCompat', 'chatApiKey'] },
  ];
}

type LegacyVoiceCredentialMaterialV1 = Readonly<{
  rawSecret: SecretStringV1; parsedSecret: SecretStringV1; binding: PredecessorVoiceCredentialBindingV1 | null;
}>;
export type LegacyVoiceCredentialCandidateClassificationV1 =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'unsupported'; rawSecret: unknown }>
  | (LegacyVoiceCredentialMaterialV1 & Readonly<{ kind: 'existing-personal' | 'inline-personal-alias'; secretId: string }>)
  | (LegacyVoiceCredentialMaterialV1 & Readonly<{ kind: 'existing-resource-reference'; resourceRef: string }>);

function legacyVoiceRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
}

/** Shared by runtime compatibility projection and original-source transfer ingress. */
export function classifyLegacyVoiceCredentialCandidateV1(input: Readonly<{
  candidate: LegacyVoiceCredentialMigrationCandidateV1; rawAdapters: unknown;
  personalSources: readonly unknown[]; credentialBindings: unknown;
}>): LegacyVoiceCredentialCandidateClassificationV1 {
  let rawSecret = input.rawAdapters;
  for (const key of input.candidate.path) rawSecret = legacyVoiceRecord(rawSecret)?.[key];
  if (rawSecret == null) return { kind: 'absent' };
  const parsed = createStoredReadSchema(SecretStringV1Schema).safeParse(rawSecret);
  const unsupported = { kind: 'unsupported' as const, rawSecret };
  if (!parsed.success || (input.credentialBindings !== undefined && !Array.isArray(input.credentialBindings))) return unsupported;
  const bindings: readonly unknown[] = Array.isArray(input.credentialBindings) ? input.credentialBindings : [];
  let binding: PredecessorVoiceCredentialBindingV1 | null = null;
  for (const candidate of bindings) {
    if (legacyVoiceRecord(candidate)?.providerId !== input.candidate.providerId) continue;
    const parsedBinding = createStoredReadSchema(PredecessorVoiceCredentialBindingV1Schema).safeParse(candidate);
    if (!parsedBinding.success) return unsupported;
    binding = parsedBinding.data;
    break;
  }
  const material = { rawSecret: rawSecret as SecretStringV1, parsedSecret: parsed.data, binding };
  const encoded = JSON.stringify(parsed.data);
  const hasSameSecret = (candidate: unknown): boolean => {
    const source = createStoredReadSchema(SecretStringV1Schema).safeParse(legacyVoiceRecord(candidate)?.encryptedValue);
    return source.success && JSON.stringify(source.data) === encoded;
  };
  const boundSecretId = binding?.credentialBindings.account?.[input.candidate.slotId];
  if (boundSecretId) {
    let reference: SavedSecretRefV1;
    try { reference = parseSavedSecretRefV1(boundSecretId); } catch { return unsupported; }
    const bound = input.personalSources.find(candidate => legacyVoiceRecord(candidate)?.id === boundSecretId);
    if (reference.kind === 'shared_resource') return bound ? unsupported
      : { ...material, kind: 'existing-resource-reference', resourceRef: boundSecretId };
    return hasSameSecret(bound)
      ? { ...material, kind: 'existing-personal', secretId: boundSecretId } : unsupported;
  }
  const secretId = `voice:${input.candidate.providerId}:${input.candidate.slotId}`;
  const existing = input.personalSources.find(candidate => legacyVoiceRecord(candidate)?.id === secretId);
  if (existing) return hasSameSecret(existing)
    ? { ...material, kind: 'existing-personal', secretId } : unsupported;
  return { ...material, kind: 'inline-personal-alias', secretId };
}

/** Canonical current Voice credential binding keyed only by contribution and slot. */
export const VoiceCredentialBindingV1Schema = lazyZodSchema(() => z.strictObject({
  contribution: asProtocolZod(PluginContributionIdentityV1Schema),
  credentialSlotId: VoiceCredentialSlotIdSchema,
  credentialSource: z.strictObject({
    kind: z.enum(['none', 'savedSecret', 'connectedAccount']),
  }),
  credentialBindings: SavedSecretSlotBindingsV1Schema,
  approvedRecipientContractDigest: z.optional(z.string().check(z.regex(/^sha256:[a-f0-9]{64}$/u))),
}).check(z.superRefine((value, context) => {
  const accountSlotIds = Object.keys(value.credentialBindings.account ?? {});
  const machineSlotIds = Object.entries(value.credentialBindings.byMachineId ?? {})
    .flatMap(([machineId, bindings]) => Object.keys(bindings).map((slotId) => ({ machineId, slotId })));
  accountSlotIds.forEach((slotId) => {
    if (slotId !== value.credentialSlotId) {
      context.addIssue({
        code: 'custom',
        path: ['credentialBindings', 'account', slotId],
        message: 'Qualified Voice credential bindings may contain only their declared slot.',
      });
    }
  });
  machineSlotIds.forEach(({ machineId, slotId }) => {
    if (slotId !== value.credentialSlotId) {
      context.addIssue({
        code: 'custom',
        path: ['credentialBindings', 'byMachineId', machineId, slotId],
        message: 'Qualified Voice credential bindings may contain only their declared slot.',
      });
    }
  });
})));

export type VoiceCredentialBindingV1 = Readonly<
  z.infer<typeof VoiceCredentialBindingV1Schema>
>;

export type VoiceProviderSettingsJsonValueV1 =
  | null
  | boolean
  | number
  | string
  | readonly VoiceProviderSettingsJsonValueV1[]
  | Readonly<{ [key: string]: VoiceProviderSettingsJsonValueV1 }>;

export const VoiceProviderSettingsJsonValueV1Schema = lazyZodSchema(() => {
  const schema = z.custom<VoiceProviderSettingsJsonValueV1>(
    (value): value is VoiceProviderSettingsJsonValueV1 => StrictJsonValueSchema.safeParse(value).success,
    'Expected a serializable JSON value',
  );
  // Keep Voice's raw-value admission while projecting the canonical JSON
  // schema grammar, including recursive definitions and refs.
  schema._zod.processJSONSchema = (context, _json, params) => {
    z.core.process(PluginJsonValueV2Schema, context, params);
    context.seen.get(schema)!.ref = PluginJsonValueV2Schema;
  };
  return schema;
});

/**
 * Generic envelope validation deliberately does not interpret provider-owned
 * config. Resource bounds and provider-version migrations remain with the host
 * settings boundary and the owning bundled provider respectively.
 */
export const VoiceProviderSettingsEnvelopeV1Schema = lazyZodSchema(() => z.object({
  schemaVersion: z.number().check(z.int(), z.minimum(1), z.maximum(0x7fffffff)),
  config: VoiceProviderSettingsJsonValueV1Schema,
}));

export type VoiceProviderSettingsEnvelopeV1 = Readonly<
  z.infer<typeof VoiceProviderSettingsEnvelopeV1Schema>
>;

export const VoiceProviderSettingsRecordV1Schema = lazyZodSchema(() => z.record(
  VoiceProviderIdSchema,
  VoiceProviderSettingsEnvelopeV1Schema,
));

export type VoiceProviderSettingsRecordV1 = Readonly<
  z.infer<typeof VoiceProviderSettingsRecordV1Schema>
>;
