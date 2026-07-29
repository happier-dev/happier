import { z } from 'zod';

import {
  PluginContributionLocalIdSchema,
} from '../contributionIdentity.js';
import {
  compilePluginJsonSchema,
  isValidPluginJsonSchemaValue,
} from '../actions/jsonSchemaValidation.js';
import { ProviderLocalIdSchema } from '../../providers/ids.js';
import { ConnectedServiceIdSchema } from '../../connect/connectedServiceBindings.js';
import {
  PluginContributionReferenceV2Schema,
  PluginLocalizedStringV2Schema,
} from './publicTypes.js';
import { containsEquivalentPluginJsonValue } from './jsonSchemaValues.js';
import {
  PluginSettingFieldIdV2Schema,
  PluginSettingFieldV2Schema,
} from './settings.js';
import { RecipientOperationV1Schema } from '../recipientContractV1.js';

const VoiceConversationProviderRoleV1Schema = z.enum([
  'conversation_stt',
  'conversation_tts',
  'realtime_conversation',
  'turn_control',
]);

const VoiceSpeechProviderRoleV1Schema = z.enum([
  'dictation_stt',
  'conversation_stt',
  'conversation_tts',
]);

function uniqueRoles<TSchema extends z.ZodEnum>(schema: TSchema) {
  return z.array(schema)
  .min(1)
  .max(schema.options.length)
  .superRefine((roles, context) => {
    if (new Set(roles).size !== roles.length) {
      context.addIssue({ code: 'custom', message: 'Voice provider roles must be unique.' });
    }
  });
}

const VoiceConversationProviderRolesV1Schema = uniqueRoles(VoiceConversationProviderRoleV1Schema);
const VoiceSpeechProviderRolesV1Schema = uniqueRoles(VoiceSpeechProviderRoleV1Schema);

const VoiceProviderPlatformV1Schema = z.enum(['web', 'ios', 'android']);
const VoiceProviderPlatformsV1Schema = z.array(VoiceProviderPlatformV1Schema)
  .min(1)
  .max(VoiceProviderPlatformV1Schema.options.length)
  .superRefine((platforms, context) => {
    if (new Set(platforms).size !== platforms.length) {
      context.addIssue({ code: 'custom', message: 'Voice provider platforms must be unique.' });
    }
  });

// Public plugins never receive raw account credentials. Credential readiness
// is consumed only through exact declared host-mediated operations, while
// bundled first-party leaves use the same declaration to project host-owned
// SavedSecret readiness. Keep the manifest vocabulary to that consumed subset
// without admitting daemon/runtime/model requirements or public secret access.
const VoiceProviderReadinessRequirementsV1Schema = z.array(z.literal('credential')).max(1);

const VoiceProviderClientModulePathV1Schema = z.string()
  .trim()
  .min(3)
  .max(256)
  .startsWith('./')
  .refine((value) => !value.split(/[\\/]/u).includes('..'), 'Voice client module paths must not traverse parents.');

