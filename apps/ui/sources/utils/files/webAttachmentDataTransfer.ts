type DataTransferItemLike = Readonly<{
    kind?: string;
    getAsFile?: () => File | null;
}>;

type DataTransferFileListLike = Iterable<File> | ArrayLike<File>;

type DataTransferLike = Readonly<{
    items?: Iterable<DataTransferItemLike> | ArrayLike<DataTransferItemLike> | null;
    files?: DataTransferFileListLike | null;
}> | null | undefined;

function arrayFromMaybeArrayLike<T>(value: Iterable<T> | ArrayLike<T> | null | undefined): T[] {
    if (!value) return [];
    return Array.from(value as Iterable<T> | ArrayLike<T>);
}

function buildFileIdentity(file: File): string {
    return [
        file.name,
        String(file.size),
        file.type,
        String(file.lastModified || 0),
    ].join('\u0000');
}

export function extractWebAttachmentFilesFromDataTransfer(dataTransfer: DataTransferLike): readonly File[] {
    const files: File[] = [];
    const seen = new Set<string>();

    for (const item of arrayFromMaybeArrayLike(dataTransfer?.items)) {
        if (item.kind !== 'file') continue;
        const file = item.getAsFile?.();
        if (!file) continue;
        const identity = buildFileIdentity(file);
        if (seen.has(identity)) continue;
        seen.add(identity);
        files.push(file);
    }

    if (files.length === 0) {
        for (const file of arrayFromMaybeArrayLike(dataTransfer?.files)) {
            const identity = buildFileIdentity(file);
            if (seen.has(identity)) continue;
            seen.add(identity);
            files.push(file);
        }
    }

    return files;
}
