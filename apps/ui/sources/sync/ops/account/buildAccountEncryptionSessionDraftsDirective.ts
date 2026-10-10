import { sealAccountScopedBlobCiphertext, type AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { createSessionDraftPrivatePayloadV2, isSessionDraftContentV1, type AccountOwnedDraftAddressV2, type SessionDraftDocumentV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { AccountEncryptionMigrateSessionDraftsDirectiveSchema, type AccountEncryptionMigrateSessionDraftsDirective } from '@happier-dev/protocol/account/encryptionMigrate';

export type AccountEncryptionSessionDraftMigrationCandidate = Readonly<{
  address: AccountOwnedDraftAddressV2;
  baseRevision: number;
  document: SessionDraftDocumentV2;
}>;

type BuildParams = Readonly<{
  candidates: readonly AccountEncryptionSessionDraftMigrationCandidate[];
  target:
    | Readonly<{ mode: 'plain' }>
    | Readonly<{
      mode: 'e2ee';
      material: AccountScopedCryptoMaterial;
      randomBytes(length: number): Uint8Array;
    }>;
}>;

export function buildAccountEncryptionSessionDraftsDirective(
  params: BuildParams,
): AccountEncryptionMigrateSessionDraftsDirective | undefined {
  // Omission preserves the released request accepted by predecessor servers
  // when no Account-owned draft needs resealing.
  if (params.candidates.length === 0) return undefined;

  const items = params.candidates.map((candidate) => {
    const payload = createSessionDraftPrivatePayloadV2(candidate.address, candidate.document);
    return {
      address: candidate.address,
      expectedRevision: candidate.baseRevision,
      content: params.target.mode === 'plain'
        ? { t: 'plain' as const, v: payload }
        : {
          t: 'encrypted' as const,
          ...(payload.v === 2 ? { v: 2 as const } : {}),
          c: sealAccountScopedBlobCiphertext({
            kind: 'account_session_draft_private_payload',
            material: params.target.material,
            payload,
            randomBytes: params.target.randomBytes,
          }),
        },
    };
  });
  return AccountEncryptionMigrateSessionDraftsDirectiveSchema.parse({
    ...(items.some((item) => !isSessionDraftContentV1(item.content)) ? { v: 2 } : {}),
    items,
  });
}
