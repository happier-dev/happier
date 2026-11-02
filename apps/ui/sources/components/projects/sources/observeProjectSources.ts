import { isAccountCurrentnessEntityIdV1, TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import type { ProjectSourcesController } from './projectSourcesController';

/** Classify the incumbent content-free Home wake for the captured Source scope. */
export function observeProjectSources(controller: ProjectSourcesController, options?: Parameters<ProjectSourcesController['refresh']>[0],
    onChange = () => { void controller.refresh(options); }): () => void {
    return subscribeHomeAccountChange((event) => {
        if (!areServerProfileIdentifiersEquivalent(event.serverId, controller.scope.serverId)) return;
        if (event.changeKinds && !event.changeKinds.includes('account')) return;
        if (event.entityIds && !event.entityIds.some((id) => id === PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1
            || id === TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 || isAccountCurrentnessEntityIdV1(id))) return;
        onChange();
    }, { serverIds: [controller.scope.serverId] });
}
