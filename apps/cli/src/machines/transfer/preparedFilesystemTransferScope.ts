import type { NativeFilesystemImport } from '@/rpc/handlers/fileSystem/filesystemEffectChannel';
import type { FileHandle } from 'node:fs/promises';
import { filesystemPathComparisonKey } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';

/** Preserve native/currentness codes without exposing exception detail. */
export function readFilesystemTransferErrorCode(error: unknown, fallback = 'filesystem_identity_custody_unavailable'): string {
  return error && typeof error === 'object' && 'errorCode' in error && typeof error.errorCode === 'string'
    ? error.errorCode : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code : fallback;
}

/** Host-private admission stamped onto the incumbent prepared transfer record. */
export type PreparedFilesystemTransferScope = Readonly<{
  rootPath: string;
  requesterAccountId: string;
  sourceId?: string;
  destinationId?: string;
  /** Captured admitted host owner; never transported in a prepared DTO. */
  assertCurrentAuthority?: () => Promise<void>;
  /** One already admitted native operation, never transported in a DTO. */
  nativeImport?: NativeFilesystemImport;
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

export type PreparedFilesystemReadFile = Readonly<{
  handle: FileHandle;
  rootPath: string;
  path: string;
  sizeBytes: number;
  sha256: string;
}>;
