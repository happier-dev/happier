import { z } from 'zod';
import semver from 'semver';

import {
  PluginContributionLocalIdSchema,
  PluginContributionIdentityV1Schema,
} from '../contributionIdentity.js';
import { canonicalBoundedRecordKeySchema } from '../../common/canonicalRecordKey.js';
import {
  ConnectedAccountHttpHeadersRequestSchema,
  ConnectedAccountMaterializationRequestSchema,
  ConnectedAccountPurposeIdSchema,
  QualifiedConnectedAccountPurposeV1Schema,
} from '../../connect/connectedAccountPurposes.js';
import {
  compilePluginJsonSchema,
  isValidPluginJsonSchemaValue,
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

const VoiceJsonScalarSchema = z.union([z.null(), z.boolean(), z.number().finite(), z.string()]);

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

export const VoiceAvailabilityPlatformSchema = z.enum(['web', 'ios', 'android']);
export type VoiceAvailabilityPlatform = z.infer<typeof VoiceAvailabilityPlatformSchema>;

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
    allowedHeaderNames: VoiceCredentialHeaderNamesSchema,
  }).strict(),
]);
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
  const encoder = new TextEncoder();
  let entries = 0;
  const seen = new Set<object>();
  const visit = (current: unknown, depth: number, path: readonly (string | number)[]): void => {
    if (depth > 8) {
      context.addIssue({ code: 'custom', path: [...path], message: 'Voice JSON settings exceed depth 8.' });
      return;
    }
    if (typeof current === 'string' && current.length > 10_000) {
      context.addIssue({ code: 'custom', path: [...path], message: 'Voice JSON string values exceed 10,000 code units.' });
      return;
    }
    if (!current || typeof current !== 'object') return;
    if (seen.has(current)) {
      context.addIssue({ code: 'custom', path: [...path], message: 'Voice JSON settings cannot contain cycles.' });
      return;
    }
    seen.add(current);
    if (Array.isArray(current)) {
      entries += current.length;
      current.forEach((item, index) => visit(item, depth + 1, [...path, index]));
    } else {
      const record = current as Readonly<Record<string, unknown>>;
      const keys = Object.keys(record);
      entries += keys.length;
      keys.forEach((key) => {
        if (key.length > 256) {
          context.addIssue({ code: 'custom', path: [...path, key], message: 'Voice JSON keys exceed 256 code units.' });
        }
        visit(record[key], depth + 1, [...path, key]);
      });
    }
    seen.delete(current);
  };
  visit(value, 1, []);
  if (entries > 256) {
    context.addIssue({ code: 'custom', message: 'Voice JSON settings exceed 256 entries.' });
  }
  try {
    if (encoder.encode(JSON.stringify(value)).byteLength > 65_536) {
      context.addIssue({ code: 'custom', message: 'Voice JSON settings exceed 65,536 bytes.' });
    }
  } catch {
    context.addIssue({ code: 'custom', message: 'Voice JSON settings must be canonically serializable.' });
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

export const VoiceProviderSettingsSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  fields: z.array(VoiceProviderSettingFieldSchema).max(16),
  privacyDisclosure: PluginLocalizedStringV2Schema.optional(),
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
  platforms: uniqueBoundedArray(
    VoiceAvailabilityPlatformSchema,
    1,
    VoiceAvailabilityPlatformSchema.options.length,
    'Voice platforms',
  ),
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
    ),
  }).strict().optional(),
  settings: VoiceProviderSettingsSchema.optional(),
  client: z.object({
    artifactId: asProtocolZod(PluginContributionLocalIdSchema),
    modulePath: z.string().trim().min(3).max(256).startsWith('./')
      .refine((path) => !path.split(/[\\/]/u).includes('..'), 'Voice client module paths must not traverse parents.'),
    exportName: z.literal('activate'),
  }).strict(),
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
  platforms: uniqueBoundedArray(
    VoiceAvailabilityPlatformSchema,
    1,
    VoiceAvailabilityPlatformSchema.options.length,
    'Voice platforms',
  ),
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
      if (contribution.kind === 'speech' && projection.phase !== 'speech') {
        context.addIssue({ code: 'custom', path: [...path], message: 'Speech credential projections use the speech phase.' });
      }
      if (contribution.kind === 'conversation' && projection.phase === 'speech') {
        context.addIssue({ code: 'custom', path: [...path], message: 'Conversation credential projections cannot use the speech phase.' });
      }
    });
    source.rawGrants?.forEach((grant, grantIndex) => {
      const path = ['credentials', 'sources', sourceIndex, 'rawGrants', grantIndex] as const;
      if (contribution.kind === 'speech' && (grant.realm !== 'daemon' || grant.phase !== 'speech')) {
        context.addIssue({ code: 'custom', path: [...path], message: 'Speech raw credentials are daemon speech-phase grants.' });
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

export type VoiceSpeechSettingsSnapshot = Readonly<
  Record<string, VoiceProviderSettingsJsonValueV1>
>;

export type VoiceSpeechSettingsCorrespondence = Readonly<{
  settings: VoiceSpeechSettingsSnapshot;
  transcribe: Readonly<{ model: string }> | null;
  synthesize: Readonly<{ model: string | null; voiceName: string }> | null;
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
  const clone = JSON.parse(JSON.stringify(value)) as Record<string, VoiceProviderSettingsJsonValueV1>;
  const freeze = (candidate: VoiceProviderSettingsJsonValueV1): VoiceProviderSettingsJsonValueV1 => {
    if (candidate !== null && typeof candidate === 'object' && !Object.isFrozen(candidate)) {
      for (const child of Object.values(candidate)) freeze(child);
      Object.freeze(candidate);
    }
    return candidate;
  };
  for (const child of Object.values(clone)) freeze(child);
  return Object.freeze(clone);
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
  return Object.freeze({
    settings,
    transcribe: hasSttRole && model
      ? Object.freeze({ model })
      : null,
    synthesize: hasTtsRole && voiceName
      ? Object.freeze({
          model,
          voiceName,
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
