import { z } from 'zod';
import semver from 'semver';

import {
  PluginContributionLocalIdSchema,
  PluginContributionIdentityV1Schema,
  type PluginContributionIdentityV1,
} from '../contributionIdentity.js';
import { canonicalBoundedRecordKeySchema } from '../../common/canonicalRecordKey.js';
import {
  ConnectedAccountHttpHeadersRequestSchema,
  ConnectedAccountMaterializationRequestSchema,
  ConnectedAccountPurposeIdSchema,
  QualifiedConnectedAccountPurposeV1Schema,
} from '../../connect/connectedAccountPurposes.js';
import {
  cloneStrictPluginJsonValue,
  compilePluginJsonSchema,
  isValidPluginJsonSchemaValue,
  measureSerializedValidatedStrictPluginJsonUtf8Bytes,
} from '../actions/jsonSchemaValidation.js';
import { ConnectedServiceIdSchema } from '../../connect/connectedServiceBindings.js';
import {
  PluginContributionReferenceV2Schema,
  PluginLocalizedStringV2Schema,
} from './publicTypes.js';
import {
  PluginSettingFieldIdV2Schema,
  PluginSettingFieldV2Schema,
  PluginSettingsActionDeclarationV2Schema,
} from './settings.js';
import { RecipientOperationV1Schema } from '../recipientContractV1.js';
import type { VoiceProviderSettingsJsonValueV1 } from '../../voice/realtime/providerSettings.js';
import { normalizeProviderEndpointUrlSyntax } from '../../providers/safety/url.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";
import {
  PluginClientExecutionPlatformV1Schema,
  PluginClientExecutionPlatformsV1Schema,
  PluginClientExecutionReferenceV1Schema,
  type PluginClientExecutionPlatformV1,
} from './clientExecution.js';

const VoiceJsonScalarSchema = z.union([z.null(), z.boolean(), z.number().finite(), z.string()]);
const MAX_VOICE_JSON_SETTINGS_BYTES = 64 * 1024;

export const VoiceCredentialSlotIdSchema = canonicalBoundedRecordKeySchema(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
  .brand<'VoiceCredentialSlotId'>();
export type VoiceCredentialSlotId = z.infer<typeof VoiceCredentialSlotIdSchema>;

export const VoiceConversationProviderRoleSchema = z.enum([
  'conversation_stt',
  'conversation_tts',
  'realtime_conversation',
  'turn_control',
]);
export type VoiceConversationProviderRole = z.infer<typeof VoiceConversationProviderRoleSchema>;

export const VoiceSpeechProviderRoleSchema = z.enum([
  'dictation_stt',
  'conversation_stt',
  'conversation_tts',
]);
export type VoiceSpeechProviderRole = z.infer<typeof VoiceSpeechProviderRoleSchema>;

/** Voice availability uses the shared client-execution platform grammar. */
export const VoiceAvailabilityPlatformSchema = PluginClientExecutionPlatformV1Schema;
export type VoiceAvailabilityPlatform = PluginClientExecutionPlatformV1;

export const VoiceSpeechInputMimeTypeSchema = z.enum([
  'audio/wav',
  'audio/mpeg',
  'audio/mp4',
  'audio/webm',
  'audio/ogg',
]);
export type VoiceSpeechInputMimeType = z.infer<typeof VoiceSpeechInputMimeTypeSchema>;

const uniqueBoundedArray = <TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  min: number,
  max: number,
  label: string,
  uniquenessKey: (value: z.output<TSchema>) => string = (value) => JSON.stringify(value),
) => z.array(schema).min(min).max(max).superRefine((values, context) => {
  const seen = new Set(values.map((value) => uniquenessKey(value)));
  if (seen.size !== values.length) {
    context.addIssue({ code: 'custom', message: `${label} must be unique.` });
  }
});

const VoiceCredentialHeaderNameSchema = z.string().trim().min(1).max(128)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u)
  .transform((value) => value.toLowerCase());
const VoiceCredentialHeaderNamesSchema = z.array(VoiceCredentialHeaderNameSchema).min(1).max(32)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message: 'Voice credential header names must be unique.' });
    }
  });
export const VoiceCredentialAccessPhaseSchema = z.enum([
  'settings',
  'prepare',
  'connection',
  'speech',
]);
export type VoiceCredentialAccessPhase = z.infer<typeof VoiceCredentialAccessPhaseSchema>;

export const VoiceCredentialOperationProjectionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('recipientCredential'),
    operation: asProtocolZod(PluginContributionLocalIdSchema),
    phase: VoiceCredentialAccessPhaseSchema,
    format: z.enum(['raw', 'bearer']),
  }).strict(),
  z.object({
    kind: z.literal('materializedHttpHeaders'),
    operation: asProtocolZod(PluginContributionLocalIdSchema),
    phase: VoiceCredentialAccessPhaseSchema,
    request: ConnectedAccountHttpHeadersRequestSchema,
    /** Headers that must be present in every successful materialization. */
    requiredHeaderNames: VoiceCredentialHeaderNamesSchema,
    /** Complete allowlist; providers may omit members not listed as required. */
    allowedHeaderNames: VoiceCredentialHeaderNamesSchema,
  }).strict(),
]).superRefine((value, context) => {
  if (value.kind !== 'materializedHttpHeaders') return;
  const allowed = new Set(value.allowedHeaderNames);
  for (const required of value.requiredHeaderNames) {
    if (!allowed.has(required)) {
      context.addIssue({
        code: 'custom',
        path: ['requiredHeaderNames'],
        message: 'Required Voice credential headers must also be allowed.',
      });
    }
  }
});
export type VoiceCredentialOperationProjection = z.infer<
  typeof VoiceCredentialOperationProjectionSchema
>;

export const VoiceRawCredentialGrantDeclarationSchema = z.object({
  realm: z.enum(['web', 'ios', 'android', 'daemon']),
  phase: VoiceCredentialAccessPhaseSchema,
  request: ConnectedAccountMaterializationRequestSchema,
}).strict();
export type VoiceRawCredentialGrantDeclaration = z.infer<
  typeof VoiceRawCredentialGrantDeclarationSchema
>;

function canonicalVoiceRawCredentialGrantUniquenessKey(
  grant: VoiceRawCredentialGrantDeclaration,
): string {
  const request = grant.request.kind === 'httpHeaders'
    ? { ...grant.request, headerNames: [...grant.request.headerNames].sort() }
    : grant.request.kind === 'environment'
      ? { ...grant.request, keys: [...grant.request.keys].sort() }
      : { ...grant.request, fileIds: [...grant.request.fileIds].sort() };
  return JSON.stringify({ ...grant, request });
}

