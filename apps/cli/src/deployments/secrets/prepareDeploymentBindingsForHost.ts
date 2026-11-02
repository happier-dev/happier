import axios from '@/api/client/credentialAxios';
import { isDeepStrictEqual } from 'node:util';
import { DeploymentBindingsSetInputV1Schema, DeploymentBindingsPreparedInputV1Schema, DeploymentEnvironmentGetResultV1Schema,
    DeploymentEnvironmentGetInputV1Schema, captureDeploymentBindingSavedSecretRevisionsV1,
    matchesDeploymentBindingSavedSecretCapturesV1, applyEnvironmentSecretBindingsPatchV1,
    EnvironmentSecretBindingV1Schema } from '@happier-dev/protocol';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { bindHomeDomainHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readDeploymentEnvironmentArtifactV1, isDeploymentEnvironmentBindingsOnlyUpdateV1,
    DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, type MachineSecretGrantV1 } from '@happier-dev/deployment-protocol';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { createCredentialedAccountArtifactStore, type ArtifactRequestAuthorizationHeaders } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import type { StoredCredentials } from '@/persistence';
import { readSavedSecretMaterializerForOperation } from '@/settings/secrets/savedSecretCatalogRead';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import type { DeploymentBindingPreparationRequestV1, PreparedDeploymentBindingStorageV1 } from '../createCliDeploymentActionDeps';
import { createDeploymentArtifactForHost } from '../createArtifactForHost';
import { prepareEnvironmentSecretBindings } from './environmentSecretBindingService';
import { assertDeploymentSecretInvocationCurrent, readEnvironmentSecretBindingPreparationForHost } from './readEnvironmentSecretLaunchAdmissionForHost';

const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };
function failure(error: unknown): ActionExecuteFailure {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code
        : error && typeof error === 'object' && 'data' in error && error.data && typeof error.data === 'object'
            && 'code' in error.data && typeof error.data.code === 'string' ? error.data.code : 'deployment_content_unavailable';
    return { ok: false, errorCode: code, error: code };
}
export { captureDeploymentBindingSavedSecretRevisionsV1 } from '@happier-dev/protocol';

