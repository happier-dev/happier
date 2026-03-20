export type DownloadTransferSource = Readonly<{
  filePath: string;
  deleteFileOnClose: boolean;
  sizeBytes: number;
  name: string;
}>;
