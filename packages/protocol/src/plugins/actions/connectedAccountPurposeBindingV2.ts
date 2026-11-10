import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { InputPathSchema } from '../../inputs/inputPredicates.js';
import { ConnectedAccountPurposeIdSchema } from '../../connect/connectedAccountPurposeIdentity.js';

/** An exact credential-ref field mapped to one declared Connected Account purpose. */
export const PluginActionConnectedAccountPurposeBindingV2Schema = lazyZodSchema(() => z.strictObject({
  path: InputPathSchema,
  purpose: ConnectedAccountPurposeIdSchema,
  /** Companion path for a machine-native service selection instead of an account ref. */
  nativeServicePath: z.optional(InputPathSchema),
}));
export type PluginActionConnectedAccountPurposeBindingV2 = z.infer<typeof PluginActionConnectedAccountPurposeBindingV2Schema>;
