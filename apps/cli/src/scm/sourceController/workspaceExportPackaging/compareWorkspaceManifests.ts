import type { WorkspaceManifest, WorkspaceManifestEntry } from '@happier-dev/protocol';

export type { WorkspaceManifest };

export type WorkspaceManifestEntryChange = Readonly<{
    previous: WorkspaceManifestEntry;
    next: WorkspaceManifestEntry;
}>;

export type WorkspaceManifestComparison = Readonly<{
    added: readonly WorkspaceManifestEntry[];
    removed: readonly WorkspaceManifestEntry[];
    changed: readonly WorkspaceManifestEntryChange[];
    unchanged: readonly WorkspaceManifestEntry[];
    hasChanges: boolean;
}>;

function comparePaths(left: string, right: string): number {
    return left.localeCompare(right);
}

function serializeWorkspaceManifestEntry(entry: WorkspaceManifestEntry): string {
    switch (entry.kind) {
        case 'directory':
            return `directory\t${entry.relativePath}`;
        case 'symlink':
            return `symlink\t${entry.relativePath}\t${entry.target}`;
        case 'file':
            return `file\t${entry.relativePath}\t${entry.digest}\t${entry.sizeBytes}\t${entry.executable ? '1' : '0'}`;
    }
}

function areEntriesEquivalent(previous: WorkspaceManifestEntry, next: WorkspaceManifestEntry): boolean {
    return serializeWorkspaceManifestEntry(previous) === serializeWorkspaceManifestEntry(next);
}

function createManifestEntryMap(entries: readonly WorkspaceManifestEntry[]): Map<string, WorkspaceManifestEntry> {
    const entryMap = new Map<string, WorkspaceManifestEntry>();

    for (const entry of entries) {
        if (entryMap.has(entry.relativePath)) {
            throw new Error(`Workspace manifest contains duplicate entry: ${entry.relativePath}`);
        }
        entryMap.set(entry.relativePath, entry);
    }

    return entryMap;
}

export function compareWorkspaceManifests(params: Readonly<{
    previousManifest: WorkspaceManifest;
    nextManifest: WorkspaceManifest;
}>): WorkspaceManifestComparison {
    const previousEntriesByPath = createManifestEntryMap(params.previousManifest.entries);
    const nextEntriesByPath = createManifestEntryMap(params.nextManifest.entries);
    const allPaths = [...new Set([...previousEntriesByPath.keys(), ...nextEntriesByPath.keys()])].sort(comparePaths);
    const added: WorkspaceManifestEntry[] = [];
    const removed: WorkspaceManifestEntry[] = [];
    const changed: WorkspaceManifestEntryChange[] = [];
    const unchanged: WorkspaceManifestEntry[] = [];

    for (const relativePath of allPaths) {
        const previousEntry = previousEntriesByPath.get(relativePath);
        const nextEntry = nextEntriesByPath.get(relativePath);

        if (!previousEntry && nextEntry) {
            added.push(nextEntry);
            continue;
        }

        if (previousEntry && !nextEntry) {
            removed.push(previousEntry);
            continue;
        }

        if (!previousEntry || !nextEntry) {
            continue;
        }

        if (areEntriesEquivalent(previousEntry, nextEntry)) {
            unchanged.push(nextEntry);
            continue;
        }

        changed.push({
            previous: previousEntry,
            next: nextEntry,
        });
    }

    return {
        added,
        removed,
        changed,
        unchanged,
        hasChanges: added.length > 0 || removed.length > 0 || changed.length > 0,
    };
}
