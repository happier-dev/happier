import { PLUGIN_SETTINGS_ADMINISTRATION_ACTION_IDS_V1 } from './settingsAdministrationActionIdsV1.js';
export { PLUGIN_SETTINGS_ADMINISTRATION_ACTION_IDS_V1 } from './settingsAdministrationActionIdsV1.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

import { SERVER_IDENTITY_ID_PATTERN } from '../features/payload/capabilities/serverIdentityCapabilities.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { ProviderMachineIdSchema } from '../providers/ids.js';
import {
  PluginSettingFieldIdV2Schema,
  PluginSettingsScopeRefV1Schema,
} from './contributions/settings.js';
import { PluginIdSchema } from './pluginId.js';
import { PLUGIN_ACCOUNT_SETTINGS_MAXIMUM_FIELDS_V1 } from './settings/accountSettingsFieldCountV1.js';
import { asProtocolZod } from "./actions/internalProtocolZodAdapter.js";

export type PluginSettingsAdministrationActionIdV1 =
  typeof PLUGIN_SETTINGS_ADMINISTRATION_ACTION_IDS_V1[number];

export const PluginSettingsAdministrationActionIdV1Schema = lazyZodSchema(() => z.enum(
  PLUGIN_SETTINGS_ADMINISTRATION_ACTION_IDS_V1,
));

export const PluginSettingsAdministrationAccountTargetV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('account'),
}));
export type PluginSettingsAdministrationAccountTargetV1 = z.infer<
  typeof PluginSettingsAdministrationAccountTargetV1Schema
>;

/**
 * This portable target carries the server identity stamped by canonical machine
 * selection together with the machine-owned Settings identity.
 */
export const PluginSettingsAdministrationDaemonTargetV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('daemon'),
  serverIdentityId: z.string().check(z.trim(), z.regex(SERVER_IDENTITY_ID_PATTERN)),
  machineId: ProviderMachineIdSchema,
}));
export type PluginSettingsAdministrationDaemonTargetV1 = z.infer<
  typeof PluginSettingsAdministrationDaemonTargetV1Schema
>;

export const PluginSettingsAdministrationTargetV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  PluginSettingsAdministrationAccountTargetV1Schema,
  PluginSettingsAdministrationDaemonTargetV1Schema,
]));
export type PluginSettingsAdministrationTargetV1 = z.infer<
  typeof PluginSettingsAdministrationTargetV1Schema
>;

const ExpectedRevisionSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(512)));

function requireScopeTargetMatch(
  value: Readonly<{
    scope: z.infer<typeof PluginSettingsScopeRefV1Schema>;
    target: PluginSettingsAdministrationTargetV1;
    bindingServerIdentityId?: string | null;
  }>,
  context: z.core.$RefinementCtx,
): void {
  if (value.scope.kind !== value.target.kind) context.addIssue({
    code: "custom", path: ['target'],
    message: 'Plugin Settings administration target must match the selected scope.',
  });
  if (value.bindingServerIdentityId !== undefined && value.scope.kind !== 'account') context.addIssue({
    code: "custom", path: ['bindingServerIdentityId'],
    message: 'A per-server Settings binding belongs to an Account record.',
  });
}

const ScopeSelectedSettingsActionBaseSchema = lazyZodSchema(() => z.strictObject({
  pluginId: asProtocolZod(PluginIdSchema),
  scope: PluginSettingsScopeRefV1Schema,
  target: PluginSettingsAdministrationTargetV1Schema,
}).check(z.superRefine(requireScopeTargetMatch)));

const ScopeSelectedSettingsFieldActionBaseSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ScopeSelectedSettingsActionBaseSchema, {
  localId: PluginSettingFieldIdV2Schema,
  /** Explicit null selects the declared fallback; omission retains the original operation. */
  bindingServerIdentityId: z.optional(z.nullable(z.string().check(z.trim(), z.regex(SERVER_IDENTITY_ID_PATTERN)))),
})).check(z.superRefine(requireScopeTargetMatch)));

