import { z } from 'zod';

import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { PluginContributionReferenceV2Schema } from '../plugins/contributions/publicTypes.js';

export const ConnectedAccountPurposeIdSchema = z.string().trim().min(1).max(128);
export type ConnectedAccountPurposeId = z.infer<typeof ConnectedAccountPurposeIdSchema>;

export const PluginConnectedAccountMaterializationKindSchema = z.enum([
  'httpHeaders',
  'environment',
  'files',
]);
export type PluginConnectedAccountMaterializationKind = z.infer<
  typeof PluginConnectedAccountMaterializationKindSchema
>;

export const PluginConnectedAccountMaterializationKindsSchema = z.array(
  PluginConnectedAccountMaterializationKindSchema,
).min(1).max(PluginConnectedAccountMaterializationKindSchema.options.length)
  .superRefine((kinds, context) => {
    const seen = new Set<PluginConnectedAccountMaterializationKind>();
    for (const [index, kind] of kinds.entries()) {
      if (seen.has(kind)) {
        context.addIssue({
          code: 'custom',
          path: [index],
          message: 'Connected Account materialization kinds must be unique.',
        });
      }
      seen.add(kind);
    }
  });

export const ConnectedAccountPurposeDeclarationV1Schema = z.object({
  purpose: ConnectedAccountPurposeIdSchema,
  service: PluginContributionReferenceV2Schema,
  required: z.boolean().optional(),
  materializationKinds: PluginConnectedAccountMaterializationKindsSchema.optional(),
}).strict();
export type ConnectedAccountPurposeDeclarationV1 = z.infer<
  typeof ConnectedAccountPurposeDeclarationV1Schema
>;

export const ConnectedAccountPurposeDeclarationsV1Schema = z.array(
  ConnectedAccountPurposeDeclarationV1Schema,
).max(32).superRefine((declarations, context) => {
  const seenPurposes = new Set<string>();
  for (const [index, declaration] of declarations.entries()) {
    if (seenPurposes.has(declaration.purpose)) {
      context.addIssue({
        code: 'custom',
        path: [index, 'purpose'],
        message: 'Connected-account purpose ids must be unique within one consumer contribution.',
      });
    }
    seenPurposes.add(declaration.purpose);
  }
});
export type ConnectedAccountPurposeDeclarationsV1 = z.infer<
  typeof ConnectedAccountPurposeDeclarationsV1Schema
>;

export const QualifiedConnectedAccountPurposeV1Schema = z.object({
  consumer: PluginContributionIdentityV1Schema,
  purpose: ConnectedAccountPurposeIdSchema,
}).strict();
export type QualifiedConnectedAccountPurposeV1 = z.infer<
  typeof QualifiedConnectedAccountPurposeV1Schema
>;
