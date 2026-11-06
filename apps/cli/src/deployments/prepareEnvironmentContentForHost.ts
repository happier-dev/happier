import axios from '@/api/client/credentialAxios';
import { isDeepStrictEqual } from 'node:util';
import { DeploymentEnvironmentGetInputV1Schema, DeploymentEnvironmentGetResultV1Schema } from '@happier-dev/protocol';
import type { ActionExecutorContext, DeploymentActionIdV1, DeploymentEnvironmentCreateInputV1,
    DeploymentEnvironmentUpdateInputV1 } from '@happier-dev/protocol';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readDeploymentEnvironmentArtifactV1, resolveDeploymentStoredDefinitionRevisionV1,
    type DeploymentEnvironmentDefinitionV1 } from '@happier-dev/deployment-protocol';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { StoredCredentials } from '@/persistence';
import { admitStoredComposeDefinition } from '@/workspaces/projectSetup/nativeComposeSource';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { bindHomeDomainHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { admitPreviewEnvironmentForHost } from './previewAdmissionForHost';
import { readDeploymentEnvironmentForHost } from './readEnvironmentForHost';
import { createDeploymentArtifactForHost } from './createArtifactForHost';
import { projectDeploymentFailure } from './deploymentFailure';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/artifacts/deploymentArtifactKindsV1';
import { createDeploymentEnvironmentContentArtifactIdV1,
    isDeploymentEnvironmentUpdateNativeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';

export type DeploymentEnvironmentContentPreparation = Readonly<{
    actionId: 'deployments.environments.create' | 'deployments.environments.update';
    input: DeploymentEnvironmentCreateInputV1 | DeploymentEnvironmentUpdateInputV1;
    context: ActionExecutorContext;
}>;
export type DeploymentEnvironmentContentPreparationResult = ActionExecuteFailure | Readonly<{
    input: DeploymentEnvironmentUpdateInputV1;
    authoredInputDigest?: string;
}> | null;

/** Create/edit and deploy share P41's source policy; storage never parses Compose. */
export function createPrepareEnvironmentContentForHost(host: Readonly<{
    credentials: StoredCredentials;
    accountArtifacts?: ReturnType<typeof createCredentialedAccountArtifactStore>;
    serverHttpBaseUrl: string;
    resolveRequestHeaders(context: ActionExecutorContext, actionId: DeploymentActionIdV1,
        request: Readonly<{ method: string; path: string; body?: unknown }>):
        Readonly<Record<string, string>> | null | Promise<Readonly<Record<string, string>> | null>;
}>) {
    const artifacts = host.accountArtifacts ?? createCredentialedAccountArtifactStore(host.credentials);
    return async (request: DeploymentEnvironmentContentPreparation): Promise<DeploymentEnvironmentContentPreparationResult> => {
        try {
            request.context.signal?.throwIfAborted();
            const open = (id: string) => runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => artifacts.read(id, {
                signal: request.context.signal, prepareRecipients: false, includeSharedAudience: false,
                authorizationHeaders: async transport => {
                    const headers = await host.resolveRequestHeaders(request.context, request.actionId, transport);
                    if (!headers) throw Object.assign(new Error('action_forbidden'), { code: 'action_forbidden' });
                    return headers;
                },
            }));
            const readMetadata = async (environmentId: string) => {
                const transport = getActionSpec('deployments.environments.get').serverTransport;
                if (!transport) throw Object.assign(new Error('unsupported_action'), { code: 'unsupported_action' });
                const wire = bindHomeDomainHttpRequestV1({ transport, inputSchema: DeploymentEnvironmentGetInputV1Schema,
                    input: { serverId: request.context.externalActionExecutionAuthorization?.binding.serverIdentityId
                        ?? request.input.serverId, environmentId } });
                const headers = await host.resolveRequestHeaders(request.context, request.actionId, wire);
                if (!headers) throw Object.assign(new Error('action_forbidden'), { code: 'action_forbidden' });
                const response = await axios.request<unknown>({ method: wire.method, url: `${host.serverHttpBaseUrl}${wire.path}`,
                    headers, signal: request.context.signal, validateStatus: () => true });
                const loaded = DeploymentEnvironmentGetResultV1Schema.parse(response.data);
                if (!loaded.ok) throw Object.assign(new Error(loaded.error), { code: loaded.error });
                return loaded;
            };
            const artifact = await open(request.input.contentArtifactId);
            let candidate = readDeploymentEnvironmentArtifactV1(request.input, artifact);
            if (!candidate.ok) return { ok: false, errorCode: candidate.error, error: candidate.error };
            // Dedicated writers own bindings and backup configuration, including
            // in E2EE mode where the server cannot inspect these leaves.
            if (request.actionId === 'deployments.environments.create'
                && (candidate.content.bindings.length > 0 || candidate.content.backup !== undefined || candidate.content.ingress !== undefined))
                return { ok: false, errorCode: 'deployment_invalid', error: 'deployment_invalid' };
            if (request.actionId === 'deployments.environments.create' && 'purpose' in request.input
                && request.input.purpose === 'preview') {
                const preview = request.input.preview;
                if (!preview) return { ok: false, errorCode: 'deployment_invalid', error: 'deployment_invalid' };
                await admitPreviewEnvironmentForHost({ content: candidate.content,
                    templateEnvironmentId: preview.templateEnvironmentId, expectedTemplateRevision: preview.expectedTemplateRevision }, {
                    readTemplate: environmentId => readDeploymentEnvironmentForHost({ environmentId, context: request.context }, {
                        open: id => open(id), assertCurrent: async () => { request.context.signal?.throwIfAborted(); },
                        readMetadata: () => readMetadata(environmentId),
                    }),
                });
            }
            let previousDefinition: DeploymentEnvironmentDefinitionV1 | undefined;
            let preparedIngress: Readonly<{ input: DeploymentEnvironmentUpdateInputV1;
                owner: Awaited<ReturnType<typeof readMetadata>>['environment']['owner'] }> | undefined;
            if (request.actionId === 'deployments.environments.update' && 'environmentId' in request.input) {
                const loaded = await readMetadata(request.input.environmentId);
                if (loaded.environment.id !== request.input.environmentId || loaded.environment.revision !== request.input.expectedRevision)
                    return { ok: false, errorCode: 'deployment_conflict', error: 'deployment_conflict' };
                const currentReference = request.input.contentArtifactId === loaded.environment.contentArtifactId
                    && request.input.contentHeaderVersion === loaded.environment.contentHeaderVersion
                    && request.input.contentBodyVersion === loaded.environment.contentBodyVersion;
                const previous = currentReference ? candidate
                    : readDeploymentEnvironmentArtifactV1(loaded.environment, await open(loaded.environment.contentArtifactId));
                if (!previous.ok) return { ok: false, errorCode: previous.error, error: previous.error };
                previousDefinition = previous.content.definition;
                const ingress = request.input.patch?.ingress;
                const desiredIngress = ingress === undefined ? previous.content.ingress : ingress ?? undefined;
                if (!isDeepStrictEqual(candidate.content.ingress, desiredIngress)) {
                    if (!currentReference || ingress === undefined) return { ok: false, errorCode: 'deployment_invalid',
                        error: 'deployment_invalid (deployment.environment.ingress_content_mismatch)',
                        details: { requiredFact: 'preparedEnvironmentIngress' } };
                    candidate = { ...candidate, content: { ...previous.content, ingress: desiredIngress } };
                    preparedIngress = { input: request.input, owner: loaded.environment.owner };
                }
                // This check owns opened content in both Account modes. An E2EE
                // server cannot inspect this private leaf on the client's behalf.
                if (!isDeepStrictEqual(previous.content.template, candidate.content.template)
                    || !isDeepStrictEqual(previous.content.previewProvenance, candidate.content.previewProvenance)
                    || !isDeepStrictEqual(previous.content.backup, candidate.content.backup)
                    || !isDeepStrictEqual(previous.content.bindings, candidate.content.bindings))
                    return { ok: false, errorCode: 'deployment_invalid', error: 'deployment_invalid' };
            }
            if (candidate.content.definition.kind === 'stored') {
                if (candidate.content.definition.contentRevision !== resolveDeploymentStoredDefinitionRevisionV1(previousDefinition, candidate.content.definition)) {
                    return { ok: false, errorCode: 'deployment_conflict', error: 'deployment_conflict' };
                }
                await admitStoredComposeDefinition(candidate.content.definition);
            }
            request.context.signal?.throwIfAborted();
            if (preparedIngress) {
                const prepared = preparedIngress;
                const content = candidate.content;
                const binding = request.context.externalActionExecutionAuthorization?.binding;
                const native = binding?.deploymentNativeAdmission;
                if (binding && (binding.actionId !== request.actionId || !isDeploymentEnvironmentUpdateNativeAdmissionV1(native)
                    || native.environmentId !== prepared.input.environmentId)) return { ok: false,
                    errorCode: 'action_forbidden', error: 'action_forbidden (deployment.environment.ingress_admission_missing)',
                    details: { requiredFact: 'admittedEnvironmentIngress' } };
                const created = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => createDeploymentArtifactForHost({
                    artifacts, owner: prepared.owner, publication: 'create',
                    assertCurrent: async () => { request.context.signal?.throwIfAborted(); },
                    content: { ...(binding && isDeploymentEnvironmentUpdateNativeAdmissionV1(native) ? {
                        artifactId: createDeploymentEnvironmentContentArtifactIdV1({ ...binding, deploymentNativeAdmission: native }),
                    } : {}), header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: content.name },
                        body: JSON.stringify(content), signal: request.context.signal,
                        beforeWrite: async () => { request.context.signal?.throwIfAborted(); },
                        authorizationHeaders: async transport => {
                            const headers = await host.resolveRequestHeaders(request.context, request.actionId, transport);
                            if (!headers) throw Object.assign(new Error('action_forbidden'), { code: 'action_forbidden' });
                            return headers;
                        } },
                }));
                return { input: { ...prepared.input, contentArtifactId: created.artifactId,
                    contentHeaderVersion: created.revision.headerVersion, contentBodyVersion: created.revision.bodyVersion },
                    ...(isDeploymentEnvironmentUpdateNativeAdmissionV1(native) ? { authoredInputDigest: native.inputDigest } : {}) };
            }
            return null;
        } catch (error) {
            const code = request.context.signal?.aborted ? 'cancelled'
                : error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'deployment_content_unavailable';
            return projectDeploymentFailure(code, error);
        }
    };
}
