import { configuration } from '@/configuration';
import { createBrowserStoragePartitionOwner } from '../storage/partitions';
import { createBrowserProfileStore, type BrowserProfileStoreOptions } from './store';

/** Daemon control and Store update checks read the same Machine-owned profile root. */
export function createConfiguredBrowserProfileStore(options: Pick<BrowserProfileStoreOptions, 'emitAudit'> = {}) {
  return createBrowserProfileStore({
    storageRootDirectory: configuration.happyHomeDir,
    partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: configuration.happyHomeDir }),
    ...options,
  });
}
