import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { STORAGE_SPECIMEN_STATES, StorageSpecimen } from '@/components/dev/storage/StorageSpecimen';

/** Dev-only: the Account's Storage view with the storage-view lab's fixtures. `?state=` one of the specimen's states. */
export default function StorageDevScreen() {
    const params = useLocalSearchParams<{ state?: string }>();
    const state = STORAGE_SPECIMEN_STATES.find((candidate) => candidate === params.state) ?? 'settings';
    return <StorageSpecimen key={state} state={state} />;
}
