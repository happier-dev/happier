export type FsPathInputV1 = Readonly<{
    path: string;
}>;

export type FsWriteTextInputV1 = FsPathInputV1 & Readonly<{
    contents: string;
}>;

export type FsEntryV1 = Readonly<{
    name: string;
    kind: 'file' | 'directory' | 'other';
}>;

export type FsStatV1 = Readonly<{
    kind: 'file' | 'directory' | 'other';
    size: number;
    mtimeMs: number;
}>;

export interface FsRuntimeServiceV1 {
    readText(input: FsPathInputV1): Promise<string>;
    writeText(input: FsWriteTextInputV1): Promise<void>;
    mkdir(input: FsPathInputV1): Promise<void>;
    list(input: FsPathInputV1): Promise<readonly FsEntryV1[]>;
    stat(input: FsPathInputV1): Promise<FsStatV1 | null>;
}
