export type PrivateFilesBackend = {
    init(): Promise<void>;
    writePrivateFile(key: string, data: Uint8Array): Promise<void>;
    readPrivateFile(key: string): Promise<Uint8Array>;
    deletePrivateFile?(key: string): Promise<void>;
};
