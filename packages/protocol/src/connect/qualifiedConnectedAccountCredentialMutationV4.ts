import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';

import { StoredJsonContentEnvelopeSchema } from '../storage/storedJsonContentEnvelope.js';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from './pluginConnectedAccountAuthenticationV2.js';
import { ConnectedServiceCredentialRevisionV1Schema } from './connectedServiceSchemas.js';
import { QualifiedConnectedAccountRefSchema } from './qualifiedConnectedAccountPersistence.js';
import {
  QualifiedConnectedAccountConfigurationRevisionV4Schema,
  QualifiedConnectedAccountCredentialMetadataV4Schema,
  QualifiedConnectedAccountModeIdV4Schema,
} from './qualifiedConnectedAccountProjectionsV4.js';

const RevisionSchema =
  QualifiedConnectedAccountConfigurationRevisionV4Schema;
const ModeIdSchema = QualifiedConnectedAccountModeIdV4Schema;
const ModeIdZodSchema = asProtocolZod(ModeIdSchema);

const QualifiedConnectedAccountCredentialMutationCommonV4Shape = {
  ref: asProtocolZod(QualifiedConnectedAccountRefSchema),
  authenticationModeId: ModeIdZodSchema,
  content: StoredJsonContentEnvelopeSchema,
  metadata: QualifiedConnectedAccountCredentialMetadataV4Schema,
  directExportContract: z.optional(z.nullable(z.literal(CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1))),
  /**
   * Server-visible custody fact (ids only, no material): the Saved Secret
   * resources this credential references. Omission on an update retains the
   * stored set; legacy readers refuse a referencing credential with their
   * released typed unsupported-format result.
   */
  savedSecretResourceIds: z.optional(z.array(z.string().check(z.minLength(1), z.maxLength(128))).check(z.maxLength(64),
    z.refine(ids => new Set(ids).size === ids.length, 'Saved Secret resource ids must be unique'))),
  /** Selected-reference admission operands for this write; never persisted. */
  savedSecretRevisions: z.optional(z.array(z.strictObject({ resourceId: z.string().check(z.minLength(1)),
    expectedRevision: z.number().check(z.int(), z.positive()) }))),
  contributionContractVersion: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
  reconnect: z.optional(z.strictObject({
    allowProviderIdentityChange: z._default(z.optional(z.boolean()), false),
  })),
  refreshLeaseOwnerId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
} as const;

export const QualifiedConnectedAccountCredentialCreateV4Schema = lazyZodSchema(() => z.strictObject({
  ...QualifiedConnectedAccountCredentialMutationCommonV4Shape,
  expectedCredentialRevision: z.null(),
  initialConfiguration: z.optional(z.strictObject({
    expectedConfigurationRevision: z.null(),
    replacementContentEnvelope: StoredJsonContentEnvelopeSchema,
  })),
}));

export const QualifiedConnectedAccountCredentialUpdateV4Schema = lazyZodSchema(() => z.strictObject({
  ...QualifiedConnectedAccountCredentialMutationCommonV4Shape,
  expectedCredentialRevision: ConnectedServiceCredentialRevisionV1Schema,
  expectedConfigurationRevision: z.nullable(RevisionSchema),
}));

export const QualifiedConnectedAccountCredentialMutationV4Schema = lazyZodSchema(() => z.union([
  QualifiedConnectedAccountCredentialCreateV4Schema,
  QualifiedConnectedAccountCredentialUpdateV4Schema,
]));

export const QualifiedConnectedAccountCredentialMutationSuccessV4Schema =
  lazyZodSchema(() => z.strictObject({
    success: z.literal(true),
    credentialRevision: ConnectedServiceCredentialRevisionV1Schema,
    configurationRevision: z.nullable(RevisionSchema),
  }));