const VoiceCredentialSourceBaseSchema = z.object({
  operationProjections: uniqueBoundedArray(
    VoiceCredentialOperationProjectionSchema,
    1,
    16,
    'Voice credential operation projections',
  ).optional(),
  rawGrants: uniqueBoundedArray(
    VoiceRawCredentialGrantDeclarationSchema,
    1,
    8,
    'Voice raw credential grants',
    canonicalVoiceRawCredentialGrantUniquenessKey,
  ).optional(),
});

export const VoiceCredentialSourceSchema = z.discriminatedUnion('kind', [
  VoiceCredentialSourceBaseSchema.extend({
    kind: z.literal('savedSecret'),
    secretKinds: uniqueBoundedArray(
      z.enum(['apiKey', 'token', 'password', 'other']),
      1,
      4,
      'Voice SavedSecret kinds',
    ),
  }).strict(),
  VoiceCredentialSourceBaseSchema.extend({
    kind: z.literal('connectedAccount'),
    service: asProtocolZod(PluginContributionReferenceV2Schema),
  }).strict(),
]);
export type VoiceCredentialSource = z.infer<typeof VoiceCredentialSourceSchema>;

export const VoiceCredentialDeclarationSchema = z.object({
  slot: z.object({
    id: VoiceCredentialSlotIdSchema,
    purpose: ConnectedAccountPurposeIdSchema,
    title: PluginLocalizedStringV2Schema,
    description: PluginLocalizedStringV2Schema.optional(),
  }).strict(),
  requirement: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('always') }).strict(),
    z.object({ kind: z.literal('optional') }).strict(),
    z.object({
      kind: z.literal('when_setting_equals'),
      settingId: PluginSettingFieldIdV2Schema,
      value: VoiceJsonScalarSchema,
    }).strict(),
  ]),
  sources: z.array(VoiceCredentialSourceSchema).min(1).max(5),
  hostMediated: z.object({
    operations: z.array(RecipientOperationV1Schema).min(1).max(16),
  }).strict().optional(),
}).strict().superRefine((declaration, context) => {
  const savedSecretCount = declaration.sources.filter((source) => source.kind === 'savedSecret').length;
  if (savedSecretCount > 1) {
    context.addIssue({ code: 'custom', path: ['sources'], message: 'Voice credentials permit at most one SavedSecret source.' });
  }
  const connectedRefs = declaration.sources.flatMap((source) => source.kind === 'connectedAccount'
    ? [JSON.stringify(source.service)]
    : []);
  if (connectedRefs.length > 4 || new Set(connectedRefs).size !== connectedRefs.length) {
    context.addIssue({ code: 'custom', path: ['sources'], message: 'Voice Connected Account alternatives must be unique and capped at four.' });
  }
  const operationIds = new Set<string>();
  const operationPurposes = new Set<string>();
  declaration.hostMediated?.operations.forEach((operation, index) => {
    if (operation.credentialSlotId !== declaration.slot.id) {
      context.addIssue({
        code: 'custom',
        path: ['hostMediated', 'operations', index, 'credentialSlotId'],
        message: 'Voice host-mediated operations must use the contribution credential slot.',
      });
    }
    if (operationIds.has(operation.id)) {
      context.addIssue({
        code: 'custom',
        path: ['hostMediated', 'operations', index, 'id'],
        message: 'Voice host-mediated operation ids must be unique.',
      });
    }
    if (operationPurposes.has(operation.purpose)) {
      context.addIssue({
        code: 'custom',
        path: ['hostMediated', 'operations', index, 'purpose'],
        message: 'Voice host-mediated operation purposes must be unique.',
      });
    }
    operationIds.add(operation.id);
    operationPurposes.add(operation.purpose);
  });
  declaration.sources.forEach((source, sourceIndex) => {
    const projectedOperations = new Set<string>();
    source.operationProjections?.forEach((projection, projectionIndex) => {
      if (!operationIds.has(projection.operation)) {
        context.addIssue({
          code: 'custom',
          path: ['sources', sourceIndex, 'operationProjections', projectionIndex, 'operation'],
          message: 'Voice credential projections must reference a declared host-mediated operation.',
        });
      }
      if (projectedOperations.has(projection.operation)) {
        context.addIssue({
          code: 'custom',
          path: ['sources', sourceIndex, 'operationProjections', projectionIndex, 'operation'],
          message: 'A Voice credential source may project each host-mediated operation at most once.',
        });
      }
      projectedOperations.add(projection.operation);
      if (source.kind === 'savedSecret' && projection.kind !== 'recipientCredential') {
        context.addIssue({ code: 'custom', path: ['sources', sourceIndex, 'operationProjections', projectionIndex], message: 'SavedSecret projections must use recipient credentials.' });
      }
      if (source.kind === 'connectedAccount' && projection.kind !== 'materializedHttpHeaders') {
        context.addIssue({ code: 'custom', path: ['sources', sourceIndex, 'operationProjections', projectionIndex], message: 'Connected Account projections must use materialized HTTP headers.' });
      }
    });
  });
  const hasRawGrant = declaration.sources.some((source) => (source.rawGrants?.length ?? 0) > 0);
  if (!declaration.hostMediated && !hasRawGrant) {
    context.addIssue({ code: 'custom', message: 'Voice credentials must declare host mediation or a source-specific raw grant.' });
  }
});
export type VoiceCredentialDeclaration = z.infer<typeof VoiceCredentialDeclarationSchema>;

export const VoiceSettingReadinessDeclarationSchema = z.object({
  kind: z.literal('setting_nonempty'),
  settingId: PluginSettingFieldIdV2Schema,
  when: z.object({
    settingId: PluginSettingFieldIdV2Schema,
    equals: VoiceJsonScalarSchema,
  }).strict().optional(),
}).strict();
export type VoiceSettingReadinessDeclaration = z.infer<
  typeof VoiceSettingReadinessDeclarationSchema
>;

export const VoiceProviderSettingsActionDeclarationSchema = PluginSettingsActionDeclarationV2Schema.extend({
  enabledWhen: z.object({
    kind: z.literal('setting_nonempty'),
    settingId: PluginSettingFieldIdV2Schema,
  }).strict().optional(),
}).strict();
export type VoiceProviderSettingsActionDeclaration = z.infer<
  typeof VoiceProviderSettingsActionDeclarationSchema
>;

function validateVoiceJsonBounds(value: unknown, context: z.RefinementCtx): void {
  let snapshot: unknown;
  try {
    snapshot = cloneStrictPluginJsonValue(value, 'Voice JSON settings');
  } catch {
    context.addIssue({ code: 'custom', message: 'Voice JSON settings must be canonically serializable.' });
    return;
  }
  if (measureSerializedValidatedStrictPluginJsonUtf8Bytes(
    snapshot,
    'Voice JSON settings',
    MAX_VOICE_JSON_SETTINGS_BYTES,
  ) > MAX_VOICE_JSON_SETTINGS_BYTES) {
    context.addIssue({ code: 'custom', message: 'Voice JSON settings exceed 65,536 bytes.' });
  }
}

