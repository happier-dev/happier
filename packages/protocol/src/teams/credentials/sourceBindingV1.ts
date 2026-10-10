import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import {
  QualifiedConnectedAccountPurposeBindingAccountTargetV1Schema,
  QualifiedConnectedAccountPurposeBindingGroupTargetV1Schema,
} from '../../connect/connectedAccountPurposeBindings.js';
import { QualifiedConnectedAccountGroupIncarnationV4Schema } from '../../connect/qualifiedConnectedAccountProjectionsV4.js';
import { ProviderConnectionSecurityFingerprintV1Schema } from '../../providers/fingerprints.js';
import { ProviderConnectionIdSchema, ProviderLocalIdSchema } from '../../providers/ids.js';

/** One owning ServiceAccountToken row pins a qualified credential lifetime. */
export const TeamCredentialSourceCredentialIncarnationV1Schema = lazyZodSchema(() => z.string().min(1));

/** Canonical closed source identity shared by resource and broker schemas. */
export const TeamCredentialSourceBindingV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({
    v: z.literal(1),
    kind: z.literal('connected_account'),
    target: QualifiedConnectedAccountPurposeBindingAccountTargetV1Schema,
    credentialIncarnation: TeamCredentialSourceCredentialIncarnationV1Schema,
  }).strict(),
  z.object({
    v: z.literal(1),
    kind: z.literal('connected_pool'),
    target: QualifiedConnectedAccountPurposeBindingGroupTargetV1Schema,
    poolIncarnation: QualifiedConnectedAccountGroupIncarnationV4Schema,
  }).strict(),
  z.object({
    v: z.literal(1),
    kind: z.literal('provider_connection'),
    connectionId: ProviderConnectionIdSchema,
    connectionSecurityFingerprint: ProviderConnectionSecurityFingerprintV1Schema,
    credentialSlotId: ProviderLocalIdSchema,
  }).strict(),
]));

export type TeamCredentialSourceCredentialIncarnationV1 = z.infer<
  typeof TeamCredentialSourceCredentialIncarnationV1Schema
>;
export type TeamCredentialSourceBindingV1 = z.infer<
  typeof TeamCredentialSourceBindingV1Schema
>;
