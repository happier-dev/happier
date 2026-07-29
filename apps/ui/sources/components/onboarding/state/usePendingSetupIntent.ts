import * as React from 'react';

import { getPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';
import {
    subscribePendingSetupIntent,
    type PendingSetupIntent,
} from '@/sync/domains/pending/pendingSetupIntent.shared';

type StorageEventTarget = Readonly<{
    addEventListener: (type: 'storage', listener: (event: Event) => void) => void;
    removeEventListener: (type: 'storage', listener: (event: Event) => void) => void;
}>;

function getStorageEventTarget(): StorageEventTarget | null {
    const maybeWindow = (globalThis as { window?: unknown }).window;
    if (!maybeWindow || typeof maybeWindow !== 'object') return null;
    const target = maybeWindow as Partial<StorageEventTarget>;
    if (typeof target.addEventListener !== 'function' || typeof target.removeEventListener !== 'function') {
        return null;
    }
    return target as StorageEventTarget;
}

function subscribePendingSetupIntentSnapshot(onStoreChange: () => void): () => void {
    const unsubscribeIntent = subscribePendingSetupIntent(onStoreChange);
    const storageTarget = getStorageEventTarget();
    if (!storageTarget) {
        return unsubscribeIntent;
    }

    const handleStorage = () => {
        onStoreChange();
    };
    storageTarget.addEventListener('storage', handleStorage);
    return () => {
        unsubscribeIntent();
        storageTarget.removeEventListener('storage', handleStorage);
    };
}

export function usePendingSetupIntent(): PendingSetupIntent | null {
    return React.useSyncExternalStore(
        subscribePendingSetupIntentSnapshot,
        getPendingSetupIntent,
        getPendingSetupIntent,
    );
}
