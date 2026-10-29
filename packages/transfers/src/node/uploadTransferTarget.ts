export type FinalizeUploadTransferInput = Readonly<{
  uploadId: string;
  tempPath: string;
  sizeBytes: number;
  sha256: string;
}>;

export const TRANSFER_FINALIZE_RECOVERY_REQUIRED_ERROR_CODE =
  'TRANSFER_FINALIZE_RECOVERY_REQUIRED' as const;

// Only non-content reason codes cross the finalization boundary. In particular,
// an exception's arbitrary `code` must never become a path/credential carrier.
export const UPLOAD_TRANSFER_FINALIZE_ERROR_CODES = [
  TRANSFER_FINALIZE_RECOVERY_REQUIRED_ERROR_CODE, 'TRANSFER_FINALIZE_FAILED',
  'file_replace_failed', 'hash_mismatch', 'expected_file_absent', 'expected_file_missing',
  'EACCES', 'EPERM', 'ENOENT', 'EXDEV', 'EEXIST', 'ENOTDIR', 'EISDIR',
  'ENOSPC', 'EDQUOT', 'EROFS', 'EMFILE', 'ENFILE', 'EBUSY', 'EIO',
  'EINVAL', 'ENAMETOOLONG', 'ELOOP', 'ENOTEMPTY', 'EFBIG', 'ETXTBSY', 'ENOSYS', 'ENOTSUP',
] as const;

export function readUploadTransferFinalizeErrorCode(value: unknown): typeof UPLOAD_TRANSFER_FINALIZE_ERROR_CODES[number] | undefined {
  return UPLOAD_TRANSFER_FINALIZE_ERROR_CODES.find(code => code === value);
}

export type UploadTransferFinalizeResult<TResult = undefined> =
  | Readonly<{
      success: true;
      path: string;
      sizeBytes: number;
      result?: TResult;
    }>
  | Readonly<{
      success: false;
      error: string;
      keepSession?: boolean;
      errorCode?: string;
    }>
  | Readonly<{
      success: false;
      error: string;
      errorCode: typeof TRANSFER_FINALIZE_RECOVERY_REQUIRED_ERROR_CODE;
      keepSession: true;
    }>;

export type UploadTransferTarget<TResult = undefined> = Readonly<{
  destDisplayPath: string;
  expectedSizeBytes: number;
  overwrite: boolean;
  finalizeUpload: (input: FinalizeUploadTransferInput) => Promise<UploadTransferFinalizeResult<TResult>>;
}>;
