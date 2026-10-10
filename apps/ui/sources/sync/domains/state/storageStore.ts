import { create } from 'zustand';

import { createArtifactsDomain } from '../../store/domains/artifacts';
import { createAuthoringMemoryDomain } from '../../store/domains/authoringMemory';
import { createAutomationsDomain } from '../../store/domains/automations';
import { createFeedDomain } from '../../store/domains/feed';
import { createFriendsDomain } from '../../store/domains/friends';
import { createMachinesDomain } from '../../store/domains/machines';
import { createMachinePoolsDomain } from '../../store/domains/machinePools';
import { createProjectAccountRowsDomain } from '../../store/domains/projectAccountRows';
import { createMessagesDomain } from '../../store/domains/messages';
import { createPendingDomain } from '../../store/domains/pending';
import { createPetsDomain } from '../../store/domains/pets';
import { createProfileDomain } from '../../store/domains/profile';
import { createRealtimeDomain } from '../../store/domains/realtime';
import { createSessionOrganizationDomain } from '../../store/domains/sessionOrganization';
import { createSessionsDomain } from '../../store/domains/sessions';
import { createSettingsDomain } from '../../store/domains/settings';
import { createTodosDomain } from '../../store/domains/todos';
import { createTranscriptLoadingDomain } from '../../store/domains/transcriptLoading';
import { createWorkflowRunsDomain } from '../../store/domains/workflowRuns';
import type { StorageState } from '../../store/types';
import { registerStorageStateReader, registerStorageStateSubscribe } from './storageStateReaderBridge';

export type { KnownEntitlements } from '../../store/types';
export type { SessionListViewItem } from '../session/listing/sessionListViewData';

export const storage = create<StorageState>()((set, get) => {
    const settingsDomain = createSettingsDomain<StorageState>({ set, get });
    const authoringMemoryDomain = createAuthoringMemoryDomain<StorageState>({ set, get });
    const profileDomain = createProfileDomain<StorageState>({ set, get });
    const todosDomain = createTodosDomain<StorageState>({ set, get });
    const machinesDomain = createMachinesDomain<StorageState>({ set, get });
    const machinePoolsDomain = createMachinePoolsDomain<StorageState>({ set, get });
    const projectAccountRowsDomain = createProjectAccountRowsDomain<StorageState>({ set, get });
    const sessionsDomain = createSessionsDomain<StorageState>({ set, get });
    const sessionOrganizationDomain = createSessionOrganizationDomain<StorageState>({ set, get });
    const pendingDomain = createPendingDomain<StorageState>({ set, get });
    const messagesDomain = createMessagesDomain<StorageState>({ set, get });
    const transcriptLoadingDomain = createTranscriptLoadingDomain<StorageState>({ set, get });
    const realtimeDomain = createRealtimeDomain<StorageState>({ set });
    const artifactsDomain = createArtifactsDomain<StorageState>({ set, get });
    const workflowRunsDomain = createWorkflowRunsDomain<StorageState>({ set, get });
    const automationsDomain = createAutomationsDomain<StorageState>({ set, get });
    const petsDomain = createPetsDomain<StorageState>({ set, get });
    const friendsDomain = createFriendsDomain<StorageState>({ set, get });
    const feedDomain = createFeedDomain<StorageState>({ set, get });

    return {
        ...settingsDomain,
        ...authoringMemoryDomain,
        ...profileDomain,
        ...sessionsDomain,
        ...sessionOrganizationDomain,
        ...machinesDomain,
        ...machinePoolsDomain,
        ...projectAccountRowsDomain,
        ...artifactsDomain,
        ...workflowRunsDomain,
        ...automationsDomain,
        ...petsDomain,
        ...friendsDomain,
        ...feedDomain,
        ...todosDomain,
        ...pendingDomain,
        ...messagesDomain,
        ...transcriptLoadingDomain,
        ...realtimeDomain,
    };
});

registerStorageStateReader(() => storage.getState());
registerStorageStateSubscribe((listener) => storage.subscribe((state) => listener(state)));

export function getStorage() {
    return storage;
}
