import type { BuiltinPicture, PictureRecord, PictureStore } from './pictureStore.types';

export function builtinPictureLocalId(id: string): string { return `builtin:${id}`; }
/** Shared small record: browsing never downloads originals, and backdrops can paint it first. */
export function builtinThumbnailLocalId(id: string): string { return `builtin-thumb:${id}`; }

/** Download nonces never enter this identity; only the catalog's canonical URLs do. */
export function pictureSourceMatches(source: BuiltinPicture['src'] | undefined, expected: BuiltinPicture['src']): boolean {
    return source?.full === expected.full && source.thumb === expected.thumb;
}

/** Optional metadata on existing device records; absent/malformed identities are re-downloadable. */
export function readPictureSource(value: unknown): BuiltinPicture['src'] | undefined {
    if (typeof value !== 'object' || value === null || !('full' in value) || typeof value.full !== 'string'
        || !('thumb' in value) || typeof value.thumb !== 'string') return undefined;
    return { full: value.full, thumb: value.thumb };
}

/** One acquisition owner for full pictures and picker thumbnails; failures retry only on later demand. */
export function createBuiltinPictureAcquisition(
    store: Pick<PictureStore, 'get' | 'put'>,
    prepare: (data: Blob | string) => Promise<Blob | string>,
    fetchPicture: (url: string) => Promise<Response> = url => fetch(url),
) {
    const pendingPictures = new Map<string, Readonly<{ source: BuiltinPicture['src']; operation: Promise<PictureRecord> }>>();
    function ensureBuiltin(picture: BuiltinPicture): Promise<PictureRecord> {
        const localId = builtinPictureLocalId(picture.id);
        const existing = pendingPictures.get(localId);
        if (existing) return pictureSourceMatches(existing.source, picture.src) ? existing.operation
            : existing.operation.then(() => ensureBuiltin(picture), () => ensureBuiltin(picture));
        const operation = (async () => {
            const stored = await store.get(localId);
            if (stored && pictureSourceMatches(stored.source, picture.src)) return stored;
            const download = async (url: string) => {
                const response = await fetchPicture(url);
                if (!response.ok) throw new Error(`Atmosphere picture download failed (${response.status}).`);
                return prepare(await response.blob());
            };
            // Publish the small backdrop before acquiring its full-size replacement.
            const thumb = await ensureBuiltinThumbnail(picture);
            const data = await download(picture.src.full);
            return store.put({ localId, kind: 'builtin', data, thumb, source: picture.src });
        })().finally(() => pendingPictures.delete(localId));
        pendingPictures.set(localId, { source: picture.src, operation });
        return operation;
    }

    // Full downloads use this same cache/in-flight operation, including while their original is pending.
    const pendingThumbnails = new Map<string, Readonly<{ source: string; operation: Promise<Blob | string> }>>();
    function ensureBuiltinThumbnail(picture: BuiltinPicture): Promise<Blob | string> {
        const localId = builtinThumbnailLocalId(picture.id);
        const existing = pendingThumbnails.get(localId);
        if (existing) return existing.source === picture.src.thumb ? existing.operation
            : existing.operation.then(() => ensureBuiltinThumbnail(picture), () => ensureBuiltinThumbnail(picture));
        const operation = (async () => {
            const full = await store.get(builtinPictureLocalId(picture.id));
            if (full?.thumb !== undefined && full.source?.thumb === picture.src.thumb) return full.thumb;
            const stored = await store.get(localId);
            if (stored?.source?.thumb === picture.src.thumb) return stored.data;
            const response = await fetchPicture(picture.src.thumb);
            if (!response.ok) throw new Error(`Atmosphere thumbnail download failed (${response.status}).`);
            return (await store.put({ localId, kind: 'builtin', data: await prepare(await response.blob()), source: picture.src })).data;
        })().finally(() => pendingThumbnails.delete(localId));
        pendingThumbnails.set(localId, { source: picture.src.thumb, operation });
        return operation;
    }

    return { ensureBuiltin, ensureBuiltinThumbnail };
}
