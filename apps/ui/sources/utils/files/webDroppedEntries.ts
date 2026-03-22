export type WebDroppedFileEntry = Readonly<{
    file: File;
    relativePath: string;
}>;

export async function readWebDroppedEntries(_dataTransfer: unknown): Promise<WebDroppedFileEntry[]> {
    return [];
}

