import { describeScmChangeKind } from '@/scm/scmChangeKind';
import { selectScmChangedFiles } from '@/scm/scmStatusFiles';
import type { ScmEntryKind, ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { scmChangeHasLineDelta } from '@/scm/scmLineDelta';

export type ScmTreeBadge = Readonly<{
    kindLetter: string;
    added: number;
    removed: number;
    changedCount: number;
    isComplete?: boolean;
}>;

function sumEntryAdded(entry: { stats: { includedAdded: number; pendingAdded: number } }): number {
    return entry.stats.includedAdded + entry.stats.pendingAdded;
}

function sumEntryRemoved(entry: { stats: { includedRemoved: number; pendingRemoved: number } }): number {
    return entry.stats.includedRemoved + entry.stats.pendingRemoved;
}

type DirKindPriority = Readonly<{ priority: number; letter: string }>;

function kindToDirPriority(kind: ScmEntryKind): DirKindPriority {
    const descriptor = describeScmChangeKind(kind);
    // A moved child modifies its containing directory; it does not rename the directory itself.
    const directoryKind = descriptor.tone === 'moved' ? describeScmChangeKind('modified') : descriptor;
    const priority = directoryKind.tone === 'conflicted' ? 5 : directoryKind.tone === 'modified' ? 4
        : directoryKind.tone === 'added' ? 3 : 2;
    return { priority, letter: directoryKind.code };
}

type DirAggregate = {
    priority: number;
    kindLetter: string;
    added: number;
    removed: number;
    changedCount: number;
    isComplete?: boolean;
};

export type ScmTreeBadgeIndex = Readonly<{
    getFileBadge: (fullPath: string) => ScmTreeBadge | null;
    getDirectoryBadge: (directoryPath: string) => ScmTreeBadge | null;
}>;

export function buildScmTreeBadgeSignature(snapshot: ScmWorkingSnapshot | null | undefined): string {
    if (!snapshot?.entries?.length) return '';
    return snapshot.entries
        .map((entry) => [
            entry.path,
            entry.kind,
            entry.stats.includedAdded,
            entry.stats.includedRemoved,
            entry.stats.pendingAdded,
            entry.stats.pendingRemoved,
            entry.stats.isComplete === false ? 0 : 1,
        ].join(':'))
        .sort()
        .join('|');
}

const badgeIndexCache = new WeakMap<ScmWorkingSnapshot, ScmTreeBadgeIndex>();

export function createScmTreeBadgeIndex(snapshot: ScmWorkingSnapshot | null | undefined): ScmTreeBadgeIndex {
    if (snapshot) {
        const cached = badgeIndexCache.get(snapshot);
        if (cached) return cached;
    }

    // Folder counts come from the one changed-file list, so a folder's total and the header count
    // agree (a directory the backend collapsed, such as `scratch/`, is not a changed file).
    const changedPaths = snapshot ? new Set(selectScmChangedFiles(snapshot).map((file) => file.fullPath)) : null;
    const entries = (snapshot?.entries ?? []).filter((entry) => changedPaths?.has(entry.path) === true);
    const fileMap = new Map<string, ScmTreeBadge>();
    const dirAgg = new Map<string, DirAggregate>();

    const ensureDir = (dirPath: string): DirAggregate => {
        const existing = dirAgg.get(dirPath);
        if (existing) return existing;
        const created: DirAggregate = { priority: 0, kindLetter: 'M', added: 0, removed: 0, changedCount: 0 };
        dirAgg.set(dirPath, created);
        return created;
    };

    for (const entry of entries) {
        const counted = scmChangeHasLineDelta({ fullPath: entry.path, isBinary: entry.stats.isBinary });
        const added = counted ? sumEntryAdded(entry) : 0;
        const removed = counted ? sumEntryRemoved(entry) : 0;
        fileMap.set(entry.path, { kindLetter: describeScmChangeKind(entry.kind).code, added, removed, changedCount: 1, ...(entry.stats.isComplete === false ? { isComplete: false } : {}) });

        const { priority, letter } = kindToDirPriority(entry.kind);
        const segments = entry.path.split('/').filter(Boolean);
        // Aggregate at the root ("") and every directory prefix.
        let current = '';
        for (let i = 0; i < segments.length - 1; i++) {
            current = current ? `${current}/${segments[i]}` : segments[i]!;
            const agg = ensureDir(current);
            if (entry.stats.isComplete === false) agg.isComplete = false;
            agg.added += added;
            agg.removed += removed;
            agg.changedCount += 1;
            if (priority > agg.priority) {
                agg.priority = priority;
                agg.kindLetter = letter;
            }
        }
        // Root aggregate (empty string) is used by callers that render the repo root.
        const rootAgg = ensureDir('');
        if (entry.stats.isComplete === false) rootAgg.isComplete = false;
        rootAgg.added += added;
        rootAgg.removed += removed;
        rootAgg.changedCount += 1;
        if (priority > rootAgg.priority) {
            rootAgg.priority = priority;
            rootAgg.kindLetter = letter;
        }
    }

    const index: ScmTreeBadgeIndex = {
        getFileBadge: (fullPath: string) => fileMap.get(fullPath) ?? null,
        getDirectoryBadge: (directoryPath: string) => {
            const normalized = directoryPath.replace(/\/+$/, '');
            const agg = dirAgg.get(normalized) ?? null;
            if (!agg || agg.changedCount === 0) return null;
            return { kindLetter: agg.kindLetter, added: agg.added, removed: agg.removed, changedCount: agg.changedCount, ...(agg.isComplete === false ? { isComplete: false } : {}) };
        },
    } as const;

    if (snapshot) {
        badgeIndexCache.set(snapshot, index);
    }
    return index;
}

export function computeScmFileTreeBadge(snapshot: ScmWorkingSnapshot | null | undefined, fullPath: string): ScmTreeBadge | null {
    return createScmTreeBadgeIndex(snapshot).getFileBadge(fullPath);
}

export function computeScmDirectoryTreeBadge(snapshot: ScmWorkingSnapshot | null | undefined, directoryPath: string): ScmTreeBadge | null {
    return createScmTreeBadgeIndex(snapshot).getDirectoryBadge(directoryPath);
}
