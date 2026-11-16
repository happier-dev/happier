import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import { CanonicalHttpOriginSchema } from '../http/canonicalHttpOrigin.js';
import { InputPathSchema } from '../inputs/inputPredicates.js';
import { MachineRecipeReferenceV1Schema } from '../machines/setup/machineRecipeReferenceV1.js';
import { PluginContributionLocalIdSchema } from '../plugins/contributionIdentity.js';
import { AccessProviderRefV1Schema } from '../plugins/contributions/accessProviderSelection.js';
import { PluginClientExecutionReferenceV1Schema } from '../plugins/contributions/clientExecution.js';
import {
  PluginConfigurationSettingFieldV2Schema,
  PluginSettingFieldV2Schema,
  PluginSettingFieldIdV2Schema,
} from '../plugins/contributions/settings.js';
import {
  PluginJsonValueV2Schema,
  PluginLocalizedStringV2Schema,
} from '../plugins/contributions/publicTypes.js';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";
import { ProviderAccountUsageRecordKeyV1Schema } from './providerAccountUsagePrimitives.js';
import type { ConnectedServiceCredentialKind } from './connectedServiceCredentialKind.js';
import { QualifiedConnectedAccountCredentialKeyV1Schema } from './qualifiedConnectedAccountCredentialKeyV1.js';

const PluginConnectedAccountAuthenticationFieldV2Schema =
  lazyZodSchema(() => z.pipe(PluginSettingFieldV2Schema, z.transform((field) => ({
    ...field,
    secret: field.secret === true,
  }))));

const [
  PluginSecretConfigurationSettingFieldV2Schema,
  PluginPublicConfigurationSettingFieldV2Schema,
] = PluginConfigurationSettingFieldV2Schema._zod.def.options;

const PluginConnectedAccountOriginValueSchemaV2Schema = lazyZodSchema(() => z.strictObject({
  type: z.literal('string'),
  title: z.optional(z.string()),
  description: z.optional(z.string()),
  minLength: z.number().check(z.int(), z.minimum(1)),
  maxLength: z.optional(z.number().check(z.int(), z.nonnegative())),
}));

/**
 * The closed choice set of a fixed-origin field. Its persisted value is the
 * choice, never the origin: a user picking a named deployment is not asked to
 * retype a URL the descriptor already knows.
 */
const PluginConnectedAccountFixedOriginChoiceSchemaV2Schema = lazyZodSchema(() => z.strictObject({
  type: z.literal('string'),
  title: z.optional(z.string()),
  description: z.optional(z.string()),
  enum: z.array(z.string().check(z.minLength(1))).check(z.minLength(1)),
}));