export const VoiceProviderSettingFieldSchema = PluginSettingFieldV2Schema.superRefine((field, context) => {
  if (field.secret === true || field.availability !== undefined || field.analytics !== undefined) {
    context.addIssue({ code: 'custom', message: 'Voice settings are bounded non-secret fields without gates or analytics.' });
  }
  const control = field.presentation?.control;
  if (!control || !['text', 'textarea', 'number', 'select', 'switch', 'json'].includes(control)) {
    context.addIssue({ code: 'custom', path: ['presentation', 'control'], message: 'Voice settings require a supported bounded control.' });
    return;
  }
  const hostOwnedEndpointConsent = (
    field.id === 'insecureLocalOriginConsent'
    || field.id === 'insecureLocalConsentMachineId'
  ) && field.presentation?.hidden === true;
  if (field.presentation?.binding !== undefined || (field.presentation?.hidden !== undefined && !hostOwnedEndpointConsent)) {
    context.addIssue({ code: 'custom', path: ['presentation'], message: 'Voice settings cannot declare host bindings or hidden controls.' });
  }
  let validatesDefault: ReturnType<typeof compilePluginJsonSchema>;
  try {
    validatesDefault = compilePluginJsonSchema(field.schema);
  } catch {
    context.addIssue({ code: 'custom', path: ['schema'], message: 'Voice setting schemas must be valid bounded JSON Schema.' });
    return;
  }
  if (field.default === undefined || !isValidPluginJsonSchemaValue(validatesDefault, field.default)) {
    context.addIssue({ code: 'custom', path: ['default'], message: 'Voice setting defaults must satisfy their schema.' });
  }
  if (control === 'text' || control === 'textarea') {
    if (field.schema.type !== 'string'
      || field.schema.maxLength === undefined
      || field.schema.maxLength < 1
      || field.schema.maxLength > 10_000
      || (field.schema.minLength ?? 0) > field.schema.maxLength
      || field.schema.enum !== undefined
      || typeof field.default !== 'string') {
      context.addIssue({ code: 'custom', message: 'Voice text settings require a bounded string schema and matching default.' });
    }
    return;
  }
  if (control === 'number') {
    const min = field.schema.minimum;
    const max = field.schema.maximum;
    const step = field.presentation?.step;
    if ((field.schema.type !== 'number' && field.schema.type !== 'integer')
      || min === undefined || max === undefined
      || !Number.isFinite(min) || !Number.isFinite(max)
      || min < -1_000_000_000_000 || max > 1_000_000_000_000 || min > max
      || typeof field.default !== 'number' || !Number.isFinite(field.default)
      || (step !== undefined && (!Number.isFinite(step) || step <= 0 || step > (max - min || 1)))) {
      context.addIssue({ code: 'custom', message: 'Voice number settings require finite bounded values and a matching step.' });
    }
    return;
  }
  if (control === 'switch') {
    if (field.schema.type !== 'boolean' || Object.keys(field.schema).some((key) => key !== 'type') || typeof field.default !== 'boolean') {
      context.addIssue({ code: 'custom', message: 'Voice switch settings require a boolean schema and default.' });
    }
    return;
  }
  if (control === 'select') {
    const values = field.schema.enum;
    const options = field.presentation?.options;
    const staticSelect = field.schema.type === 'string' && Array.isArray(values);
    const catalogSelect = field.schema.type === 'string'
      && values === undefined
      && field.schema.maxLength !== undefined
      && field.schema.maxLength >= 1
      && field.schema.maxLength <= 512;
    if (staticSelect) {
      if (values.length < 1 || values.length > 32
        || values.some((value) => typeof value !== 'string' || value.length > 512)
        || new Set(values).size !== values.length
        || !options || options.length !== values.length
        || values.some((value) => options.filter((option) => option.value === value).length !== 1)
        || typeof field.default !== 'string' || !values.includes(field.default)) {
        context.addIssue({ code: 'custom', message: 'Voice static selects require 1–32 unique bounded values and exact options.' });
      }
    } else if (!catalogSelect || options !== undefined || typeof field.default !== 'string') {
      context.addIssue({ code: 'custom', message: 'Voice catalog selects require a bounded string schema and no static options.' });
    }
    return;
  }
  if ((field.schema.type !== 'object' && field.schema.type !== 'array')
    || (field.schema.type === 'object' && (field.default === null || typeof field.default !== 'object' || Array.isArray(field.default)))
    || (field.schema.type === 'array' && !Array.isArray(field.default))) {
    context.addIssue({ code: 'custom', message: 'Voice JSON controls require matching object or array outer shapes.' });
  } else {
    validateVoiceJsonBounds(field.default, context);
  }
});
export type VoiceProviderSettingField = z.infer<typeof VoiceProviderSettingFieldSchema>;

const VoiceProviderSettingsPresentationTextSchema = PluginLocalizedStringV2Schema;
const VoiceProviderSettingsPresentationPathSchema = z.string().min(1).max(256).refine((value) => {
  const segments = value.split('.');
  return segments.length <= 12 && segments.every((segment) => (
    /^[A-Za-z][A-Za-z0-9_]*$/u.test(segment)
    && segment !== '__proto__'
    && segment !== 'prototype'
    && segment !== 'constructor'
  ));
}, 'Voice settings presentation paths must be bounded safe dotted paths.');

const VoiceProviderSettingsPresentationOptionSchema = z.union([
  z.string().max(512),
  z.object({
    id: z.string().max(512),
    kind: z.enum(['pinned', 'moving_alias']).optional(),
    title: VoiceProviderSettingsPresentationTextSchema.optional(),
    titleKey: VoiceProviderSettingsPresentationTextSchema.optional(),
    subtitle: VoiceProviderSettingsPresentationTextSchema.optional(),
    subtitleKey: VoiceProviderSettingsPresentationTextSchema.optional(),
  }).strict(),
]);

const VoiceProviderSettingsPresentationNumericSchema = z.object({
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  step: z.number().finite().positive().optional(),
  reset: z.number().finite().optional(),
  integer: z.boolean().optional(),
  nullable: z.boolean().optional(),
  requiresOptIn: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  if (value.min !== undefined && value.max !== undefined && value.min > value.max) {
    context.addIssue({ code: 'custom', path: ['min'], message: 'Voice presentation minimum cannot exceed maximum.' });
  }
  if (value.reset !== undefined && (
    (value.min !== undefined && value.reset < value.min)
    || (value.max !== undefined && value.reset > value.max)
  )) {
    context.addIssue({ code: 'custom', path: ['reset'], message: 'Voice presentation reset must satisfy its bounds.' });
  }
});

