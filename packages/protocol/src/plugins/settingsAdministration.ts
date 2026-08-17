import { z } from 'zod';

import { SERVER_IDENTITY_ID_PATTERN } from '../features/payload/capabilities/serverIdentityCapabilities.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { ProviderMachineIdSchema } from '../providers/ids.js';
import {
  PluginSettingFieldIdV2Schema,
  PluginSettingsScopeRefV1Schema,
} from './contributions/settings.js';
import { PluginIdSchema } from './pluginId.js';
import { asProtocolZod } from "./actions/internalProtocolZodAdapter.js";

/**
 * Canonical user-administration Actions for declared plugin Settings. These
 * Actions select one existing Settings/Secrets owner; they do not introduce a
 * new settings store or accept raw secret material.
 */
export const PLUGIN_SETTINGS_ADMINISTRATION_ACTION_IDS_V1 = [
  'plugins.settings.list',
  'plugins.settings.get',
  'plugins.settings.set',
  'plugins.settings.reset',
  'plugins.settings.secret.status',
  'plugins.settings.secret.bind',
  'plugins.settings.secret.unbind',
  'plugins.settings.secret.delete',
] as const;

export type PluginSettingsAdministrationActionIdV1 =
  typeof PLUGIN_SETTINGS_ADMINISTRATION_ACTION_IDS_V1[number];

export const PluginSettingsAdministrationActionIdV1Schema = z.enum(
  PLUGIN_SETTINGS_ADMINISTRATION_ACTION_IDS_V1,
);

export const PluginSettingsAdministrationAccountTargetV1Schema = z.object({
  kind: z.literal('account'),
}).strict();
export type PluginSettingsAdministrationAccountTargetV1 = z.infer<
  typeof PluginSettingsAdministrationAccountTargetV1Schema
>;

/**
 * This portable target carries the server identity stamped by canonical machine
 * selection together with the machine-owned Settings identity.
 */
export const PluginSettingsAdministrationDaemonTargetV1Schema = z.object({
  kind: z.literal('daemon'),
  serverIdentityId: z.string().trim().regex(SERVER_IDENTITY_ID_PATTERN),
  machineId: ProviderMachineIdSchema,
}).strict();
export type PluginSettingsAdministrationDaemonTargetV1 = z.infer<
  typeof PluginSettingsAdministrationDaemonTargetV1Schema
>;

export const PluginSettingsAdministrationTargetV1Schema = z.discriminatedUnion('kind', [
  PluginSettingsAdministrationAccountTargetV1Schema,
  PluginSettingsAdministrationDaemonTargetV1Schema,
]);
export type PluginSettingsAdministrationTargetV1 = z.infer<
  typeof PluginSettingsAdministrationTargetV1Schema
>;

const ExpectedRevisionSchema = z.string().trim().min(1).max(512);

function requireScopeTargetMatch(
  value: Readonly<{
    scope: z.infer<typeof PluginSettingsScopeRefV1Schema>;
    target: PluginSettingsAdministrationTargetV1;
  }>,
  context: z.RefinementCtx,
): void {
  if (value.scope.kind === value.target.kind) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['target'],
    message: 'Plugin Settings administration target must match the selected scope.',
  });
}

const ScopeSelectedSettingsActionBaseSchema = z.object({
  pluginId: asProtocolZod(PluginIdSchema),
  scope: PluginSettingsScopeRefV1Schema,
  target: PluginSettingsAdministrationTargetV1Schema,
}).strict().superRefine(requireScopeTargetMatch);

const ScopeSelectedSettingsFieldActionBaseSchema = ScopeSelectedSettingsActionBaseSchema.extend({
  localId: PluginSettingFieldIdV2Schema,
}).strict().superRefine(requireScopeTargetMatch);

/**
 * Secret declarations are globally unique per plugin, so a direct secret can
 * be administered without inventing a Settings scope. A declared settings
 * secret may still carry its presentation scope for exact field lookup. When
 * that secret's custody is daemon, `secretDaemonTarget` selects that existing
 * machine owner independently of its Settings scope.
 */
const SecretActionBaseSchema = z.object({
  pluginId: asProtocolZod(PluginIdSchema),
  localId: PluginSettingFieldIdV2Schema,
  scope: PluginSettingsScopeRefV1Schema.optional(),
  target: PluginSettingsAdministrationTargetV1Schema.optional(),
  secretDaemonTarget: PluginSettingsAdministrationDaemonTargetV1Schema.optional(),
}).strict().superRefine((value, context) => {
  if (value.scope && !value.target) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['target'],
      message: 'A selected Settings scope requires its exact target.',
    });
    return;
  }
  if (value.target && !value.scope) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['scope'],
      message: 'A Settings target requires an explicit Settings scope.',
    });
    return;
  }
  if (value.scope && value.target && value.scope.kind !== value.target.kind) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['target'],
      message: 'Plugin Settings administration target must match the selected scope.',
    });
  }
  if (value.scope?.kind === 'daemon' && value.secretDaemonTarget) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['secretDaemonTarget'],
      message: 'A daemon Settings scope already supplies the exact daemon secret target.',
    });
  }
});

