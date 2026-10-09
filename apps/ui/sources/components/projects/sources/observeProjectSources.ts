import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import type { ProjectSourcesController } from './projectSourcesController';

/** Observe the incumbent content-free Home wake only while a Source surface is demanded. */
export function observeProjectSources(controller: ProjectSourcesController, options?: Parameters<ProjectSourcesController['refresh']>[0]): () => void {
    return subscribeHomeAccountChange((event) => {
        if (!areServerProfileIdentifiersEquivalent(event.serverId, controller.scope.serverId)) return;
        if (event.entityIds && !event.entityIds.some((id) => id === PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1
            || id === TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 || id === 'self')) return;
        void controller.refresh(options);
    });
}