export const PluginConnectedAccountConfigurationFieldV2Schema =
  lazyZodSchema(() => z.union([
    z.pipe(z.extend(PluginSecretConfigurationSettingFieldV2Schema, {
      semantic: z.optional(z.never()),
    }), z.transform((field) => ({
      ...field,
      secret: true as const,
    }))),
    z.pipe(z.extend(PluginPublicConfigurationSettingFieldV2Schema, {
      semantic: z.optional(z.never()),
    }), z.transform((field) => ({
      ...field,
      secret: false as const,
    }))),
    z.pipe(z.extend(z.omit(PluginPublicConfigurationSettingFieldV2Schema, {
        schema: true,
        default: true,
        required: true,
      }), {
        semantic: z.literal('connectedAccountOrigin'),
        schema: PluginConnectedAccountOriginValueSchemaV2Schema,
        default: z.optional(z.never()),
        required: z.literal(true),
      }), z.transform((field) => ({
        ...field,
        secret: false as const,
      }))),
    z.pipe(z.extend(z.omit(PluginPublicConfigurationSettingFieldV2Schema, {
        schema: true,
        default: true,
        required: true,
      }), {
        semantic: z.literal('connectedAccountFixedOrigin'),
        schema: PluginConnectedAccountFixedOriginChoiceSchemaV2Schema,
        originByValue: z.record(z.string().check(z.minLength(1)), CanonicalHttpOriginSchema),
        default: z.optional(z.never()),
        required: z.literal(true),
      }).check(z.superRefine((field, context) => {
        // The choice set and the route table are one declaration seen from two
        // sides. Letting them disagree would leave a pickable value with no
        // route, or a route no user can select.
        const choices = new Set(field.schema.enum);
        const routed = new Set(Object.keys(field.originByValue));
        if (
          choices.size !== field.schema.enum.length
          || choices.size !== routed.size
          || [...choices].some((choice) => !routed.has(choice))
        ) {
          context.addIssue({
            code: 'custom',
            path: ['originByValue'],
            message: 'Fixed-origin choices must declare exactly one origin per distinct choice.',
          });
        }
      })), z.transform((field) => ({
        ...field,
        secret: false as const,
      }))),
    // A configured *service base* is a second, distinct fact from the network
    // origin: a deployment reached beneath a path segment — an Azure DevOps
    // organization or collection, a path-prefixed self-hosted GitLab or Sentry —
    // routes by the base while HostAccess keeps governing by the origin the
    // host derives from it. `connectedAccountOrigin` is deliberately not
    // loosened to carry a path, so `origin` keeps meaning scheme://host[:port].
    z.pipe(z.extend(z.omit(PluginPublicConfigurationSettingFieldV2Schema, {
        schema: true,
        default: true,
        required: true,
      }), {
        semantic: z.literal('connectedAccountBase'),
        schema: PluginConnectedAccountOriginValueSchemaV2Schema,
        default: z.optional(z.never()),
        required: z.literal(true),
      }), z.transform((field) => ({
        ...field,
        secret: false as const,
      }))),
  ]).check(z.superRefine((field, context) => {
      if (field.presentation?.binding !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['presentation', 'binding'],
          message: 'Connected Account configuration fields are already bound to their service or account target.',
        });
      }
    })));
export type PluginConnectedAccountConfigurationFieldV2 =
  z.infer<typeof PluginConnectedAccountConfigurationFieldV2Schema>;

function rejectDuplicateFieldIds(
  fields: readonly Readonly<{ id: string }>[],
  context: z.core.$RefinementCtx,
): void {
  const fieldIds = new Set<string>();
  fields.forEach((field, fieldIndex) => {
    if (fieldIds.has(field.id)) {
      context.addIssue({
        code: 'custom',
        path: [fieldIndex, 'id'],
        message: `Duplicate Connected Account field id '${field.id}'.`,
      });
    }
    fieldIds.add(field.id);
  });
}

const PluginConnectedAccountAuthenticationFieldsV2Schema =
  lazyZodSchema(() => z.array(PluginConnectedAccountAuthenticationFieldV2Schema).check(z.superRefine(rejectDuplicateFieldIds)));

const PluginConnectedAccountConfigurationFieldsV2Schema =
  lazyZodSchema(() => z.array(PluginConnectedAccountConfigurationFieldV2Schema).check(z.minLength(1), z.superRefine(rejectDuplicateFieldIds)));

export const PluginConnectedAccountConfigurationV2Schema = lazyZodSchema(() => z.strictObject({
  scope: z.enum(['service', 'account']),
  changeBehavior: z.enum(['refresh', 'reconnect']),
  fields: PluginConnectedAccountConfigurationFieldsV2Schema,
}));
export type PluginConnectedAccountConfigurationV2 =
  z.infer<typeof PluginConnectedAccountConfigurationV2Schema>;

const PluginConnectedAccountClientConfigurationV2Schema = lazyZodSchema(() => z.strictObject({
  clientIdFieldId: PluginSettingFieldIdV2Schema,
  scopesFieldId: PluginSettingFieldIdV2Schema,
}));

const PluginConnectedAccountOutcomeReconciliationV2Schema =
  lazyZodSchema(() => z.enum(['providerCheck', 'lateEvidence', 'none']));

