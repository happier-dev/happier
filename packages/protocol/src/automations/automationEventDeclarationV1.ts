import { z } from 'zod';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';

import { AUTOMATION_INT_COLUMN_MAX } from './automationColumnBoundsV1.js';

import {
  PluginContributionIdentityV1Schema,
  type PluginContributionIdentityV1,
} from '../plugins/contributionIdentity.js';
import {
  PluginJsonSchemaV2Schema,
  type PluginJsonSchemaV2,
} from '../plugins/contributions/publicTypes.js';
import {
  hasValidPluginConnectedAccountPurposeBindingsV2,
  PluginActionConnectedAccountPurposeBindingV2Schema,
} from '../plugins/actions/v2.js';
import { PluginUiRendererChainBindingV1Schema } from '../plugins/contributions/ui/rendererChainBinding.js';

/**
 * Shared positive counter/version primitive for Automation Event contracts.
 * Its one current use, the Event source contract version, persists as the
 * 32-bit `AutomationTrigger.sourceContractVersion` column, so admission caps it
 * at that column's ceiling rather than at the JavaScript safe-integer range.
 */
export const AutomationEventPositiveSafeIntegerV1Schema = z.number().int().positive()
  .max(AUTOMATION_INT_COLUMN_MAX);

const AUTOMATION_SOURCE_SELECTOR_ID_V1_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

/**
 * A source selector identifies the declared Event source independently of a
 * persisted occurrence. Keeping it with Event declarations lets declaration
 * consumers use the exact identity contract without importing occurrence
 * hashing or E2EE lifecycle code.
 */
export const AutomationSourceSelectorIdV1Schema = z.string().regex(
  new RegExp(AUTOMATION_SOURCE_SELECTOR_ID_V1_PATTERN, 'u'),
  'Source selectors must be canonical lowercase RFC 4122 UUID-v4 values',
).brand<'AutomationSourceSelectorIdV1'>();
export type AutomationSourceSelectorIdV1 = z.infer<typeof AutomationSourceSelectorIdV1Schema>;
export const AutomationSourceSelectorIdV1JsonSchema = {
  type: 'string',
  pattern: AUTOMATION_SOURCE_SELECTOR_ID_V1_PATTERN,
} as const satisfies PluginJsonSchemaV2;

export const AutomationQualifiedPluginContributionRefV1Schema =
  PluginContributionIdentityV1Schema;
export type AutomationQualifiedPluginContributionRefV1 = PluginContributionIdentityV1;

export const AutomationObservationTransportKindV1Schema = z.enum([
  'checkpointedPull',
  'durablePush',
]);
export type AutomationObservationTransportKindV1 = z.infer<
  typeof AutomationObservationTransportKindV1Schema
>;

/** Descriptor-only eligibility on the canonical Event contribution. */
export const PluginEventAutomationDeclarationV1Schema = z.object({
  v: z.literal(1),
  eligible: z.literal(true),
  source: z.object({
    sourceContractVersion: AutomationEventPositiveSafeIntegerV1Schema,
    supportedObservationTransports: z.array(AutomationObservationTransportKindV1Schema)
      .min(1)
      .max(2)
      .superRefine((value, context) => {
        if (new Set(value).size !== value.length) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: 'Observation transports must be unique' });
        }
      }),
    webhookContributionRef: asProtocolZod(AutomationQualifiedPluginContributionRefV1Schema).optional(),
    sourceConfigSchema: PluginJsonSchemaV2Schema,
    setupActionRef: asProtocolZod(AutomationQualifiedPluginContributionRefV1Schema),
    /**
     * Optional same-plugin renderer chain for collecting strict setup Action
     * input. The host still owns Action validation, invocation and setup-result
     * handling; this is presentation only and never targeted membership.
     */
    setupSurface: PluginUiRendererChainBindingV1Schema.optional(),
    historyGapResetActionRef: asProtocolZod(AutomationQualifiedPluginContributionRefV1Schema).optional(),
    /**
     * A history-gap reset may bind the exact Account persisted in the current
     * source config. This is declarative source metadata; reset Action input
     * stays the strict source-identity triple and never carries credentials.
     */
    connectedAccountPurposeBindings: z.array(
      PluginActionConnectedAccountPurposeBindingV2Schema,
    ).max(8).optional(),
  }).strict(),
}).strict().superRefine((value, context) => {
  const supportsDurablePush = value.source.supportedObservationTransports.includes('durablePush');
  if (supportsDurablePush !== (value.source.webhookContributionRef !== undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['source', 'webhookContributionRef'],
      message: 'durablePush requires exactly one webhook contribution reference',
    });
  }
  if (!value.source.supportedObservationTransports.includes('checkpointedPull')
    && value.source.historyGapResetActionRef !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['source', 'historyGapResetActionRef'],
      message: 'history-gap recovery requires checkpointedPull observation support',
    });
  }
  const purposeBindings = value.source.connectedAccountPurposeBindings ?? [];
  if (purposeBindings.length > 0 && value.source.historyGapResetActionRef === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['source', 'historyGapResetActionRef'],
      message: 'Connected Account source bindings require a history-gap recovery Action.',
    });
  }
  if (!hasValidPluginConnectedAccountPurposeBindingsV2(
    value.source.sourceConfigSchema,
    purposeBindings,
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['source', 'connectedAccountPurposeBindings'],
      message: 'Connected Account source bindings must target one exact qualified credential-ref source-config leaf in every declared input arm.',
    });
  }
});
export type PluginEventAutomationDeclarationV1 = z.infer<
  typeof PluginEventAutomationDeclarationV1Schema
>;
