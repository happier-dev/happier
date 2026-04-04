import type { ScmEntryKind, ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

export type ScmTreeBadge = Readonly<{
    kindLetter: string;
    added: number;
    removed: number;
    changedCount: number;
}>;

function sumEntryAdded(entry: { stats: { includedAdded: number; pendingAdded: number } }): number {
    return entry.stats.includedAdded + entry.stats.pendingAdded;
}

function sumEntryRemoved(entry: { stats: { includedRemoved: number; pendingRemoved: number } }): number {
    return entry.stats.includedRemoved + entry.stats.pendingRemoved;
}

function kindLetter(kind: ScmEntryKind): string {
    switch (kind) {
        case 'modified':
            return 'M';
        case 'added':
            return 'A';
        case 'deleted':
            return 'D';
        case 'renamed':
            return 'R';
        case 'copied':
            return 'C';
        case 'untracked':
            // Treat untracked files as "added" in the UI, since they represent new content
            // that will be included once staged/committed.
            return 'A';
        case 'conflicted':
            return '!';
        default:
            return 'M';
    }
}

type DirKindPriority = Readonly<{ priority: number; letter: string }>;

function kindToDirPriority(kind: ScmEntryKind): DirKindPriority {
    if (kind === 'conflicted') return { priority: 5, letter: '!' };
    if (kind === 'modified' || kind === 'renamed' || kind === 'copied') return { priority: 4, letter: 'M' };
    if (kind === 'added') return { priority: 3, letter: 'A' };
    if (kind === 'deleted') return { priority: 2, letter: 'D' };
    if (kind === 'untracked') return { priority: 3, letter: 'A' };
    return { priority: 0, letter: 'M' };
}

type DirAggregate = {
    priority: number;
    kindLetter: string;
    added: number;
    removed: number;
    changedCount: number;
};

export type ScmTreeBadgeIndex = Readonly<{
    getFileBadge: (fullPath: string) => ScmTreeBadge | null;
    getDirectoryBadge: (directoryPath: string) => ScmTreeBadge | null;
}>;

const badgeIndexCache = new WeakMap<ScmWorkingSnapshot, ScmTreeBadgeIndex>();

export function createScmTreeBadgeIndex(snapshot: ScmWorkingSnapshot | null | undefined): ScmTreeBadgeIndex {
    if (snapshot) {
        const cached = badgeIndexCache.get(snapshot);
        if (cached) return cached;
    }

    const entries = snapshot?.entries ?? [];
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
        const added = sumEntryAdded(entry);
        const removed = sumEntryRemoved(entry);
        fileMap.set(entry.path, { kindLetter: kindLetter(entry.kind), added, removed, changedCount: 1 });

        const { priority, letter } = kindToDirPriority(entry.kind);
        const segments = entry.path.split('/').filter(Boolean);
        // Aggregate at the root ("") and every directory prefix.
        let current = '';
        for (let i = 0; i < segments.length - 1; i++) {
            current = current ? `${current}/${segments[i]}` : segments[i]!;
            const agg = ensureDir(current);
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
            return { kindLetter: agg.kindLetter, added: agg.added, removed: agg.removed, changedCount: agg.changedCount };
        },
    } as const;

    if (snapshot) {
        badgeIndexCache.set(snapshot, index);
    }
    return index;
}

export function computeScmFileTreeBadge(snapshot: ScmWorkingSnapshot | null | undefined, fullPath: string): ScmTreeBadge | null {
    if (!snapshot?.entries) return null;
    const entry = snapshot.entries.find((e) => e.path === fullPath) ?? null;
    if (!entry) return null;
    const added = sumEntryAdded(entry);
    const removed = sumEntryRemoved(entry);
    return { kindLetter: kindLetter(entry.kind), added, removed, changedCount: 1 };
}

export function computeScmDirectoryTreeBadge(snapshot: ScmWorkingSnapshot | null | undefined, directoryPath: string): ScmTreeBadge | null {
    if (!snapshot?.entries) return null;
    const prefix = directoryPath ? `${directoryPath.replace(/\/+$/, '')}/` : '';
    const matching = prefix
        ? snapshot.entries.filter((e) => e.path.startsWith(prefix))
        : snapshot.entries.slice();
    if (matching.length === 0) return null;

    const added = matching.reduce((acc, e) => acc + sumEntryAdded(e), 0);
    const removed = matching.reduce((acc, e) => acc + sumEntryRemoved(e), 0);
    let bestPriority = 0;
    let letter = 'M';
    for (const entry of matching) {
        const pr = kindToDirPriority(entry.kind);
        if (pr.priority > bestPriority) {
            bestPriority = pr.priority;
            letter = pr.letter;
        }
    }
    return { kindLetter: letter, added, removed, changedCount: matching.length };
}
