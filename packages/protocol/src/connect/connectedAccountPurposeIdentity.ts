import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';

export const ConnectedAccountPurposeIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(128)));
export type ConnectedAccountPurposeId = z.infer<typeof ConnectedAccountPurposeIdSchema>;

export const QualifiedConnectedAccountPurposeV1Schema = lazyZodSchema(() => z.strictObject({
  consumer: asProtocolZod(PluginContributionIdentityV1Schema),
  purpose: ConnectedAccountPurposeIdSchema,
}));
export type QualifiedConnectedAccountPurposeV1 = z.infer<
  typeof QualifiedConnectedAccountPurposeV1Schema
>;
