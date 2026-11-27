import { isSafeWorkspaceRelativePath } from '@/utils/path/isSafeWorkspaceRelativePath';
import { resolveFileDetailsRootPath } from './fileDetailsTab';

export type GalleryDetailsResource =
    | Readonly<{ kind: 'gallery'; path: string; rootPath?: string }>
    | Readonly<{ kind: 'gallery'; scope: 'session-media' }>;

export function readGalleryDetailsResource(value: unknown): GalleryDetailsResource | null {
    if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'gallery') return null;
    if ('scope' in value && value.scope === 'session-media') return { kind: 'gallery', scope: 'session-media' };
    if (!('path' in value) || typeof value.path !== 'string' || (value.path !== '' && !isSafeWorkspaceRelativePath(value.path))) return null;
    const rootPath = 'rootPath' in value && typeof value.rootPath === 'string' ? resolveFileDetailsRootPath(value.rootPath) : undefined;
    return { kind: 'gallery', path: value.path, ...(rootPath ? { rootPath } : {}) };
}

export function createWorkspaceGalleryDetailsTab(resource: GalleryDetailsResource, title?: string) {
    const key = 'scope' in resource ? 'gallery:session-media' : `gallery:${JSON.stringify([resource.rootPath ?? '', resource.path])}`;
    return { kind: 'gallery' as const, key, title: title ?? ('path' in resource ? resource.path.split('/').at(-1) || '/' : 'Media'), resource };
}
