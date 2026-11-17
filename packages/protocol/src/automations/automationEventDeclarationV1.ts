import * as zMini from '../zodRuntimePolicy.js';
import { lazyZodSchema, lazyDefinition } from '../lazyZodSchema.js';
import { AutomationSubjectKindV1Schema, type AutomationSubjectKindV1 } from './automationSubjectV1.js';
import { z } from '../zodRuntimePolicy.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { ActionIdSchema, type ActionId } from '../actions/actionIds.js';
import { AutomationActionOutcomeV1Schema, type AutomationActionOutcomeV1 } from './automationActionIdentityV1.js';

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
  type PluginActionConnectedAccountPurposeBindingV2,
} from '../plugins/actions/v2.js';
import { PluginUiRendererChainBindingV1Schema, type PluginUiRendererChainBindingV1 } from '../plugins/contributions/ui/rendererChainBinding.js';
import { AutomationObservationOnlyIntentV1Schema } from './automationEventSetupResultV1.js';
import { PluginSubjectProjectionV1Schema, type PluginSubjectProjectionV1 } from '../plugins/actions/v2.js';
import { ScmHostingProviderKindSchema, type ScmHostingProviderKind } from '../scm/pullRequests.js';
import { MachinePresenceTransitionKindV1Schema, type MachinePresenceTransitionKindV1 } from '../machines/machinePresenceTransitionsV1.js';

