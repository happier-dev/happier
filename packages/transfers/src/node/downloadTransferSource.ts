export type DownloadTransferSource = Readonly<{
  filePath: string;
  deleteFileOnClose: boolean;
  /**
   * Optional private byte range within `filePath`. The transfer session exposes
   * only this range, never adjacent file bytes.
   */
  sourceOffsetBytes?: number;
  sizeBytes: number;
  name: string;
}>;
