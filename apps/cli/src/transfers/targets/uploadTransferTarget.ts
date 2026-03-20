export type FinalizeUploadTransferInput = Readonly<{
  tempPath: string;
  sizeBytes: number;
  sha256: string;
}>;

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
    }>;

export type UploadTransferTarget<TResult = undefined> = Readonly<{
  destDisplayPath: string;
  expectedSizeBytes: number;
  overwrite: boolean;
  finalizeUpload: (input: FinalizeUploadTransferInput) => Promise<UploadTransferFinalizeResult<TResult>>;
}>;
