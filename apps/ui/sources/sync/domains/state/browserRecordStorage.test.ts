import { describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { forceCloseDatabase, IDBFactory } from 'fake-indexeddb';
import { clearBrowserRecords, deleteBrowserRecord, listBrowserRecords, readBrowserRecord, updateBrowserRecord, writeBrowserRecord } from './browserRecordStorage';

describe('browser large-record transactions', () => {
    it('indexes existing version-one pictures by kind without replacing their bytes or keys', async () => {
        vi.stubGlobal('indexedDB', new IDBFactory());
        let upgraded: IDBDatabase | undefined;
        try {
            const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
                const request = indexedDB.open('happier-atmosphere-pictures', 1);
                request.onupgradeneeded = () => request.result.createObjectStore('pictures');
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            await new Promise<void>((resolve, reject) => {
                const transaction = legacy.transaction('pictures', 'readwrite');
                const store = transaction.objectStore('pictures');
                store.put({ localId: 'kept-user', kind: 'user', createdAtMs: 1, size: 5, data: new Blob(['photo']) }, 'kept-user');
                store.put({ localId: 'kept-builtin', kind: 'builtin', createdAtMs: 2, size: 7, data: new Blob(['builtin']) }, 'kept-builtin');
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error);
            });
            legacy.close();
            vi.resetModules();
            const records = await import('./browserRecordStorage');
            const { pictureStore } = await import('@/components/atmosphere/pictureStore.web');
            expect(await pictureStore.list('user')).toEqual([{ localId: 'kept-user', kind: 'user', createdAtMs: 1, size: 5 }]);
            expect(await (await pictureStore.get('kept-user'))?.data.text()).toBe('photo');
            expect(await (await pictureStore.get('kept-builtin'))?.data.text()).toBe('builtin');
            upgraded = await records.openBrowserRecordDatabase('pictures');
            expect(upgraded.version).toBe(2);
        } finally { upgraded?.close(); vi.unstubAllGlobals(); }
    });
    it('reopens an unexpectedly closed connection before clearing durable records', async () => {
        const opening = vi.spyOn(indexedDB, 'open');
        await writeBrowserRecord('closed:draft', 'private draft');
        const opened = opening.mock.results[0];
        opening.mockRestore();
        if (opened.type !== 'return') throw new Error('Expected a database open request');
        const database = opened.value.result;
        const closed = new Promise<void>((resolve) => database.addEventListener('close', () => resolve(), { once: true }));
        // @ts-expect-error fake-indexeddb declares a constructor here, but its API takes an instance.
        forceCloseDatabase(database);
        await closed;

        expect(await readBrowserRecord('closed:draft')).toBe('private draft');
        await clearBrowserRecords();
        expect(await listBrowserRecords('')).toEqual(new Map());
        await writeBrowserRecord('closed:next-account', 'new draft');
        expect(await readBrowserRecord('closed:next-account')).toBe('new draft');
    });

    it('completes an explicit local-data clear before reporting success', async () => {
        await writeBrowserRecord('clear:draft', 'draft');
        await writeBrowserRecord('clear:outbox', 'message');
        await clearBrowserRecords();
        expect(await listBrowserRecords('clear:')).toEqual(new Map());
    });
    it('persists a large record beyond Web Storage limits and deletes only its exact key', async () => {
        const value = 'large draft '.repeat(600_000);
        await writeBrowserRecord('large:scope', value);
        await writeBrowserRecord('other:scope', 'keep');
        expect(await readBrowserRecord('large:scope')).toBe(value);
        expect(await listBrowserRecords('large:')).toEqual(new Map([['large:scope', value]]));
        await deleteBrowserRecord('large:scope');
        expect(await readBrowserRecord('large:scope')).toBeUndefined();
        expect(await readBrowserRecord('other:scope')).toBe('keep');
    });

    it('serializes concurrent read-modify-write callers without losing records', async () => {
        await writeBrowserRecord('concurrent:scope', '[]');
        await Promise.all(Array.from({ length: 12 }, (_, index) => updateBrowserRecord('concurrent:scope', (raw) => ({
            value: JSON.stringify([...JSON.parse(raw ?? '[]'), index]),
            result: undefined,
        }))));
        expect(JSON.parse((await readBrowserRecord('concurrent:scope'))!)).toEqual(Array.from({ length: 12 }, (_, index) => index));
    });

    it('rejects a failed update without replacing the committed record', async () => {
        await writeBrowserRecord('failed:scope', 'valuable');
        await expect(updateBrowserRecord('failed:scope', () => { throw new Error('cannot encode'); })).rejects.toThrow('cannot encode');
        expect(await readBrowserRecord('failed:scope')).toBe('valuable');
    });
    it('keeps predecessor string records readable while adding durable picture bytes', async () => {
        vi.stubGlobal('indexedDB', new IDBFactory());
        try {
            const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
                const request = indexedDB.open('happier-local-records', 1);
                request.onupgradeneeded = () => request.result.createObjectStore('records');
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            await new Promise<void>((resolve, reject) => {
                const transaction = legacy.transaction('records', 'readwrite');
                transaction.objectStore('records').put('valuable draft', 'retained:draft');
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error);
            });
            legacy.close();
            vi.resetModules();
            const records = await import('./browserRecordStorage');
            const { pictureStore } = await import('@/components/atmosphere/pictureStore.web');
            expect(await records.readBrowserRecord('retained:draft')).toBe('valuable draft');
            await pictureStore.put({ localId: 'after-upgrade', kind: 'user', data: new Blob(['photo']) });
            expect(await (await pictureStore.get('after-upgrade'))?.data.text()).toBe('photo');
            expect(await records.readBrowserRecord('retained:draft')).toBe('valuable draft');
            const predecessor = await new Promise<IDBDatabase>((resolve, reject) => {
                // 0.2's real opener requests version 1; a second tab must still be able to read.
                const request = indexedDB.open('happier-local-records', 1);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            predecessor.close();
            (await records.openBrowserRecordDatabase()).close();
            (await records.openBrowserRecordDatabase('pictures')).close();
        } finally { vi.unstubAllGlobals(); }
    });
});
