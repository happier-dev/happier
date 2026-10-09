import { filesystemPathComparisonKey } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';

/** Host-private admission stamped onto the incumbent prepared transfer record. */
export type PreparedFilesystemTransferScope = Readonly<{
  rootPath: string;
  requesterAccountId: string;
  sourceId?: string;
  destinationId?: string;
  /** Captured admitted host owner; never transported in a prepared DTO. */
  assertCurrentAuthority?: () => Promise<void>;
}>;

export function assertPreparedFilesystemTransferScope(
  ownedScope: PreparedFilesystemTransferScope | undefined,
  requesterScope: PreparedFilesystemTransferScope | null | undefined,
): void {
  // Undefined is trusted owning-lifecycle or incumbent data-plane bearer
  // admission, never a remotely supplied requester identity.
  if (requesterScope === undefined) return;
  if (ownedScope && requesterScope
    && ownedScope.requesterAccountId === requesterScope.requesterAccountId
    && filesystemPathComparisonKey(ownedScope.rootPath) === filesystemPathComparisonKey(requesterScope.rootPath)) return;
  if (!ownedScope && requesterScope === null) return;
  throw Object.assign(new Error('Prepared filesystem transfer scope does not match'), {
    errorCode: 'FILESYSTEM_TRANSFER_SCOPE_MISMATCH',
  });
}