const VoiceProviderSettingFieldV1Schema = PluginSettingFieldV2Schema.superRefine((field, context) => {
  if (field.id === 'mode') {
    context.addIssue({
      code: 'custom',
      path: ['id'],
      message: "Voice provider setting id 'mode' is reserved by the host.",
    });
  }
  if (field.secret === true) {
    context.addIssue({
      code: 'custom',
      path: ['secret'],
      message: 'Voice provider settings cannot contain secrets; declare an account credential slot instead.',
    });
  }
  if (field.availability !== undefined || field.analytics !== undefined) {
    context.addIssue({
      code: 'custom',
      message: 'Voice provider settings do not support field gates or analytics in this preview.',
    });
  }
  const control = field.presentation?.control;
  if (control !== 'select' && control !== 'switch' && control !== 'json') {
    context.addIssue({
      code: 'custom',
      path: ['presentation', 'control'],
      message: 'Voice provider settings support only select, switch, and JSON controls.',
    });
    return;
  }
  if (field.presentation?.binding !== undefined
    || field.presentation?.placeholder !== undefined
    || field.presentation?.step !== undefined
    || field.presentation?.hidden !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['presentation'],
      message: 'Voice provider settings do not support binding, placeholder, step, or hidden presentation metadata.',
    });
  }
  let validatesDefault: ReturnType<typeof compilePluginJsonSchema>;
  try {
    validatesDefault = compilePluginJsonSchema(field.schema);
  } catch {
    context.addIssue({
      code: 'custom',
      path: ['schema'],
      message: 'Voice provider setting schema must be a valid bounded JSON Schema.',
    });
    return;
  }
  if (!isValidPluginJsonSchemaValue(validatesDefault, field.default)) {
    context.addIssue({
      code: 'custom',
      path: ['default'],
      message: 'Voice provider setting default must satisfy its declared JSON Schema.',
    });
  }
  if (control === 'switch') {
    if (field.schema.type !== 'boolean'
      || Object.keys(field.schema).some((key) => key !== 'type')
      || typeof field.default !== 'boolean'
      || field.presentation?.options !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Voice provider switch settings require a boolean schema and boolean default.',
      });
    }
    return;
  }
  if (control === 'json') {
    const defaultMatchesOuterShape = field.schema.type === 'object'
      ? field.default !== null
        && typeof field.default === 'object'
        && !Array.isArray(field.default)
      : field.schema.type === 'array'
        ? Array.isArray(field.default)
        : false;
    if (!defaultMatchesOuterShape || field.presentation?.options !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Voice provider JSON settings require an object/array schema and matching JSON default.',
      });
    }
    return;
  }
  const enumValues = field.schema.type === 'string'
    && Object.keys(field.schema).every((key) => key === 'type' || key === 'enum')
    && Array.isArray(field.schema.enum)
    && field.schema.enum.length >= 1
    && field.schema.enum.length <= 32
    && field.schema.enum.every((value) => typeof value === 'string')
    ? field.schema.enum
    : null;
  const options = field.presentation?.options;
  if (!enumValues
    || typeof field.default !== 'string'
    || !containsEquivalentPluginJsonValue(enumValues, field.default)
    || !options
    || options.length !== enumValues.length
    || enumValues.some((value) => (
      options.filter((option) => containsEquivalentPluginJsonValue([option.value], value)).length !== 1
    ))) {
    context.addIssue({
      code: 'custom',
      message: 'Voice provider select settings require a bounded string enum, matching options, and an accepted default.',
    });
  }
});

const VoiceProviderConnectedServicesBindingV1Schema = z.object({
  id: PluginSettingFieldIdV2Schema,
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  agent: PluginContributionReferenceV2Schema,
  serviceIds: z.array(ConnectedServiceIdSchema)
    .min(1)
    .max(ConnectedServiceIdSchema.options.length)
    .superRefine((serviceIds, context) => {
      if (new Set(serviceIds).size !== serviceIds.length) {
        context.addIssue({
          code: 'custom',
          message: 'Voice Connected Service ids must be unique.',
        });
      }
    }),
}).strict();

const VoiceProviderSettingsV1Schema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  fields: z.array(VoiceProviderSettingFieldV1Schema)
    .max(16),
  privacyDisclosure: PluginLocalizedStringV2Schema.optional(),
  connectedServicesBinding: VoiceProviderConnectedServicesBindingV1Schema.optional(),
}).strict().superRefine((settings, context) => {
  if (settings.fields.length === 0 && !settings.connectedServicesBinding) {
    context.addIssue({
      code: 'custom',
      path: ['fields'],
      message: 'Voice provider settings must declare at least one field.',
    });
  }
  if (settings.connectedServicesBinding && settings.schemaVersion !== 2) {
    context.addIssue({
      code: 'custom',
      path: ['schemaVersion'],
      message: 'Voice Connected Services bindings require settings schema version 2.',
    });
  }
  const ids = new Set<string>();
  settings.fields.forEach((field, index) => {
    if (ids.has(field.id)) {
      context.addIssue({
        code: 'custom',
        path: ['fields', index, 'id'],
        message: `Duplicate Voice provider setting id '${field.id}'.`,
      });
    }
    ids.add(field.id);
  });
  if (settings.connectedServicesBinding && ids.has(settings.connectedServicesBinding.id)) {
    context.addIssue({
      code: 'custom',
      path: ['connectedServicesBinding', 'id'],
      message: `Duplicate Voice provider setting id '${settings.connectedServicesBinding.id}'.`,
    });
  }
});

export const VoiceProviderAccountOperationKindV1Schema = PluginContributionLocalIdSchema;

export type VoiceProviderAccountOperationKindV1 = z.infer<
  typeof VoiceProviderAccountOperationKindV1Schema
>;

const VoiceProviderCredentialSlotV1Schema = z.object({
  id: ProviderLocalIdSchema,
  scope: z.literal('account'),
}).strict();

