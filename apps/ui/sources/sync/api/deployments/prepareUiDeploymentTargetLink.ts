import { buildDeploymentTargetLinkInputV1, DeploymentTargetLinksListResultV1Schema,
    type DeploymentTargetLinkAlreadyLinkedResultV1, type DeploymentTargetLinkInputV1, type DeploymentTargetLinkIntentInputV1,
    type DeploymentTargetLinkProviderIntentInputV1,
    type DeploymentEnvironmentGetResultV1Schema} from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { type ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, findExistingDeploymentTargetLinkV1 } from '@happier-dev/deployment-protocol';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { requestHomeDomain } from '@/sync/api/home/homeServerActionTransport';
import { homeDomainFailureCode } from '@/sync/api/home/homeDomainActions';
import { shareDeploymentContentWithOwner } from './shareDeploymentContentWithOwner';

/** Content is authored by the admitted parent, never by a second Artifact Action. */
export async function prepareUiDeploymentTargetLink(account: LazyActionAccountContext,
    input: DeploymentTargetLinkIntentInputV1 | DeploymentTargetLinkProviderIntentInputV1, context: ActionExecutorContext,
    current: Extract<ReturnType<typeof DeploymentEnvironmentGetResultV1Schema.parse>, { ok: true }>,
): Promise<DeploymentTargetLinkInputV1 | DeploymentTargetLinkAlreadyLinkedResultV1> {
    const provider = 'provider' in input ? input.provider : undefined;
    if ('provider' in input) {
        const existing = await findExistingDeploymentTargetLinkV1(input, {
            async list(selection, cursor) {
                const response = await requestHomeDomain({ scope: account.accountLifetime.scope,
                    path: '/v1/deployments/targets/list', method: 'POST', effect: 'read', signal: context.signal,
                    input: { serverId: account.serverIdentityId ?? account.serverId, scope: current.environment.owner, selection,
                        ...(cursor ? { cursor } : {}) }, schema: DeploymentTargetLinksListResultV1Schema,
                    requestAuthority: { request: account.request, assertCurrent: () => account.assertResultCurrent('read') } });
                if (!response.ok) {
                    const code = homeDomainFailureCode(response.failure);
                    throw Object.assign(new Error(code), { code, details: response.failure.details });
                }
                return response.value;
            },
            artifact: link => account.readArtifactContent(link.contentArtifactId, { signal: context.signal }),
        });
        if (existing) return existing;
    }
    const created = await account.createArtifactDocument({
        header: { kind: DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, title: '' },
        body: JSON.stringify(provider ?? {}), signal: context.signal,
    });
    await shareDeploymentContentWithOwner(account, created.artifactId, current.environment.owner, context.signal);
    return buildDeploymentTargetLinkInputV1(input, created);
}
