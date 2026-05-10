export type AttachmentsUploadFileSource =
    | Readonly<{ kind: 'web'; file: File }>
    | Readonly<{
        kind: 'memory';
        bytes: Uint8Array;
        name: string;
        mimeType?: string | null;
        previewUri?: string | null;
    }>
    | Readonly<{
        kind: 'native';
        uri: string;
        name: string;
        sizeBytes?: number | null;
        mimeType?: string | null;
    }>;
