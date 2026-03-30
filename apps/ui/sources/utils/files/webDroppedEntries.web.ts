export type WebDroppedFileEntry = Readonly<{
    file: File;
    relativePath: string;
}>;

type FileSystemEntryLike = Readonly<{
    isFile: boolean;
    isDirectory: boolean;
    name: string;
    file?: (cb: (file: File) => void, err?: (e: unknown) => void) => void;
    createReader?: () => Readonly<{ readEntries: (cb: (entries: any[]) => void, err?: (e: unknown) => void) => void }>;
}>;

function readEntryFile(entry: FileSystemEntryLike): Promise<File> {
    return new Promise<File>((resolve, reject) => {
        if (!entry.file) {
            reject(new Error('Not a file entry'));
            return;
        }
        entry.file(resolve, reject);
    });
}

async function readAllDirectoryEntries(entry: FileSystemEntryLike): Promise<FileSystemEntryLike[]> {
    const reader = entry.createReader?.();
    if (!reader) return [];

    const out: FileSystemEntryLike[] = [];
    while (true) {
        const batch = await new Promise<FileSystemEntryLike[]>((resolve, reject) => {
            reader.readEntries((entries: any[]) => resolve(entries as FileSystemEntryLike[]), reject);
        });
        if (!Array.isArray(batch) || batch.length === 0) break;
        out.push(...batch);
    }
    return out;
}

async function walkEntry(entry: FileSystemEntryLike, prefix: string): Promise<WebDroppedFileEntry[]> {
    if (entry.isFile) {
        const file = await readEntryFile(entry);
        const rel = prefix ? `${prefix}/${file.name}` : file.name;
        return [{ file, relativePath: rel.replace(/\\/g, '/') }];
    }

    if (entry.isDirectory) {
        const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
        const children = await readAllDirectoryEntries(entry);
        const nested: WebDroppedFileEntry[] = [];
        for (const child of children) {
            nested.push(...(await walkEntry(child, nextPrefix)));
        }
        return nested;
    }

    return [];
}

export async function readWebDroppedEntries(dataTransfer: DataTransfer): Promise<WebDroppedFileEntry[]> {
    const items = Array.from(dataTransfer.items ?? []);
    const hasWebkitEntries = items.some((item) => typeof (item as any).webkitGetAsEntry === 'function');

    if (!hasWebkitEntries) {
        return Array.from(dataTransfer.files ?? []).map((file) => ({ file, relativePath: file.name }));
    }

    const out: WebDroppedFileEntry[] = [];
    for (const item of items) {
        if (!item || item.kind !== 'file') continue;
        const getEntry = (item as any).webkitGetAsEntry;
        if (typeof getEntry !== 'function') continue;
        const entry = getEntry.call(item) as FileSystemEntryLike | null;
        if (!entry) continue;
        out.push(...(await walkEntry(entry, '')));
    }

    return out;
}

