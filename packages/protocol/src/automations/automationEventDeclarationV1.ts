import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';

import { AutomationEventPositiveSafeIntegerV1Schema } from './automationColumnBoundsV1.js';
import {
  AutomationSourceSelectorIdV1Schema,
  type AutomationSourceSelectorIdV1,
} from './automationEventJsonBoundsV1.js';
export {
  AutomationSourceSelectorIdV1JsonSchema,
  AutomationSourceSelectorIdV1Schema,
  type AutomationSourceSelectorIdV1,
} from './automationEventJsonBoundsV1.js';

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

export const AutomationQualifiedPluginContributionRefV1Schema =
  PluginContributionIdentityV1Schema;
export type AutomationQualifiedPluginContributionRefV1 = PluginContributionIdentityV1;

/**
 * One selected observation transport per Event source. `checkpointedPull` is
 * the ordered provider-cursor contract whose consumer must advance a durable
 * provider checkpoint; `socket` is a provider-owned long-lived session-bound
 * observation with no ordered pull checkpoint and no provider checkpoint
 * cursor; `durablePush` is the webhook-delivered transport.
 */
export const AutomationObservationTransportKindV1Schema = lazyZodSchema(() => z.enum([
  'checkpointedPull',
  'durablePush',
  'socket',
]));
export type AutomationObservationTransportKindV1 = z.infer<
  typeof AutomationObservationTransportKindV1Schema
>;

/** Descriptor-only eligibility on the canonical Event contribution. */
export const PluginEventAutomationDeclarationV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  eligible: z.literal(true),
  source: z.object({
    sourceContractVersion: AutomationEventPositiveSafeIntegerV1Schema,
    supportedObservationTransports: z.array(AutomationObservationTransportKindV1Schema)
      .min(1)
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
}));
export type PluginEventAutomationDeclarationV1 = z.infer<
  typeof PluginEventAutomationDeclarationV1Schema
>;
