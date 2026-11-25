import { PROJECT_STARTER_CREATE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/specs/projectStartersActionIdsV1';
import { renderDeployPlanBriefV1, type DeploySuggestionCatalogV1, type DeploySuggestionRecommendationV1 } from '@happier-dev/protocol/deployments/suggestions/deploySuggestionsV1';
import type { ProjectStarterCreateInputV1 } from '@happier-dev/protocol/projects/starters/createV1';

import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { openSessionAuthoringAction } from '@/sync/ops/actions/sessionAuthoringActions';
import { buildProjectNewSessionOrigin, buildProjectNewSessionSeed } from '../detail/projectRouteState';
import type { OpenProject } from '../useOpenProject';
import { readStarterCreateOutcome, type StarterCreateOutcome } from './newAppDraft';

const executeAction = createFrontDoorActionExecute();

export type DeploySuggestionCreateOperands = Readonly<{
    input: Omit<ProjectStarterCreateInputV1, 'serverId' | 'source' | 'starterId' | 'starterSourceId' | 'description'>;
    lifetime: ServerAccountScopeLifetime;
}>;

export type ApplyDeploySuggestionOutcome =
    | Readonly<{ kind: 'where'; app: Readonly<{ sourceId: string; itemId: string }>; targetId: string }>
    | Readonly<{ kind: 'needsCreateInput' }>
    | Readonly<{ kind: 'created'; creation: Extract<StarterCreateOutcome, { kind: 'created' }> }>
    | Readonly<{ kind: 'failed'; code: string; creation?: StarterCreateOutcome }>;

export async function openStarterBuildSession(
    creation: Extract<StarterCreateOutcome, { kind: 'created' }>,
    sessionName: string,
    lifetime: ServerAccountScopeLifetime,
    openProject: OpenProject,
): Promise<boolean> {
    const { workspace, handoff, reviewedSetup } = creation;
    const origin = buildProjectNewSessionOrigin({ scope: lifetime.scope, workspace, page: 'overview', routeParams: {} });
    if (!origin || !lifetime.isCurrent()) return false;
    const focused = await openProject(workspace.workspaceId, {
        workspaceAddress: workspace, activeRootPath: handoff.directory,
    });
    if (!focused) return false;
    const name = sessionName.trim();
    const opened = await openSessionAuthoringAction({ seed: {
        ...buildProjectNewSessionSeed({ serverId: workspace.serverId, machineId: handoff.machineId, rootPath: handoff.directory }, origin),
        prompt: handoff.initialMessage,
        ...(name ? { sessionName: name } : {}),
        ...(reviewedSetup ? { forgeEvidence: { v: 1 as const, items: [{
            source: { kind: 'entry' as const, label: 'Reviewed app setup' },
            author: { kind: 'process' as const },
            text: reviewedSetup,
        }] } } : {}),
    } }, lifetime);
    return opened.kind === 'opened';
}

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
    const create = params.create;
    if (!create) return { kind: 'needsCreateInput' };
    let creationSource: NonNullable<ProjectStarterCreateInputV1['source']>;
    if (source.kind === 'starter') {
        const starter = params.catalog.starters.find(item => item.id === source.starterId);
        if (!starter?.sourceId || !starter.itemId) return { kind: 'failed', code: 'starter_unavailable' };
        creationSource = { kind: 'starter', starterId: starter.itemId, sourceId: starter.sourceId };
    } else {
        creationSource = { kind: 'scratch' };
    }

    const input: ProjectStarterCreateInputV1 = { ...create.input, serverId: params.serverId,
        source: creationSource,
        description: params.description };
    const reviewedSetup = renderDeployPlanBriefV1('', params.suggestion, create.input.repository,
        params.catalog.targets.find(target => target.id === params.suggestion.targetId));
    const result = await executeAction.confirmed(PROJECT_STARTER_CREATE_ACTION_ID_V1, input, { surface: 'ui', authority: 'present_user',
        actionCaller: { kind: 'host' }, serverId: params.serverId, expectedAccountId: create.lifetime.scope.accountId });
    if (!result.ok) return { kind: 'failed', code: result.errorCode };
    const creation = readStarterCreateOutcome(result.result, input.resume);
    if (creation.kind !== 'created') return { kind: 'failed', creation,
        code: creation.kind === 'failed' ? creation.code : creation.kind };

    return { kind: 'created', creation: { ...creation, reviewedSetup } };
}