const VoiceProviderSettingsPresentationSubfieldSchema = z.object({
  path: VoiceProviderSettingsPresentationPathSchema,
  suffix: z.string().min(1).max(128).optional(),
  kind: z.literal('number').optional(),
  titleKey: VoiceProviderSettingsPresentationTextSchema.optional(),
  subtitleKey: VoiceProviderSettingsPresentationTextSchema.optional(),
  promptTitleKey: VoiceProviderSettingsPresentationTextSchema.optional(),
  promptBodyKey: VoiceProviderSettingsPresentationTextSchema.optional(),
  confirmTitleKey: VoiceProviderSettingsPresentationTextSchema.optional(),
  confirmBodyKey: VoiceProviderSettingsPresentationTextSchema.optional(),
  confirmActionKey: VoiceProviderSettingsPresentationTextSchema.optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  step: z.number().finite().positive().optional(),
  reset: z.number().finite().optional(),
  integer: z.boolean().optional(),
  nullable: z.boolean().optional(),
  requiresOptIn: z.boolean().optional(),
}).strict();

export const VoiceProviderSettingsPresentationFieldSchema = z.object({
  kind: z.enum([
    'welcome',
    'text',
    'remote_voice',
    'select',
    'number',
    'model',
    'voice_catalog',
    'instructions',
    'segmented',
    'range',
    'language_hint',
    'keyterms',
    'server_vad',
    'privacy_opt_in',
  ]),
  path: VoiceProviderSettingsPresentationPathSchema,
  titleKey: VoiceProviderSettingsPresentationTextSchema.optional(),
  subtitleKey: VoiceProviderSettingsPresentationTextSchema.optional(),
  promptTitleKey: VoiceProviderSettingsPresentationTextSchema.optional(),
  promptBodyKey: VoiceProviderSettingsPresentationTextSchema.optional(),
  searchPlaceholderKey: VoiceProviderSettingsPresentationTextSchema.optional(),
  confirmTitleKey: VoiceProviderSettingsPresentationTextSchema.optional(),
  confirmBodyKey: VoiceProviderSettingsPresentationTextSchema.optional(),
  confirmActionKey: VoiceProviderSettingsPresentationTextSchema.optional(),
  options: z.array(VoiceProviderSettingsPresentationOptionSchema).max(64).optional(),
  supportedModelIds: z.array(z.string().min(1).max(512)).max(64).optional(),
  catalog: z.literal('voices').optional(),
  customIdAllowed: z.boolean().optional(),
  movingAliasRequiresOptIn: z.boolean().optional(),
  advanced: z.boolean().optional(),
  defaultValue: VoiceJsonScalarSchema.optional(),
  forgetAction: z.literal('forget_provider_conversation').optional(),
  maxLength: z.number().int().positive().max(10_000).optional(),
  maxItems: z.number().int().positive().max(1_000).optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  step: z.number().finite().positive().optional(),
  reset: z.number().finite().optional(),
  integer: z.boolean().optional(),
  nullable: z.boolean().optional(),
  requiresOptIn: z.boolean().optional(),
  subfields: z.array(VoiceProviderSettingsPresentationSubfieldSchema).min(1).max(16).optional(),
}).strict().superRefine((field, context) => {
  if ((field.kind === 'number' || field.kind === 'range')
    && !VoiceProviderSettingsPresentationNumericSchema.safeParse({
      min: field.min,
      max: field.max,
      step: field.step,
      reset: field.reset,
      integer: field.integer,
      nullable: field.nullable,
      requiresOptIn: field.requiresOptIn,
    }).success) {
    context.addIssue({ code: 'custom', message: 'Voice numeric presentation metadata must be internally consistent.' });
  }
  if (field.kind === 'server_vad' && !field.subfields) {
    context.addIssue({ code: 'custom', path: ['subfields'], message: 'Voice server VAD presentation requires subfields.' });
  }
  if (field.kind === 'privacy_opt_in' && field.titleKey === undefined) {
    context.addIssue({ code: 'custom', path: ['titleKey'], message: 'Voice privacy controls require a title.' });
  }
});
export type VoiceProviderSettingsPresentationField = z.infer<
  typeof VoiceProviderSettingsPresentationFieldSchema
>;

export const VoiceProviderSettingsPresentationSchema = z.object({
  kind: z.literal('voice.provider-settings.v1'),
  modes: uniqueBoundedArray(z.enum(['byo', 'happier']), 1, 2, 'Voice settings presentation modes'),
  titleKey: VoiceProviderSettingsPresentationTextSchema.optional(),
  footerKey: VoiceProviderSettingsPresentationTextSchema.optional(),
  credential: z.object({
    kind: z.enum(['api_key', 'none']),
    credentialPurpose: ConnectedAccountPurposeIdSchema.optional(),
    catalog: z.literal('voices').nullable(),
    titleKey: VoiceProviderSettingsPresentationTextSchema.optional(),
    promptTitleKey: VoiceProviderSettingsPresentationTextSchema.optional(),
    promptBodyKey: VoiceProviderSettingsPresentationTextSchema.optional(),
  }).strict(),
  links: z.object({
    account: z.string().url().max(2_048).optional(),
    apiKeys: z.string().url().max(2_048).optional(),
    privacy: z.string().url().max(2_048).optional(),
  }).strict().superRefine((links, context) => {
    Object.entries(links).forEach(([name, raw]) => {
      const url = new URL(raw);
      if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
        context.addIssue({ code: 'custom', path: [name], message: 'Voice settings presentation links must use HTTPS without embedded credentials.' });
      }
    });
  }),
  fields: z.array(VoiceProviderSettingsPresentationFieldSchema).max(64),
}).strict().superRefine((presentation, context) => {
  if (presentation.credential.kind === 'none' && presentation.credential.catalog !== null) {
    context.addIssue({ code: 'custom', path: ['credential', 'catalog'], message: 'Voice settings without credentials cannot declare a credential catalog.' });
  }
  const paths = new Set<string>();
  presentation.fields.forEach((field, index) => {
    if (paths.has(field.path)) {
      context.addIssue({ code: 'custom', path: ['fields', index, 'path'], message: 'Voice settings presentation paths must be unique.' });
    }
    paths.add(field.path);
    field.subfields?.forEach((subfield, subfieldIndex) => {
      if (!subfield.path.startsWith(`${field.path}.`) || paths.has(subfield.path)) {
        context.addIssue({ code: 'custom', path: ['fields', index, 'subfields', subfieldIndex, 'path'], message: 'Voice settings presentation subfields must be unique descendants.' });
      }
      paths.add(subfield.path);
    });
  });
});
export type VoiceProviderSettingsPresentation = z.infer<
  typeof VoiceProviderSettingsPresentationSchema
>;

