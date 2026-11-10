import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ActionInputHintsSchema } from '../actions/actionInputHints.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { PluginContributionIdentityV1Schema as CanonicalPluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { PluginUiRuntimeOccurrenceIdV1Schema as CanonicalPluginUiRuntimeOccurrenceIdV1Schema } from '../plugins/ui/targetedContributions.js';
import { PluginSourceCustodyV1Schema } from '../plugins/runtime/sourceCustody.js';
import { PluginJsonSchemaV2Schema, PluginLocalizedStringV2Schema } from '../plugins/contributions/publicTypes.js';
import { PluginEventAutomationDeclarationV1Schema } from '../automations/automationEventDeclarationV1.js';

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
}).check(z.superRefine((entry, context) => {
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
  return AutomationEligibleEventsCatalogV1Schema.parse(events.map(({ event, setupAction, historyGapResetAction }) => ({
    event, setupAction, ...(historyGapResetAction === undefined ? {} : { historyGapResetAction }),
  })));
}
