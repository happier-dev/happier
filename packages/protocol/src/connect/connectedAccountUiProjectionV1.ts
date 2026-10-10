import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { PluginContributionLocalIdSchema } from '../plugins/contributionIdentity.js';
import { PluginConnectedAccountAuthenticationV2Schema, ConnectedAccountBillingUrlSchema } from './pluginConnectedAccountAuthenticationV2.js';
import { PluginIdSchema } from '../plugins/pluginId.js';
import { ConnectedServiceIdSchema } from './connectedServiceSchemas.js';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";
import { PluginUiRuntimeOccurrenceIdV1Schema } from '../plugins/ui/targetedContributions.js';

const ProjectedLocalizedTextSchema = lazyZodSchema(() => z.union([
  z.string().trim().min(1),
  z.object({ key: z.string().trim().min(1), fallback: z.string().trim().min(1) }).strict(),
]));

export const ConnectedAccountUiProjectionEntryV1Schema = lazyZodSchema(() => z.object({
  id: z.string().trim().min(1),
  serviceId: asProtocolZod(PluginContributionLocalIdSchema),
  pluginId: asProtocolZod(PluginIdSchema).optional(),
  /** Exact live slot stamped on plugin-owned projection-family entries. */
  occurrenceId: asProtocolZod(PluginUiRuntimeOccurrenceIdV1Schema).optional(),
  provenance: z.enum(['first_party', 'external']),
  sourceKind: z.string().trim().min(1),
  title: ProjectedLocalizedTextSchema,
  description: ProjectedLocalizedTextSchema.optional(),
  authentication: PluginConnectedAccountAuthenticationV2Schema,
  capabilities: z.array(z.string()),
  recoveryCredits: z.object({ supported: z.literal(true) }).strict().optional(),
  billingUrl: ConnectedAccountBillingUrlSchema.optional(),
  availability: z.object({ state: z.enum(['available', 'disabled', 'blocked']), reason: z.string().trim().min(1) }).strict(),
  diagnostics: z.array(z.string()),
}).strict().superRefine((entry, context) => {
  if (!entry.pluginId && !ConnectedServiceIdSchema.safeParse(entry.serviceId).success) {
    context.addIssue({
      code: 'custom',
      path: ['serviceId'],
      message: 'Unqualified connected-account projections must use a built-in connected service id.',
    });
  }
}));

export type ConnectedAccountUiProjectionEntryV1 = z.infer<typeof ConnectedAccountUiProjectionEntryV1Schema>;
