import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import {
  QualifiedConnectedAccountPurposeBindingAccountTargetV1Schema,
  QualifiedConnectedAccountPurposeBindingGroupTargetV1Schema,
} from '../../connect/connectedAccountPurposeBindings.js';
import { QualifiedConnectedAccountGroupIncarnationV4Schema } from '../../connect/qualifiedConnectedAccountProjectionsV4.js';
import { QualifiedConnectedAccountPurposeV1Schema } from '../../connect/connectedAccountPurposes.js';
import { ProviderConnectionSecurityFingerprintV1Schema } from '../../providers/fingerprints.js';
import { ProviderConnectionIdSchema, ProviderLocalIdSchema } from '../../providers/ids.js';

/** One owning ServiceAccountToken row pins a qualified credential lifetime. */
export const TeamCredentialSourceCredentialIncarnationV1Schema = lazyZodSchema(() => z.string().check(z.minLength(1)));

/** Canonical closed source identity shared by resource and broker schemas. */
export const TeamCredentialSourceBindingV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    v: z.literal(1),
    kind: z.literal('connected_account'),
    target: QualifiedConnectedAccountPurposeBindingAccountTargetV1Schema,
    credentialIncarnation: TeamCredentialSourceCredentialIncarnationV1Schema,
    providerPurpose: z.optional(QualifiedConnectedAccountPurposeV1Schema),
  }),
  z.strictObject({
    v: z.literal(1),
    kind: z.literal('connected_pool'),
    target: QualifiedConnectedAccountPurposeBindingGroupTargetV1Schema,
    poolIncarnation: QualifiedConnectedAccountGroupIncarnationV4Schema,
  }),
  z.strictObject({
    v: z.literal(1),
    kind: z.literal('provider_connection'),
    connectionId: ProviderConnectionIdSchema,
    connectionSecurityFingerprint: ProviderConnectionSecurityFingerprintV1Schema,
    credentialSlotId: ProviderLocalIdSchema,
  }),
]));

export type TeamCredentialSourceCredentialIncarnationV1 = z.infer<
  typeof TeamCredentialSourceCredentialIncarnationV1Schema
>;
export type TeamCredentialSourceBindingV1 = z.infer<
  typeof TeamCredentialSourceBindingV1Schema
>;
