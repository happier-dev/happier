import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { bindExternalActionExecutionAuthorizationHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { buildScmDiffSummaryModelProfiles } from '@/settings/scmDiffSummary/models';
import { ScmDiffSummaryModelSelectorSchema } from '@happier-dev/protocol/scm/diffSummary';
import { createExternalActionAccountHttpBoundary } from './externalActionAccountHttpBoundary';
import type { HomeGovernanceHarness } from './homeGovernanceHarness';

const MODEL_CATALOG_ACTION_ID: ActionId = 'agents.models.list';
type CatalogTarget = Pick<Parameters<typeof buildScmDiffSummaryModelProfiles>[0], 'backendTarget' | 'models' | 'catalogModels' | 'agentFormats'> & Readonly<{
    /** Native discovery is requested for the selected Agent, as at settingsCatalogServices. */
    discoveredModels?: Parameters<typeof buildScmDiffSummaryModelProfiles>[0]['models'];
}>;

/**
 * The executing Machine's Summary model catalog, served as the canonical exact-Machine
 * `agents.models.list` Action over Home HTTP: the only source of offered Summary models.
 * Account capture, custody admission, schemas, the catalog reader and picker projection stay real.
 */
export async function createScmDiffSummaryModelCatalogHttpBoundary(params: Readonly<{
    serverUrl: string; serverIdentityId: string; accountId: string; machineId: string;
    /** `currentAccount` Home tokens carry epoch 0. */
    tokenEpoch?: number;
    /** The Machine's offered Agents; the first is its automatic default. */
    targets: readonly CatalogTarget[];
    /** Omitted uses the first target; null represents offered routes without an Account default. */
    automaticTarget?: CatalogTarget['backendTarget'] | null;
}>) {
    if (params.targets.length === 0) throw new Error('A Machine catalog fixture needs at least one Agent');
    const boundary = await createExternalActionAccountHttpBoundary({ serverUrl: params.serverUrl,
        serverIdentityId: params.serverIdentityId, accountId: params.accountId, machineId: params.machineId,
        tokenEpoch: params.tokenEpoch ?? 0, actionId: MODEL_CATALOG_ACTION_ID,
        execute(input) {
            const selector = ScmDiffSummaryModelSelectorSchema.safeParse(input && typeof input === 'object' && 'modelSelector' in input ? input.modelSelector : null);
            const discoveryTargetKey = input && typeof input === 'object' && 'discoveryTargetKey' in input ? input.discoveryTargetKey : null;
            const byTarget = params.targets.map(target => {
                const targetKey = buildBackendTargetKeyV2(target.backendTarget);
                const discover = discoveryTargetKey === targetKey || (selector.success && selector.data.backendTargetKey === targetKey);
                return buildScmDiffSummaryModelProfiles({ ...target, models: [...target.models, ...(discover ? target.discoveredModels ?? [] : [])] });
            });
            const automaticTarget = params.automaticTarget;
            const automaticIndex = automaticTarget === undefined ? 0 : params.targets.findIndex(target =>
                automaticTarget !== null && buildBackendTargetKeyV2(target.backendTarget) === buildBackendTargetKeyV2(automaticTarget));
            return { items: [], scmDiffSummaryCatalog: { profiles: byTarget.flat(), automaticProfiles: byTarget[automaticIndex] ?? [],
                discoveryTargetKeys: params.targets.map(target => buildBackendTargetKeyV2(target.backendTarget)) } };
        } });
    const paths = ['/v1/machines', '/v1/machines/read-batch', bindExternalActionExecutionAuthorizationHttpPathV1(MODEL_CATALOG_ACTION_ID),
        `/v1/actions/${MODEL_CATALOG_ACTION_ID}`] as const;
    return {
        paths, handle: boundary.handle, machine: boundary.machine,
        /** Answers these paths on a `homeGovernanceHarness` Home. */
        installOn(homes: HomeGovernanceHarness, homeId: string) {
            for (const path of paths) homes.answer(homeId, path, { select: async input => {
                const response = await boundary.handle(new URL(path, params.serverUrl),
                    input === undefined ? undefined : { method: 'POST', body: JSON.stringify(input) });
                if (!response) throw new Error(`Unexpected Summary model catalog path: ${path}`);
                return { body: await response.json() };
            } });
        },
    };
}
