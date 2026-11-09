import * as React from 'react';
import { pictureStore } from './pictureStore';
import type { PictureRecord } from './pictureStore.types';

export type StoredPictureRecord = Readonly<{ status: 'loading' }>
    | Readonly<{ status: 'missing' }>
    | Readonly<{ status: 'present'; record: PictureRecord }>;

const LOADING: StoredPictureRecord = { status: 'loading' };
const MISSING: StoredPictureRecord = { status: 'missing' };

/** One exact-picture reader for the surface and picker, with latest-read ordering at persistence. */
export function useStoredPictureRecord(localId: string | null, thumbnailLocalId?: string): StoredPictureRecord {
    const [read, setRead] = React.useState<Readonly<{ localId: string; result: StoredPictureRecord }> | null>(null);
    React.useEffect(() => {
        if (localId === null) { setRead(null); return; }
        let disposed = false;
        let request = 0;
        const update = () => {
            const current = ++request;
            void pictureStore.get(localId, thumbnailLocalId).then(record => {
                if (!disposed && current === request) setRead({ localId,
                    result: record ? { status: 'present', record } : MISSING });
            }, () => {
                if (!disposed && current === request) setRead({ localId, result: MISSING });
            });
        };
        const stop = pictureStore.subscribe(update, localId);
        const stopThumbnail = thumbnailLocalId ? pictureStore.subscribe(update, thumbnailLocalId) : undefined;
        update();
        return () => { disposed = true; stop(); stopThumbnail?.(); };
    }, [localId, thumbnailLocalId]);
    return localId === null ? MISSING : read?.localId === localId ? read.result : LOADING;
}
