import { getPersistenceStorage } from './persistenceStorage';

export function clearPersistence() {
    const mmkv = getPersistenceStorage();
    mmkv.clearAll();
}