export const VoiceProviderSettingsSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  fields: z.array(VoiceProviderSettingFieldSchema).max(16),
  privacyDisclosure: PluginLocalizedStringV2Schema.optional(),
  presentation: VoiceProviderSettingsPresentationSchema.optional(),
  connectedServicesBinding: z.object({
    id: PluginSettingFieldIdV2Schema,
    title: PluginLocalizedStringV2Schema,
    description: PluginLocalizedStringV2Schema.optional(),
    agent: asProtocolZod(PluginContributionReferenceV2Schema),
    serviceIds: uniqueBoundedArray(
      ConnectedServiceIdSchema,
      1,
      ConnectedServiceIdSchema.options.length,
      'Voice Connected Service ids',
    ),
  }).strict().optional(),
  actions: z.array(VoiceProviderSettingsActionDeclarationSchema).max(8).optional(),
  readiness: uniqueBoundedArray(
    VoiceSettingReadinessDeclarationSchema,
    1,
    8,
    'Voice settings readiness declarations',
  ).optional(),
}).strict().superRefine((settings, context) => {
  if (
    settings.fields.length === 0
    && !settings.connectedServicesBinding
    && !settings.privacyDisclosure
  ) {
    context.addIssue({
      code: 'custom',
      path: ['fields'],
      message: 'Voice settings must declare a field, Connected Services binding, or privacy disclosure.',
    });
  }
  if (settings.connectedServicesBinding && settings.schemaVersion !== 2) {
    context.addIssue({
      code: 'custom',
      path: ['schemaVersion'],
      message: 'Voice Connected Services bindings require settings schema version 2.',
    });
  }
  const fieldsById = new Map(settings.fields.map((field) => [field.id, field] as const));
  if (fieldsById.size !== settings.fields.length) {
    context.addIssue({ code: 'custom', path: ['fields'], message: 'Voice setting field ids must be unique.' });
  }
  if (settings.connectedServicesBinding && fieldsById.has(settings.connectedServicesBinding.id)) {
    context.addIssue({
      code: 'custom',
      path: ['connectedServicesBinding', 'id'],
      message: 'Voice Connected Services binding ids must not collide with setting field ids.',
    });
  }
  settings.presentation?.fields.forEach((field, index) => {
    const rootFieldId = field.path.split('.')[0]!;
    if (field.kind !== 'welcome' && !fieldsById.has(rootFieldId)) {
      context.addIssue({
        code: 'custom',
        path: ['presentation', 'fields', index, 'path'],
        message: 'Voice settings presentation paths must resolve from a declared setting field.',
      });
    }
    field.subfields?.forEach((subfield, subfieldIndex) => {
      if (!fieldsById.has(subfield.path.split('.')[0]!)) {
        context.addIssue({
          code: 'custom',
          path: ['presentation', 'fields', index, 'subfields', subfieldIndex, 'path'],
          message: 'Voice settings presentation subfield paths must resolve from a declared setting field.',
        });
      }
    });
  });
  settings.readiness?.forEach((rule, index) => {
    const target = fieldsById.get(rule.settingId);
    if (!target || target.schema.type !== 'string') {
      context.addIssue({ code: 'custom', path: ['readiness', index, 'settingId'], message: 'Voice nonempty readiness must reference a string field.' });
    }
    if (rule.when && !fieldsById.has(rule.when.settingId)) {
      context.addIssue({ code: 'custom', path: ['readiness', index, 'when', 'settingId'], message: 'Voice readiness conditions must reference a declared field.' });
    }
  });
  const actionIds = new Set<string>();
  settings.actions?.forEach((action, index) => {
    if (actionIds.has(action.id)) {
      context.addIssue({ code: 'custom', path: ['actions', index, 'id'], message: 'Voice settings action ids must be unique.' });
    }
    actionIds.add(action.id);
    if (action.placement.kind === 'afterField' && !fieldsById.has(action.placement.fieldId)) {
      context.addIssue({ code: 'custom', path: ['actions', index, 'placement', 'fieldId'], message: 'Voice settings actions must reference a declared placement field.' });
    }
    if (action.enabledWhen) {
      const target = fieldsById.get(action.enabledWhen.settingId);
      if (!target || target.schema.type !== 'string') {
        context.addIssue({ code: 'custom', path: ['actions', index, 'enabledWhen', 'settingId'], message: 'Voice settings action nonempty conditions must reference a string field.' });
      }
    }
    action.patchFieldIds.forEach((fieldId, fieldIndex) => {
      if (!fieldsById.has(fieldId)) {
        context.addIssue({ code: 'custom', path: ['actions', index, 'patchFieldIds', fieldIndex], message: 'Voice settings actions may patch only declared fields.' });
      }
    });
  });
});
export type VoiceProviderSettings = z.infer<typeof VoiceProviderSettingsSchema>;

export const VoiceSpeechCatalogDeclarationSchema = z.object({
  kind: z.enum(['models', 'voices']),
  settingFieldId: PluginSettingFieldIdV2Schema,
  allowCustom: z.boolean(),
}).strict();
export type VoiceSpeechCatalogDeclaration = z.infer<typeof VoiceSpeechCatalogDeclarationSchema>;

const VoiceSpeechProviderLimitSchema = z.number().int().min(1).max(2_147_483_647);
export const VoiceSpeechProviderLimitsSchema = z.object({
  transcribe: z.object({ maxInputBytes: VoiceSpeechProviderLimitSchema.optional() }).strict().optional(),
  synthesize: z.object({
    maxInputCharacters: VoiceSpeechProviderLimitSchema.optional(),
    maxOutputBytes: VoiceSpeechProviderLimitSchema.optional(),
  }).strict().optional(),
}).strict();
export type VoiceSpeechProviderLimits = z.infer<typeof VoiceSpeechProviderLimitsSchema>;

/** One public speech-response ceiling shared by provider declarations and daemon transfer/wire admission. */
export const VOICE_SPEECH_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Provider evidence that effectful Voice tools can be retried/redelivered without
 * executing their semantic effect more than once. `stable_ids` requires a
 * provider-stable tool-call identity and retained result delivery.
 */
export const VoiceConversationToolEffectCallsSchema = z.enum(['none', 'stable_ids']);
export type VoiceConversationToolEffectCalls = z.infer<
  typeof VoiceConversationToolEffectCallsSchema
>;

export const VoiceConversationToolCapabilitiesSchema = z.object({
  effectCalls: VoiceConversationToolEffectCallsSchema.default('none'),
}).strict();
export type VoiceConversationToolCapabilities = z.infer<
  typeof VoiceConversationToolCapabilitiesSchema
>;

export const VoiceConversationCapabilitiesSchema = z.object({
  turn: z.object({
    cancelResponse: z.boolean(),
    bargeIn: z.boolean(),
    clearInput: z.boolean().optional(),
    resumption: z.enum(['none', 'resume']).optional(),
    replay: z.enum(['none', 'stable_ids']).optional(),
    exactMessage: z.boolean().optional(),
    interruptionPolicy: z.enum(['disabled', 'client_two_stage', 'provider_immediate']).optional(),
  }).strict(),
  tools: VoiceConversationToolCapabilitiesSchema.default({ effectCalls: 'none' }),
}).strict();
export type VoiceConversationCapabilities = z.infer<typeof VoiceConversationCapabilitiesSchema>;