const SecretMutationActionBaseSchema = SecretActionBaseSchema.extend({
  expectedRevision: ExpectedRevisionSchema.optional(),
}).strict();

export const PluginSettingsAdministrationListActionInputV1Schema =
  ScopeSelectedSettingsActionBaseSchema;
export type PluginSettingsAdministrationListActionInputV1 = z.infer<
  typeof PluginSettingsAdministrationListActionInputV1Schema
>;

export const PluginSettingsAdministrationGetActionInputV1Schema =
  ScopeSelectedSettingsFieldActionBaseSchema;
export type PluginSettingsAdministrationGetActionInputV1 = z.infer<
  typeof PluginSettingsAdministrationGetActionInputV1Schema
>;

export const PluginSettingsAdministrationSetActionInputV1Schema =
  ScopeSelectedSettingsFieldActionBaseSchema.extend({
    value: StrictJsonValueSchema,
    expectedRevision: ExpectedRevisionSchema.optional(),
  }).strict().superRefine(requireScopeTargetMatch);
export type PluginSettingsAdministrationSetActionInputV1 = z.infer<
  typeof PluginSettingsAdministrationSetActionInputV1Schema
>;

export const PluginSettingsAdministrationResetActionInputV1Schema =
  ScopeSelectedSettingsFieldActionBaseSchema.extend({
    expectedRevision: ExpectedRevisionSchema.optional(),
  }).strict().superRefine(requireScopeTargetMatch);
export type PluginSettingsAdministrationResetActionInputV1 = z.infer<
  typeof PluginSettingsAdministrationResetActionInputV1Schema
>;

export const PluginSettingsAdministrationSecretStatusActionInputV1Schema =
  SecretActionBaseSchema;
export type PluginSettingsAdministrationSecretStatusActionInputV1 = z.infer<
  typeof PluginSettingsAdministrationSecretStatusActionInputV1Schema
>;

/** Existing SavedSecret identity only: raw create/replace stays UI-present. */
export const PluginSettingsAdministrationSecretBindActionInputV1Schema =
  SecretMutationActionBaseSchema.extend({
    savedSecretId: z.string().trim().min(1).max(512),
  }).strict();
export type PluginSettingsAdministrationSecretBindActionInputV1 = z.infer<
  typeof PluginSettingsAdministrationSecretBindActionInputV1Schema
>;

export const PluginSettingsAdministrationSecretUnbindActionInputV1Schema =
  SecretMutationActionBaseSchema;
export type PluginSettingsAdministrationSecretUnbindActionInputV1 = z.infer<
  typeof PluginSettingsAdministrationSecretUnbindActionInputV1Schema
>;

export const PluginSettingsAdministrationSecretDeleteActionInputV1Schema =
  SecretMutationActionBaseSchema;
export type PluginSettingsAdministrationSecretDeleteActionInputV1 = z.infer<
  typeof PluginSettingsAdministrationSecretDeleteActionInputV1Schema
>;

export const PluginSettingsAdministrationActionInputSchemasV1 = {
  'plugins.settings.list': PluginSettingsAdministrationListActionInputV1Schema,
  'plugins.settings.get': PluginSettingsAdministrationGetActionInputV1Schema,
  'plugins.settings.set': PluginSettingsAdministrationSetActionInputV1Schema,
  'plugins.settings.reset': PluginSettingsAdministrationResetActionInputV1Schema,
  'plugins.settings.secret.status': PluginSettingsAdministrationSecretStatusActionInputV1Schema,
  'plugins.settings.secret.bind': PluginSettingsAdministrationSecretBindActionInputV1Schema,
  'plugins.settings.secret.unbind': PluginSettingsAdministrationSecretUnbindActionInputV1Schema,
  'plugins.settings.secret.delete': PluginSettingsAdministrationSecretDeleteActionInputV1Schema,
} as const satisfies Readonly<Record<
  PluginSettingsAdministrationActionIdV1,
  z.ZodTypeAny
>>;

const PluginSettingsAdministrationResultTextV1Schema = z.string().trim().min(1).max(4_096);
const PluginSettingsAdministrationResultFieldsV1Schema = z.array(z.union([
  z.object({
    localId: PluginSettingFieldIdV2Schema,
    title: PluginSettingsAdministrationResultTextV1Schema.optional(),
    description: PluginSettingsAdministrationResultTextV1Schema.optional(),
    secret: z.literal(true),
  }).strict(),
  z.object({
    localId: PluginSettingFieldIdV2Schema,
    title: PluginSettingsAdministrationResultTextV1Schema.optional(),
    description: PluginSettingsAdministrationResultTextV1Schema.optional(),
    secret: z.literal(false),
    value: StrictJsonValueSchema,
  }).strict(),
])).max(256);
const PluginSettingsAdministrationLiveApplicationV1Schema = z.object({
  kind: z.literal('live'),
}).strict();

