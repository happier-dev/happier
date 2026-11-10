import { DeploymentEnvironmentCreateInputV1Schema,
    type ActionExecutorContext, type DeploymentEnvironmentCreateInputV1,
    type DeploymentEnvironmentCreateIntentInputV1, type DeploymentTargetLinkHeaderV1 } from '@happier-dev/protocol';
import { DeploymentTargetLinkProviderContentV1Schema,
    type DeploymentTargetLinkProviderContentV1 } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
import type { DeploymentPreviewProvenanceV1 } from '@happier-dev/protocol/deployments/deploymentPreviewProvenanceV1';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ProjectSourceOwnerV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { DeploymentEnvironmentContentV1Schema, createOwnServerEnvironmentConfigurationV1, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1,
    DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, DeploymentOwnServerTargetLinkContentV1Schema,
    readDeploymentTargetLinkArtifactV1, type DeploymentNativeComposeOriginV1 } from '@happier-dev/deployment-protocol';
import { ArtifactEncryptionMaterialUnavailableError, createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { StoredCredentials } from '@/persistence';
import { normalizeStoredComposeDefinitionInput } from '@/workspaces/projectSetup/nativeComposeSource';
import type { createPrepareEnvironmentContentForHost } from './prepareEnvironmentContentForHost';
import { createDeploymentArtifactForHost } from './createArtifactForHost';
import type { EnvironmentCreateCopyResolution } from './resolveEnvironmentCreateCopyForHost';
import { deriveDeploymentEnvironmentCreateCommitmentV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { resolveCliAccountStorageContext } from '@/api/client/accountKvJsonTransport';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { admitPreviewEnvironmentForHost } from './previewAdmissionForHost';
import type { readDeploymentEnvironmentForHost } from './readEnvironmentForHost';
export { resolveEnvironmentCreateCopyForHost, type EnvironmentCreateCopyResolution,
    type EnvironmentCreateCopyHost } from './resolveEnvironmentCreateCopyForHost';

export type EnvironmentCreateRequest = Readonly<{ input: DeploymentEnvironmentCreateIntentInputV1; context: ActionExecutorContext;
    projectOwner: ProjectSourceOwnerV1; copy?: EnvironmentCreateCopyResolution;
    admittedPreview?: EnvironmentCreatePreviewResolution;
    /** Captured on the target host, never an operand of the public create Action. */
    nativeOrigin?: DeploymentNativeComposeOriginV1 }>;
export type EnvironmentCreateHost = Readonly<{
    credentials: StoredCredentials;
    accountArtifacts?: ReturnType<typeof createCredentialedAccountArtifactStore>;
    serverHttpBaseUrl: string;
    assertCurrent(context: ActionExecutorContext): Promise<void>;
    resolveRequestHeaders: Parameters<typeof createPrepareEnvironmentContentForHost>[0]['resolveRequestHeaders'];
    readPreviewTemplate?(request: Readonly<{ environmentId: string; context: ActionExecutorContext }>):
        ReturnType<typeof readDeploymentEnvironmentForHost>;
}>;
export type EnvironmentCreatePreviewResolution = Readonly<{
    input: DeploymentEnvironmentCreateIntentInputV1; provenance?: DeploymentPreviewProvenanceV1;
    dataTargetLinks?: readonly Readonly<{ targetLink: DeploymentTargetLinkHeaderV1; content: DeploymentTargetLinkProviderContentV1 }>[];
}>;

/** One template admission supplies both omitted creation values and exact private PR provenance. */
export async function resolveEnvironmentCreatePreviewForHost(
    { input, context }: Readonly<{ input: DeploymentEnvironmentCreateIntentInputV1; context: ActionExecutorContext }>,
    host: EnvironmentCreateHost,
): Promise<EnvironmentCreatePreviewResolution | ActionExecuteFailure> {
    if (!input.preview) return { input };
    const refuse = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
    if (!host.readPreviewTemplate) return refuse('client_required');
    const preview = input.preview;
    if (preview.provenance.templateEnvironmentId !== preview.templateEnvironmentId
        || preview.provenance.pullRequestId !== preview.pullRequestId
        || preview.provenance.runtimeTargetLinkId !== preview.runtimeTargetLinkId) return refuse('deployment_invalid');
    try {
        await host.assertCurrent(context);
        context.signal?.throwIfAborted();
        const template = await host.readPreviewTemplate({ environmentId: preview.templateEnvironmentId, context });
        await admitPreviewEnvironmentForHost({ content: { previewProvenance: preview.provenance },
            templateEnvironmentId: preview.templateEnvironmentId, expectedTemplateRevision: preview.expectedTemplateRevision,
            projectSourceId: input.projectSourceId }, { readTemplate: async () => template });
        const runtime = template.targetLinks.find(link => link.id === preview.runtimeTargetLinkId);
        if (!runtime || runtime.environmentId !== template.environment.id || runtime.role !== 'runtime') return refuse('target_mismatch');
        if (template.content.definition.kind !== 'repository' || runtime.source.kind !== 'host'
            || runtime.source.id !== 'own-server' || runtime.targetKind !== 'ownServer') return refuse('unsupported_action');
        const dataTargetLinks: NonNullable<EnvironmentCreatePreviewResolution['dataTargetLinks']>[number][] = [];
        const artifacts = host.accountArtifacts ?? createCredentialedAccountArtifactStore(host.credentials);
        const selectedIds = new Set<string>();
        for (const selection of template.content.previewTemplate!.data) {
            if (selection.kind !== 'managed') return refuse('unsupported_action');
            if (selectedIds.has(selection.dataTargetLinkId)) return refuse('deployment_invalid');
            selectedIds.add(selection.dataTargetLinkId);
            const targetLink = template.targetLinks.find(link => link.id === selection.dataTargetLinkId);
            if (!targetLink || targetLink.environmentId !== template.environment.id || targetLink.role !== 'data'
                || targetLink.source.kind !== 'plugin' || targetLink.deletedAtMs !== undefined || targetLink.detachedAtMs !== undefined)
                return refuse('target_mismatch');
            const artifact = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => artifacts.read(targetLink.contentArtifactId, {
                signal: context.signal, prepareRecipients: false, includeSharedAudience: false,
                authorizationHeaders: async transport => {
                    const headers = await host.resolveRequestHeaders(context, 'deployments.environments.create', transport);
                    if (!headers) throw Object.assign(new Error('action_forbidden'), { code: 'action_forbidden' });
                    return headers;
                },
            }));
            const opened = readDeploymentTargetLinkArtifactV1(targetLink, artifact);
            if (!opened.ok) return refuse(opened.error);
            const provider = DeploymentTargetLinkProviderContentV1Schema.safeParse(opened.content);
            if (!provider.success) return refuse('deployment_content_unavailable');
            dataTargetLinks.push({ targetLink, content: provider.data });
        }
        return { input: { ...input, name: `pr-${preview.provenance.pullRequestNumber}`,
            definition: { from: 'repository', ref: preview.headSha, compose: template.content.definition.compose },
            firstTargetLink: { machines: runtime.members.map(member => ({ machineId: member.machineId, installationId: member.installationId })) },
            controllerMachineId: template.environment.controllerMachineId,
            ...(template.environment.buildMachineId === undefined ? {} : { buildMachineId: template.environment.buildMachineId }) },
            provenance: preview.provenance, dataTargetLinks };
    } catch (error) {
        return refuse(context.signal?.aborted ? 'cancelled' : error instanceof Error && 'code' in error
            && typeof error.code === 'string' ? error.code : 'deployment_content_unavailable');
    }
}

/** Called once by Action preparation after defaults resolve, never by the prepared storage carrier. */
export function createPrepareEnvironmentCreateForHost(host: EnvironmentCreateHost) {
    const artifacts = host.accountArtifacts ?? createCredentialedAccountArtifactStore(host.credentials);
    return async ({ input, context, projectOwner, copy, nativeOrigin, admittedPreview }: EnvironmentCreateRequest): Promise<DeploymentEnvironmentCreateInputV1 | ActionExecuteFailure> => {
        try {
            await host.assertCurrent(context);
            context.signal?.throwIfAborted();
            const preview = admittedPreview ?? await resolveEnvironmentCreatePreviewForHost({ input, context }, host);
            if ('errorCode' in preview) return preview;
            if (preview.provenance) input = { ...input, name: preview.input.name, definition: preview.input.definition,
                controllerMachineId: preview.input.controllerMachineId,
                ...(preview.input.buildMachineId === undefined ? {} : { buildMachineId: preview.input.buildMachineId }),
                firstTargetLink: preview.input.firstTargetLink };
            // These are reviewed values from the sole defaults preparer. Missing
            // values are not permission to resolve again during execution.
            if (input.copyFrom !== undefined && copy?.copyPlan === undefined || input.definition === undefined
                || input.controllerMachineId === undefined || input.retainPreviousDeployments === undefined
                || input.firstTargetLink !== undefined && input.buildMachineId === undefined) {
                const { actionInputIssueFailure } = await import('@happier-dev/protocol/actions/executor/actionInputValidation');
                const missing = [
                    ...(input.copyFrom !== undefined && copy?.copyPlan === undefined ? ['copyFrom'] : []),
                    ...(input.definition === undefined ? ['definition'] : []),
                    ...(input.controllerMachineId === undefined ? ['controllerMachineId'] : []),
                    ...(input.retainPreviousDeployments === undefined ? ['retainPreviousDeployments'] : []),
                    ...(input.firstTargetLink !== undefined && input.buildMachineId === undefined ? ['buildMachineId'] : []),
                ];
                return actionInputIssueFailure(...missing.map(field => ({ code: 'custom', path: [field] })));
            }
            const targetLinkContent = DeploymentOwnServerTargetLinkContentV1Schema.parse(preview.provenance || nativeOrigin === undefined ? {} : { nativeOrigin });
            // Catalog materialization stays with the template composition at the creating Action owner.
            if (input.definition.from === 'catalogApp') return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
            const definition = input.definition.from === 'repository'
                ? { kind: 'repository' as const, ref: input.definition.ref, compose: input.definition.compose }
                : await normalizeStoredComposeDefinitionInput(input.definition);
            const content = DeploymentEnvironmentContentV1Schema.parse({ name: input.name,
                retainPreviousDeployments: input.retainPreviousDeployments, definition, bindings: [],
                ownServer: copy?.content?.ownServer ?? createOwnServerEnvironmentConfigurationV1(),
                ...(preview.provenance === undefined ? {} : { previewProvenance: preview.provenance,
                    ...(context.executionRunWorkflowRunId ? { previewCreationRunId: context.executionRunWorkflowRunId } : {}) }) });
            let copyIntentCommitment: string | undefined;
            if (input.copyFrom !== undefined) {
                const requester = readRequesterAccountActionContext(context.externalActionExecutionAuthorization);
                const credentials = context.externalActionExecutionAuthorization ? requester?.credentials : host.credentials;
                const accountId = requester?.authorization.binding.accountId ?? (credentials && readAccountIdFromToken(credentials.token));
                if (!credentials || !accountId) return { ok: false, errorCode: 'client_required', error: 'client_required' };
                const authorizationHeaders = await host.resolveRequestHeaders(context, 'deployments.environments.create',
                    { method: 'GET', path: '/v1/account/encryption/currentness' });
                if (!authorizationHeaders) return { ok: false, errorCode: 'action_forbidden', error: 'action_forbidden' };
                const storage = await resolveCliAccountStorageContext({ credentials, serverBaseUrl: host.serverHttpBaseUrl,
                    authorizationHeaders, signal: context.signal, usage: 'fresh-authority' });
                const { mode: _presentationMode, ...resolvedInput } = input;
                copyIntentCommitment = deriveDeploymentEnvironmentCreateCommitmentV1({ accountId, mode: storage.mode,
                    material: storage.material, intent: projectNativeJsonValueForTransport({ input: resolvedInput,
                        content, projectOwner, targetLinkContent, copyPlan: copy!.copyPlan }) });
            }
            const createContent = async (kind: typeof DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 | typeof DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1,
                body: unknown) => {
                const created = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => createDeploymentArtifactForHost({
                    artifacts, owner: projectOwner, assertCurrent: () => host.assertCurrent(context), content: {
                        header: { kind, title: input.name }, body: JSON.stringify(body), signal: context.signal,
                        beforeWrite: () => host.assertCurrent(context),
                        authorizationHeaders: async transport => {
                            const headers = await host.resolveRequestHeaders(context, 'deployments.environments.create', transport);
                            if (!headers) throw Object.assign(new Error('action_forbidden'), { code: 'action_forbidden' });
                            return headers;
                        },
                } }));
                return { contentArtifactId: created.artifactId, contentHeaderVersion: created.revision.headerVersion,
                    contentBodyVersion: created.revision.bodyVersion };
            };
            const previewDataTargetLinks: NonNullable<DeploymentEnvironmentCreateInputV1['previewDataTargetLinks']> = [];
            for (const data of preview.dataTargetLinks ?? []) previewDataTargetLinks.push({
                templateDataTargetLinkId: data.targetLink.id, expectedTemplateTargetLinkRevision: data.targetLink.revision,
                ...await createContent(DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, data.content),
            });
            const prepared = DeploymentEnvironmentCreateInputV1Schema.parse({ serverId: input.serverId,
                projectSourceId: input.projectSourceId, newProject: input.newProject, requestKey: input.requestKey, protection: input.protection,
                purpose: input.purpose, deployerMode: input.deployerMode,
                ...(input.managedRetention === undefined ? {} : { managedRetention: input.managedRetention }),
                ...(input.deployerPrincipals === undefined ? {} : { deployerPrincipals: input.deployerPrincipals }),
                controllerMachineId: input.controllerMachineId,
                ...(input.preview === undefined ? {} : { preview: {
                    templateEnvironmentId: input.preview.templateEnvironmentId, expectedTemplateRevision: input.preview.expectedTemplateRevision,
                    pullRequestId: input.preview.pullRequestId, runtimeTargetLinkId: input.preview.runtimeTargetLinkId,
                } }),
                ...(previewDataTargetLinks.length ? { previewDataTargetLinks } : {}),
                ...(input.buildMachineId === undefined ? {} : { buildMachineId: input.buildMachineId }),
                ...(input.copyFrom === undefined ? {} : { copyFrom: input.copyFrom, copyPlan: copy!.copyPlan, copyIntentCommitment }),
                ...await createContent(DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, content),
                ...(input.firstTargetLink === undefined ? {} : { firstTargetLink: {
                    machines: input.firstTargetLink.machines,
                    ...await createContent(DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, targetLinkContent),
                } }),
            });
            await host.assertCurrent(context);
            context.signal?.throwIfAborted();
            return prepared;
        } catch (error) {
            const code = context.signal?.aborted ? 'cancelled' : error instanceof ArtifactEncryptionMaterialUnavailableError
                || error instanceof Error && 'code' in error && error.code === 'account_storage_currentness_unavailable' ? 'client_required'
                : error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'deployment_content_unavailable';
            return { ok: false, errorCode: code, error: code };
        }
    };
}
