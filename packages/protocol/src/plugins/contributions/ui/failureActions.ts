import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';
import { PluginContributionLocalIdSchema } from '../../contributionIdentity.js';
import { asProtocolZod } from '../../actions/internalProtocolZodAdapter.js';

/** Button presentation available with declarations, before its catalog Action runs. */
export const PluginUiDeclaredFailureActionV1Schema = lazyZodSchema(() => z.strictObject({
  subjects: z.array(z.string().check(z.minLength(1))),
  actionId: z.string().check(z.minLength(1)),
  label: z.string(),
  titleKey: z.optional(z.string()),
  launchMode: z.enum(['start', 'review']),
  startable: z.boolean(),
}));
export type PluginUiDeclaredFailureActionV1 = z.infer<typeof PluginUiDeclaredFailureActionV1Schema>;

/** One app page supplies the native failure controls through its declared client Action. */
export const PluginUiFailureActionsBindingV1Schema = lazyZodSchema(() => z.strictObject({
  action: asProtocolZod(PluginContributionLocalIdSchema),
  declaredActions: z.optional(z.array(PluginUiDeclaredFailureActionV1Schema)),
}));
export type PluginUiFailureActionsBindingV1 = z.infer<typeof PluginUiFailureActionsBindingV1Schema>;
