import { z } from 'zod';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";

import { canonicalBoundedRecordKeySchema } from '../common/canonicalRecordKey.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { ConnectedServiceCredentialKindSchema } from './connectedServiceSchemas.js';
import {
  PluginContributionReferenceV2Schema,
  PluginLocalizedStringV2Schema,
} from '../plugins/contributions/publicTypes.js';

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

const ConnectedAccountMaterializationDestinationsSchema = z.array(
  canonicalBoundedRecordKeySchema(128),
).min(1).max(32).superRefine((destinations, context) => {
  if (new Set(destinations).size !== destinations.length) {
    context.addIssue({
      code: 'custom',
      message: 'Connected Account materialization destinations must be unique.',
    });
  }
}).readonly();

const ConnectedAccountHttpHeaderNameSchema = z.string().trim().min(1).max(128)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u)
  .transform((value) => value.toLowerCase());
const ConnectedAccountHttpHeaderNamesSchema = z.array(
  ConnectedAccountHttpHeaderNameSchema,
).min(1).max(32).superRefine((headerNames, context) => {
  if (new Set(headerNames).size !== headerNames.length) {
    context.addIssue({
      code: 'custom',
      message: 'Connected Account materialization header names must be unique.',
    });
  }
}).readonly();

const ConnectedAccountHttpsOriginSchema = z.string().trim().max(2_048)
  .superRefine((value, context) => {
    try {
      const url = new URL(value);
      if (
        url.protocol !== 'https:'
        || url.username
        || url.password
        || url.pathname !== '/'
        || url.search
        || url.hash
        || url.origin !== value
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Connected Account materialization origins must be canonical HTTPS origins.',
        });
      }
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'Connected Account materialization origins must be canonical HTTPS origins.',
      });
    }
  });

export const ConnectedAccountHttpHeadersRequestSchema = z.object({
  kind: z.literal('httpHeaders'),
  origin: ConnectedAccountHttpsOriginSchema,
  headerNames: ConnectedAccountHttpHeaderNamesSchema,
}).strict();
export type ConnectedAccountHttpHeadersRequest = z.infer<
  typeof ConnectedAccountHttpHeadersRequestSchema
>;

export const ConnectedAccountMaterializationRequestSchema = z.discriminatedUnion('kind', [
  ConnectedAccountHttpHeadersRequestSchema,
  z.object({
    kind: z.literal('environment'),
    keys: ConnectedAccountMaterializationDestinationsSchema,
  }).strict(),
  z.object({
    kind: z.literal('files'),
    fileIds: ConnectedAccountMaterializationDestinationsSchema,
  }).strict(),
]);
export type ConnectedAccountMaterializationRequest = z.infer<
  typeof ConnectedAccountMaterializationRequestSchema
>;

export const PluginConnectedAccountMaterializationKindsSchema = z.array(
  PluginConnectedAccountMaterializationKindSchema,
).min(1).max(PluginConnectedAccountMaterializationKindSchema.options.length)
  .meta({ uniqueItems: true })
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
  service: asProtocolZod(PluginContributionReferenceV2Schema),
  /** Optional human-facing presentation; purpose remains the machine identifier. */
  title: PluginLocalizedStringV2Schema.optional(),
  required: z.boolean().optional(),
  materializationKinds: PluginConnectedAccountMaterializationKindsSchema.optional(),
  /** Credential/profile kinds this consumer can use for this service. */
  credentialKinds: z.array(ConnectedServiceCredentialKindSchema)
    .min(1)
    .max(ConnectedServiceCredentialKindSchema.options.length)
    .meta({ uniqueItems: true })
    .superRefine((kinds, context) => {
      if (new Set(kinds).size !== kinds.length) {
        context.addIssue({
          code: 'custom',
          message: 'Connected Account credential kinds must be unique.',
        });
      }
    })
    .optional(),
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
  consumer: asProtocolZod(PluginContributionIdentityV1Schema),
  purpose: ConnectedAccountPurposeIdSchema,
}).strict();
export type QualifiedConnectedAccountPurposeV1 = z.infer<
  typeof QualifiedConnectedAccountPurposeV1Schema
>;
