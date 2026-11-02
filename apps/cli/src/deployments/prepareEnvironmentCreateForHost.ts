import { DeploymentEnvironmentCreateInputV1Schema,
    type ActionExecutorContext, type DeploymentEnvironmentCreateInputV1,
    type DeploymentEnvironmentCreateIntentInputV1 } from '@happier-dev/protocol';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ProjectSourceOwnerV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { DeploymentEnvironmentContentV1Schema, createOwnServerEnvironmentConfigurationV1, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1,
    DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, DeploymentOwnServerTargetLinkContentV1Schema,
    type DeploymentNativeComposeOriginV1 } from '@happier-dev/deployment-protocol';
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
export { resolveEnvironmentCreateCopyForHost, type EnvironmentCreateCopyResolution,
    type EnvironmentCreateCopyHost } from './resolveEnvironmentCreateCopyForHost';

export type EnvironmentCreateRequest = Readonly<{ input: DeploymentEnvironmentCreateIntentInputV1; context: ActionExecutorContext;
    projectOwner: ProjectSourceOwnerV1; copy?: EnvironmentCreateCopyResolution;
    /** Captured on the target host, never an operand of the public create Action. */
    nativeOrigin?: DeploymentNativeComposeOriginV1 }>;
export type EnvironmentCreateHost = Readonly<{
    credentials: StoredCredentials;
    accountArtifacts?: ReturnType<typeof createCredentialedAccountArtifactStore>;
    serverHttpBaseUrl: string;
    assertCurrent(context: ActionExecutorContext): Promise<void>;
    resolveRequestHeaders: Parameters<typeof createPrepareEnvironmentContentForHost>[0]['resolveRequestHeaders'];
}>;

/** Called once by Action preparation after defaults resolve, never by the prepared storage carrier. */
export function createPrepareEnvironmentCreateForHost(host: EnvironmentCreateHost) {
    const artifacts = host.accountArtifacts ?? createCredentialedAccountArtifactStore(host.credentials);
    return async ({ input, context, projectOwner, copy, nativeOrigin }: EnvironmentCreateRequest): Promise<DeploymentEnvironmentCreateInputV1 | ActionExecuteFailure> => {
        try {
            await host.assertCurrent(context);
            context.signal?.throwIfAborted();
            // These are reviewed values from the sole defaults preparer. Missing
            // values are not permission to resolve again during execution.
            if (input.copyFrom !== undefined && copy?.copyPlan === undefined || input.definition === undefined
                || input.controllerMachineId === undefined || input.retainPreviousDeployments === undefined
                || input.firstTargetLink !== undefined && input.buildMachineId === undefined) {
                return { ok: false, errorCode: 'client_required', error: 'client_required' };
            }
            const targetLinkContent = DeploymentOwnServerTargetLinkContentV1Schema.parse(nativeOrigin === undefined ? {} : { nativeOrigin });
            // Catalog materialization stays with the template composition at the creating Action owner.
            if (input.definition.from === 'catalogApp') return { ok: false, errorCode: 'client_required', error: 'client_required' };
            const definition = input.definition.from === 'repository'
                ? { kind: 'repository' as const, ref: input.definition.ref, compose: input.definition.compose }
                : await normalizeStoredComposeDefinitionInput(input.definition);
            const content = DeploymentEnvironmentContentV1Schema.parse({ name: input.name,
                retainPreviousDeployments: input.retainPreviousDeployments, definition, bindings: [],
                ownServer: copy?.content?.ownServer ?? createOwnServerEnvironmentConfigurationV1() });
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
            const prepared = DeploymentEnvironmentCreateInputV1Schema.parse({ serverId: input.serverId,
                projectSourceId: input.projectSourceId, newProject: input.newProject, requestKey: input.requestKey, protection: input.protection,
                purpose: input.purpose, deployerMode: input.deployerMode,
                ...(input.deployerPrincipals === undefined ? {} : { deployerPrincipals: input.deployerPrincipals }),
                controllerMachineId: input.controllerMachineId,
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
