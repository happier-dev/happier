import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';

/** Names only; private runtime values never enter the plugin manifest. */
export const PluginServiceLaunchEnvironmentContributionV1Schema = lazyZodSchema(
  () =>
    z.strictObject({
      id: asProtocolZod(PluginContributionLocalIdSchema),
      environmentNames: z.array(
        z.string().check(z.regex(/^[A-Za-z_][A-Za-z0-9_]*$/)),
      ),
    }),
);
export type PluginServiceLaunchEnvironmentContributionV1 = z.infer<
  typeof PluginServiceLaunchEnvironmentContributionV1Schema
>;
