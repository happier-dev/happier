import { z } from 'zod/mini';
import { ConnectedAccountSourceCustodyV1Schema, QualifiedConnectedAccountRefSchema } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { asProtocolZod } from '@happier-dev/protocol/plugins/actions/internalProtocolZodAdapter';

/** Admission references only; manual fields and resolved secret values stay in the submitting invocation. */
export const ConnectedAccountManualAttemptBasisSchema = z.strictObject({
    account: z.nullable(asProtocolZod(QualifiedConnectedAccountRefSchema)),
    sourceCustody: ConnectedAccountSourceCustodyV1Schema,
    expectedCredentialRevision: z.nullable(z.string()),
    expectedCredentialConfigurationRevision: z.nullable(z.string()),
    expectedConfigurationRevision: z.nullable(z.string()),
});

export const ConnectedAccountManualAttemptDraftSchema = z.strictObject({
    manual: ConnectedAccountManualAttemptBasisSchema,
});
export type ConnectedAccountManualAttemptBasis = z.infer<typeof ConnectedAccountManualAttemptBasisSchema>;
