import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ActionInputHintsSchema } from '../actions/actionInputHints.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { PluginContributionIdentityV1Schema as CanonicalPluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { PluginUiRuntimeOccurrenceIdV1Schema as CanonicalPluginUiRuntimeOccurrenceIdV1Schema } from '../plugins/ui/targetedContributions.js';
import { PluginSourceCustodyV1Schema, pluginSourceCustodyV1Equal } from '../plugins/runtime/sourceCustody.js';
import { PluginMachineExecutionOriginV1Schema, getPluginMachineExecutionOriginRef } from '../machines/administration/pluginMachineExecutionOriginV1.js';
import { PluginMachineMaterializationRefV1Schema } from '../plugins/availability/materializationRefV1.js';
import { PluginJsonSchemaV2Schema, PluginLocalizedStringV2Schema } from '../plugins/contributions/publicTypes.js';
import { PluginEventAutomationDeclarationV1Schema } from '../automations/automationEventDeclarationV1.js';
import { PluginWebhookEndpointAuthoringSetupV1Schema } from '../plugins/webhooks/endpointV1.js';

const PluginContributionIdentityV1Schema = lazyZodSchema(() => asProtocolZod(CanonicalPluginContributionIdentityV1Schema));
const PluginUiRuntimeOccurrenceIdV1Schema = lazyZodSchema(() => asProtocolZod(CanonicalPluginUiRuntimeOccurrenceIdV1Schema));

export const DaemonContributionRegistryProjectionAutomationEligibleEventActionV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.trim(), z.minLength(1), z.maxLength(1024)),
  identity: PluginContributionIdentityV1Schema,
  occurrenceId: PluginUiRuntimeOccurrenceIdV1Schema,
  title: z.string().check(z.trim(), z.minLength(1)),
  description: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  inputSchema: PluginJsonSchemaV2Schema,
  inputHints: z.nullable(ActionInputHintsSchema),
}));
export type DaemonContributionRegistryProjectionAutomationEligibleEventActionV1 = z.infer<
  typeof DaemonContributionRegistryProjectionAutomationEligibleEventActionV1Schema
>;

/** The declaration/setup catalog shared by daemon presentation and headless authoring. */
export const AutomationEligibleEventCatalogEntryV1Schema = lazyZodSchema(() => z.strictObject({
  event: z.strictObject({
    id: z.string().check(z.trim(), z.minLength(1), z.maxLength(1024)),
    identity: PluginContributionIdentityV1Schema,
    occurrenceId: PluginUiRuntimeOccurrenceIdV1Schema,
    sourceCustody: PluginSourceCustodyV1Schema,
    title: z.string().check(z.trim(), z.minLength(1)),
    description: z.nullable(z.string().check(z.trim(), z.minLength(1))),
    localizedPresentation: z.optional(z.strictObject({
      title: PluginLocalizedStringV2Schema,
      description: z.optional(PluginLocalizedStringV2Schema),
    })),
    payloadSchema: z.optional(PluginJsonSchemaV2Schema),
    automation: PluginEventAutomationDeclarationV1Schema,
  }),
  setupAction: DaemonContributionRegistryProjectionAutomationEligibleEventActionV1Schema,
  historyGapResetAction: z.optional(DaemonContributionRegistryProjectionAutomationEligibleEventActionV1Schema),
  /** Derived from the admitted webhook declaration; no credential is projected. */
  webhookEndpointSetup: z.optional(PluginWebhookEndpointAuthoringSetupV1Schema),
  /** Same current daemon source, with its actual host-owned observer assignment. */
  observationBinding: z.optional(z.strictObject({
    executionOrigin: PluginMachineExecutionOriginV1Schema,
    materializationRef: PluginMachineMaterializationRefV1Schema,
  })),
}).check(z.superRefine((entry, context) => {
  const binding = entry.observationBinding;
  if (binding) {
    const source = getPluginMachineExecutionOriginRef(binding.executionOrigin);
    if (source.pluginId !== entry.event.identity.pluginId
      || binding.materializationRef.pluginId !== entry.event.identity.pluginId
      || source.machineId !== binding.materializationRef.machineId
      || ('materializationRef' in binding.executionOrigin
        && binding.executionOrigin.materializationRef.materializationId !== binding.materializationRef.materializationId)
      || ('sourceRef' in binding.executionOrigin
        && !pluginSourceCustodyV1Equal(binding.executionOrigin.sourceRef.sourceCustody, entry.event.sourceCustody))) {
      context.addIssue({ code: 'custom', path: ['observationBinding'],
        message: 'Observer assignment must match the exact admitted Event source and host.' });
    }
  }
  const requireSamePluginOccurrence = (
    value: Readonly<{ identity: Readonly<{ pluginId: string }>; occurrenceId: string }>,
    path: (string | number)[],
  ) => {
    if (value.identity.pluginId !== entry.event.identity.pluginId
      || value.occurrenceId !== entry.event.occurrenceId) {
      context.addIssue({ code: "custom", path,
        message: 'Automation Action must carry the exact admitted Event plugin occurrence.' });
    }
  };
  requireSamePluginOccurrence(entry.setupAction, ['setupAction']);
  if (entry.historyGapResetAction) requireSamePluginOccurrence(entry.historyGapResetAction, ['historyGapResetAction']);
})));
export type AutomationEligibleEventCatalogEntryV1 = z.output<typeof AutomationEligibleEventCatalogEntryV1Schema>;

export const AutomationEligibleEventsCatalogV1Schema = lazyZodSchema(() => z.array(AutomationEligibleEventCatalogEntryV1Schema));

/** Physical setup renderers remain in the daemon's UI projection, outside the declaration catalog. */
export function projectAutomationEligibleEventsCatalogV1(
  events: readonly AutomationEligibleEventCatalogEntryV1[],
): AutomationEligibleEventCatalogEntryV1[] {
  return events.map(({ event, setupAction, historyGapResetAction, webhookEndpointSetup, observationBinding }) => ({
    event, setupAction, ...(historyGapResetAction === undefined ? {} : { historyGapResetAction }),
    ...(webhookEndpointSetup === undefined ? {} : { webhookEndpointSetup }),
    ...(observationBinding === undefined ? {} : { observationBinding }),
  }));
}