/** Explicit author preparation only. P40's single bindings CAS remains the sole writer. */
export function createPrepareDeploymentBindingsForHost(host: Readonly<{
    credentials: StoredCredentials;
    accountArtifacts?: ReturnType<typeof createCredentialedAccountArtifactStore>;
    serverId: string;
    serverHttpBaseUrl: string;
    machineId: string;
    savedSecretOperationContext?: SavedSecretOperationContextV1;
}>) {
    const artifacts = host.accountArtifacts ?? createCredentialedAccountArtifactStore(host.credentials);
    return async (request: DeploymentBindingPreparationRequestV1):
        Promise<PreparedDeploymentBindingStorageV1 | ActionExecuteFailure> => runWithServerHttpBaseUrl(host.serverHttpBaseUrl, async () => {
        let admission: Awaited<ReturnType<typeof readEnvironmentSecretBindingPreparationForHost>> | undefined;
        try {
            const input = DeploymentBindingsSetInputV1Schema.parse(request.input);
            if ('set' in input && input.set.some(binding => binding.source.kind === 'secret'
                && binding.source.ref === 'person_selects')) return refuse('client_required');
            const { context } = request;
            if (input.serverId !== host.serverId) return refuse('target_mismatch');
            const assertAuthority = () => assertDeploymentSecretInvocationCurrent(context);
            const headers: ArtifactRequestAuthorizationHeaders = async transport => {
                await assertAuthority();
                const projection = context.externalActionExecutionAuthorization?.requesterHttpProjection;
                const authorized = projection ? await projection.createRequestHeaders({ ...transport,
                    effectActionId: request.buildMachineId ? 'deployments.environments.update' : 'deployments.bindings.set',
                    ...(context.signal ? { signal: context.signal } : {}) })
                    : { Authorization: `Bearer ${host.credentials.token}` };
                if (!authorized) return refuse('action_forbidden');
                return { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...authorized };
            };
            const storageServerId = context.externalActionExecutionAuthorization?.binding.serverIdentityId ?? host.serverId;
            const transport = getActionSpec('deployments.environments.get').serverTransport;
            if (!transport) return refuse('unsupported_action');
            const { path } = bindHomeDomainHttpRequestV1({ transport, inputSchema: DeploymentEnvironmentGetInputV1Schema,
                input: { serverId: storageServerId, environmentId: input.environmentId } });
            const response = await axios.request<unknown>({ method: 'GET', url: `${host.serverHttpBaseUrl}${path}`,
                headers: await headers({ method: 'GET', path }), signal: context.signal, maxRedirects: 0, validateStatus: () => true });
            await assertAuthority();
            const loaded = DeploymentEnvironmentGetResultV1Schema.parse(response.data);
            if (!loaded.ok) return refuse(loaded.error);
            if (response.status !== 200 || !loaded.environment.capabilities.manageBindings) return refuse('deployment_access_denied');
            if (loaded.environment.revision !== input.expectedRevision) return refuse('deployment_conflict');
            const targetLinkId = loaded.environment.runtimeTargetLinkId;
            const open = (id: string) => artifacts.read(id, { signal: context.signal, prepareRecipients: false,
                includeSharedAudience: false, authorizationHeaders: headers });
            const [currentArtifact, candidateArtifact] = await Promise.all([
                open(loaded.environment.contentArtifactId), 'contentArtifactId' in input ? open(input.contentArtifactId) : null,
            ]);
            const current = readDeploymentEnvironmentArtifactV1(loaded.environment, currentArtifact);
            if (!current.ok) return refuse(current.error);
            const candidate = 'set' in input ? { ok: true as const, content: { ...current.content,
                bindings: applyEnvironmentSecretBindingsPatchV1(current.content.bindings,
                    { set: input.set.map(binding => EnvironmentSecretBindingV1Schema.parse(binding)), remove: input.remove }) } }
                : readDeploymentEnvironmentArtifactV1(input, candidateArtifact);
            if (!candidate.ok) return refuse(candidate.error);
            if (request.buildMachineId ? !isDeepStrictEqual(current.content.bindings, candidate.content.bindings)
                : !isDeploymentEnvironmentBindingsOnlyUpdateV1(current.content, candidate.content)) return refuse('deployment_invalid');
            const selectedCaptures = captureDeploymentBindingSavedSecretRevisionsV1(candidate.content.bindings);
            if (!request.buildMachineId && 'referencedSavedSecretRevisions' in input
                && !matchesDeploymentBindingSavedSecretCapturesV1(selectedCaptures,
                input.referencedSavedSecretRevisions)) return refuse('deployment_invalid');
            const operation = readRequesterAccountActionContext(context.externalActionExecutionAuthorization)
                ?.savedSecretOperationContext ?? host.savedSecretOperationContext;
            const assertCurrent = async () => {
                await assertAuthority();
                if (operation && !await operation.isCurrent(context.signal)) return refuse('action_forbidden');
                await admission?.assertCurrent();
            };
            const complete = async (grants: readonly MachineSecretGrantV1[]): Promise<PreparedDeploymentBindingStorageV1> => {
                if ('contentArtifactId' in input) return { ...input, referencedSavedSecretRevisions: selectedCaptures, grants };
                // Authored changes join the same private candidate and sole server CAS
                // after current resource/installation custody has settled.
                await assertCurrent();
                const created = await createDeploymentArtifactForHost({ artifacts, owner: loaded.environment.owner, assertCurrent,
                    content: { header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: candidate.content.name },
                        body: JSON.stringify(candidate.content), signal: context.signal, beforeWrite: assertCurrent,
                        authorizationHeaders: headers } });
                await assertCurrent();
                return { ...DeploymentBindingsPreparedInputV1Schema.parse({ serverId: input.serverId,
                    environmentId: input.environmentId, expectedRevision: input.expectedRevision,
                    contentArtifactId: created.artifactId, contentHeaderVersion: created.revision.headerVersion,
                    contentBodyVersion: created.revision.bodyVersion, referencedSavedSecretRevisions: selectedCaptures }), grants };
            };
            if (candidate.content.bindings.length === 0 && current.content.bindings.length === 0) {
                await assertAuthority();
                return await complete([]);
            }
            if (!targetLinkId || !loaded.targetLinks.some(link => link.id === targetLinkId)) return refuse('deployment_unavailable');
            const identity = readInstallationIdentityIfExistsSync();
            if (!identity) return refuse('secret_missing');
            admission = await readEnvironmentSecretBindingPreparationForHost({ credentials: host.credentials,
                serverId: storageServerId, serverHttpBaseUrl: host.serverHttpBaseUrl, machineId: host.machineId,
                installationId: identity.installationId, environmentId: input.environmentId, targetLinkId,
                expectedRevision: input.expectedRevision, ...(request.buildMachineId ? { buildMachineId: request.buildMachineId } : {}),
                domainIds: [...new Set([...candidate.content.bindings, ...current.content.bindings].flatMap(binding =>
                    binding.purpose === 'domainCredential' ? [binding.domainId] : []))],
                context, signal: context.signal ?? new AbortController().signal });
            const retainedAdmission = admission;
            if (retainedAdmission.bindingPreparation.buildInstallation?.machineId !== loaded.environment.buildMachineId
                || request.buildMachineId && retainedAdmission.bindingPreparation.proposedBuildInstallation?.machineId !== request.buildMachineId) {
                return refuse('deployment_conflict');
            }
            const materializer = operation ? async () => {
                if (operation.credentials.token !== host.credentials.token || !await operation.isCurrent(context.signal)) return refuse('action_forbidden');
                const snapshot = operation.readSnapshot();
                if (!snapshot?.scopeKey) return refuse('client_required');
                const admitted = await readSavedSecretMaterializerForOperation({ expectedScopeKey: snapshot.scopeKey,
                    operationContext: operation, signal: context.signal, references: candidate.content.bindings.flatMap(binding =>
                        binding.source.kind === 'secret' ? [{ ref: binding.source.ref, revision: binding.source.resourceRevision }] : []) });
                return admitted.materializer;
            } : undefined;
            const decodeInstallation = (installation: typeof retainedAdmission.bindingPreparation.runtimeInstallations[number]) => ({
                ...installation, publicKey: decodeBase64(installation.publicKey, 'base64url'),
            });
            const buildInstallation = retainedAdmission.bindingPreparation.proposedBuildInstallation
                ?? retainedAdmission.bindingPreparation.buildInstallation;
            const domainDestinations = retainedAdmission.bindingPreparation.domainDestinations;
            const decodedDomainDestinations = domainDestinations ? { status: domainDestinations.status,
                domains: domainDestinations.domains.map(domain => ({ domainId: domain.domainId,
                    installations: domain.installations.map(decodeInstallation) })) } : undefined;
            const prepared = await prepareEnvironmentSecretBindings({ environmentId: input.environmentId,
                bindings: candidate.content.bindings, previousBindings: current.content.bindings,
                runtimeInstallations: retainedAdmission.bindingPreparation.runtimeInstallations.map(decodeInstallation),
                ...(buildInstallation ? { buildInstallation: decodeInstallation(buildInstallation) } : {}),
                ...(decodedDomainDestinations ? { domainDestinations: decodedDomainDestinations } : {}),
                ...(request.buildMachineId ? { previousDestinations: {
                    runtimeInstallations: retainedAdmission.bindingPreparation.runtimeInstallations.map(decodeInstallation),
                    ...(decodedDomainDestinations ? { domainDestinations: decodedDomainDestinations } : {}),
                    ...(retainedAdmission.bindingPreparation.buildInstallation
                        ? { buildInstallation: decodeInstallation(retainedAdmission.bindingPreparation.buildInstallation) } : {}),
                } } : {}),
                existingGrants: retainedAdmission.grants, materializer, assertCurrent });
            if (!matchesDeploymentBindingSavedSecretCapturesV1(selectedCaptures,
                prepared.referencedSavedSecretRevisions)) return refuse('deployment_invalid');
            return await complete(prepared.grants);
        } catch (error) { return failure(request.context.signal?.aborted ? { code: 'cancelled' } : error); }
        finally { admission?.release(); }
    });
}
