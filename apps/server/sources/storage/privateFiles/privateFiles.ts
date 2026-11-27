export type PrivateFileWrite = Uint8Array | Readonly<{ chunks: AsyncIterable<Uint8Array>; byteLength: number }>;

export type PrivateFilesBackend = {
    init(): Promise<void>;
    writePrivateFile(key: string, data: PrivateFileWrite): Promise<void>;
    readPrivateFile(key: string): Promise<Uint8Array>;
    deletePrivateFile?(key: string): Promise<void>;
};
