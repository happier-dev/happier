import type { LazyDirectoryTreeEntry } from '@/hooks/ui/filesystem/lazyDirectoryTreeTypes';
import { resolveFileViewerKind } from '@/scm/utils/filePresentation';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

export type GalleryMediaOrigin = 'folder' | 'messages' | 'generated' | 'artifacts' | 'captures';
export type GalleryMediaItem = Readonly<{
    id: string;
    name: string;
    path: string;
    scope: WorkspaceScopeBase;
    origin: GalleryMediaOrigin;
    kind: 'image' | 'svg' | 'video';
    mimeType: string;
    alphaCapable: boolean;
    sizeBytes?: number;
    modifiedMs?: number;
    messageLocalId?: string;
}>;

export type GalleryDaySection = Readonly<{ day: string | null; items: readonly GalleryMediaItem[] }>;

export function classifyGalleryFile(
    entry: Pick<LazyDirectoryTreeEntry, 'name' | 'path' | 'sizeBytes' | 'modifiedMs'>,
    scope: WorkspaceScopeBase,
    origin: GalleryMediaOrigin,
    messageLocalId?: string,
): GalleryMediaItem | null {
    const { kind, mimeType, alphaCapable } = resolveFileViewerKind({ path: entry.name });
    if (kind !== 'image' && kind !== 'svg' && kind !== 'video') return null;
    return { ...entry, id: JSON.stringify([origin, entry.path]), scope, origin, kind, mimeType, alphaCapable,
        ...(messageLocalId === undefined ? {} : { messageLocalId }) };
}

function localDay(modifiedMs: number | undefined): string | null {
    if (modifiedMs === undefined) return null;
    const date = new Date(modifiedMs);
    if (!Number.isFinite(date.valueOf())) return null;
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

export function groupGalleryMedia(items: readonly GalleryMediaItem[]): Readonly<{
    items: readonly GalleryMediaItem[];
    sections: readonly GalleryDaySection[];
    shownCount: number;
}> {
    const sorted = [...items].sort((a, b) => (b.modifiedMs ?? -Infinity) - (a.modifiedMs ?? -Infinity)
        || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const days = new Map<string | null, GalleryMediaItem[]>();
    for (const item of sorted) {
        const day = localDay(item.modifiedMs);
        const section = days.get(day);
        if (section) section.push(item);
        else days.set(day, [item]);
    }
    return { items: sorted, sections: Array.from(days, ([day, items]) => ({ day, items })), shownCount: sorted.length };
}
