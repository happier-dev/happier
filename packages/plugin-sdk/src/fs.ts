export type FsPathInputV1 = Readonly<{
    path: string;
}>;

export type FsWriteTextInputV1 = FsPathInputV1 & Readonly<{
    contents: string;
}>;

export type FsCreateTempDirectoryInputV1 = Readonly<{
    prefix?: string;
}>;

export type FsTempTextFileInputV1 = Readonly<{
    suffix?: string;
    contents: string;
}>;

export type FsScopedPathListFileInputV1 = Readonly<{
    suffix?: string;
    paths: readonly string[];
}>;

export type FsScopedPathListDiagnosticCodeV1 =
    | 'scope_unavailable'
    | 'path_invalid'
    | 'path_escape'
    | 'path_missing'
    | 'path_not_file';

export type FsScopedPathListDiagnosticV1 = Readonly<{
    code: FsScopedPathListDiagnosticCodeV1;
    severity: 'error';
    messageKey: string;
    path?: string;
    detail?: Readonly<Record<string, unknown>>;
}>;

export type FsScopedPathListFileResultV1 =
    | Readonly<{
        status: 'created';
        path: string;
        paths: readonly string[];
    }>
    | Readonly<{
        status: 'blocked';
        diagnostics: readonly FsScopedPathListDiagnosticV1[];
    }>;

export interface FsTempDirectoryV1 {
    readonly path: string;
    createTextFile(input: FsTempTextFileInputV1): Promise<string>;
    createScopedPathListFile(input: FsScopedPathListFileInputV1): Promise<FsScopedPathListFileResultV1>;
    readText(input: FsPathInputV1): Promise<string>;
    cleanup(): Promise<void>;
}

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
    createTempDirectory(input?: FsCreateTempDirectoryInputV1): Promise<FsTempDirectoryV1>;
}
