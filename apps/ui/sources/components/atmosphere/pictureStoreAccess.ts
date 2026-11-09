import type { PictureInfo, PictureRecord, PictureSubscription } from './pictureStore.types';

/** Exact-id reads and mutation invalidation share the device-local resource owner. */
export function createPictureStoreAccess<Record extends PictureRecord>(read: (localId: string) => Promise<Record | undefined>) {
    const pending = new Map<string, Promise<Record | undefined>>();
    const library = new Set<() => void>();
    const pictures = new Map<string, Set<() => void>>();
    const kinds = { user: new Set<() => void>(), builtin: new Set<() => void>() };
    const kindRevisions = { user: 0, builtin: 0 };
    let revision = 0;
    function get(localId: string, thumbnailLocalId?: string): Promise<Record | undefined> {
        // Full cache hits keep one read; concurrent misses share both exact-id reads.
        if (thumbnailLocalId) return get(localId).then(record => record ?? get(thumbnailLocalId));
        const previous = pending.get(localId);
        if (previous) return previous;
        const reading = read(localId).finally(() => {
            if (pending.get(localId) === reading) pending.delete(localId);
        });
        pending.set(localId, reading);
        return reading;
    }
    return {
        get,
        changed(localId: string, kind?: PictureInfo['kind'], previousKind?: PictureInfo['kind']) {
            pending.delete(localId);
            revision += 1;
            // Unknown/corrupt removed metadata cannot rule out either library kind.
            const changedKinds = new Set<PictureInfo['kind']>(kind ? [kind] : ['user', 'builtin']);
            if (previousKind) changedKinds.add(previousKind);
            changedKinds.forEach(value => { kindRevisions[value]++; });
            library.forEach(listener => listener());
            changedKinds.forEach(value => kinds[value].forEach(listener => listener()));
            pictures.get(localId)?.forEach(listener => listener());
        },
        getRevision: (kind?: PictureInfo['kind']) => kind ? kindRevisions[kind] : revision,
        subscribe(listener: () => void, selection?: PictureSubscription) {
            const localId = typeof selection === 'string' ? selection : undefined;
            const listeners = selection === undefined ? library : typeof selection === 'object' ? kinds[selection.kind]
                : pictures.get(selection) ?? new Set<() => void>();
            if (localId !== undefined) pictures.set(localId, listeners);
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
                if (localId !== undefined && listeners.size === 0) pictures.delete(localId);
            };
        },
    };
}
