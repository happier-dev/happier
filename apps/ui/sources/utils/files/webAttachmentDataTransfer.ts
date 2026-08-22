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
    if (!dataTransfer) return [];

    const files: File[] = [];
    const seen = new Set<string>();
    const pushFile = (file: File | null | undefined) => {
        if (!file) return;
        const identity = buildFileIdentity(file);
        if (seen.has(identity)) return;
        seen.add(identity);
        files.push(file);
    };

    for (const item of arrayFromMaybeArrayLike(dataTransfer.items)) {
        if (item?.kind !== 'file') continue;
        pushFile(typeof item.getAsFile === 'function' ? item.getAsFile() : null);
    }

    if (files.length === 0) {
        for (const file of arrayFromMaybeArrayLike(dataTransfer.files)) {
            pushFile(file);
        }
    }

    return files;
}
