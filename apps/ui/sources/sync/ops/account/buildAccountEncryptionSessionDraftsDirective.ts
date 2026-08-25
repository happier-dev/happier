import {
  sealAccountScopedBlobCiphertext,
  type AccountEncryptionMigrateSessionDraftsDirective,
  type AccountScopedCryptoMaterial,
  type SessionDraftAddressV1,
  type SessionDraftDocumentV1,
} from '@happier-dev/protocol';

export type AccountEncryptionSessionDraftMigrationCandidate = Readonly<{
  address: Extract<SessionDraftAddressV1, { kind: 'newSession' }>;
  baseRevision: number;
  document: SessionDraftDocumentV1;
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
  // when no Account-owned new-session draft needs resealing.
  if (params.candidates.length === 0) return undefined;

  return {
    items: params.candidates.map((candidate) => {
      const payload = {
        v: 1 as const,
        address: candidate.address,
        document: candidate.document,
      };
      return {
        address: candidate.address,
        expectedRevision: candidate.baseRevision,
        content: params.target.mode === 'plain'
          ? { t: 'plain' as const, v: payload }
          : {
            t: 'encrypted' as const,
            c: sealAccountScopedBlobCiphertext({
              kind: 'account_session_draft_private_payload',
              material: params.target.material,
              payload,
              randomBytes: params.target.randomBytes,
            }),
          },
      };
    }),
  };
}