const VoiceProviderAccountMediationV1Schema = z.object({
  credentialSlots: z.array(VoiceProviderCredentialSlotV1Schema)
    .length(1),
  operations: z.array(RecipientOperationV1Schema).min(1).max(64),
}).strict().superRefine((mediation, context) => {
  const slotIds = new Set(mediation.credentialSlots.map((slot) => slot.id));
  const operationIds = new Set<string>();
  const operationPurposes = new Set<string>();
  for (const [operationIndex, operation] of mediation.operations.entries()) {
    if (!slotIds.has(operation.credentialSlotId)) {
      context.addIssue({
        code: 'custom',
        path: ['operations', operationIndex, 'credentialSlotId'],
        message: 'Voice account-mediated operations must reference a declared credential slot.',
      });
    }
    if (operationIds.has(operation.id)) {
      context.addIssue({
        code: 'custom',
        path: ['operations', operationIndex, 'id'],
        message: 'Voice account-mediated operation ids must be unique.',
      });
    }
    if (operationPurposes.has(operation.purpose)) {
      context.addIssue({
        code: 'custom',
        path: ['operations', operationIndex, 'purpose'],
        message: 'Voice account-mediated operation purpose ids must be unique.',
      });
    }
    operationIds.add(operation.id);
    operationPurposes.add(operation.purpose);
  }
});

/**
 * Consumed F35 conversation declaration: a trusted app-client runtime on the
 * declared web/iOS/Android subset. Account mediation declares only SavedSecret
 * slot identities and exact bounded action/request capabilities; the host owns
 * materialization and external code never receives the source credential.
 */
const PluginVoiceConversationProviderContributionV1Schema = z.object({
  id: PluginContributionLocalIdSchema,
  title: PluginLocalizedStringV2Schema,
  kind: z.literal('conversation'),
  roles: VoiceConversationProviderRolesV1Schema,
  platforms: VoiceProviderPlatformsV1Schema,
  capabilities: z.object({
    readiness: z.object({
      requirements: VoiceProviderReadinessRequirementsV1Schema,
    }).strict(),
    turn: z.object({
      cancelResponse: z.boolean(),
      bargeIn: z.boolean(),
      clearInput: z.boolean().optional(),
      resumption: z.enum(['none', 'resume']).optional(),
      replay: z.enum(['none', 'stable_ids']).optional(),
      exactMessage: z.boolean().optional(),
      interruptionPolicy: z.enum(['disabled', 'client_two_stage', 'provider_immediate']).optional(),
    }).strict(),
  }).strict(),
  accountMediation: VoiceProviderAccountMediationV1Schema.optional(),
  execution: z.object({
    kind: z.literal('experimental_agent_session_realtime'),
    agent: PluginContributionReferenceV2Schema,
  }).strict().optional(),
  settings: VoiceProviderSettingsV1Schema.optional(),
  client: z.object({
    artifactId: PluginContributionLocalIdSchema,
    modulePath: VoiceProviderClientModulePathV1Schema,
    exportName: z.literal('activate'),
  }).strict(),
}).strict().superRefine((declaration, context) => {
  const binding = declaration.settings?.connectedServicesBinding;
  if (declaration.execution?.kind === 'experimental_agent_session_realtime' && !binding) {
    context.addIssue({
      code: 'custom',
      path: ['settings', 'connectedServicesBinding'],
      message: 'Agent-session realtime Voice requires an exact Connected Services binding declaration.',
    });
  }
  if (binding && declaration.execution?.kind !== 'experimental_agent_session_realtime') {
    context.addIssue({
      code: 'custom',
      path: ['settings', 'connectedServicesBinding'],
      message: 'Voice Connected Services bindings are reserved for Agent-session realtime execution.',
    });
  }
});

const PluginVoiceSpeechProviderContributionV1Schema = z.object({
  id: PluginContributionLocalIdSchema,
  title: PluginLocalizedStringV2Schema,
  kind: z.literal('speech'),
  roles: VoiceSpeechProviderRolesV1Schema,
  platforms: VoiceProviderPlatformsV1Schema,
  capabilities: z.object({
    readiness: z.object({
      requirements: VoiceProviderReadinessRequirementsV1Schema,
    }).strict(),
  }).strict(),
}).strict();

export const PluginVoiceProviderContributionV1Schema = z.discriminatedUnion('kind', [
  PluginVoiceConversationProviderContributionV1Schema,
  PluginVoiceSpeechProviderContributionV1Schema,
]);

export type PluginVoiceProviderContributionV1 = z.infer<typeof PluginVoiceProviderContributionV1Schema>;
