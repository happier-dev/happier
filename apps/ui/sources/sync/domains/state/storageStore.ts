import { create } from 'zustand';

import { createArtifactsDomain } from '../../store/domains/artifacts';
import { createFeedDomain } from '../../store/domains/feed';
import { createFriendsDomain } from '../../store/domains/friends';
import { createMachinesDomain } from '../../store/domains/machines';
import { createMessagesDomain } from '../../store/domains/messages';
import { createPendingDomain } from '../../store/domains/pending';
import { createProfileDomain } from '../../store/domains/profile';
import { createRealtimeDomain } from '../../store/domains/realtime';
import { createSessionsDomain } from '../../store/domains/sessions';
import { createSettingsDomain } from '../../store/domains/settings';
import { createTodosDomain } from '../../store/domains/todos';
import type { StorageState } from '../../store/types';

export type { KnownEntitlements, SessionListItem } from '../../store/types';
export type { SessionListViewItem } from '../session/listing/sessionListViewData';

export const storage = create<StorageState>()((set, get) => {
    const settingsDomain = createSettingsDomain<StorageState>({ set, get });
    const profileDomain = createProfileDomain<StorageState>({ set, get });
    const todosDomain = createTodosDomain<StorageState>({ set, get });
    const machinesDomain = createMachinesDomain<StorageState>({ set, get });
    const sessionsDomain = createSessionsDomain<StorageState>({ set, get });
    const pendingDomain = createPendingDomain<StorageState>({ set, get });
    const messagesDomain = createMessagesDomain<StorageState>({ set, get });
    const realtimeDomain = createRealtimeDomain<StorageState>({ set, get });
    const artifactsDomain = createArtifactsDomain<StorageState>({ set, get });
    const friendsDomain = createFriendsDomain<StorageState>({ set, get });
    const feedDomain = createFeedDomain<StorageState>({ set, get });

    return {
        ...settingsDomain,
        ...profileDomain,
        ...sessionsDomain,
        ...machinesDomain,
        ...artifactsDomain,
        ...friendsDomain,
        ...feedDomain,
        ...todosDomain,
        ...pendingDomain,
        ...messagesDomain,
        ...realtimeDomain,
    };
});

export function getStorage() {
    return storage;
}
