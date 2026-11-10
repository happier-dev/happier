import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginContributionIdentityV1Schema } from '../contributionIdentity.js';
import { defineProtocolJsonValue } from './protocolComposableSchema.js';
import { asProtocolZod } from './internalProtocolZodAdapter.js';

/** Declarative operands only; execution still requires the host's current admission. */
export const PluginActionInvocationBindingV1Schema = lazyZodSchema(() => z.strictObject({
  action: asProtocolZod(PluginContributionIdentityV1Schema),
  input: asProtocolZod(defineProtocolJsonValue()),
}));
export type PluginActionInvocationBindingV1 = z.infer<typeof PluginActionInvocationBindingV1Schema>;
