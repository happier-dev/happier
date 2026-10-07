import type { LazyDirectoryTreeNode } from '@/hooks/ui/filesystem/lazyDirectoryTreeTypes';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';

export type ChangedFilesOutlineNode =
    | {
          kind: 'dir';
          name: string;
          fullPath: string;
          children: ChangedFilesOutlineNode[];
      }
    | {
          kind: 'file';
          name: string;
          fullPath: string;
          file: ScmFileStatus;
      };

function compareNamesCaseInsensitive(a: string, b: string): number {
    return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

function sortNodes(nodes: ChangedFilesOutlineNode[]): ChangedFilesOutlineNode[] {
    return [...nodes].sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
        return compareNamesCaseInsensitive(a.name, b.name);
    });
}

type DirBuilder = {
    kind: 'dir';
    name: string;
    fullPath: string;
    dirs: Map<string, DirBuilder>;
    files: Map<string, ChangedFilesOutlineNode & { kind: 'file' }>;
};

function createDir(name: string, fullPath: string): DirBuilder {
    return {
        kind: 'dir',
        name,
        fullPath,
        dirs: new Map(),
        files: new Map(),
    };
}

function toNode(dir: DirBuilder): ChangedFilesOutlineNode & { kind: 'dir' } {
    const children: ChangedFilesOutlineNode[] = [];
    for (const childDir of dir.dirs.values()) children.push(toNode(childDir));
    for (const childFile of dir.files.values()) children.push(childFile);
    return {
        kind: 'dir',
        name: dir.name,
        fullPath: dir.fullPath,
        children: sortNodes(children),
    };
}

function readChangedFilePath(path: string): Readonly<{ fullPath: string; parts: string[] }> | null {
    const fullPath = path?.trim();
    if (!fullPath) return null;
    // SCM paths are normally forward-slash normalized; retain Windows/interop inputs.
    const parts = fullPath.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts.length > 0 ? { fullPath, parts } : null;
}

/** The outline's root folder count without allocating or sorting its file rows. */
export function countChangedFilesOutlineRootFolders(files: readonly Pick<ScmFileStatus, 'fullPath'>[]): number {
    const roots = new Set<string>();
    for (const file of files) {
        const path = readChangedFilePath(file.fullPath);
        if (path && path.parts.length > 1) roots.add(path.parts[0]!);
    }
    return roots.size;
}

export function buildChangedFilesOutlineTree(files: readonly Pick<ScmFileStatus, 'fullPath'>[]): ChangedFilesOutlineNode[] {
    const root = createDir('', '');

    for (const file of files) {
        const path = readChangedFilePath(file.fullPath);
        if (!path) continue;
        const { fullPath, parts } = path;

        let current = root;
        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i]!;
            const nextPath = current.fullPath ? `${current.fullPath}/${part}` : part;
            const existing = current.dirs.get(part);
            if (existing) {
                current = existing;
            } else {
                const next = createDir(part, nextPath);
                current.dirs.set(part, next);
                current = next;
            }
        }

        const fileName = parts[parts.length - 1]!;
        current.files.set(fullPath, {
            kind: 'file',
            name: fileName,
            fullPath,
            file: file as ScmFileStatus,
        });
    }

    return toNode(root).children;
}

/**
 * Changed only (session tabs lab FC): the Files tree pruned to the changed files, as tree rows. Every
 * folder is open unless the person closed it, and a folder whose only child is one folder merges
 * into it ("components/settings/modal"), so a deep change never costs seven rows in a narrow pane.
 * A merged row stands for its deepest folder: its path opens, reveals and counts that folder.
 */
export function buildChangedOnlyTreeNodes(
    files: readonly Pick<ScmFileStatus, 'fullPath'>[],
    closedPaths: ReadonlySet<string>,
    preferredPaths?: ReadonlySet<string>,
): LazyDirectoryTreeNode[] {
    const rows: LazyDirectoryTreeNode[] = [];
    const emit = (nodes: readonly ChangedFilesOutlineNode[], depth: number, parentDirectoryPath: string) => {
        for (const node of nodes) {
            if (node.kind === 'file') {
                rows.push({ path: node.fullPath, name: node.name, type: 'file', depth, isExpanded: false, isLoadingChildren: false, parentDirectoryPath });
                continue;
            }
            let folder = node;
            let name = node.name;
            while (folder.children.length === 1 && folder.children[0]!.kind === 'dir') {
                folder = folder.children[0] as typeof folder;
                name = `${name}/${folder.name}`;
            }
            const isExpanded = !closedPaths.has(folder.fullPath);
            rows.push({ path: folder.fullPath, name, type: 'directory', depth, isExpanded, isLoadingChildren: false, parentDirectoryPath });
            if (isExpanded) emit(folder.children, depth + 1, folder.fullPath);
        }
    };
    const roots = buildChangedFilesOutlineTree(files);
    if (preferredPaths?.size) {
        const preferredRoots = new Set(Array.from(preferredPaths, (path) => path.replace(/\\/g, '/').split('/')[0]));
        // Stable partition: only roots containing this session's work move; descendants retain their order.
        roots.sort((a, b) => Number(preferredRoots.has(b.name)) - Number(preferredRoots.has(a.name)));
    }
    emit(roots, 0, '');
    return rows;
}

type MergedChangedFolder = Readonly<{ path: string; childRows: number; childFolders: readonly MergedChangedFolder[] }>;

/** The folders as Changed only draws them: a single-child folder chain is one row standing for its deepest folder. */
function mergeChangedFolders(nodes: readonly ChangedFilesOutlineNode[]): MergedChangedFolder[] {
    const folders: MergedChangedFolder[] = [];
    for (const node of nodes) {
        if (node.kind !== 'dir') continue;
        let folder = node;
        while (folder.children.length === 1 && folder.children[0]!.kind === 'dir') {
            folder = folder.children[0] as typeof folder;
        }
        folders.push({ path: folder.fullPath, childRows: folder.children.length, childFolders: mergeChangedFolders(folder.children) });
    }
    return folders;
}

/**
 * Which folders a large changed-only tree starts closed: every folder starts closed, then folders open
 * breadth first (top level, then their children) for as long as the visible rows stay within
 * `rowBudget`. A small change therefore opens whole, and a large one reads as a page of folders with
 * every file one tap away; nothing is left out, only folded.
 */
export function resolveChangedOnlyTreeInitiallyClosedPaths(
    files: readonly Pick<ScmFileStatus, 'fullPath'>[],
    rowBudget: number,
): ReadonlySet<string> {
    const outline = buildChangedFilesOutlineTree(files);
    const topLevel = mergeChangedFolders(outline);
    const closed = new Set<string>();
    const collect = (folders: readonly MergedChangedFolder[]) => {
        for (const folder of folders) {
            closed.add(folder.path);
            collect(folder.childFolders);
        }
    };
    collect(topLevel);

    let visibleRows = outline.length;
    let level: readonly MergedChangedFolder[] = topLevel;
    while (level.length > 0) {
        const next: MergedChangedFolder[] = [];
        for (const folder of level) {
            if (visibleRows + folder.childRows > rowBudget) continue;
            visibleRows += folder.childRows;
            closed.delete(folder.path);
            next.push(...folder.childFolders);
        }
        level = next;
    }
    return closed;
}
