import axios from '@/api/client/credentialAxios';
import { buildDeploymentTargetLinkInputV1, DeploymentTargetLinksListResultV1Schema,
    type DeploymentTargetLinkInputV1, type DeploymentTargetLinkAlreadyLinkedResultV1,
    type DeploymentTargetLinkIntentInputV1, type DeploymentTargetLinkProviderIntentInputV1,
    type DeploymentEnvironmentGetResultV1Schema, type ActionExecutorContext } from '@happier-dev/protocol';
import { DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, findExistingDeploymentTargetLinkV1 } from '@happier-dev/deployment-protocol';
import type { createCredentialedAccountArtifactStore, ArtifactRequestAuthorizationHeaders } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createDeploymentArtifactForHost } from './createArtifactForHost';

type LinkIntent = DeploymentTargetLinkIntentInputV1 | DeploymentTargetLinkProviderIntentInputV1;

/** The admitted link Action authors private content; the existing storage writer owns association/CAS. */
export async function prepareTargetLinkForHost(request: Readonly<{ input: LinkIntent; context: ActionExecutorContext }>,
    host: Readonly<{
        serverHttpBaseUrl: string;
        artifacts: ReturnType<typeof createCredentialedAccountArtifactStore>;
        readMetadata(request: Readonly<{ environmentId: string; context: ActionExecutorContext }>):
            Promise<Extract<ReturnType<typeof DeploymentEnvironmentGetResultV1Schema.parse>, { ok: true }>>;
        assertCurrent(context: ActionExecutorContext): Promise<void>;
        artifactAuthorization(context: ActionExecutorContext): ArtifactRequestAuthorizationHeaders;
    }>,
): Promise<DeploymentTargetLinkInputV1 | DeploymentTargetLinkAlreadyLinkedResultV1> {
    const { input, context } = request;
    await host.assertCurrent(context);
    const current = await host.readMetadata({ environmentId: input.environmentId, context });
    const provider = 'provider' in input ? input.provider : undefined;
    if ('provider' in input) {
        const existing = await findExistingDeploymentTargetLinkV1(input, {
            async list(selection, cursor) {
                const path = '/v1/deployments/targets/list';
                const body = { serverId: input.serverId, scope: current.environment.owner, selection, ...(cursor ? { cursor } : {}) };
                const response = await axios.request({ method: 'POST', url: new URL(path, host.serverHttpBaseUrl).href,
                    data: body, signal: context.signal, validateStatus: () => true,
                    headers: await host.artifactAuthorization(context)({ method: 'POST', path, body }) });
                return DeploymentTargetLinksListResultV1Schema.parse(response.data);
            },
            artifact: targetLink => runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => host.artifacts.read(targetLink.contentArtifactId, {
                signal: context.signal, prepareRecipients: false, includeSharedAudience: false,
                authorizationHeaders: host.artifactAuthorization(context) })),
        });
        if (existing) return existing;
    }
    const created = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => createDeploymentArtifactForHost({
        artifacts: host.artifacts, owner: current.environment.owner, assertCurrent: () => host.assertCurrent(context),
        content: { header: { kind: DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, title: '' },
            body: JSON.stringify(provider ?? {}), signal: context.signal,
            beforeWrite: () => host.assertCurrent(context), authorizationHeaders: host.artifactAuthorization(context) },
    }));
    return buildDeploymentTargetLinkInputV1(input, created);
}
