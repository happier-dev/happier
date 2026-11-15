import * as zMini from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { PluginContributionIdentityV1Schema, PluginContributionLocalIdSchema } from '../plugins/contributionIdentity.js';
import { PluginConnectedAccountAuthenticationV2Schema, PluginConnectedAccountDescriptorContributionV2Schema, ConnectedAccountBillingUrlSchema,
  type PluginConnectedAccountDescriptorContributionV2 } from './pluginConnectedAccountAuthenticationV2.js';
import { PluginIdSchema } from '../plugins/pluginId.js';
import { ConnectedServiceIdSchema } from './connectedServiceSchemas.js';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";
import { PluginUiRuntimeOccurrenceIdV1Schema } from '../plugins/ui/targetedContributions.js';

const ProjectedLocalizedTextSchema = lazyZodSchema(() => z.union([
  z.string().check(z.trim(), z.minLength(1)),
  z.strictObject({ key: z.string().check(z.trim(), z.minLength(1)), fallback: z.string().check(z.trim(), z.minLength(1)) }),
]));

export const ConnectedAccountUiProjectionEntryV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.trim(), z.minLength(1)),
  serviceId: asProtocolZod(PluginContributionLocalIdSchema),
  pluginId: zMini.optional(asProtocolZod(PluginIdSchema)),
  /** Exact live slot stamped on plugin-owned projection-family entries. */
  occurrenceId: zMini.optional(asProtocolZod(PluginUiRuntimeOccurrenceIdV1Schema)),
  provenance: z.enum(['first_party', 'external']),
  sourceKind: z.string().check(z.trim(), z.minLength(1)),
  title: ProjectedLocalizedTextSchema,
  description: z.optional(ProjectedLocalizedTextSchema),
  ui: PluginConnectedAccountDescriptorContributionV2Schema.shape.ui,
  authentication: PluginConnectedAccountAuthenticationV2Schema,
  capabilities: z.array(z.string()),
  usageIdentity: PluginConnectedAccountDescriptorContributionV2Schema.shape.usageIdentity,
  recoveryCredits: z.optional(z.strictObject({ supported: z.literal(true) })),
  billingUrl: zMini.optional(ConnectedAccountBillingUrlSchema),
  availability: z.strictObject({ state: z.enum(['available', 'disabled', 'blocked']), reason: z.string().check(z.trim(), z.minLength(1)) }),
  diagnostics: z.array(z.string()),
  /** Derived from Agent declarations, never an independently authored sharing policy. */
  nativeLoginRequiredBy: z.optional(z.readonly(z.array(z.strictObject({
    identity: asProtocolZod(PluginContributionIdentityV1Schema),
    title: z.string().check(z.trim(), z.minLength(1)),
  })))),
}).check(z.superRefine((entry, context) => {
  if (!entry.pluginId && !ConnectedServiceIdSchema.safeParse(entry.serviceId).success) {
    context.addIssue({
      code: 'custom',
      path: ['serviceId'],
      message: 'Unqualified connected-account projections must use a built-in connected service id.',
    });
  }
})));

export type ConnectedAccountUiProjectionEntryV1 = z.infer<typeof ConnectedAccountUiProjectionEntryV1Schema>;

/** Declaration presentation crosses into the read projection through this single projection owner. */
export function projectConnectedAccountDescriptorV1(input: Readonly<{
  descriptor: PluginConnectedAccountDescriptorContributionV2;
  serviceId: string;
  pluginId?: string;
  provenance: ConnectedAccountUiProjectionEntryV1['provenance'];
  sourceKind: string;
  availability: ConnectedAccountUiProjectionEntryV1['availability'];
  diagnostics: readonly string[];
  nativeLoginRequiredBy?: ConnectedAccountUiProjectionEntryV1['nativeLoginRequiredBy'];
}>): ConnectedAccountUiProjectionEntryV1 {
  const { descriptor, nativeLoginRequiredBy, ...facts } = input;
  return { ...facts, id: descriptor.id, title: descriptor.title,
    ...(nativeLoginRequiredBy?.length ? { nativeLoginRequiredBy } : {}),
    ...(descriptor.description ? { description: descriptor.description } : {}),
    ...(descriptor.ui ? { ui: descriptor.ui } : {}),
    authentication: descriptor.authentication, capabilities: descriptor.capabilities ?? [],
    ...(descriptor.usageIdentity ? { usageIdentity: descriptor.usageIdentity } : {}),
    ...(descriptor.recoveryCredits ? { recoveryCredits: descriptor.recoveryCredits } : {}),
    ...(descriptor.billingUrl ? { billingUrl: descriptor.billingUrl } : {}), diagnostics: [...input.diagnostics],
  };
}