export const CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 =
  'happier.team-credential-manual-connected-account-direct.v1' as const;

export const CONNECTED_ACCOUNT_ACCESS_ONLY_EXPORT_CONTRACT_V1 =
  'happier.team-credential-access-only-connected-account-direct.v1' as const;

export const ConnectedAccountDirectExportContractV1Schema = lazyZodSchema(() => z.union([
  z.literal(CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1),
  z.literal(CONNECTED_ACCOUNT_ACCESS_ONLY_EXPORT_CONTRACT_V1),
]));
export type ConnectedAccountDirectExportContractV1 = z.infer<typeof ConnectedAccountDirectExportContractV1Schema>;

/** Public declaration projection carried by the incumbent credential-health publication. */
export const ConnectedAccountDirectExportProjectionV1Schema = lazyZodSchema(() => z.strictObject({
  directExportContract: z.nullable(ConnectedAccountDirectExportContractV1Schema),
  contributionContractVersion: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
  /** Source-owned availability, independent of personal or brokered authentication health. */
  directExportFailure: z.optional(z.strictObject({
    code: z.literal('access_only_expiry_unavailable'),
    message: z.optional(z.string()),
  })),
}));
export type ConnectedAccountDirectExportProjectionV1 = z.infer<typeof ConnectedAccountDirectExportProjectionV1Schema>;

/** The plugin declares public metadata explicitly; all other credential/configuration fields remain private. */
export const PluginConnectedAccountAccessOnlyExportV1Schema = lazyZodSchema(() => z.strictObject({
  contractVersion: z.literal(CONNECTED_ACCOUNT_ACCESS_ONLY_EXPORT_CONTRACT_V1),
  accessTokenKey: QualifiedConnectedAccountCredentialKeyV1Schema,
  expiresAtMsKey: QualifiedConnectedAccountCredentialKeyV1Schema,
  metadataKeys: z.array(QualifiedConnectedAccountCredentialKeyV1Schema),
}).check(z.refine(declaration => {
  const keys = [declaration.accessTokenKey, declaration.expiresAtMsKey, ...declaration.metadataKeys];
  return new Set(keys).size === keys.length;
}, 'Access-only fields must have distinct keys.')));
export type PluginConnectedAccountAccessOnlyExportV1 = z.infer<typeof PluginConnectedAccountAccessOnlyExportV1Schema>;

export const PluginConnectedAccountDirectExportV2Schema = lazyZodSchema(() => z.strictObject({
  contractVersion: z.literal(CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1),
}));
export type PluginConnectedAccountDirectExportV2 = z.infer<
  typeof PluginConnectedAccountDirectExportV2Schema
>;

/**
 * Presentation guidance for creating a mode's credential or client: `url` is the provider console, `checklist[0]`
 * is the sentence that opens it, `permissions` lists what it must allow per feature. Presentation only.
 * `checklist[0]` may mark its destination in brackets ("Create a key in [Cursor Dashboard → API Keys]."): only that
 * phrase links to `url`. An unmarked sentence stays plain and the host offers `createKeyTitle` as the link after it.
 */
export const PluginConnectedAccountSetupGuideV2Schema = lazyZodSchema(() => z.strictObject({
  url: ConnectedAccountBillingUrlSchema,
  checklist: z.array(PluginLocalizedStringV2Schema),
  /** What the credential must allow, per feature: a list to pick from, not more steps. */
  permissions: z.optional(z.array(z.strictObject({
    feature: PluginLocalizedStringV2Schema,
    items: z.array(PluginLocalizedStringV2Schema).check(z.minLength(1)),
  }))),
  createKeyTitle: z.optional(PluginLocalizedStringV2Schema),
  billingNote: z.optional(PluginLocalizedStringV2Schema),
  shapeHint: z.optional(PluginLocalizedStringV2Schema),
}));

/** Only measured browser-unreachable modes change placement; omission preserves execution. */
const browserReachabilitySchema = z.literal('unreachable');