export const AutomationQualifiedPluginContributionRefV1Schema =
  lazyDefinition(() => PluginContributionIdentityV1Schema);
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
const completionActionIdSchema: z.ZodMiniType<ActionId> = lazyZodSchema(() => ActionIdSchema);
function createPluginEventAutomationDeclarationV1Schema() {
return z.strictObject({
  v: z.literal(1),
  eligible: z.literal(true),
  /** Settled resource Events resolve accepted-handle Action completion. */
  completesActionIds: z.optional(z.array(completionActionIdSchema)),
  /** Terminal mapping owned by this existing Event producer (R25). */
  completionOutcome: z.optional(AutomationActionOutcomeV1Schema),
  subjects: z.optional(z.array(PluginSubjectProjectionV1Schema)),
  /** Native adapter identities; plugin support is derived from its validated subject projections. */
  subjectKinds: z.optional(z.array(AutomationSubjectKindV1Schema.check(z.refine(kind => kind !== 'plugin')))),
  source: z.strictObject({
    sourceContractVersion: AutomationEventPositiveSafeIntegerV1Schema,
    /** Binds an already synced native fact to this Event's ordinary setup Action. */
    nativeActivity: z.optional(z.strictObject({
      kind: z.literal('machinePresence'),
      transition: MachinePresenceTransitionKindV1Schema,
    })),
    /** Neutral lifecycle role consumed by deployment preview enrollment. */
    scmPullRequestLifecycle: z.optional(z.strictObject({
      providerKind: ScmHostingProviderKindSchema,
      /** Existing Forge Action used by a sibling receipt-change Workflow. */
      previewStatusActionRef: zMini.optional(asProtocolZod(AutomationQualifiedPluginContributionRefV1Schema)),
    })),
    supportedObservationTransports: z.array(AutomationObservationTransportKindV1Schema).check(z.minLength(1), z.superRefine((value, context) => {
        if (new Set(value).size !== value.length) {
          context.addIssue({ code: "custom", message: 'Observation transports must be unique' });
        }
      })),
    webhookContributionRef: zMini.optional(asProtocolZod(AutomationQualifiedPluginContributionRefV1Schema)),
    sourceConfigSchema: PluginJsonSchemaV2Schema,
    setupActionRef: asProtocolZod(AutomationQualifiedPluginContributionRefV1Schema),
    /** A new source can be saved without authoring an execution recipe. */
    observationOnly: z.optional(AutomationObservationOnlyIntentV1Schema),
    /**
     * Optional same-plugin renderer chain for collecting strict setup Action
     * input. The host still owns Action validation, invocation and setup-result
     * handling; this is presentation only and never targeted membership.
     */
    setupSurface: zMini.optional(PluginUiRendererChainBindingV1Schema),
    historyGapResetActionRef: zMini.optional(asProtocolZod(AutomationQualifiedPluginContributionRefV1Schema)),
    /**
     * A history-gap reset may bind the exact Account persisted in the current
     * source config. This is declarative source metadata; reset Action input
     * stays the strict source-identity triple and never carries credentials.
     */
    connectedAccountPurposeBindings: z.optional(z.array(
      PluginActionConnectedAccountPurposeBindingV2Schema,
    ).check(z.maxLength(8))),
  }),
}).check(z.superRefine((value, context) => {
  const supportsDurablePush = value.source.supportedObservationTransports.includes('durablePush');
  if (supportsDurablePush !== (value.source.webhookContributionRef !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ['source', 'webhookContributionRef'],
      message: 'durablePush requires exactly one webhook contribution reference',
    });
  }
  if (!value.source.supportedObservationTransports.includes('checkpointedPull')
    && !supportsDurablePush
    && value.source.historyGapResetActionRef !== undefined) {
    context.addIssue({
      code: "custom",
      path: ['source', 'historyGapResetActionRef'],
      message: 'history-gap recovery requires checkpointedPull or durablePush observation support',
    });
  }
  const purposeBindings = value.source.connectedAccountPurposeBindings ?? [];
  if (purposeBindings.length > 0 && value.source.historyGapResetActionRef === undefined) {
    context.addIssue({
      code: "custom",
      path: ['source', 'historyGapResetActionRef'],
      message: 'Connected Account source bindings require a history-gap recovery Action.',
    });
  }
  if (!hasValidPluginConnectedAccountPurposeBindingsV2(
    value.source.sourceConfigSchema,
    purposeBindings,
  )) {
    context.addIssue({
      code: "custom",
      path: ['source', 'connectedAccountPurposeBindings'],
      message: 'Connected Account source bindings must target one exact qualified credential-ref source-config leaf in every declared input arm.',
    });
  }
}));
}
export type PluginEventAutomationDeclarationV1 = {
  v: 1;
  eligible: true;
  completesActionIds?: ActionId[];
  completionOutcome?: AutomationActionOutcomeV1;
  subjects?: PluginSubjectProjectionV1[];
  subjectKinds?: AutomationSubjectKindV1[];
  source: {
    sourceContractVersion: number;
    nativeActivity?: {
      kind: 'machinePresence';
      transition: MachinePresenceTransitionKindV1;
    };
    scmPullRequestLifecycle?: {
      providerKind: ScmHostingProviderKind;
      previewStatusActionRef?: AutomationQualifiedPluginContributionRefV1;
    };
    supportedObservationTransports: AutomationObservationTransportKindV1[];
    webhookContributionRef?: AutomationQualifiedPluginContributionRefV1;
    sourceConfigSchema: PluginJsonSchemaV2;
    setupActionRef: AutomationQualifiedPluginContributionRefV1;
    observationOnly?: z.infer<typeof AutomationObservationOnlyIntentV1Schema>;
    setupSurface?: PluginUiRendererChainBindingV1;
    historyGapResetActionRef?: AutomationQualifiedPluginContributionRefV1;
    connectedAccountPurposeBindings?: PluginActionConnectedAccountPurposeBindingV2[];
  };
};
export const PluginEventAutomationDeclarationV1Schema: z.ZodMiniType<PluginEventAutomationDeclarationV1> =
  lazyZodSchema(createPluginEventAutomationDeclarationV1Schema);

/** The declaration owner supplies the supported subject kinds to every authoring surface. */
export function readAutomationEventSubjectKindsV1(
  declaration: PluginEventAutomationDeclarationV1 | undefined,
): readonly AutomationSubjectKindV1[] {
  const nativeKinds = declaration?.subjectKinds ?? [];
  return declaration?.subjects?.length ? [...nativeKinds, 'plugin'] : nativeKinds;
}
