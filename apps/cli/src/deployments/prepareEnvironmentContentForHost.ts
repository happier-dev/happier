import axios from '@/api/client/credentialAxios';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DeploymentEnvironmentGetInputV1Schema, DeploymentEnvironmentGetResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { omitDeploymentEnvironmentPrivateContentPatchV1 } from '@happier-dev/protocol/deployments/deploymentEnvironmentContentPatchV1';
import { applyEnvironmentSecretBindingsPatchV1 } from '@happier-dev/protocol/deployments/deploymentBindingPatchV1';
import type { ActionExecutorContext, DeploymentActionIdV1, DeploymentEnvironmentCreateInputV1,
    DeploymentEnvironmentUpdateInputV1 } from '@happier-dev/protocol';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readDeploymentEnvironmentArtifactV1, resolveDeploymentStoredDefinitionRevisionV1,
    applyOwnServerEnvironmentConfigurationPatchV1, reconcileDeploymentRemovedDataServicesV1,
    type DeploymentEnvironmentDefinitionV1 } from '@happier-dev/deployment-protocol';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { StoredCredentials } from '@/persistence';
import { admitStoredComposeDefinition, normalizeStoredComposeDefinitionInput } from '@/workspaces/projectSetup/nativeComposeSource';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { bindHomeDomainHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { admitPreviewEnvironmentForHost, preparePreviewForkEligibilityForHost } from './previewAdmissionForHost';
import type { DeploymentEnvironmentListInputV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { readDeploymentEnvironmentForHost } from './readEnvironmentForHost';
import { createDeploymentArtifactForHost } from './createArtifactForHost';
import { projectDeploymentFailure } from './deploymentFailure';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/artifacts/deploymentArtifactKindsV1';
import { createDeploymentEnvironmentContentArtifactIdV1,
    isDeploymentEnvironmentUpdateNativeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { readHostAdmittedReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';

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
    listEnvironments?(input: DeploymentEnvironmentListInputV1, context: ActionExecutorContext): Promise<unknown>;
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
                // Composed preparation uses the selected Environment's read Action.
                // A root writer retains its original create/update purpose.
                const admittedRoot = request.context.externalActionExecutionAuthorization?.binding.actionId;
                const metadataActionId = admittedRoot !== undefined && admittedRoot !== request.actionId
                    ? 'deployments.environments.get' : request.actionId;
                const headers = await host.resolveRequestHeaders(request.context, metadataActionId, wire);
                if (!headers) throw Object.assign(new Error('action_forbidden'), { code: 'action_forbidden' });
                const response = await axios.request<unknown>({ method: wire.method, url: `${host.serverHttpBaseUrl}${wire.path}`,
                    headers, signal: request.context.signal, validateStatus: () => true });
                const loaded = DeploymentEnvironmentGetResultV1Schema.parse(response.data);
                if (!loaded.ok) throw Object.assign(new Error(loaded.error), { code: loaded.error });
                return loaded;
            };
            const artifact = await open(request.input.contentArtifactId);
            let candidate = readDeploymentEnvironmentArtifactV1(request.input, artifact);
            if (!candidate.ok) return projectDeploymentFailure(candidate.error, candidate);
            // Create cannot bypass the existing binding and backup update writers,
            // including in E2EE mode where the server cannot inspect these leaves.
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
            const updateInput = request.actionId === 'deployments.environments.update' && 'environmentId' in request.input
                ? request.input : undefined;
            const storagePatch = updateInput ? omitDeploymentEnvironmentPrivateContentPatchV1(updateInput.patch ?? {}) : undefined;
            const hasPrivatePatch = updateInput !== undefined && !isDeepStrictEqual(updateInput.patch ?? {}, storagePatch);
            let previousDefinition: DeploymentEnvironmentDefinitionV1 | undefined;
            const definitionInput = updateInput?.patch?.definition;
            let preparedContent: Readonly<{ input: DeploymentEnvironmentUpdateInputV1;
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
                if (!previous.ok) return projectDeploymentFailure(previous.error, previous);
                previousDefinition = previous.content.definition;
                let desiredTemplate = previous.content.template;
                let desiredOwnServer = previous.content.ownServer;
                let desiredPreviewTemplate = previous.content.previewTemplate;
                const bindingPatch = request.input.patch?.bindings;
                if (bindingPatch?.set.some(binding => binding.source.kind === 'secret' && binding.source.ref === 'person_selects'))
                    return { ok: false, errorCode: 'client_required', error: 'client_required' };
                const desiredBindings = bindingPatch ? applyEnvironmentSecretBindingsPatchV1(previous.content.bindings,
                    { set: bindingPatch.set, remove: bindingPatch.remove }, randomUUID)
                    : previous.content.bindings;
                if (bindingPatch) {
                    if (!currentReference) return { ok: false, errorCode: 'deployment_invalid', error: 'deployment_invalid' };
                    candidate = { ...candidate, content: { ...candidate.content, bindings: desiredBindings } };
                    preparedContent = { input: request.input, owner: loaded.environment.owner };
                }
                const ingress = request.input.patch?.ingress;
                const desiredIngress = ingress === undefined ? previous.content.ingress : ingress ?? undefined;
                if (!isDeepStrictEqual(candidate.content.ingress, desiredIngress)) {
                    if (!currentReference || ingress === undefined) return { ok: false, errorCode: 'deployment_invalid',
                        error: 'deployment_invalid (deployment.environment.ingress_content_mismatch)',
                        details: { requiredFact: 'preparedEnvironmentIngress' } };
                    candidate = { ...candidate, content: { ...candidate.content, ingress: desiredIngress } };
                    preparedContent = { input: request.input, owner: loaded.environment.owner };
                }
                if (definitionInput !== undefined) {
                    if (!currentReference) return { ok: false, errorCode: 'deployment_invalid', error: 'deployment_invalid' };
                    const definition = await normalizeStoredComposeDefinitionInput(definitionInput);
                    const contentRevision = resolveDeploymentStoredDefinitionRevisionV1(previousDefinition, definition);
                    if (contentRevision === null) return { ok: false, errorCode: 'deployment_conflict', error: 'deployment_conflict' };
                    const desiredDefinition = { ...definition, contentRevision };
                    if (!isDeepStrictEqual(candidate.content.definition, desiredDefinition)) {
                        candidate = { ...candidate, content: await reconcileDeploymentRemovedDataServicesV1(candidate.content, desiredDefinition) };
                        desiredTemplate = candidate.content.template;
                        desiredOwnServer = candidate.content.ownServer;
                        preparedContent = { input: request.input, owner: loaded.environment.owner };
                    }
                }
                const desiredBackup = definitionInput === undefined ? previous.content.backup : candidate.content.backup;
                const ownServerPatch = request.input.patch?.ownServer;
                if (ownServerPatch) {
                    desiredOwnServer = applyOwnServerEnvironmentConfigurationPatchV1(desiredOwnServer, ownServerPatch);
                    if (!isDeepStrictEqual(candidate.content.ownServer, desiredOwnServer)) {
                        if (!currentReference) return { ok: false, errorCode: 'deployment_invalid', error: 'deployment_invalid' };
                        candidate = { ...candidate, content: { ...candidate.content, ownServer: desiredOwnServer } };
                        preparedContent = { input: request.input, owner: loaded.environment.owner };
                    }
                }
                const retainedDeployments = request.input.patch?.retainPreviousDeployments;
                if (retainedDeployments !== undefined && candidate.content.retainPreviousDeployments !== retainedDeployments) {
                    if (!currentReference) return { ok: false, errorCode: 'deployment_invalid', error: 'deployment_invalid' };
                    candidate = { ...candidate, content: { ...candidate.content, retainPreviousDeployments: retainedDeployments } };
                    preparedContent = { input: request.input, owner: loaded.environment.owner };
                }
                const previewTemplate = request.input.patch?.previewTemplate;
                if (previewTemplate !== undefined) {
                    if (!currentReference) return { ok: false, errorCode: 'deployment_invalid', error: 'deployment_invalid' };
                    desiredPreviewTemplate = previewTemplate ?? undefined;
                    candidate = { ...candidate, content: { ...candidate.content, previewTemplate: desiredPreviewTemplate } };
                    preparedContent = { input: request.input, owner: loaded.environment.owner };
                }
                if (desiredPreviewTemplate?.enabled && desiredPreviewTemplate.forkPreviews === 'approveEachCommit') {
                    const forkEligibility = await preparePreviewForkEligibilityForHost({ serverId: request.input.serverId,
                        protection: request.input.patch?.protection ?? loaded.environment.protection,
                        buildMachineId: request.input.patch?.buildMachineId ?? loaded.environment.buildMachineId,
                        runtime: loaded.targetLinks.find(link => link.id === desiredPreviewTemplate.runtimeTargetLinkId) },
                    input => host.listEnvironments ? host.listEnvironments(input, request.context) : Promise.resolve(null));
                    if (forkEligibility.kind !== 'eligible') return { ok: false, errorCode: 'deployment_access_denied',
                        error: 'deployment_access_denied', details: { forkEligibility } };
                }
                // This check owns opened content in both Account modes. An E2EE
                // server cannot inspect this private leaf on the client's behalf.
                if (!isDeepStrictEqual(desiredTemplate, candidate.content.template)
                    || !isDeepStrictEqual(desiredOwnServer, candidate.content.ownServer)
                    || !isDeepStrictEqual(desiredPreviewTemplate, candidate.content.previewTemplate)
                    || !isDeepStrictEqual(previous.content.previewProvenance, candidate.content.previewProvenance)
                    || !isDeepStrictEqual(desiredBackup, candidate.content.backup)
                    || !isDeepStrictEqual(desiredBindings, candidate.content.bindings))
                    return { ok: false, errorCode: 'deployment_invalid', error: 'deployment_invalid' };
                // Signed private authoring must publish its invocation's Artifact,
                // including when the selected content is already current.
                if (request.context.externalActionExecutionAuthorization && hasPrivatePatch) {
                    preparedContent = { input: request.input, owner: loaded.environment.owner };
                }
            }
            // Authored source already passed the same admission and revision owners above.
            if (candidate.content.definition.kind === 'stored' && definitionInput === undefined) {
                if (candidate.content.definition.contentRevision !== resolveDeploymentStoredDefinitionRevisionV1(previousDefinition, candidate.content.definition)) {
                    return { ok: false, errorCode: 'deployment_conflict', error: 'deployment_conflict' };
                }
                await admitStoredComposeDefinition(candidate.content.definition);
            }
            request.context.signal?.throwIfAborted();
            let preparedInput = hasPrivatePatch ? updateInput : undefined;
            const binding = request.context.externalActionExecutionAuthorization?.binding;
            const child = readHostAdmittedReviewedChildV1(request.context);
            const native = child?.actionId === request.actionId ? child.deploymentNativeAdmission : binding?.deploymentNativeAdmission;
            if (preparedContent) {
                const prepared = preparedContent;
                const content = candidate.content;
                if (binding && (binding.actionId !== request.actionId && child?.actionId !== request.actionId
                    || !isDeploymentEnvironmentUpdateNativeAdmissionV1(native)
                    || native.environmentId !== prepared.input.environmentId)) return { ok: false,
                    errorCode: 'action_forbidden', error: 'action_forbidden (deployment.environment.ingress_admission_missing)',
                    details: { requiredFact: 'admittedEnvironmentIngress' } };
                const created = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => createDeploymentArtifactForHost({
                    artifacts, owner: prepared.owner, publication: 'create',
                    assertCurrent: async () => { request.context.signal?.throwIfAborted(); },
                    content: { ...(binding && isDeploymentEnvironmentUpdateNativeAdmissionV1(native) ? {
                        artifactId: createDeploymentEnvironmentContentArtifactIdV1({ ...binding, environmentId: native.environmentId }),
                    } : {}), header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: content.name },
                        body: JSON.stringify(content), signal: request.context.signal,
                        beforeWrite: async () => { request.context.signal?.throwIfAborted(); },
                        authorizationHeaders: async transport => {
                            const headers = await host.resolveRequestHeaders(request.context, request.actionId, transport);
                            if (!headers) throw Object.assign(new Error('action_forbidden'), { code: 'action_forbidden' });
                            return headers;
                        } },
                }));
                preparedInput = { ...prepared.input, contentArtifactId: created.artifactId,
                    contentHeaderVersion: created.revision.headerVersion, contentBodyVersion: created.revision.bodyVersion };
            }
            if (preparedInput) {
                return { input: { ...preparedInput, patch: storagePatch ?? {} },
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
