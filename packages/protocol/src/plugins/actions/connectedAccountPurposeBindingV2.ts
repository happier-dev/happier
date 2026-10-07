import { z } from 'zod';
import { InputPathSchema } from '../../inputs/inputPredicates.js';
import { ConnectedAccountPurposeIdSchema } from '../../connect/connectedAccountPurposeIdentity.js';

/** An exact credential-ref field mapped to one declared Connected Account purpose. */
export const PluginActionConnectedAccountPurposeBindingV2Schema = z.object({
  path: InputPathSchema,
  purpose: ConnectedAccountPurposeIdSchema,
  /** Companion path for a machine-native service selection instead of an account ref. */
  nativeServicePath: InputPathSchema.optional(),
}).strict();
export type PluginActionConnectedAccountPurposeBindingV2 = z.infer<typeof PluginActionConnectedAccountPurposeBindingV2Schema>;
