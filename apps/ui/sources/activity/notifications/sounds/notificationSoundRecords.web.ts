import { openBrowserRecordDatabase } from '@/sync/domains/state/browserRecordStorage';
import type { NotificationSoundInfo, NotificationSoundRecords } from './notificationSoundRecords.types';

async function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore, result: (value: T) => void) => void): Promise<T> {
    const database = await openBrowserRecordDatabase('sounds');
    return new Promise((resolve, reject) => {
        const transaction = database.transaction('sounds', mode);
        let value: T;
        transaction.oncomplete = () => resolve(value);
        transaction.onabort = () => reject(transaction.error ?? new Error('notification_sound_storage_aborted'));
        run(transaction.objectStore('sounds'), result => { value = result; });
    });
}

export const notificationSoundRecords: NotificationSoundRecords = {
    get(id) {
        return transact('readonly', (store, result) => {
            const info = store.get(id);
            const bytes = store.get(['bytes', id]);
            bytes.onsuccess = () => result(info.result && bytes.result instanceof ArrayBuffer
                ? { ...info.result, bytes: bytes.result } : undefined);
        });
    },
    put(info, bytes) {
        return transact('readwrite', store => {
            store.put(info, info.id);
            store.put(bytes, ['bytes', info.id]);
        });
    },
    list() {
        return transact('readonly', (store, result) => {
            const request = store.index('kind').getAll('user');
            request.onsuccess = () => result(request.result);
        });
    },
    rename(id, label) {
        return transact('readwrite', (store, result) => {
            const request = store.get(id);
            request.onsuccess = () => {
                const info: NotificationSoundInfo | undefined = request.result;
                if (info?.kind !== 'user') return result(undefined);
                const renamed = { ...info, label };
                store.put(renamed, id);
                result(renamed);
            };
        });
    },
    remove(id) {
        return transact('readwrite', store => {
            store.delete(id);
            store.delete(['bytes', id]);
        });
    },
};
