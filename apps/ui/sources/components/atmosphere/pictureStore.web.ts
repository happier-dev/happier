import { openBrowserRecordDatabase } from '@/sync/domains/state/browserRecordStorage';
import { ATMOSPHERE_PICTURE_MAX_EDGE } from '@happier-dev/brand/atmosphere';
import { createBuiltinPictureAcquisition, readPictureSource } from './ensureBuiltinPicture';
import type { PictureInfo, PictureInput, PictureStore, BuiltinPicture, PicturePreparationOptions } from './pictureStore.types';
import { createPictureStoreAccess } from './pictureStoreAccess';

type WebPictureRecord = PictureInfo & Readonly<{ data: Blob; thumb?: Blob; source?: BuiltinPicture['src'] }>;
const access = createPictureStoreAccess(readRecordFromStore);
const get = access.get;

function readRecord(value: unknown): WebPictureRecord | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'object' || value === null || !('localId' in value) || typeof value.localId !== 'string'
        || !('kind' in value) || (value.kind !== 'builtin' && value.kind !== 'user')
        || !('createdAtMs' in value) || typeof value.createdAtMs !== 'number'
        || !('size' in value) || typeof value.size !== 'number'
        || !('data' in value) || !(value.data instanceof Blob)
        || ('thumb' in value && value.thumb !== undefined && !(value.thumb instanceof Blob))) {
        throw new Error('Invalid stored atmosphere picture; bytes were preserved.');
    }
    const source = 'source' in value ? readPictureSource(value.source) : undefined;
    return { localId: value.localId, kind: value.kind, createdAtMs: value.createdAtMs, size: value.size,
        ...(source ? { source } : {}),
        data: value.data, ...('thumb' in value && value.thumb instanceof Blob ? { thumb: value.thumb } : {}) };
}

async function asBlob(data: Blob | string): Promise<Blob> {
    if (typeof data !== 'string') return data;
    const response = await fetch(data);
    if (!response.ok) throw new Error(`Atmosphere picture read failed (${response.status}).`);
    return response.blob();
}

function fetchBuiltinPicture(source: string): Promise<Response> {
    const url = new URL(source);
    // Met's CDN loses CORS headers on reused URLs; stored bytes keep this nonce download-only.
    url.searchParams.set('happier-atmosphere', crypto.getRandomValues(new Uint32Array(4)).join('-'));
    return fetch(url.href, { mode: 'cors' });
}

/** Browser decoding/canvas encoding owns image formats and orientation. */
async function prepare(data: Blob | string, options?: PicturePreparationOptions): Promise<Blob> {
    const bitmap = await createImageBitmap(await asBlob(data));
    try {
        const scale = Math.min(1, ATMOSPHERE_PICTURE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(bitmap.width * scale);
        canvas.height = Math.round(bitmap.height * scale);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Atmosphere image canvas is unavailable.');
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const mime = options?.format === 'png' ? 'image/png' : 'image/webp';
        return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => {
            if (blob?.type === mime) resolve(blob); else reject(new Error('Atmosphere picture encoding failed.'));
        }, mime, 0.86));
    } finally { bitmap.close(); }
}

async function readRecordFromStore(localId: string): Promise<WebPictureRecord | undefined> {
    const database = await openBrowserRecordDatabase('pictures');
    return new Promise((resolve, reject) => {
        const transaction = database.transaction('pictures', 'readonly');
        const request = transaction.objectStore('pictures').get(localId);
        transaction.oncomplete = () => { try { resolve(readRecord(request.result)); } catch (error) { reject(error); } };
        transaction.onabort = () => reject(transaction.error ?? new Error('Atmosphere picture read aborted.'));
        transaction.onerror = () => reject(transaction.error);
    });
}
async function put(input: PictureInput): Promise<WebPictureRecord> {
    const [data, thumb] = await Promise.all([asBlob(input.data), input.thumb === undefined ? undefined : asBlob(input.thumb)]);
    // A mutation must not wait on an older display snapshot before it can publish new bytes.
    const previous = await readRecordFromStore(input.localId);
    const record: WebPictureRecord = { localId: input.localId, kind: input.kind,
        createdAtMs: previous?.createdAtMs ?? Date.now(), size: data.size + (thumb?.size ?? 0), data,
        ...(input.source ? { source: input.source } : {}),
        ...(thumb ? { thumb } : {}) };
    const database = await openBrowserRecordDatabase('pictures');
    await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('pictures', 'readwrite', { durability: 'strict' });
        transaction.objectStore('pictures').put(record, input.localId);
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new Error('Atmosphere picture write aborted.'));
        transaction.onerror = () => reject(transaction.error);
    });
    access.changed(input.localId, input.kind, previous?.kind);
    return record;
}
async function remove(localId: string): Promise<void> {
    const database = await openBrowserRecordDatabase('pictures');
    let kind: WebPictureRecord['kind'] | undefined;
    await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('pictures', 'readwrite', { durability: 'strict' });
        const store = transaction.objectStore('pictures');
        const request = store.get(localId);
        request.onsuccess = () => {
            const value: unknown = request.result;
            if (typeof value === 'object' && value !== null && 'kind' in value
                && (value.kind === 'user' || value.kind === 'builtin')) kind = value.kind;
        };
        store.delete(localId);
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new Error('Atmosphere picture removal aborted.'));
        transaction.onerror = () => reject(transaction.error);
    });
    access.changed(localId, kind);
}
async function list(kind?: PictureInfo['kind']): Promise<PictureInfo[]> {
    const database = await openBrowserRecordDatabase('pictures');
    return new Promise((resolve, reject) => {
        const transaction = database.transaction('pictures', 'readonly');
        const store = transaction.objectStore('pictures');
        const request = kind === undefined ? store.openCursor() : store.index('kind').openCursor(IDBKeyRange.only(kind));
        const pictures: PictureInfo[] = [];
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            try {
                const record = readRecord(cursor.value);
                if (record) pictures.push({ localId: record.localId, kind: record.kind, createdAtMs: record.createdAtMs, size: record.size });
                cursor.continue();
            } catch (error) { transaction.abort(); reject(error); }
        };
        transaction.oncomplete = () => resolve(pictures);
        transaction.onabort = () => reject(transaction.error ?? new Error('Atmosphere picture listing aborted.'));
        transaction.onerror = () => reject(transaction.error);
    });
}
export const pictureStore = {
    prepare, put, get, remove, list,
    ...createBuiltinPictureAcquisition({ get, put }, prepare, fetchBuiltinPicture),
    subscribe: access.subscribe,
    getRevision: access.getRevision,
} satisfies PictureStore;