const VoiceAgentRuntimeVersionSchema = z.string().min(1).max(64).refine(
  (value) => value.trim() === value && semver.valid(value) === value,
  'Voice Agent runtime versions must be exact canonical semver versions.',
);

const VoiceConversationProviderContributionSchema = z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  kind: z.literal('conversation'),
  roles: uniqueBoundedArray(
    VoiceConversationProviderRoleSchema,
    1,
    VoiceConversationProviderRoleSchema.options.length,
    'Voice conversation roles',
  ),
  platforms: PluginClientExecutionPlatformsV1Schema,
  capabilities: VoiceConversationCapabilitiesSchema,
  credentials: VoiceCredentialDeclarationSchema.optional(),
  execution: z.object({
    kind: z.literal('experimental_agent_session_realtime'),
    agent: asProtocolZod(PluginContributionReferenceV2Schema),
    supportedRuntimeVersions: uniqueBoundedArray(
      VoiceAgentRuntimeVersionSchema,
      1,
      16,
      'Voice Agent runtime versions',
    ).optional(),
  }).strict().optional(),
  settings: VoiceProviderSettingsSchema.optional(),
  client: PluginClientExecutionReferenceV1Schema.extend({
    exportName: z.literal('activate'),
  }),
}).strict();

const VoiceSpeechProviderContributionSchema = z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  kind: z.literal('speech'),
  roles: uniqueBoundedArray(
    VoiceSpeechProviderRoleSchema,
    1,
    VoiceSpeechProviderRoleSchema.options.length,
    'Voice speech roles',
  ),
  platforms: PluginClientExecutionPlatformsV1Schema,
  credentials: VoiceCredentialDeclarationSchema.optional(),
  settings: VoiceProviderSettingsSchema,
  catalogs: z.array(VoiceSpeechCatalogDeclarationSchema).max(2).optional(),
  limits: VoiceSpeechProviderLimitsSchema.optional(),
}).strict();

export const VoiceProviderContributionSchema = z.discriminatedUnion('kind', [
  VoiceConversationProviderContributionSchema,
  VoiceSpeechProviderContributionSchema,
]).superRefine((contribution, context) => {
  const settings = contribution.settings;
  if (contribution.kind === 'conversation') {
    if (settings?.connectedServicesBinding && contribution.execution?.kind !== 'experimental_agent_session_realtime') {
      context.addIssue({ code: 'custom', path: ['settings', 'connectedServicesBinding'], message: 'Voice Connected Services bindings require Agent-session realtime execution.' });
    }
  } else if (settings?.connectedServicesBinding) {
    context.addIssue({ code: 'custom', path: ['settings', 'connectedServicesBinding'], message: 'Speech contributions cannot bind Agent Connected Services.' });
  }
  const credentials = contribution.credentials;
  credentials?.sources.forEach((source, sourceIndex) => {
    source.operationProjections?.forEach((projection, projectionIndex) => {
      const path = ['credentials', 'sources', sourceIndex, 'operationProjections', projectionIndex, 'phase'] as const;
      if (contribution.kind === 'speech' && projection.phase !== 'settings' && projection.phase !== 'speech') {
        context.addIssue({ code: 'custom', path: [...path], message: 'Speech credential projections use the settings or speech phase.' });
      }
      if (contribution.kind === 'conversation' && projection.phase === 'speech') {
        context.addIssue({ code: 'custom', path: [...path], message: 'Conversation credential projections cannot use the speech phase.' });
      }
    });
    source.rawGrants?.forEach((grant, grantIndex) => {
      const path = ['credentials', 'sources', sourceIndex, 'rawGrants', grantIndex] as const;
      if (
        contribution.kind === 'speech'
        && (grant.realm !== 'daemon' || (grant.phase !== 'settings' && grant.phase !== 'speech'))
      ) {
        context.addIssue({ code: 'custom', path: [...path], message: 'Speech raw credentials are daemon settings- or speech-phase grants.' });
      }
      if (contribution.kind === 'conversation' && grant.realm === 'daemon') {
        context.addIssue({ code: 'custom', path: [...path, 'realm'], message: 'Conversation raw credentials are limited to declared client platforms.' });
      }
      if (contribution.kind === 'conversation'
        && grant.realm !== 'daemon'
        && !contribution.platforms.includes(grant.realm)) {
        context.addIssue({ code: 'custom', path: [...path, 'realm'], message: 'Conversation raw credential realms must be declared client platforms.' });
      }
      if (grant.realm !== 'daemon' && grant.request.kind !== 'httpHeaders') {
        context.addIssue({ code: 'custom', path: [...path, 'request'], message: 'Browser and mobile raw credentials cannot materialize environment or files.' });
      }
    });
  });
  if (credentials?.requirement.kind === 'when_setting_equals') {
    const settingId = credentials.requirement.settingId;
    if (!settings?.fields.some((field) => field.id === settingId)) {
      context.addIssue({ code: 'custom', path: ['credentials', 'requirement', 'settingId'], message: 'Conditional credentials must reference a declared setting.' });
    }
  }
  if (contribution.kind === 'speech') {
    const catalogs = contribution.catalogs ?? [];
    if (new Set(catalogs.map((catalog) => catalog.kind)).size !== catalogs.length) {
      context.addIssue({ code: 'custom', path: ['catalogs'], message: 'Speech contributions may declare at most one models and one voices catalog.' });
    }
    catalogs.forEach((catalog, index) => {
      const field = settings?.fields.find((candidate) => candidate.id === catalog.settingFieldId);
      if (!field || field.presentation?.control !== 'select' || field.schema.type !== 'string') {
        context.addIssue({ code: 'custom', path: ['catalogs', index, 'settingFieldId'], message: 'Speech catalogs must bind a declared catalog-select setting.' });
      }
    });
    const fieldById = new Map(contribution.settings.fields.map((field) => [field.id, field] as const));
    const endpointPolicyFieldIds = [
      'baseUrl',
      'insecureLocalOriginConsent',
      'insecureLocalConsentMachineId',
    ] as const;
    const endpointPolicyFieldCount = endpointPolicyFieldIds.filter((fieldId) => fieldById.has(fieldId)).length;
    if (endpointPolicyFieldCount !== 0 && endpointPolicyFieldCount !== endpointPolicyFieldIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['settings', 'fields'],
        message: 'Speech endpoint settings must declare the complete host-owned endpoint consent tuple.',
      });
    }
    const modelsFieldId = catalogs.find((catalog) => catalog.kind === 'models')?.settingFieldId ?? 'model';
    const voicesFieldId = catalogs.find((catalog) => catalog.kind === 'voices')?.settingFieldId ?? 'voiceName';
    const hasSttRole = contribution.roles.some((role) => role === 'dictation_stt' || role === 'conversation_stt');
    const hasTtsRole = contribution.roles.includes('conversation_tts');
    const validateRequiredRequestString = (fieldId: string, path: readonly (string | number)[]) => {
      const field = fieldById.get(fieldId);
      if (!field || field.schema.type !== 'string') {
        context.addIssue({ code: 'custom', path: [...path], message: 'Required Voice speech request fields must reference a declared bounded string setting.' });
        return;
      }
      const permitsBlank = Array.isArray(field.schema.enum)
        ? field.schema.enum.includes('')
        : (field.schema.minLength ?? 0) < 1;
      const hasUnconditionalReadiness = contribution.settings.readiness?.some((rule) => (
        rule.kind === 'setting_nonempty'
        && rule.settingId === fieldId
        && rule.when === undefined
      )) === true;
      if (permitsBlank && !hasUnconditionalReadiness) {
        context.addIssue({ code: 'custom', path: [...path], message: 'Blank-capable Voice speech request fields require unconditional nonempty readiness.' });
      }
    };
    if (hasSttRole) validateRequiredRequestString(modelsFieldId, ['settings', 'fields']);
    if (hasTtsRole) validateRequiredRequestString(voicesFieldId, ['settings', 'fields']);
  }
});
export type VoiceProviderContribution = z.infer<typeof VoiceProviderContributionSchema>;

