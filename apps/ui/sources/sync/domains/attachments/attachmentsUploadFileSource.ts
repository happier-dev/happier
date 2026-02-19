export type AttachmentsUploadFileSource =
    | Readonly<{ kind: 'web'; file: File }>
    | Readonly<{
        kind: 'native';
        uri: string;
        name: string;
        sizeBytes?: number | null;
        mimeType?: string | null;
    }>;