/** A native recipe prepares public configuration before the same manual authentication mode continues. */
export const PluginConnectedAccountMachineSetupV1Schema = lazyZodSchema(() => z.strictObject({
  title: PluginLocalizedStringV2Schema,
  recipe: MachineRecipeReferenceV1Schema,
  inputPrefill: z.optional(z.array(z.strictObject({
    path: InputPathSchema,
    source: z.strictObject({ kind: z.literal('privateNetworkHttps'), provider: AccessProviderRefV1Schema }),
  }))),
  afterApply: z.strictObject({
    modeId: asProtocolZod(PluginContributionLocalIdSchema),
    configurationFromInputs: z.record(PluginSettingFieldIdV2Schema, InputPathSchema),
  }),
}));
export type PluginConnectedAccountMachineSetupV1 = z.infer<typeof PluginConnectedAccountMachineSetupV1Schema>;

export const PluginConnectedAccountAuthenticationModeV2Schema =
  lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.strictObject({
      id: asProtocolZod(PluginContributionLocalIdSchema),
      kind: z.literal('manual'),
      browserReachability: z.optional(browserReachabilitySchema),
      title: z.optional(PluginLocalizedStringV2Schema),
      /** Presentation fact only: stored token material and absent usage never establish API-key mode. */
      apiKey: z.optional(z.literal(true)),
      outcomeReconciliation: z.literal('none'),
      fields: PluginConnectedAccountAuthenticationFieldsV2Schema,
      setup: z.optional(PluginConnectedAccountSetupGuideV2Schema),
      machineSetup: z.optional(PluginConnectedAccountMachineSetupV1Schema),
      configuration: z.optional(PluginConnectedAccountConfigurationV2Schema),
      directExport: z.optional(PluginConnectedAccountDirectExportV2Schema),
      accessOnlyExport: z.optional(PluginConnectedAccountAccessOnlyExportV1Schema),
      /** Verified manual input fields staged under these exact credential keys. */
      credentialFieldKeys: z.optional(z.record(PluginSettingFieldIdV2Schema, QualifiedConnectedAccountCredentialKeyV1Schema)),
      /** Omission is unknown. Import completion never establishes the original sign-in time. */
      credentialOrigin: z.optional(z.enum(['authentication', 'native_import'])),
      /** Canonical string values, with only an optional declared field-key projection; no runtime/provider verification. */
      accountDirectSave: z.optional(z.union([z.literal(true), z.strictObject({
        fieldKeys: z.record(PluginSettingFieldIdV2Schema, QualifiedConnectedAccountCredentialKeyV1Schema),
      })])),
    }).check(z.superRefine((mode, context) => {
      if (mode.machineSetup) {
        if (mode.machineSetup.afterApply.modeId !== mode.id) context.addIssue({
          code: 'custom', path: ['machineSetup', 'afterApply', 'modeId'],
          message: 'Machine setup must continue its declaring manual authentication mode.',
        });
        for (const fieldId of Object.keys(mode.machineSetup.afterApply.configurationFromInputs)) {
          if (!mode.configuration?.fields.some(field => field.id === fieldId && field.secret === false)) context.addIssue({
            code: 'custom', path: ['machineSetup', 'afterApply', 'configurationFromInputs', fieldId],
            message: 'Machine setup inputs may populate only declared public configuration fields.',
          });
        }
      }
      if (mode.directExport && mode.accessOnlyExport) context.addIssue({ code: 'custom', path: ['accessOnlyExport'],
        message: 'A mode has one direct export contract.' });
      if (mode.credentialFieldKeys) {
        const declared = new Set(mode.fields.map(field => field.id));
        const keys = Object.values(mode.credentialFieldKeys);
        if (Object.keys(mode.credentialFieldKeys).some(id => !declared.has(id)) || new Set(keys).size !== keys.length
          || mode.accountDirectSave !== undefined) context.addIssue({ code: 'custom', path: ['credentialFieldKeys'],
            message: 'Manual credential keys must name distinct declared fields and have one mapping owner.' });
      }
      if (mode.accountDirectSave && mode.configuration) context.addIssue({ code: 'custom', path: ['accountDirectSave'],
        message: 'Account-direct credentials cannot require daemon-owned configuration.' });
      if (typeof mode.accountDirectSave === 'object') {
        const mapping = mode.accountDirectSave.fieldKeys;
        const sourceIds = new Set(mode.fields.map(field => field.id));
        if (Object.keys(mapping).some(id => !sourceIds.has(id))) context.addIssue({ code: 'custom', path: ['accountDirectSave', 'fieldKeys'],
          message: 'Account-direct field keys must name declared manual fields.' });
        const keys = mode.fields.map(field => mapping[field.id] ?? field.id);
        if (new Set(keys).size !== keys.length || keys.some(key => !QualifiedConnectedAccountCredentialKeyV1Schema.safeParse(key).success)) {
          context.addIssue({ code: 'custom', path: ['accountDirectSave', 'fieldKeys'], message: 'Account-direct credential keys must be valid and unique.' });
        }
      }
    })),
    z.strictObject({
      id: asProtocolZod(PluginContributionLocalIdSchema),
      kind: z.literal('oauthAuthorizationCode'),
      browserReachability: z.optional(browserReachabilitySchema),
      title: z.optional(PluginLocalizedStringV2Schema),
      /** Omit to use the Home's Connected Account relay; declare only a provider-fixed callback. */
      callbackUrl: z.optional(z.url().check(z.maxLength(2_048))),
      scopes: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
      pkce: z.literal('required'),
      allowRawAuthorizationCode: z.optional(z.boolean()),
      /** Declared optional Account fields whose choices become available only after authorization. */
      postAuthenticationFieldIds: z.optional(z.array(PluginSettingFieldIdV2Schema)),
      /** How to register an own client, shown with the client fields; the attempt's callback is offered to copy. */
      setup: z.optional(PluginConnectedAccountSetupGuideV2Schema),
      outcomeReconciliation: PluginConnectedAccountOutcomeReconciliationV2Schema,
      configuration: z.optional(PluginConnectedAccountConfigurationV2Schema),
      clientConfiguration: z.optional(PluginConnectedAccountClientConfigurationV2Schema),
      accessOnlyExport: z.optional(PluginConnectedAccountAccessOnlyExportV1Schema),
    }).check(z.superRefine((mode, context) => {
      if (mode.postAuthenticationFieldIds !== undefined
        && (mode.configuration?.scope !== 'account'
          || new Set(mode.postAuthenticationFieldIds).size !== mode.postAuthenticationFieldIds.length
          || mode.postAuthenticationFieldIds.some(id => !mode.configuration?.fields.some(field => field.id === id && field.required !== true)))) {
        context.addIssue({ code: 'custom', path: ['postAuthenticationFieldIds'],
          message: 'Post-authentication fields must reference distinct optional Account configuration fields.' });
      }
    })),
    z.strictObject({
      id: asProtocolZod(PluginContributionLocalIdSchema),
      kind: z.literal('oauthDeviceCode'),
      browserReachability: z.optional(browserReachabilitySchema),
      title: z.optional(PluginLocalizedStringV2Schema),
      scopes: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
      outcomeReconciliation: PluginConnectedAccountOutcomeReconciliationV2Schema,
      configuration: z.optional(PluginConnectedAccountConfigurationV2Schema),
      clientConfiguration: z.optional(PluginConnectedAccountClientConfigurationV2Schema),
      accessOnlyExport: z.optional(PluginConnectedAccountAccessOnlyExportV1Schema),
    }),
  ]).check(z.superRefine((mode, context) => {
    if (mode.kind === 'manual' || mode.clientConfiguration === undefined) return;
    const { clientIdFieldId, scopesFieldId } = mode.clientConfiguration;
    const ids = [clientIdFieldId, scopesFieldId];
    if (clientIdFieldId === scopesFieldId || ids.some(id => !mode.configuration?.fields.some(field =>
      field.id === id && field.secret !== true && field.semantic === undefined && field.schema.type === 'string'))) {
      context.addIssue({ code: 'custom', path: ['clientConfiguration'],
        message: 'OAuth client configuration must reference distinct declared public string configuration fields.' });
    }
  })));
