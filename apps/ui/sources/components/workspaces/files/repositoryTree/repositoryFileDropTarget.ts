import { isWebFileDragEvent } from '@/utils/files/isWebFileDragEvent';
import type { WebFileDragEvent } from '@/components/ui/treeDragDrop/externalFileDropAdapter';

export type RepositoryFileDropTarget = Readonly<{
    destinationDir: string;
    hoverPath: string | null;
    autoExpandDirectoryPath: string | null;
}>;

export function writeRepositoryFileDropTarget(host: HTMLElement, target: RepositoryFileDropTarget | undefined) {
    for (const [key, value] of [
        ['data-repository-drop-destination', target?.destinationDir],
        ['data-repository-drop-hover', target?.hoverPath],
        ['data-repository-drop-expand', target?.autoExpandDirectoryPath],
    ] as const) {
        if (value == null) host.removeAttribute(key);
        else host.setAttribute(key, value);
    }
}

/** Semantic destination from the currently mounted row, used for hover AND release. */
export function readRepositoryFileDropTarget(event: WebFileDragEvent): RepositoryFileDropTarget | null {
    if (!isWebFileDragEvent(event)) return null;
    const target = event.target;
    const candidate = target && 'closest' in target && typeof target.closest === 'function'
        ? target.closest('[data-repository-drop-destination]') as Element | null
        : null;
    const host = event.currentTarget;
    const row = candidate && host && 'contains' in host && typeof host.contains === 'function' && !host.contains(candidate)
        ? null : candidate;
    return row ? {
        destinationDir: row.getAttribute('data-repository-drop-destination') ?? '',
        hoverPath: row.getAttribute('data-repository-drop-hover'),
        autoExpandDirectoryPath: row.getAttribute('data-repository-drop-expand'),
    } : { destinationDir: '', hoverPath: null, autoExpandDirectoryPath: null };
}
