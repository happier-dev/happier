import axios from '@/api/client/credentialAxios';
import { $ZodError } from 'zod/v4/core';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { buildDeploymentTargetLinkInputV1, createDeploymentLinkContentArtifactIdV1, DeploymentTargetLinksListResultV1Schema,
    type DeploymentTargetLinkInputV1, type DeploymentTargetLinkAlreadyLinkedResultV1,
    type DeploymentTargetLinkIntentInputV1, type DeploymentTargetLinkProviderIntentInputV1,
    type DeploymentEnvironmentGetResultV1Schema, type ActionExecutorContext } from '@happier-dev/protocol';
import { DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { findExistingDeploymentTargetLinkV1 } from '@happier-dev/deployments';
import type { createCredentialedAccountArtifactStore, ArtifactRequestAuthorizationHeaders } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createDeploymentArtifactForHost } from './createArtifactForHost';
import { normalizeDeploymentTargetLinkOriginV1 } from '@happier-dev/protocol/deployments/targetLinkInput';
import { readDeploymentTargetLinkArtifactV1 } from '@happier-dev/deployment-protocol';

type LinkIntent = (DeploymentTargetLinkIntentInputV1 & { provider?: never; contentArtifactId?: never })
    | (DeploymentTargetLinkProviderIntentInputV1 & { contentArtifactId?: never })
    | (DeploymentTargetLinkInputV1 & { provider?: never });

type PreparationStep = 'admission' | 'environment_read' | 'provider_links_read' | 'provider_links_compare'
    | 'provider_content_read' | 'provider_content_compare' | 'content_publish' | 'prepared_input';

/** Retain the original refusal for its owner; expose only closed diagnostic facts. */
export class TargetLinkPreparationError extends Error {
    readonly reason: 'invalid_payload' | 'content_unavailable' | 'dependency_failed';
    constructor(readonly step: PreparationStep, cause: unknown) {
        super('target_link_preparation_failed', { cause });
        this.reason = cause instanceof $ZodError ? 'invalid_payload'
            : cause instanceof Error && 'code' in cause && cause.code === 'deployment_content_unavailable'
                ? 'content_unavailable' : 'dependency_failed';
    }
}

/** The admitted link Action authors private content; the existing storage writer owns association/CAS. */
export async function prepareTargetLinkForHost(request: Readonly<{ input: LinkIntent; context: ActionExecutorContext;
        /** In-process Create acknowledgment, never a field accepted from Link input. */
        acknowledgedCreate?: boolean }>,
    host: Readonly<{
        serverHttpBaseUrl: string;
        artifacts: ReturnType<typeof createCredentialedAccountArtifactStore>;
        readMetadata(request: Readonly<{ environmentId: string; context: ActionExecutorContext }>):
            Promise<Extract<ReturnType<typeof DeploymentEnvironmentGetResultV1Schema.parse>, { ok: true }>>;
        assertCurrent(context: ActionExecutorContext): Promise<void>;
        artifactAuthorization(context: ActionExecutorContext): ArtifactRequestAuthorizationHeaders;
    }>,
): Promise<DeploymentTargetLinkInputV1 | DeploymentTargetLinkAlreadyLinkedResultV1> {
    const { context } = request;
    const input: LinkIntent = request.input.provider !== undefined && !request.acknowledgedCreate
        ? { ...request.input, provider: normalizeDeploymentTargetLinkOriginV1(request.input.provider) } : request.input;
    let step: PreparationStep = 'admission';
    try {
        await host.assertCurrent(context);
        step = 'environment_read';
        const current = await host.readMetadata({ environmentId: input.environmentId, context });
        const provider = input.provider;
        let content = provider ?? {};
        let title = 'title' in input ? input.title ?? '' : '';
        if (input.contentArtifactId !== undefined) {
            step = 'provider_content_read';
            const opened = readDeploymentTargetLinkArtifactV1(input,
                await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => host.artifacts.read(input.contentArtifactId, {
                    signal: context.signal, prepareRecipients: false, includeSharedAudience: false,
                    authorizationHeaders: host.artifactAuthorization(context) })));
            if (!opened.ok) throw createActionExecuteFailureError({ ok: false, errorCode: opened.error, error: opened.error });
            if (opened.content.providerResourceOrigin === undefined) return input;
            content = normalizeDeploymentTargetLinkOriginV1(opened.content);
            title = opened.title;
        }
        if (input.provider !== undefined) {
            const existing = await findExistingDeploymentTargetLinkV1(input, {
                async list(selection, cursor) {
                    step = 'provider_links_read';
                    const path = '/v1/deployments/targets/list';
                    const body = { serverId: input.serverId, scope: current.environment.owner, selection, ...(cursor ? { cursor } : {}) };
                    const response = await axios.request({ method: 'POST', url: new URL(path, host.serverHttpBaseUrl).href,
                        data: body, signal: context.signal, validateStatus: () => true,
                        headers: await host.artifactAuthorization(context)({ method: 'POST', path, body }) });
                    const page = DeploymentTargetLinksListResultV1Schema.parse(response.data);
                    step = 'provider_links_compare';
                    return page;
                },
                async artifact(targetLink) {
                    step = 'provider_content_read';
                    const artifact = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => host.artifacts.read(targetLink.contentArtifactId, {
                        signal: context.signal, prepareRecipients: false, includeSharedAudience: false,
                        authorizationHeaders: host.artifactAuthorization(context) }));
                    step = 'provider_content_compare';
                    return artifact;
                },
            });
            if (existing) return existing;
        }
        step = 'content_publish';
        const binding = context.externalActionExecutionAuthorization?.binding;
        const admission = binding?.deploymentLinkAdmission;
        if (binding?.actionId === 'deployments.targets.link' && !admission) {
            throw createActionExecuteFailureError({ ok: false, errorCode: 'deployment_content_unavailable', error: 'deployment_content_unavailable' });
        }
        const created = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => createDeploymentArtifactForHost({
            artifacts: host.artifacts, owner: current.environment.owner, assertCurrent: () => host.assertCurrent(context), publication: 'create',
            content: { ...(binding?.actionId === 'deployments.targets.link' && admission
                    ? { artifactId: createDeploymentLinkContentArtifactIdV1({ ...binding, deploymentLinkAdmission: admission }) } : {}),
        header: { kind: DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, title },
                body: JSON.stringify(content), signal: context.signal,
                beforeWrite: () => host.assertCurrent(context), authorizationHeaders: host.artifactAuthorization(context) },
        }));
        step = 'prepared_input';
        return buildDeploymentTargetLinkInputV1(input, created);
    } catch (cause) {
        throw new TargetLinkPreparationError(step, cause);
    }
}
