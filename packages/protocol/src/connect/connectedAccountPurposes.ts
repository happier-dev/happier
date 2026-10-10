import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";

import { canonicalBoundedRecordKeySchema } from '../common/canonicalRecordKey.js';
import { ConnectedServiceCredentialKindSchema } from './connectedServiceCredentialKind.js';
import { ConnectedAccountPurposeIdSchema } from './connectedAccountPurposeIdentity.js';
import {
  PluginContributionReferenceV2Schema,
  PluginLocalizedStringV2Schema,
} from '../plugins/contributions/publicTypes.js';

export {
  ConnectedAccountPurposeIdSchema,
  QualifiedConnectedAccountPurposeV1Schema,
  type ConnectedAccountPurposeId,
  type QualifiedConnectedAccountPurposeV1,
} from './connectedAccountPurposeIdentity.js';

export const PluginConnectedAccountMaterializationKindSchema = lazyZodSchema(() => z.enum([
  'httpHeaders',
  'environment',
  'files',
]));
export type PluginConnectedAccountMaterializationKind = z.infer<
  typeof PluginConnectedAccountMaterializationKindSchema
>;

const ConnectedAccountMaterializationDestinationsSchema = lazyZodSchema(() => z.array(
  canonicalBoundedRecordKeySchema(128),
).min(1).max(32).superRefine((destinations, context) => {
  if (new Set(destinations).size !== destinations.length) {
    context.addIssue({
      code: 'custom',
      message: 'Connected Account materialization destinations must be unique.',
    });
  }
}).readonly());

const ConnectedAccountHttpHeaderNameSchema = lazyZodSchema(() => z.string().trim().min(1).max(128)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u)
  .transform((value) => value.toLowerCase()));
const ConnectedAccountHttpHeaderNamesSchema = lazyZodSchema(() => z.array(
  ConnectedAccountHttpHeaderNameSchema,
).min(1).max(32).superRefine((headerNames, context) => {
  if (new Set(headerNames).size !== headerNames.length) {
    context.addIssue({
      code: 'custom',
      message: 'Connected Account materialization header names must be unique.',
    });
  }
}).readonly());

const ConnectedAccountHttpsOriginSchema = lazyZodSchema(() => z.string().trim().max(2_048)
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
  }));

export const ConnectedAccountHttpHeadersRequestSchema = lazyZodSchema(() => z.object({
  kind: z.literal('httpHeaders'),
  origin: ConnectedAccountHttpsOriginSchema,
  headerNames: ConnectedAccountHttpHeaderNamesSchema,
}).strict());
export type ConnectedAccountHttpHeadersRequest = z.infer<
  typeof ConnectedAccountHttpHeadersRequestSchema
>;

export const ConnectedAccountMaterializationRequestSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  ConnectedAccountHttpHeadersRequestSchema,
  z.object({
    kind: z.literal('environment'),
    keys: ConnectedAccountMaterializationDestinationsSchema,
  }).strict(),
  z.object({
    kind: z.literal('files'),
    fileIds: ConnectedAccountMaterializationDestinationsSchema,
  }).strict(),
]));
export type ConnectedAccountMaterializationRequest = z.infer<
  typeof ConnectedAccountMaterializationRequestSchema
>;

export const PluginConnectedAccountMaterializationKindsSchema = lazyZodSchema(() => z.array(
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
  }));

export const ConnectedAccountPurposeDeclarationV1Schema = lazyZodSchema(() => z.object({
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
}).strict());
export type ConnectedAccountPurposeDeclarationV1 = z.infer<
  typeof ConnectedAccountPurposeDeclarationV1Schema
>;

export const ConnectedAccountPurposeDeclarationsV1Schema = lazyZodSchema(() => z.array(
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
}));
export type ConnectedAccountPurposeDeclarationsV1 = z.infer<
  typeof ConnectedAccountPurposeDeclarationsV1Schema
>;
