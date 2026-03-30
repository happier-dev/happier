export type LazyDirectoryTreeEntry = Readonly<{
    name: string;
    path: string;
    type: 'file' | 'directory';
    sizeBytes?: number;
    modifiedMs?: number;
    source?: 'preview' | 'remote';
}>;

export type LazyDirectoryTreeLoadResult =
    | { ok: true; entries: LazyDirectoryTreeEntry[]; truncated?: boolean }
    | { ok: false; error: string };

export type LazyDirectoryTreeNode = Readonly<{
    path: string;
    name: string;
    type: 'file' | 'directory' | 'error' | 'info';
    depth: number;
    isExpanded: boolean;
    isLoadingChildren: boolean;
    sizeBytes?: number;
    modifiedMs?: number;
    source?: 'preview' | 'remote';
    parentDirectoryPath?: string;
    errorMessage?: string;
    infoKind?: 'truncated';
    entryCount?: number;
}>;
