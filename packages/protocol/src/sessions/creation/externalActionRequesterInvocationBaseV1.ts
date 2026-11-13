import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginIdSchema } from '../../plugins/pluginId.js';
import { PluginContributionLocalIdSchema } from '../../plugins/contributionIdentity.js';
import { PluginSourceCustodyV1Schema } from '../../plugins/runtime/sourceCustody.js';
import { PluginMachineMaterializationRefV1Schema } from '../../plugins/availability/materializationRefV1.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';

/** Shared invocation identity; portable Run responses never carry a reviewed confirmation. */
export const ExternalActionRequesterInvocationBaseV1Schema = lazyZodSchema(() => z.strictObject({
  caller: z.union([
    z.strictObject({ kind: z.literal('host') }),
    z.strictObject({ kind: z.literal('plugin'), pluginId: asProtocolZod(PluginIdSchema),
      contributionLocalId: asProtocolZod(PluginContributionLocalIdSchema), occurrenceId: z.optional(z.string().check(z.minLength(1))),
      sourceCustody: z.optional(PluginSourceCustodyV1Schema), materialization: z.optional(PluginMachineMaterializationRefV1Schema),
    }),
  ]),
  surface: z.enum(['ui', 'voice', 'agent', 'mcp', 'cli', 'rpc', 'api', 'plugin']),
  authority: z.enum(['present_user', 'account_automation']),
}));
export type ExternalActionRequesterInvocationBaseV1 = z.infer<typeof ExternalActionRequesterInvocationBaseV1Schema>;