export type PluginConnectedAccountAuthenticationModeV2 =
  z.infer<typeof PluginConnectedAccountAuthenticationModeV2Schema>;

/** Current mode plus observed credential kind owns export eligibility; unknown legacy kinds use the establishing mode. */
export function resolveConnectedAccountDirectExportContractV1(
  mode: PluginConnectedAccountAuthenticationModeV2,
  credentialKind?: ConnectedServiceCredentialKind,
): ConnectedAccountDirectExportContractV1 | null {
  if (mode.accessOnlyExport && credentialKind !== 'token') return mode.accessOnlyExport.contractVersion;
  return mode.kind === 'manual' && credentialKind !== 'oauth' ? mode.directExport?.contractVersion ?? null : null;
}

/** Only the selected mode's explicit declaration identifies an API-key account. */
export function isConnectedAccountApiKeyModeV1(mode: PluginConnectedAccountAuthenticationModeV2 | null | undefined): boolean {
  return mode?.kind === 'manual' && mode.apiKey === true;
}

export function isAccountDirectConnectedAccountModeV1(mode: PluginConnectedAccountAuthenticationModeV2 | null | undefined):
  mode is Extract<PluginConnectedAccountAuthenticationModeV2, { kind: 'manual' }> & { accountDirectSave: NonNullable<Extract<PluginConnectedAccountAuthenticationModeV2, { kind: 'manual' }>['accountDirectSave']> } {
  return mode?.kind === 'manual' && mode.accountDirectSave !== undefined && mode.configuration === undefined;
}

