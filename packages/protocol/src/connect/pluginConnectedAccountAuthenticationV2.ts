import { z } from 'zod';

import { PluginContributionLocalIdSchema } from '../plugins/contributionIdentity.js';
import {
  PluginConfigurationSettingFieldV2Schema,
  PluginSettingFieldV2Schema,
} from '../plugins/contributions/settings.js';
import { PluginLocalizedStringV2Schema } from '../plugins/contributions/publicTypes.js';

const PluginConnectedAccountAuthenticationFieldV2Schema =
  PluginSettingFieldV2Schema.transform((field) => ({
    ...field,
    secret: field.secret === true,
  }));

const [
  PluginSecretConfigurationSettingFieldV2Schema,
  PluginPublicConfigurationSettingFieldV2Schema,
] = PluginConfigurationSettingFieldV2Schema.options;

const PluginConnectedAccountOriginValueSchemaV2Schema = z.object({
  type: z.literal('string'),
  title: z.string().optional(),
  description: z.string().optional(),
  minLength: z.number().int().min(1),
  maxLength: z.number().int().nonnegative().optional(),
}).strict();

export const PluginConnectedAccountConfigurationFieldV2Schema =
  z.union([
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
  ])
    .superRefine((field, context) => {
      if (field.presentation?.binding !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['presentation', 'binding'],
          message: 'Connected Account configuration fields are already bound to their service or account target.',
        });
      }
    });
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
  z.array(PluginConnectedAccountAuthenticationFieldV2Schema)
    .min(1)
    .superRefine(rejectDuplicateFieldIds);

const PluginConnectedAccountConfigurationFieldsV2Schema =
  z.array(PluginConnectedAccountConfigurationFieldV2Schema)
    .min(1)
    .superRefine(rejectDuplicateFieldIds);

export const PluginConnectedAccountConfigurationV2Schema = z.object({
  scope: z.enum(['service', 'account']),
  changeBehavior: z.enum(['refresh', 'reconnect']),
  fields: PluginConnectedAccountConfigurationFieldsV2Schema,
}).strict();
export type PluginConnectedAccountConfigurationV2 =
  z.infer<typeof PluginConnectedAccountConfigurationV2Schema>;

const PluginConnectedAccountOutcomeReconciliationV2Schema =
  z.enum(['providerCheck', 'lateEvidence', 'none']);

export const PluginConnectedAccountAuthenticationModeV2Schema =
  z.discriminatedUnion('kind', [
    z.object({
      id: PluginContributionLocalIdSchema,
      kind: z.literal('manual'),
      title: PluginLocalizedStringV2Schema.optional(),
      outcomeReconciliation: z.literal('none'),
      fields: PluginConnectedAccountAuthenticationFieldsV2Schema,
      configuration: PluginConnectedAccountConfigurationV2Schema.optional(),
    }).strict(),
    z.object({
      id: PluginContributionLocalIdSchema,
      kind: z.literal('oauthAuthorizationCode'),
      title: PluginLocalizedStringV2Schema.optional(),
      callbackUrl: z.url().max(2_048).optional(),
      scopes: z.array(z.string().trim().min(1)).optional(),
      pkce: z.literal('required'),
      outcomeReconciliation: PluginConnectedAccountOutcomeReconciliationV2Schema,
      configuration: PluginConnectedAccountConfigurationV2Schema.optional(),
    }).strict(),
    z.object({
      id: PluginContributionLocalIdSchema,
      kind: z.literal('oauthDeviceCode'),
      title: PluginLocalizedStringV2Schema.optional(),
      scopes: z.array(z.string().trim().min(1)).optional(),
      outcomeReconciliation: PluginConnectedAccountOutcomeReconciliationV2Schema,
      configuration: PluginConnectedAccountConfigurationV2Schema.optional(),
    }).strict(),
  ]);
export type PluginConnectedAccountAuthenticationModeV2 =
  z.infer<typeof PluginConnectedAccountAuthenticationModeV2Schema>;

export const PluginConnectedAccountAuthenticationV2Schema = z.object({
  defaultModeId: PluginContributionLocalIdSchema,
  modes: z.array(PluginConnectedAccountAuthenticationModeV2Schema).min(1),
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
});
export type PluginConnectedAccountAuthenticationV2 =
  z.infer<typeof PluginConnectedAccountAuthenticationV2Schema>;
