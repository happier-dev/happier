import { z } from 'zod';

import {
  PluginContributionIdentityV1Schema,
} from '../plugins/contributionIdentity.js';
import { PluginJsonSchemaV2Schema } from '../plugins/contributions/publicTypes.js';

export const QualifiedConnectedAccountIdSchema = z.string()
  .min(1)
  .regex(/^(?!\s)[\s\S]*\S$/u)
  .regex(/^[\s\S]{1,256}$/u);

export const QualifiedConnectedAccountRefSchema = z.object({
  service: PluginContributionIdentityV1Schema,
  accountId: QualifiedConnectedAccountIdSchema,
}).strict();

/** Canonical portable JSON Schema projection of the qualified account ref. */
export const QualifiedConnectedAccountRefJsonSchema = PluginJsonSchemaV2Schema.parse(
  QualifiedConnectedAccountRefSchema.toJSONSchema({
    io: 'input',
    target: 'draft-7',
    unrepresentable: 'throw',
  }),
);

export type QualifiedConnectedAccountRef = z.infer<typeof QualifiedConnectedAccountRefSchema>;