/**
 * The Account-settings source selected for one exact host-mediated Voice
 * operation. The Account Settings owner retains its richer persisted target;
 * this boundary receives only the materialization-relevant identity.
 */
export type VoiceCredentialOperationSelectedSource =
  | Readonly<{ kind: 'savedSecret' }>
  | Readonly<{
      kind: 'connectedAccount';
      service: PluginContributionIdentityV1;
    }>;

/**
 * One exact declaration projection authorized for the selected credential
 * source, host-owned phase, and operation. The discriminated projection is
 * the materialization contract: callers must use recipient credentials only
 * for SavedSecret selections and materialized headers only for Connected
 * Account selections.
 */
export type VoiceCredentialOperationAuthorization =
  | Readonly<{
      source: Extract<VoiceCredentialSource, Readonly<{ kind: 'savedSecret' }>>;
      projection: Extract<VoiceCredentialOperationProjection, Readonly<{
        kind: 'recipientCredential';
      }>>;
    }>
  | Readonly<{
      source: Extract<VoiceCredentialSource, Readonly<{ kind: 'connectedAccount' }>>;
      projection: Extract<VoiceCredentialOperationProjection, Readonly<{
        kind: 'materializedHttpHeaders';
      }>>;
    }>;

function sameVoiceCredentialContribution(
  left: PluginContributionIdentityV1,
  right: PluginContributionIdentityV1,
): boolean {
  return left.pluginId === right.pluginId && left.localId === right.localId;
}

function qualifiesVoiceCredentialConnectedAccountSource(
  pluginId: string,
  source: Extract<VoiceCredentialSource, Readonly<{ kind: 'connectedAccount' }>>,
): PluginContributionIdentityV1 {
  return typeof source.service === 'string'
    ? Object.freeze({ pluginId, localId: source.service })
    : Object.freeze({ ...source.service });
}

/**
 * Resolves the only materialization declaration a host may use for one
 * selected Voice credential source. It is deliberately pure: lifecycle,
 * persistence, decryption, and Connected Account materialization stay with
 * their existing owners.
 */
export function resolveVoiceCredentialOperationAuthorization(input: Readonly<{
  pluginId: string;
  contributionId: string;
  contribution: VoiceProviderContribution;
  selectedSource: VoiceCredentialOperationSelectedSource;
  phase: VoiceCredentialAccessPhase;
  operationId: string;
}>): VoiceCredentialOperationAuthorization | null {
  if (input.contribution.id !== input.contributionId) return null;
  const credentials = input.contribution.credentials;
  if (!credentials?.hostMediated?.operations.some((operation) => (
    operation.id === input.operationId
  ))) return null;
  const sources = credentials.sources.filter((candidate) => {
    if (candidate.kind !== input.selectedSource.kind) return false;
    if (candidate.kind === 'savedSecret') return true;
    if (input.selectedSource.kind !== 'connectedAccount') return false;
    return sameVoiceCredentialContribution(
      qualifiesVoiceCredentialConnectedAccountSource(input.pluginId, candidate),
      input.selectedSource.service,
    );
  });
  if (sources.length !== 1) return null;
  const source = sources[0]!;
  const projection = source?.operationProjections?.find((candidate) => (
    candidate.operation === input.operationId && candidate.phase === input.phase
  ));
  if (!source || !projection) return null;
  if (source.kind === 'savedSecret') {
    return projection.kind === 'recipientCredential'
      ? Object.freeze({ source, projection })
      : null;
  }
  return projection.kind === 'materializedHttpHeaders'
    ? Object.freeze({ source, projection })
    : null;
}

export type VoiceSpeechSettingsSnapshot = Readonly<
  Record<string, VoiceProviderSettingsJsonValueV1>
>;

export type VoiceSpeechSettingsCorrespondence = Readonly<{
  settings: VoiceSpeechSettingsSnapshot;
  transcribe: Readonly<{ model: string; language: string | null }> | null;
  synthesize: Readonly<{
    model: string | null;
    voiceName: string;
    languageCode: string | null;
    format: 'mp3' | 'wav' | null;
    speakingRate: number | null;
    pitch: number | null;
  }> | null;
}>;

export type VoiceSpeechEndpointPolicy = Readonly<{
  normalizedBaseUrl: string;
  origin: string;
  insecureHttpConfirmed: boolean;
}>;

/**
 * Reserved speech endpoint settings are one atomic host-owned policy. The
 * endpoint origin is never itself authority: insecure admission is bound to
 * the exact origin and the execution machine that received confirmation.
 */
export function resolveVoiceSpeechEndpointPolicy(input: Readonly<{
  settings: Readonly<Record<string, unknown>>;
  machineId: string | null;
}>): VoiceSpeechEndpointPolicy | null {
  if (!Object.hasOwn(input.settings, 'baseUrl')) return null;
  const baseUrl = input.settings.baseUrl;
  const consentOrigin = input.settings.insecureLocalOriginConsent;
  const consentMachineId = input.settings.insecureLocalConsentMachineId;
  if (
    typeof baseUrl !== 'string'
    || typeof consentOrigin !== 'string'
    || typeof consentMachineId !== 'string'
  ) throw new TypeError('voice_speech_endpoint_policy_invalid');
  let endpoint: ReturnType<typeof normalizeProviderEndpointUrlSyntax>;
  try {
    endpoint = normalizeProviderEndpointUrlSyntax(baseUrl.trim(), { allowQuery: false });
  } catch {
    throw new TypeError('voice_speech_endpoint_policy_invalid');
  }
  return Object.freeze({
    normalizedBaseUrl: endpoint.normalizedUrl,
    origin: endpoint.origin,
    insecureHttpConfirmed: endpoint.protocol !== 'http:' || (
      consentOrigin === endpoint.origin
      && input.machineId !== null
      && consentMachineId === input.machineId
    ),
  });
}

