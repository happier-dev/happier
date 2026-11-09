import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { Directory, File, Paths } from 'expo-file-system';

import { createBuiltinPictureAcquisition, readPictureSource } from './ensureBuiltinPicture';
import { readPictureBase64 } from './pictureBytes.native';
import type { PictureInfo, PictureInput, PictureRecord, PictureStore, PicturePreparationOptions } from './pictureStore.types';
import { createPictureStoreAccess } from './pictureStoreAccess';

type StoredInfo = PictureInfo & { hasThumb: boolean; source?: PictureRecord['source'] };
const access = createPictureStoreAccess(readRecordFromStore);
const get = access.get;

function storeDirectory() { return new Directory(Paths.document, 'atmosphere'); }

function recordDirectory(localId: string) {
    // Opaque names avoid URI-decoded separators and native filename-length limits.
    return new Directory(storeDirectory(), bytesToHex(sha256(localId)));
}

async function readInfo(directory: Directory): Promise<StoredInfo | undefined> {
    const info = new File(directory, 'info.json');
    if (!info.exists) return undefined;
    let value: unknown;
    try { value = JSON.parse(await info.text()); } catch (error) {
        if (error instanceof SyntaxError) return undefined;
        throw error;
    }
    if (typeof value !== 'object' || value === null ||
        !('localId' in value) || typeof value.localId !== 'string' ||
        !('kind' in value) || (value.kind !== 'user' && value.kind !== 'builtin') ||
        !('createdAtMs' in value) || typeof value.createdAtMs !== 'number' || !Number.isFinite(value.createdAtMs) ||
        !('size' in value) || typeof value.size !== 'number' || !Number.isFinite(value.size) || value.size < 0 ||
        !('hasThumb' in value) || typeof value.hasThumb !== 'boolean') return undefined;
    const source = 'source' in value ? readPictureSource(value.source) : undefined;
    return { localId: value.localId, kind: value.kind, createdAtMs: value.createdAtMs, size: value.size, hasThumb: value.hasThumb,
        ...(source ? { source } : {}) };
}

async function prepare(data: Blob | string, options?: PicturePreparationOptions): Promise<string> {
    const encoded = await readPictureBase64(data);
    const { prepareNativePicture } = await import('./preparePicture.native');
    return prepareNativePicture(encoded, options);
}

async function readRecordFromStore(localId: string): Promise<PictureRecord | undefined> {
    const directory = recordDirectory(localId);
    const info = await readInfo(directory);
    if (!info || info.localId !== localId) return undefined;
    const data = new File(directory, 'full.image');
    const thumb = new File(directory, 'thumb.image');
    if (!data.exists || (info.hasThumb && !thumb.exists)) return undefined;
    return { localId, kind: info.kind, createdAtMs: info.createdAtMs, size: info.size, data: data.uri,
        ...(info.source ? { source: info.source } : {}), ...(info.hasThumb ? { thumb: thumb.uri } : {}) };
}

async function put(input: PictureInput): Promise<PictureRecord> {
    // A mutation must not wait on an older display snapshot before it can publish new bytes.
    const previous = await readRecordFromStore(input.localId);
    const [dataBytes, thumbBytes] = await Promise.all([
        readPictureBase64(input.data), input.thumb === undefined ? undefined : readPictureBase64(input.thumb),
    ]);
    const directory = recordDirectory(input.localId);
    directory.create({ intermediates: true, idempotent: true });
    const data = new File(directory, 'full.image');
    const thumb = new File(directory, 'thumb.image');
    data.write(dataBytes, { encoding: 'base64' });
    if (thumbBytes !== undefined) thumb.write(thumbBytes, { encoding: 'base64' });
    else if (thumb.exists) thumb.delete();
    const info: StoredInfo = { localId: input.localId, kind: input.kind, createdAtMs: previous?.createdAtMs ?? Date.now(), size: data.size + (thumbBytes === undefined ? 0 : thumb.size), hasThumb: thumbBytes !== undefined,
        ...(input.source ? { source: input.source } : {}) };
    new File(directory, 'info.json').write(JSON.stringify(info));
    const record: PictureRecord = { localId: info.localId, kind: info.kind, createdAtMs: info.createdAtMs, size: info.size, data: data.uri,
        ...(info.source ? { source: info.source } : {}), ...(info.hasThumb ? { thumb: thumb.uri } : {}) };
    access.changed(input.localId, input.kind, previous?.kind);
    return record;
}

export const pictureStore: PictureStore = {
    prepare,
    put,
    get,
    async remove(localId) {
        const directory = recordDirectory(localId);
        if (!directory.exists) return;
        const info = await readInfo(directory);
        directory.delete();
        access.changed(localId, info?.kind);
    },
    async list(kind) {
        const directory = storeDirectory();
        if (!directory.exists) return [];
        const records = await Promise.all(directory.list().map(async (entry) => {
            if (!(entry instanceof Directory)) return undefined;
            const info = await readInfo(entry);
            if (!info || (kind !== undefined && info.kind !== kind)) return undefined;
            const data = new File(entry, 'full.image'), thumb = new File(entry, 'thumb.image');
            return data.exists && (!info.hasThumb || thumb.exists)
                ? { localId: info.localId, kind: info.kind, createdAtMs: info.createdAtMs, size: info.size } : undefined;
        }));
        return records.filter((record): record is PictureInfo => record !== undefined);
    },
    ...createBuiltinPictureAcquisition({ get, put }, prepare),
    subscribe: access.subscribe,
    getRevision: access.getRevision,
};