/**
 * Credential keys of an Account-direct mode whose declared field is `secret`.
 * The declaration, not a service id or value match, decides custody: these
 * keys are held by one Saved Secret resource each and the credential keeps
 * only the reference.
 */
export function listAccountDirectSecretCredentialKeysV1(
  mode: PluginConnectedAccountAuthenticationModeV2 | null | undefined,
): ReadonlyMap<string, string> {
  if (!isAccountDirectConnectedAccountModeV1(mode)) return new Map();
  return listConnectedAccountSecretCredentialKeysV1(mode);
}

/** Declaration-owned field provenance; never infer a key by comparing secret values. */
export function listConnectedAccountSecretCredentialKeysV1(
  mode: PluginConnectedAccountAuthenticationModeV2 | null | undefined,
): ReadonlyMap<string, string> {
  if (mode?.kind !== 'manual') return new Map();
  if (mode.credentialFieldKeys) return new Map(mode.fields.filter(field => field.secret && Object.hasOwn(mode.credentialFieldKeys!, field.id))
    .map(field => [mode.credentialFieldKeys![field.id]!, field.id] as const));
  if (!isAccountDirectConnectedAccountModeV1(mode)) return new Map();
  const fieldKeys = mode.accountDirectSave === true ? null : mode.accountDirectSave.fieldKeys;
  return new Map(mode.fields.filter(field => field.secret === true)
    .map(field => [fieldKeys?.[field.id] ?? field.id, field.id] as const));
}