function cloneAndFreezeVoiceSpeechSettings(
  value: Readonly<Record<string, unknown>>,
): VoiceSpeechSettingsSnapshot {
  try {
    return cloneStrictPluginJsonValue(value, 'Voice speech settings') as VoiceSpeechSettingsSnapshot;
  } catch {
    throw new TypeError('voice_speech_settings_invalid');
  }
}

function readVoiceSpeechRequestString(
  settings: VoiceSpeechSettingsSnapshot,
  fieldId: string,
): string | null {
  const raw = settings[fieldId];
  if (raw === undefined) return null;
  if (typeof raw !== 'string') throw new TypeError('voice_speech_settings_invalid');
  const value = raw.trim();
  return value || null;
}

function readVoiceSpeechRequestNumber(
  settings: VoiceSpeechSettingsSnapshot,
  fieldId: string,
): number | null {
  const raw = settings[fieldId];
  if (raw === undefined) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new TypeError('voice_speech_settings_invalid');
  }
  return raw;
}

function readVoiceSpeechOutputFormat(
  settings: VoiceSpeechSettingsSnapshot,
): 'mp3' | 'wav' | null {
  const raw = settings.format;
  if (raw === undefined) return null;
  if (raw !== 'mp3' && raw !== 'wav') {
    throw new TypeError('voice_speech_settings_invalid');
  }
  return raw;
}

/**
 * Validates and snapshots one speech contribution's non-secret settings, then
 * derives the sole request-bearing model/voice correspondence from its cold
 * declaration. Callers do not supply fallbacks or provider-specific aliases.
 */
export function resolveVoiceSpeechSettingsCorrespondence(input: Readonly<{
  contribution: Extract<VoiceProviderContribution, { kind: 'speech' }>;
  settings: unknown;
}>): VoiceSpeechSettingsCorrespondence {
  const contribution = VoiceProviderContributionSchema.parse(input.contribution);
  if (contribution.kind !== 'speech'
    || !input.settings
    || typeof input.settings !== 'object'
    || Array.isArray(input.settings)) {
    throw new TypeError('voice_speech_settings_invalid');
  }
  const settingsRecord = input.settings as Readonly<Record<string, unknown>>;
  const declaredFieldIds = new Set(contribution.settings.fields.map((field) => field.id));
  if (Object.keys(settingsRecord).some((fieldId) => !declaredFieldIds.has(fieldId))) {
    throw new TypeError('voice_speech_settings_invalid');
  }
  const normalizedSettings: Record<string, unknown> = {};
  for (const field of contribution.settings.fields) {
    const value = Object.hasOwn(settingsRecord, field.id)
      ? settingsRecord[field.id]
      : field.default;
    let validate: ReturnType<typeof compilePluginJsonSchema>;
    try {
      validate = compilePluginJsonSchema(field.schema);
    } catch {
      throw new TypeError('voice_speech_settings_invalid');
    }
    if (!isValidPluginJsonSchemaValue(validate, value)) {
      throw new TypeError('voice_speech_settings_invalid');
    }
    normalizedSettings[field.id] = value;
  }
  const settings = cloneAndFreezeVoiceSpeechSettings(normalizedSettings);
  const modelsFieldId = contribution.catalogs?.find((catalog) => catalog.kind === 'models')?.settingFieldId
    ?? 'model';
  const voicesFieldId = contribution.catalogs?.find((catalog) => catalog.kind === 'voices')?.settingFieldId
    ?? 'voiceName';
  const hasSttRole = contribution.roles.some((role) => role === 'dictation_stt' || role === 'conversation_stt');
  const hasTtsRole = contribution.roles.includes('conversation_tts');
  const model = readVoiceSpeechRequestString(settings, modelsFieldId);
  const voiceName = readVoiceSpeechRequestString(settings, voicesFieldId);
  const language = readVoiceSpeechRequestString(settings, 'language');
  const languageCode = readVoiceSpeechRequestString(settings, 'languageCode');
  const format = readVoiceSpeechOutputFormat(settings);
  const speakingRate = readVoiceSpeechRequestNumber(settings, 'speakingRate');
  const pitch = readVoiceSpeechRequestNumber(settings, 'pitch');
  return Object.freeze({
    settings,
    transcribe: hasSttRole && model
      ? Object.freeze({ model, language })
      : null,
    synthesize: hasTtsRole && voiceName
      ? Object.freeze({
          model,
          voiceName,
          languageCode,
          format,
          speakingRate,
          pitch,
        })
      : null,
  });
}

export const VoiceCredentialBindingIdentityV1Schema = z.object({
  contribution: asProtocolZod(PluginContributionIdentityV1Schema),
  credentialSlotId: VoiceCredentialSlotIdSchema,
  purpose: QualifiedConnectedAccountPurposeV1Schema,
}).strict().superRefine((value, context) => {
  if (
    value.purpose.consumer.pluginId !== value.contribution.pluginId
    || value.purpose.consumer.localId !== value.contribution.localId
  ) {
    context.addIssue({
      code: 'custom',
      path: ['purpose', 'consumer'],
      message: 'Voice credential purpose consumer must equal its qualified contribution.',
    });
  }
});
export type VoiceCredentialBindingIdentityV1 = z.infer<
  typeof VoiceCredentialBindingIdentityV1Schema
>;

export function normalizeVoiceProviderContribution(input: unknown): VoiceProviderContribution {
  return VoiceProviderContributionSchema.parse(input);
}

/**
 * Projects the one persisted selection identity from canonical manifest truth.
 * Callers never supply a separate purpose, slot, or contribution local id.
 */
export function deriveVoiceCredentialBindingIdentityV1(input: Readonly<{
  pluginId: string;
  contribution: VoiceProviderContribution;
}>): VoiceCredentialBindingIdentityV1 | null {
  const contribution = VoiceProviderContributionSchema.parse(input.contribution);
  if (!contribution.credentials) return null;
  const identity = PluginContributionIdentityV1Schema.parse({
    pluginId: input.pluginId,
    localId: contribution.id,
  });
  return VoiceCredentialBindingIdentityV1Schema.parse({
    contribution: identity,
    credentialSlotId: contribution.credentials.slot.id,
    purpose: {
      consumer: identity,
      purpose: contribution.credentials.slot.purpose,
    },
  });
}

export const VoiceProviderAccountOperationKindV1Schema = PluginContributionLocalIdSchema;

export type VoiceProviderAccountOperationKindV1 = z.infer<
  typeof VoiceProviderAccountOperationKindV1Schema
>;
