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

export function buildChangedFilesOutlineTree(files: ScmFileStatus[]): ChangedFilesOutlineNode[] {
    const root = createDir('', '');

    for (const file of files) {
        const fullPath = file.fullPath?.trim();
        if (!fullPath) continue;

        // SCM paths are expected to be forward-slash normalized, but be resilient to
        // backslash-delimited inputs (e.g. Windows/interop edge cases).
        const parts = fullPath.replace(/\\/g, '/').split('/').filter(Boolean);
        if (parts.length === 0) continue;

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
            file,
        });
    }

    return toNode(root).children;
}
