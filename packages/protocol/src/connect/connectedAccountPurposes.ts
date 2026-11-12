import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";

import { canonicalBoundedRecordKeySchema } from '../common/canonicalRecordKey.js';
import { ConnectedServiceCredentialKindSchema } from './connectedServiceCredentialKind.js';
import { ConnectedAccountPurposeIdSchema } from './connectedAccountPurposeIdentity.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
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

const ConnectedAccountMaterializationDestinationsSchema = lazyZodSchema(() => z.readonly(z.array(
  canonicalBoundedRecordKeySchema(),
).check(z.minLength(1), z.superRefine((destinations, context) => {
  if (new Set(destinations).size !== destinations.length) {
    context.addIssue({
      code: 'custom',
      message: 'Connected Account materialization destinations must be unique.',
    });
  }
}))));

const ConnectedAccountHttpHeaderNameSchema = lazyZodSchema(() => z.pipe(z.string().check(z.trim(), z.minLength(1), z.regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u)), z.transform((value) => value.toLowerCase())));
const ConnectedAccountHttpHeaderNamesSchema = lazyZodSchema(() => z.readonly(z.array(
  ConnectedAccountHttpHeaderNameSchema,
).check(z.minLength(1), z.superRefine((headerNames, context) => {
  if (new Set(headerNames).size !== headerNames.length) {
    context.addIssue({
      code: 'custom',
      message: 'Connected Account materialization header names must be unique.',
    });
  }
}))));

const ConnectedAccountHttpsOriginSchema = lazyZodSchema(() => z.string().check(z.trim(), z.maxLength(2_048), z.superRefine((value, context) => {
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
  })));

export const ConnectedAccountHttpHeadersRequestSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('httpHeaders'),
  origin: ConnectedAccountHttpsOriginSchema,
  headerNames: ConnectedAccountHttpHeaderNamesSchema,
}));
export type ConnectedAccountHttpHeadersRequest = z.infer<
  typeof ConnectedAccountHttpHeadersRequestSchema
>;

export const ConnectedAccountMaterializationRequestSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  ConnectedAccountHttpHeadersRequestSchema,
  z.strictObject({
    kind: z.literal('environment'),
    keys: ConnectedAccountMaterializationDestinationsSchema,
  }),
  z.strictObject({
    kind: z.literal('files'),
    fileIds: ConnectedAccountMaterializationDestinationsSchema,
  }),
]));
export type ConnectedAccountMaterializationRequest = z.infer<
  typeof ConnectedAccountMaterializationRequestSchema
>;

export const PluginConnectedAccountMaterializationKindsSchema = lazyZodSchema(() => z.array(
  PluginConnectedAccountMaterializationKindSchema,
).check(z.minLength(1), z.maxLength(PluginConnectedAccountMaterializationKindSchema.options.length), z.meta({ uniqueItems: true }), z.superRefine((kinds, context) => {
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
  })));

export const ConnectedAccountPurposeDeclarationV1Schema = lazyZodSchema(() => z.strictObject({
  purpose: ConnectedAccountPurposeIdSchema,
  service: asProtocolZod(PluginContributionReferenceV2Schema),
  /** Use the selected binding through this Provider's existing managed endpoint owner. */
  managedProviderEndpoint: z.optional(z.strictObject({
    provider: asProtocolZod(PluginContributionIdentityV1Schema),
    purpose: ConnectedAccountPurposeIdSchema,
    /** Native model namespace removed before exact Provider catalog admission. */
    modelIdPrefix: z.optional(z.string().check(z.trim(), z.minLength(1))),
  })),
  /** Optional human-facing presentation; purpose remains the machine identifier. */
  title: z.optional(PluginLocalizedStringV2Schema),
  required: z.optional(z.boolean()),
  materializationKinds: z.optional(PluginConnectedAccountMaterializationKindsSchema),
  /** Credential/profile kinds this consumer can use for this service. */
  credentialKinds: z.optional(z.array(ConnectedServiceCredentialKindSchema).check(z.minLength(1), z.maxLength(ConnectedServiceCredentialKindSchema.options.length), z.meta({ uniqueItems: true }), z.superRefine((kinds, context) => {
      if (new Set(kinds).size !== kinds.length) {
        context.addIssue({
          code: 'custom',
          message: 'Connected Account credential kinds must be unique.',
        });
      }
    }))),
}));
export type ConnectedAccountPurposeDeclarationV1 = z.infer<
  typeof ConnectedAccountPurposeDeclarationV1Schema
>;

export const ConnectedAccountPurposeDeclarationsV1Schema = lazyZodSchema(() => z.array(
  ConnectedAccountPurposeDeclarationV1Schema,
).check(z.maxLength(32), z.superRefine((declarations, context) => {
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
})));
export type ConnectedAccountPurposeDeclarationsV1 = z.infer<
  typeof ConnectedAccountPurposeDeclarationsV1Schema
>;
