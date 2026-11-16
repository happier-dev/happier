import { PROJECT_STARTER_CREATE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/specs/projectStartersActionIdsV1';
import { renderDeployPlanBriefV1, type DeploySuggestionCatalogV1, type DeploySuggestionRecommendationV1 } from '@happier-dev/protocol/deployments/suggestions/deploySuggestionsV1';
import type { ProjectStarterCreateInputV1 } from '@happier-dev/protocol/projects/starters/createV1';

import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { openSessionAuthoringAction } from '@/sync/ops/actions/sessionAuthoringActions';
import { readStarterCreateOutcome, type StarterCreateOutcome } from './newAppDraft';

const executeAction = createFrontDoorActionExecute();

export type DeploySuggestionCreateOperands = Readonly<{
    input: Omit<ProjectStarterCreateInputV1, 'serverId' | 'starterId' | 'starterSourceId' | 'description'>;
    lifetime: ServerAccountScopeLifetime;
    sessionName?: string;
}>;

export type ApplyDeploySuggestionOutcome =
    | Readonly<{ kind: 'where'; app: Readonly<{ sourceId: string; itemId: string }>; targetId: string }>
    | Readonly<{ kind: 'needsCreateInput' }>
    | Readonly<{ kind: 'created'; creation: Extract<StarterCreateOutcome, { kind: 'created' }>; sessionOpened: boolean }>
    | Readonly<{ kind: 'failed'; code: string; creation?: StarterCreateOutcome }>;

/** Both dialog and Session cards route through the existing create or deployment journey. */
export async function applyDeploySuggestion(params: Readonly<{
    serverId: string;
    suggestion: DeploySuggestionRecommendationV1;
    catalog: DeploySuggestionCatalogV1;
    description: string;
    create?: DeploySuggestionCreateOperands;
}>): Promise<ApplyDeploySuggestionOutcome> {
    const source = params.suggestion.source;
    if (source.kind === 'catalogApp') {
        const app = params.catalog.apps.find(item => item.id === source.appId);
        if (!app?.sourceId || !app.itemId) return { kind: 'failed', code: 'catalog_app_unavailable' };
        return { kind: 'where', app: { sourceId: app.sourceId, itemId: app.itemId }, targetId: params.suggestion.targetId };
    }
    // Scratch is admitted by the source union; its create vertical is U5's extension of the same Action.
    if (source.kind === 'scratch') return { kind: 'failed', code: 'unsupported_source' };
    const create = params.create;
    if (!create) return { kind: 'needsCreateInput' };
    const starter = params.catalog.starters.find(item => item.id === source.starterId);
    if (!starter?.sourceId || !starter.itemId) return { kind: 'failed', code: 'starter_unavailable' };

    const input: ProjectStarterCreateInputV1 = { ...create.input, serverId: params.serverId,
        starterId: starter.itemId, starterSourceId: starter.sourceId,
        description: renderDeployPlanBriefV1(params.description, params.suggestion) };
    const result = await executeAction.confirmed(PROJECT_STARTER_CREATE_ACTION_ID_V1, input, { surface: 'ui', authority: 'present_user',
        actionCaller: { kind: 'host' }, serverId: params.serverId, expectedAccountId: create.lifetime.scope.accountId });
    if (!result.ok) return { kind: 'failed', code: result.errorCode };
    const creation = readStarterCreateOutcome(result.result, input.resume);
    if (creation.kind !== 'created') return { kind: 'failed', creation,
        code: creation.kind === 'failed' ? creation.code : creation.kind };

    const opened = await openSessionAuthoringAction({ seed: {
        placement: { kind: 'exactTarget', serverId: params.serverId,
            machineId: creation.handoff.machineId, directory: creation.handoff.directory },
        prompt: creation.handoff.initialMessage,
        ...(create.sessionName?.trim() ? { sessionName: create.sessionName.trim() } : {}),
    } }, create.lifetime);
    return { kind: 'created', creation, sessionOpened: opened.kind === 'opened' };
}
