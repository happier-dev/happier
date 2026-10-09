import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { CanonicalHttpOriginSchema } from '../http/canonicalHttpOrigin.js';
import { PluginContributionLocalIdSchema } from '../plugins/contributionIdentity.js';
import {
  PluginConfigurationSettingFieldV2Schema,
  PluginSettingFieldV2Schema,
} from '../plugins/contributions/settings.js';
import {
  PluginJsonValueV2Schema,
  PluginLocalizedStringV2Schema,
} from '../plugins/contributions/publicTypes.js';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";

const PluginConnectedAccountAuthenticationFieldV2Schema =
  lazyZodSchema(() => PluginSettingFieldV2Schema.transform((field) => ({
    ...field,
    secret: field.secret === true,
  })));

const [
  PluginSecretConfigurationSettingFieldV2Schema,
  PluginPublicConfigurationSettingFieldV2Schema,
] = PluginConfigurationSettingFieldV2Schema.options;

const PluginConnectedAccountOriginValueSchemaV2Schema = lazyZodSchema(() => z.object({
  type: z.literal('string'),
  title: z.string().optional(),
  description: z.string().optional(),
  minLength: z.number().int().min(1),
  maxLength: z.number().int().nonnegative().optional(),
}).strict());

/**
 * The closed choice set of a fixed-origin field. Its persisted value is the
 * choice, never the origin: a user picking a named deployment is not asked to
 * retype a URL the descriptor already knows.
 */
const PluginConnectedAccountFixedOriginChoiceSchemaV2Schema = lazyZodSchema(() => z.object({
  type: z.literal('string'),
  title: z.string().optional(),
  description: z.string().optional(),
  enum: z.array(z.string().min(1)).min(1),
}).strict());

export const PluginConnectedAccountConfigurationFieldV2Schema =
  lazyZodSchema(() => z.union([
    PluginSecretConfigurationSettingFieldV2Schema.extend({
      semantic: z.never().optional(),
    }).strict().transform((field) => ({
      ...field,
      secret: true as const,
    })),
    PluginPublicConfigurationSettingFieldV2Schema.extend({
      semantic: z.never().optional(),
    }).strict().transform((field) => ({
      ...field,
      secret: false as const,
    })),
    PluginPublicConfigurationSettingFieldV2Schema
      .omit({
        schema: true,
        default: true,
        required: true,
      })
      .extend({
        semantic: z.literal('connectedAccountOrigin'),
        schema: PluginConnectedAccountOriginValueSchemaV2Schema,
        default: z.never().optional(),
        required: z.literal(true),
      })
      .strict()
      .transform((field) => ({
        ...field,
        secret: false as const,
      })),
    PluginPublicConfigurationSettingFieldV2Schema
      .omit({
        schema: true,
        default: true,
        required: true,
      })
      .extend({
        semantic: z.literal('connectedAccountFixedOrigin'),
        schema: PluginConnectedAccountFixedOriginChoiceSchemaV2Schema,
        originByValue: z.record(z.string().min(1), CanonicalHttpOriginSchema),
        default: z.never().optional(),
        required: z.literal(true),
      })
      .strict()
      .superRefine((field, context) => {
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
      })
      .transform((field) => ({
        ...field,
        secret: false as const,
      })),
    // A configured *service base* is a second, distinct fact from the network
    // origin: a deployment reached beneath a path segment — an Azure DevOps
    // organization or collection, a path-prefixed self-hosted GitLab or Sentry —
    // routes by the base while HostAccess keeps governing by the origin the
    // host derives from it. `connectedAccountOrigin` is deliberately not
    // loosened to carry a path, so `origin` keeps meaning scheme://host[:port].
    PluginPublicConfigurationSettingFieldV2Schema
      .omit({
        schema: true,
        default: true,
        required: true,
      })
      .extend({
        semantic: z.literal('connectedAccountBase'),
        schema: PluginConnectedAccountOriginValueSchemaV2Schema,
        default: z.never().optional(),
        required: z.literal(true),
      })
      .strict()
      .transform((field) => ({
        ...field,
        secret: false as const,
      })),
  ])
    .superRefine((field, context) => {
      if (field.presentation?.binding !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['presentation', 'binding'],
          message: 'Connected Account configuration fields are already bound to their service or account target.',
        });
      }
    }));
export type PluginConnectedAccountConfigurationFieldV2 =
  z.infer<typeof PluginConnectedAccountConfigurationFieldV2Schema>;