const PluginSettingsAdministrationListResultDataV1Schema = z.object({
  scope: PluginSettingsScopeRefV1Schema,
  target: PluginSettingsAdministrationTargetV1Schema,
  revision: ExpectedRevisionSchema,
  fields: PluginSettingsAdministrationResultFieldsV1Schema,
}).strict().superRefine(requireScopeTargetMatch);
const PluginSettingsAdministrationGetResultDataV1Schema = z.object({
  scope: PluginSettingsScopeRefV1Schema,
  target: PluginSettingsAdministrationTargetV1Schema,
  localId: PluginSettingFieldIdV2Schema,
  revision: ExpectedRevisionSchema,
  value: StrictJsonValueSchema,
}).strict().superRefine(requireScopeTargetMatch);
const PluginSettingsAdministrationMutationResultDataV1Schema = z.object({
  scope: PluginSettingsScopeRefV1Schema,
  target: PluginSettingsAdministrationTargetV1Schema,
  localId: PluginSettingFieldIdV2Schema,
  revision: ExpectedRevisionSchema,
  application: PluginSettingsAdministrationLiveApplicationV1Schema,
}).strict().superRefine(requireScopeTargetMatch);

const PluginSettingsAdministrationAccountSecretStatusResultDataV1Schema = z.object({
  localId: PluginSettingFieldIdV2Schema,
  custody: z.literal('account'),
  target: PluginSettingsAdministrationAccountTargetV1Schema,
  state: z.enum(['configured', 'missing']),
  revision: ExpectedRevisionSchema,
}).strict();
const PluginSettingsAdministrationDaemonSecretStatusResultDataV1Schema = z.object({
  localId: PluginSettingFieldIdV2Schema,
  custody: z.literal('daemon'),
  target: PluginSettingsAdministrationDaemonTargetV1Schema,
  state: z.enum(['configured', 'missing', 'denied', 'unavailable']),
  revision: ExpectedRevisionSchema,
}).strict();
const PluginSettingsAdministrationSecretStatusResultDataV1Schema = z.union([
  PluginSettingsAdministrationAccountSecretStatusResultDataV1Schema,
  PluginSettingsAdministrationDaemonSecretStatusResultDataV1Schema,
]);
const PluginSettingsAdministrationAccountSecretMutationResultDataV1Schema = z.object({
  localId: PluginSettingFieldIdV2Schema,
  custody: z.literal('account'),
  target: PluginSettingsAdministrationAccountTargetV1Schema,
  revision: ExpectedRevisionSchema,
  application: PluginSettingsAdministrationLiveApplicationV1Schema,
}).strict();
const PluginSettingsAdministrationDaemonSecretDeleteResultDataV1Schema = z.object({
  localId: PluginSettingFieldIdV2Schema,
  custody: z.literal('daemon'),
  target: PluginSettingsAdministrationDaemonTargetV1Schema,
  state: z.enum(['configured', 'missing', 'denied', 'unavailable']),
  revision: ExpectedRevisionSchema,
  application: PluginSettingsAdministrationLiveApplicationV1Schema,
}).strict();

/**
 * The public administration result vocabulary is action-specific and closed.
 * Secret actions can carry only custody, current target, status, and revision;
 * no raw secret material has a schema path.
 */
export const PluginSettingsAdministrationActionOutputV1Schema = z.union([
  z.object({
    ok: z.literal(true),
    kind: z.literal('plugins.settings.list'),
    data: PluginSettingsAdministrationListResultDataV1Schema,
  }).strict(),
  z.object({
    ok: z.literal(true),
    kind: z.literal('plugins.settings.get'),
    data: PluginSettingsAdministrationGetResultDataV1Schema,
  }).strict(),
  z.object({
    ok: z.literal(true),
    kind: z.literal('plugins.settings.set'),
    data: PluginSettingsAdministrationMutationResultDataV1Schema,
  }).strict(),
  z.object({
    ok: z.literal(true),
    kind: z.literal('plugins.settings.reset'),
    data: PluginSettingsAdministrationMutationResultDataV1Schema,
  }).strict(),
  z.object({
    ok: z.literal(true),
    kind: z.literal('plugins.settings.secret.status'),
    data: PluginSettingsAdministrationSecretStatusResultDataV1Schema,
  }).strict(),
  z.object({
    ok: z.literal(true),
    kind: z.literal('plugins.settings.secret.bind'),
    data: PluginSettingsAdministrationAccountSecretMutationResultDataV1Schema,
  }).strict(),
  z.object({
    ok: z.literal(true),
    kind: z.literal('plugins.settings.secret.unbind'),
    data: PluginSettingsAdministrationAccountSecretMutationResultDataV1Schema,
  }).strict(),
  z.object({
    ok: z.literal(true),
    kind: z.literal('plugins.settings.secret.delete'),
    data: z.union([
      PluginSettingsAdministrationAccountSecretMutationResultDataV1Schema,
      PluginSettingsAdministrationDaemonSecretDeleteResultDataV1Schema,
    ]),
  }).strict(),
  z.object({
    ok: z.literal(false),
    kind: PluginSettingsAdministrationActionIdV1Schema,
    errorCode: z.string().trim().min(1).max(128),
    error: PluginSettingsAdministrationResultTextV1Schema,
  }).strict(),
]);
export type PluginSettingsAdministrationActionOutputV1 = z.infer<
  typeof PluginSettingsAdministrationActionOutputV1Schema
>;