/**
 * Secret declarations are globally unique per plugin, so a direct secret can
 * be administered without inventing a Settings scope. A declared settings
 * secret may still carry its presentation scope for exact field lookup. When
 * that secret's custody is daemon, `secretDaemonTarget` selects that existing
 * machine owner independently of its Settings scope.
 */
const CanonicalSecretOriginV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value
      && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}, 'A canonical HTTP(S) origin is required.')));

const SecretActionBaseSchema = lazyZodSchema(() => z.strictObject({
  pluginId: asProtocolZod(PluginIdSchema),
  localId: PluginSettingFieldIdV2Schema,
  scope: z.optional(PluginSettingsScopeRefV1Schema),
  target: z.optional(PluginSettingsAdministrationTargetV1Schema),
  secretDaemonTarget: z.optional(PluginSettingsAdministrationDaemonTargetV1Schema),
  /** Credential partition selected before approval; it is never re-derived on replay. */
  canonicalOrigin: z.optional(CanonicalSecretOriginV1Schema),
}).check(z.superRefine((value, context) => {
  if (value.scope && !value.target) {
    context.addIssue({
      code: "custom",
      path: ['target'],
      message: 'A selected Settings scope requires its exact target.',
    });
    return;
  }
  if (value.target && !value.scope) {
    context.addIssue({
      code: "custom",
      path: ['scope'],
      message: 'A Settings target requires an explicit Settings scope.',
    });
    return;
  }
  if (value.scope && value.target && value.scope.kind !== value.target.kind) {
    context.addIssue({
      code: "custom",
      path: ['target'],
      message: 'Plugin Settings administration target must match the selected scope.',
    });
  }
  if (value.scope?.kind === 'daemon' && value.secretDaemonTarget) {
    context.addIssue({
      code: "custom",
      path: ['secretDaemonTarget'],
      message: 'A daemon Settings scope already supplies the exact daemon secret target.',
    });
  }
})));

const SecretMutationActionBaseSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SecretActionBaseSchema, {
  expectedRevision: z.optional(ExpectedRevisionSchema),
})));

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
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ScopeSelectedSettingsFieldActionBaseSchema, {
    value: StrictJsonValueSchema,
    expectedRevision: z.optional(ExpectedRevisionSchema),
  })).check(z.superRefine(requireScopeTargetMatch)));
export type PluginSettingsAdministrationSetActionInputV1 = z.infer<
  typeof PluginSettingsAdministrationSetActionInputV1Schema
>;

export const PluginSettingsAdministrationResetActionInputV1Schema =
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ScopeSelectedSettingsFieldActionBaseSchema, {
    expectedRevision: z.optional(ExpectedRevisionSchema),
  })).check(z.superRefine(requireScopeTargetMatch)));
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
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SecretMutationActionBaseSchema, {
    savedSecretId: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
  })));
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
  z.ZodMiniType
>>;

/** Schema-admitted selection shared by placement and approval custody. */
export function resolvePluginSettingsAdministrationTargetV1(
  actionId: PluginSettingsAdministrationActionIdV1,
  input: unknown,
): PluginSettingsAdministrationTargetV1 {
  const parsed = PluginSettingsAdministrationActionInputSchemasV1[actionId].parse(input);
  if ('secretDaemonTarget' in parsed && parsed.secretDaemonTarget) return parsed.secretDaemonTarget;
  if ('target' in parsed && parsed.target) return parsed.target;
  return { kind: 'account' };
}

