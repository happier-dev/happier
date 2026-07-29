export type FinalizeUploadTransferInput = Readonly<{
  uploadId: string;
  tempPath: string;
  sizeBytes: number;
  sha256: string;
}>;

export const TRANSFER_FINALIZE_RECOVERY_REQUIRED_ERROR_CODE =
  'TRANSFER_FINALIZE_RECOVERY_REQUIRED' as const;

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
      errorCode?: never;
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