export const PluginConnectedAccountAuthenticationV2Schema = lazyZodSchema(() => z.strictObject({
  /** Optional authentication-only Account artifact; daemon native operations keep their runtime. */
  account: z.optional(PluginClientExecutionReferenceV1Schema),
  defaultModeId: asProtocolZod(PluginContributionLocalIdSchema),
  modes: z.array(PluginConnectedAccountAuthenticationModeV2Schema).check(z.minLength(1)),
  native: z.optional(z.strictObject({ systemTool: asProtocolZod(PluginContributionLocalIdSchema) })),
}).check(z.superRefine((authentication, context) => {
  const modeIds = new Set<string>();
  authentication.modes.forEach((mode, modeIndex) => {
    if (modeIds.has(mode.id)) {
      context.addIssue({
        code: 'custom',
        path: ['modes', modeIndex, 'id'],
        message: `Duplicate Connected Account authentication mode id '${mode.id}'.`,
      });
    }
    modeIds.add(mode.id);
  });
  if (!modeIds.has(authentication.defaultModeId)) {
    context.addIssue({
      code: 'custom',
      path: ['defaultModeId'],
      message: `Default Connected Account authentication mode '${authentication.defaultModeId}' is not declared.`,
    });
  }
})));
export type PluginConnectedAccountAuthenticationV2 =
  z.infer<typeof PluginConnectedAccountAuthenticationV2Schema>;

/**
 * One authored Connected Account descriptor contribution. It lives beside the
 * authentication vocabulary it composes so the whole author-visible Connected
 * Account family has a single narrow Protocol owner; the V2 contribution
 * catalog re-exports it for family registration.
 */
/** Authored provider navigation only; callers never supply or substitute this destination. */
export const ConnectedAccountBillingUrlSchema = lazyZodSchema(() => z.string().check(z.url(), z.refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password;
}, 'Billing destinations must be credential-free HTTPS URLs')));

export const PluginConnectedAccountDescriptorContributionV2Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  description: z.optional(PluginLocalizedStringV2Schema),
  /** Presentation only; omission retains the host's existing service classification. */
  ui: z.optional(z.strictObject({
    category: z.optional(z.literal('cloud-machines')),
    /** Same-plugin packaged Resource used for the service's distinct mark. */
    iconResourceId: z.optional(asProtocolZod(PluginContributionLocalIdSchema)),
    shortName: z.optional(z.string().check(z.trim(), z.minLength(1))),
    setup: z.optional(z.strictObject({
      order: z.optional(z.number()),
      firstRun: z.optional(z.boolean()),
      catalogDescription: z.optional(PluginLocalizedStringV2Schema),
    })),
  })),
  authentication: PluginConnectedAccountAuthenticationV2Schema,
  usageIdentity: z.optional(z.strictObject({
    providerId: z.optional(ProviderAccountUsageRecordKeyV1Schema.shape.providerId),
    requiredContext: z.optional(z.literal('organization')),
  }).check(z.refine(identity => identity.providerId !== undefined || identity.requiredContext !== undefined))),
  recoveryCredits: z.optional(z.strictObject({ supported: z.literal(true) })),
  billingUrl: z.optional(ConnectedAccountBillingUrlSchema),
  capabilities: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
  metadata: z.optional(z.record(z.string(), PluginJsonValueV2Schema)),
}));
export type PluginConnectedAccountDescriptorContributionV2 =
  z.infer<typeof PluginConnectedAccountDescriptorContributionV2Schema>;

/** One declaration-owned interpretation for fresh and retained plan observations. */
export function resolveConnectedAccountPlanLabel(
  value: string | null | undefined,
  metadata: PluginConnectedAccountDescriptorContributionV2['metadata'],
): string | null {
  const plan = value?.trim();
  if (!plan) return null;
  const labels = metadata?.planLabels;
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return plan;
  const label = labels[plan.toLowerCase()];
  return typeof label === 'string' && label.trim() ? label.trim() : plan;
}


/** Mode-local requirements take precedence over a service's portable Account artifact. */
export function resolveConnectedAccountAuthenticationModeMachineRequirement(
  mode: PluginConnectedAccountAuthenticationModeV2 | undefined,
  browser = false,
  operation: 'authentication' | 'testConnection' = 'authentication',
): 'native_import' | 'browser_unreachable' | null {
  if (operation === 'authentication' && mode?.kind === 'manual' && mode.credentialOrigin === 'native_import') return 'native_import';
  if (browser && mode?.browserReachability === 'unreachable') return 'browser_unreachable';
  return null;
}