function rejectDuplicateFieldIds(
  fields: readonly Readonly<{ id: string }>[],
  context: z.RefinementCtx,
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
  lazyZodSchema(() => z.array(PluginConnectedAccountAuthenticationFieldV2Schema)
    .superRefine(rejectDuplicateFieldIds));

const PluginConnectedAccountConfigurationFieldsV2Schema =
  lazyZodSchema(() => z.array(PluginConnectedAccountConfigurationFieldV2Schema)
    .min(1)
    .superRefine(rejectDuplicateFieldIds));

export const PluginConnectedAccountConfigurationV2Schema = lazyZodSchema(() => z.object({
  scope: z.enum(['service', 'account']),
  changeBehavior: z.enum(['refresh', 'reconnect']),
  fields: PluginConnectedAccountConfigurationFieldsV2Schema,
}).strict());
export type PluginConnectedAccountConfigurationV2 =
  z.infer<typeof PluginConnectedAccountConfigurationV2Schema>;

const PluginConnectedAccountOutcomeReconciliationV2Schema =
  lazyZodSchema(() => z.enum(['providerCheck', 'lateEvidence', 'none']));

export const CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 =
  'happier.team-credential-manual-connected-account-direct.v1' as const;

export const PluginConnectedAccountDirectExportV2Schema = lazyZodSchema(() => z.object({
  contractVersion: z.literal(CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1),
}).strict());
export type PluginConnectedAccountDirectExportV2 = z.infer<
  typeof PluginConnectedAccountDirectExportV2Schema
>;

export const PluginConnectedAccountAuthenticationModeV2Schema =
  lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.object({
      id: asProtocolZod(PluginContributionLocalIdSchema),
      kind: z.literal('manual'),
      title: PluginLocalizedStringV2Schema.optional(),
      outcomeReconciliation: z.literal('none'),
      fields: PluginConnectedAccountAuthenticationFieldsV2Schema,
      configuration: PluginConnectedAccountConfigurationV2Schema.optional(),
      directExport: PluginConnectedAccountDirectExportV2Schema.optional(),
    }).strict(),
    z.object({
      id: asProtocolZod(PluginContributionLocalIdSchema),
      kind: z.literal('oauthAuthorizationCode'),
      title: PluginLocalizedStringV2Schema.optional(),
      callbackUrl: z.url().max(2_048).optional(),
      scopes: z.array(z.string().trim().min(1)).optional(),
      pkce: z.literal('required'),
      allowRawAuthorizationCode: z.boolean().optional(),
      outcomeReconciliation: PluginConnectedAccountOutcomeReconciliationV2Schema,
      configuration: PluginConnectedAccountConfigurationV2Schema.optional(),
    }).strict(),
    z.object({
      id: asProtocolZod(PluginContributionLocalIdSchema),
      kind: z.literal('oauthDeviceCode'),
      title: PluginLocalizedStringV2Schema.optional(),
      scopes: z.array(z.string().trim().min(1)).optional(),
      outcomeReconciliation: PluginConnectedAccountOutcomeReconciliationV2Schema,
      configuration: PluginConnectedAccountConfigurationV2Schema.optional(),
    }).strict(),
  ]));
export type PluginConnectedAccountAuthenticationModeV2 =
  z.infer<typeof PluginConnectedAccountAuthenticationModeV2Schema>;

export const PluginConnectedAccountAuthenticationV2Schema = lazyZodSchema(() => z.object({
  defaultModeId: asProtocolZod(PluginContributionLocalIdSchema),
  modes: z.array(PluginConnectedAccountAuthenticationModeV2Schema).min(1),
  native: z.object({ systemTool: z.literal('gh') }).strict().optional(),
}).strict().superRefine((authentication, context) => {
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
}));
export type PluginConnectedAccountAuthenticationV2 =
  z.infer<typeof PluginConnectedAccountAuthenticationV2Schema>;

/**
 * One authored Connected Account descriptor contribution. It lives beside the
 * authentication vocabulary it composes so the whole author-visible Connected
 * Account family has a single narrow Protocol owner; the V2 contribution
 * catalog re-exports it for family registration.
 */
export const PluginConnectedAccountDescriptorContributionV2Schema = lazyZodSchema(() => z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  authentication: PluginConnectedAccountAuthenticationV2Schema,
  recoveryCredits: z.object({ supported: z.literal(true) }).strict().optional(),
  capabilities: z.array(z.string().trim().min(1)).optional(),
  metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
}).strict());
export type PluginConnectedAccountDescriptorContributionV2 =
  z.infer<typeof PluginConnectedAccountDescriptorContributionV2Schema>;
