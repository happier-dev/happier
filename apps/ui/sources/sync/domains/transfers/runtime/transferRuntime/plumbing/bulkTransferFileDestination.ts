export type BulkTransferFileDestination = Readonly<{
    writeBytes: (bytes: Uint8Array) => Promise<void>;
    close: () => Promise<void>;
    cleanup?: (() => Promise<void>) | null;
}>;
