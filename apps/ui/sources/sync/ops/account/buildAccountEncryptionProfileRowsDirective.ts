import {
  AccountEncryptionMigrateProfileRowsDirectiveSchema,
  sealProfileRecordContentV1,
  type AccountEncryptionMigrateProfileRowsDirective,
} from '@happier-dev/protocol/profiles/profileRecordV1';
import type { ProfileCatalogSnapshotV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { sealProfileTransferContentV1 } from '@happier-dev/protocol/profiles/profileTransferV1';

export function buildAccountEncryptionProfileRowsDirective(params: Readonly<{
  snapshot?: ProfileCatalogSnapshotV1;
  target: Readonly<{ mode: 'plain' }> | Readonly<{
    mode: 'e2ee'; material: AccountScopedCryptoMaterial; randomBytes(length: number): Uint8Array;
  }>;
}>): AccountEncryptionMigrateProfileRowsDirective | undefined {
  if (!params.snapshot) return undefined;
  if (params.snapshot.status !== 'ready' || params.snapshot.diagnostics.length > 0) {
    throw new Error('Profile catalog is not complete');
  }
  if (params.snapshot.control && params.snapshot.control.revision !== params.snapshot.controlRevision) {
    throw new Error('Profile catalog is not complete');
  }
  // An empty live catalog can still have a reference-guard tombstone. Keep its
  // captured revision in the Account transaction even when there is no payload to reseal.
  return AccountEncryptionMigrateProfileRowsDirectiveSchema.parse({
    expectedReferenceGuardRevision: params.snapshot.referenceGuardRevision,
    transferControl: {
      expectedRevision: params.snapshot.controlRevision,
      content: params.snapshot.control ? sealProfileTransferContentV1({
        mode: params.target.mode,
        material: params.target.mode === 'plain' ? null : params.target.material,
        record: params.snapshot.control.record,
        ...(params.target.mode === 'e2ee' ? { randomBytes: params.target.randomBytes } : {}),
      }) : null,
    },
    items: params.snapshot.records.map(({ record, revision }) => ({
      id: record.id,
      expectedRevision: revision,
      content: sealProfileRecordContentV1({
        mode: params.target.mode,
        material: params.target.mode === 'plain' ? null : params.target.material,
        record,
        ...(params.target.mode === 'e2ee' ? { randomBytes: params.target.randomBytes } : {}),
      }),
    })),
  });
}