const PluginSettingsAdministrationResultTextV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(4_096)));
// A list result carries at most one entry per field the record itself admits,
// so this cardinality is read from the canonical Settings bounds owner rather
// than transcribed here.
const PluginSettingsAdministrationResultFieldsV1Schema = lazyZodSchema(() => z.array(z.union([
  z.strictObject({
    localId: PluginSettingFieldIdV2Schema,
    title: z.optional(PluginSettingsAdministrationResultTextV1Schema),
    description: z.optional(PluginSettingsAdministrationResultTextV1Schema),
    secret: z.literal(true),
  }),
  z.strictObject({
    localId: PluginSettingFieldIdV2Schema,
    title: z.optional(PluginSettingsAdministrationResultTextV1Schema),
    description: z.optional(PluginSettingsAdministrationResultTextV1Schema),
    secret: z.literal(false),
    value: StrictJsonValueSchema,
  }),
])).check(z.maxLength(PLUGIN_ACCOUNT_SETTINGS_MAXIMUM_FIELDS_V1)));
const PluginSettingsAdministrationLiveApplicationV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('live'),
}));

const PluginSettingsAdministrationListResultDataV1Schema = lazyZodSchema(() => z.strictObject({
  scope: PluginSettingsScopeRefV1Schema,
  target: PluginSettingsAdministrationTargetV1Schema,
  revision: ExpectedRevisionSchema,
  fields: PluginSettingsAdministrationResultFieldsV1Schema,
}).check(z.superRefine(requireScopeTargetMatch)));
const PluginSettingsAdministrationGetResultDataV1Schema = lazyZodSchema(() => z.strictObject({
  scope: PluginSettingsScopeRefV1Schema,
  target: PluginSettingsAdministrationTargetV1Schema,
  localId: PluginSettingFieldIdV2Schema,
  revision: ExpectedRevisionSchema,
  value: StrictJsonValueSchema,
}).check(z.superRefine(requireScopeTargetMatch)));
const PluginSettingsAdministrationMutationResultDataV1Schema = lazyZodSchema(() => z.strictObject({
  scope: PluginSettingsScopeRefV1Schema,
  target: PluginSettingsAdministrationTargetV1Schema,
  localId: PluginSettingFieldIdV2Schema,
  revision: ExpectedRevisionSchema,
  application: PluginSettingsAdministrationLiveApplicationV1Schema,
}).check(z.superRefine(requireScopeTargetMatch)));

const PluginSettingsAdministrationAccountSecretStatusResultDataV1Schema = lazyZodSchema(() => z.strictObject({
  localId: PluginSettingFieldIdV2Schema,
  custody: z.literal('account'),
  target: PluginSettingsAdministrationAccountTargetV1Schema,
  state: z.enum(['configured', 'missing']),
  revision: ExpectedRevisionSchema,
}));
const PluginSettingsAdministrationDaemonSecretStatusResultDataV1Schema = lazyZodSchema(() => z.strictObject({
  localId: PluginSettingFieldIdV2Schema,
  custody: z.literal('daemon'),
  target: PluginSettingsAdministrationDaemonTargetV1Schema,
  state: z.enum(['configured', 'missing', 'denied', 'unavailable']),
  revision: ExpectedRevisionSchema,
}));
const PluginSettingsAdministrationSecretStatusResultDataV1Schema = lazyZodSchema(() => z.union([
  PluginSettingsAdministrationAccountSecretStatusResultDataV1Schema,
  PluginSettingsAdministrationDaemonSecretStatusResultDataV1Schema,
]));
const PluginSettingsAdministrationAccountSecretMutationResultDataV1Schema = lazyZodSchema(() => z.strictObject({
  localId: PluginSettingFieldIdV2Schema,
  custody: z.literal('account'),
  target: PluginSettingsAdministrationAccountTargetV1Schema,
  revision: ExpectedRevisionSchema,
  application: PluginSettingsAdministrationLiveApplicationV1Schema,
}));
const PluginSettingsAdministrationDaemonSecretDeleteResultDataV1Schema = lazyZodSchema(() => z.strictObject({
  localId: PluginSettingFieldIdV2Schema,
  custody: z.literal('daemon'),
  target: PluginSettingsAdministrationDaemonTargetV1Schema,
  state: z.enum(['configured', 'missing', 'denied', 'unavailable']),
  revision: ExpectedRevisionSchema,
  application: PluginSettingsAdministrationLiveApplicationV1Schema,
}));

/** The incumbent owner's safe settlement readback; never a second read or secret record. */
export const PluginSettingsAdministrationFailureDetailsV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    kind: z.literal('settings_snapshot'),
    scope: PluginSettingsScopeRefV1Schema,
    target: PluginSettingsAdministrationTargetV1Schema,
    revision: ExpectedRevisionSchema,
    values: z.record(z.string(), StrictJsonValueSchema),
  }).check(z.superRefine(requireScopeTargetMatch)),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PluginSettingsAdministrationAccountSecretStatusResultDataV1Schema, {
    kind: z.literal('secret_snapshot'),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PluginSettingsAdministrationDaemonSecretStatusResultDataV1Schema, {
    kind: z.literal('secret_snapshot'),
    canonicalOrigin: z.optional(CanonicalSecretOriginV1Schema),
  })),
]));
export type PluginSettingsAdministrationFailureDetailsV1 = z.infer<typeof PluginSettingsAdministrationFailureDetailsV1Schema>;

/**
 * The public administration result vocabulary is action-specific and closed.
 * Secret actions can carry only custody, current target, status, and revision;
 * no raw secret material has a schema path.
 */
export const PluginSettingsAdministrationActionOutputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    ok: z.literal(true),
    kind: z.literal('plugins.settings.list'),
    data: PluginSettingsAdministrationListResultDataV1Schema,
  }),
  z.strictObject({
    ok: z.literal(true),
    kind: z.literal('plugins.settings.get'),
    data: PluginSettingsAdministrationGetResultDataV1Schema,
  }),
  z.strictObject({
    ok: z.literal(true),
    kind: z.literal('plugins.settings.set'),
    data: PluginSettingsAdministrationMutationResultDataV1Schema,
  }),
  z.strictObject({
    ok: z.literal(true),
    kind: z.literal('plugins.settings.reset'),
    data: PluginSettingsAdministrationMutationResultDataV1Schema,
  }),
  z.strictObject({
    ok: z.literal(true),
    kind: z.literal('plugins.settings.secret.status'),
    data: PluginSettingsAdministrationSecretStatusResultDataV1Schema,
  }),
  z.strictObject({
    ok: z.literal(true),
    kind: z.literal('plugins.settings.secret.bind'),
    data: PluginSettingsAdministrationAccountSecretMutationResultDataV1Schema,
  }),
  z.strictObject({
    ok: z.literal(true),
    kind: z.literal('plugins.settings.secret.unbind'),
    data: PluginSettingsAdministrationAccountSecretMutationResultDataV1Schema,
  }),
  z.strictObject({
    ok: z.literal(true),
    kind: z.literal('plugins.settings.secret.delete'),
    data: z.union([
      PluginSettingsAdministrationAccountSecretMutationResultDataV1Schema,
      PluginSettingsAdministrationDaemonSecretDeleteResultDataV1Schema,
    ]),
  }),
  z.strictObject({
    ok: z.literal(false),
    kind: PluginSettingsAdministrationActionIdV1Schema,
    errorCode: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
    error: PluginSettingsAdministrationResultTextV1Schema,
    details: z.optional(PluginSettingsAdministrationFailureDetailsV1Schema),
  }).check(z.superRefine((value, context) => {
    if (value.details && value.kind.startsWith('plugins.settings.secret.') !== (value.details.kind === 'secret_snapshot'))
      context.addIssue({ code: "custom", path: ['details'], message: 'Settlement must match the Settings or Secret owner.' });
  })),
]));
export type PluginSettingsAdministrationActionOutputV1 = z.infer<
  typeof PluginSettingsAdministrationActionOutputV1Schema
>;
