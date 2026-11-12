import axios from '@/api/client/credentialAxios';
import { isDeepStrictEqual } from 'node:util';
import { DeploymentBindingsSetInputV1Schema, DeploymentBindingsPreparedInputV1Schema, DeploymentEnvironmentGetResultV1Schema,
    DeploymentEnvironmentGetInputV1Schema, captureDeploymentBindingSavedSecretRevisionsV1,
    matchesDeploymentBindingSavedSecretCapturesV1, applyEnvironmentSecretBindingsPatchV1,
    EnvironmentSecretBindingV1Schema } from '@happier-dev/protocol';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { bindHomeDomainHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { createDeploymentEnvironmentContentArtifactIdV1, createDeploymentLinkContentArtifactIdV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { readHostAdmittedReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext, DeploymentActionIdV1, DeploymentBindingsSetInputV1 } from '@happier-dev/protocol';
type DeploymentEnvironmentGetResultV1 = ReturnType<typeof DeploymentEnvironmentGetResultV1Schema.parse>;
import { readDeploymentEnvironmentArtifactV1, readDeploymentTargetLinkArtifactV1, isDeploymentEnvironmentBindingsOnlyUpdateV1,
    isEnvironmentSecretBindingManagedByBindingsWriterV1, readRetainedOperationalEnvironmentBindingGrantsV1,
    machineSecretGrantSubjectKey, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1,
    type DeploymentTargetLinkContentV1, type DeploymentTargetLinkHeaderV1, type MachineSecretGrantV1,
    type DeploymentEnvironmentContentV1 } from '@happier-dev/deployment-protocol';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { createCredentialedAccountArtifactStore, type ArtifactRequestAuthorizationHeaders } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import type { StoredCredentials } from '@/persistence';
import { readSavedSecretMaterializerForOperation } from '@/settings/secrets/savedSecretCatalogRead';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveRequesterSavedSecretActionCustody } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import type { DeploymentBindingPreparationRequestV1, PreparedDeploymentBindingStorageV1 } from '../createCliDeploymentActionDeps';
import { createDeploymentArtifactForHost } from '../createArtifactForHost';
import { prepareEnvironmentSecretBindings, type EnvironmentSecretInstallation } from './environmentSecretBindingService';
import { assertDeploymentSecretInvocationCurrent, readEnvironmentSecretBindingPreparationForHost } from './readEnvironmentSecretLaunchAdmissionForHost';

const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };
function failure(error: unknown): ActionExecuteFailure {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code
        : error && typeof error === 'object' && 'data' in error && error.data && typeof error.data === 'object'
            && 'code' in error.data && typeof error.data.code === 'string' ? error.data.code : 'deployment_content_unavailable';
    return { ok: false, errorCode: code, error: code };
}
export { captureDeploymentBindingSavedSecretRevisionsV1 } from '@happier-dev/protocol';

/** The native data owner resolves exact service destinations before any selected secret is acquired. */
export type PrepareDataRoleBindingsForHost = (input: Readonly<{
    input: DeploymentBindingsSetInputV1;
    environment: Extract<DeploymentEnvironmentGetResultV1, { ok: true }>;
    content: DeploymentEnvironmentContentV1;
    previousContent: DeploymentEnvironmentContentV1;
    context: ActionExecutorContext;
    runtimeInstallations: readonly EnvironmentSecretInstallation[];
    existingGrants: readonly MachineSecretGrantV1[];
}>) => Promise<Readonly<{
    operationalDestinations: NonNullable<Parameters<typeof prepareEnvironmentSecretBindings>[0]['operationalDestinations']>;
    complete(grants: readonly MachineSecretGrantV1[]): Promise<void>;
    dispose(): Promise<void> | void;
}>>;

export type PreparePlatformBindingsForHost = (request: Readonly<{
    input: DeploymentBindingsSetInputV1; environment: Extract<DeploymentEnvironmentGetResultV1, { ok: true }>;
    content: DeploymentEnvironmentContentV1; previousContent: DeploymentEnvironmentContentV1;
    targetLink: DeploymentTargetLinkHeaderV1; linkContent: DeploymentTargetLinkContentV1; context: ActionExecutorContext;
}>) => Promise<Readonly<{ linkContent: DeploymentTargetLinkContentV1;
    providerVariables: NonNullable<PreparedDeploymentBindingStorageV1['providerVariables']> }>>;

/** Explicit author preparation only. P40's single bindings CAS remains the sole writer. */
export function createPrepareDeploymentBindingsForHost(host: Readonly<{
    credentials: StoredCredentials;
    accountArtifacts?: ReturnType<typeof createCredentialedAccountArtifactStore>;
    serverId: string;
    serverHttpBaseUrl: string;
    machineId: string;
    savedSecretOperationContext?: SavedSecretOperationContextV1;
    prepareDataRoleBindings?: PrepareDataRoleBindingsForHost;
    preparePlatformBindings?: PreparePlatformBindingsForHost;
    resolveRequestHeaders(context: ActionExecutorContext, actionId: DeploymentActionIdV1,
        request: Parameters<ArtifactRequestAuthorizationHeaders>[0]):
        Readonly<Record<string, string>> | null | Promise<Readonly<Record<string, string>> | null>;
}>) {
    return async (request: DeploymentBindingPreparationRequestV1):
        Promise<PreparedDeploymentBindingStorageV1 | ActionExecuteFailure> => runWithServerHttpBaseUrl(host.serverHttpBaseUrl, async () => {
        let providerVariables: PreparedDeploymentBindingStorageV1['providerVariables'];
        let targetLinkContent: PreparedDeploymentBindingStorageV1['targetLinkContent'];
        let admission: Awaited<ReturnType<typeof readEnvironmentSecretBindingPreparationForHost>> | undefined;
        let dataRolePreparation: Awaited<ReturnType<PrepareDataRoleBindingsForHost>> | undefined;
        try {
            const { credentials, operation } = resolveRequesterSavedSecretActionCustody({
                authorization: request.context.externalActionExecutionAuthorization,
                credentials: host.credentials, operationContext: host.savedSecretOperationContext,
            });
            const artifacts = host.accountArtifacts ?? createCredentialedAccountArtifactStore(credentials);
            const input = DeploymentBindingsSetInputV1Schema.parse(request.input);
            if ('set' in input && input.set.some(binding => binding.source.kind === 'secret'
                && binding.source.ref === 'person_selects')) return refuse('client_required');
            const { context } = request;
            if (input.serverId !== host.serverId) return refuse('target_mismatch');
            const assertAuthority = () => assertDeploymentSecretInvocationCurrent(context);
            const headers = async (transport: Parameters<ArtifactRequestAuthorizationHeaders>[0],
                actionId: DeploymentActionIdV1 = request.buildMachineId || request.environmentUpdate
                    ? 'deployments.environments.update' : 'deployments.bindings.set') => {
                await assertAuthority();
                const authorized = await host.resolveRequestHeaders(context, actionId, transport);
                if (!authorized) return refuse('action_forbidden');
                return { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...authorized };
            };
            const storageServerId = context.externalActionExecutionAuthorization?.binding.serverIdentityId ?? host.serverId;
            const transport = getActionSpec('deployments.environments.get').serverTransport;
            if (!transport) return refuse('unsupported_action');
            const { path } = bindHomeDomainHttpRequestV1({ transport, inputSchema: DeploymentEnvironmentGetInputV1Schema,
                input: { serverId: storageServerId, environmentId: input.environmentId } });
            const response = await axios.request<unknown>({ method: 'GET', url: `${host.serverHttpBaseUrl}${path}`,
                headers: await headers({ method: 'GET', path }, 'deployments.environments.get'), signal: context.signal, maxRedirects: 0, validateStatus: () => true });
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
            if (request.environmentUpdate ? false : request.buildMachineId ? !isDeepStrictEqual(current.content.bindings, candidate.content.bindings)
                : !isDeploymentEnvironmentBindingsOnlyUpdateV1(current.content, candidate.content)) return refuse('deployment_invalid');
            if ('providerVariables' in input && input.providerVariables) {
                const keep = new Set(input.providerVariables.keepTheirs);
                candidate.content.bindings = candidate.content.bindings.filter(binding => binding.purpose !== 'variable' || !keep.has(binding.name));
            }
            const dataRoleTargetLinkIds = [...new Set([...candidate.content.bindings, ...current.content.bindings].flatMap(binding =>
                binding.purpose === 'dataRole' && 'targetLinkId' in binding ? [binding.targetLinkId] : []))];
            const selectedCaptures = captureDeploymentBindingSavedSecretRevisionsV1(candidate.content.bindings);
            if (!request.buildMachineId && !request.environmentUpdate && 'referencedSavedSecretRevisions' in input
                && !matchesDeploymentBindingSavedSecretCapturesV1(selectedCaptures,
                input.referencedSavedSecretRevisions)) return refuse('deployment_invalid');
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
                const binding = context.externalActionExecutionAuthorization?.binding;
                const child = readHostAdmittedReviewedChildV1(context);
                const artifactId = binding && (binding.actionId === DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1
                    || child?.actionId === DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1
                        && (child.role === 'backup.bindings' || child.role === 'template.bindings'))
                    ? createDeploymentEnvironmentContentArtifactIdV1({ ...binding, actionId: DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1,
                        environmentId: input.environmentId }) : undefined;
                const created = await createDeploymentArtifactForHost({ artifacts, owner: loaded.environment.owner, assertCurrent,
                    ...(artifactId ? { publication: 'create' as const } : {}),
                    content: { ...(artifactId ? { artifactId } : {}),
                        header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: candidate.content.name },
                        body: JSON.stringify(candidate.content), signal: context.signal, beforeWrite: assertCurrent,
                        authorizationHeaders: headers } });
                await assertCurrent();
                return { ...DeploymentBindingsPreparedInputV1Schema.parse({ serverId: input.serverId,
                    environmentId: input.environmentId, expectedRevision: input.expectedRevision,
                    contentArtifactId: created.artifactId, contentHeaderVersion: created.revision.headerVersion,
                    contentBodyVersion: created.revision.bodyVersion, referencedSavedSecretRevisions: selectedCaptures }), grants };
            };
            const platformLink = loaded.targetLinks.find(link => link.id === targetLinkId && link.source.kind === 'plugin');
            if (platformLink && !request.buildMachineId && !request.environmentUpdate) {
                if (!host.preparePlatformBindings) return refuse('unsupported_action');
                if (readRetainedOperationalEnvironmentBindingGrantsV1({ previousBindings: current.content.bindings,
                    bindings: candidate.content.bindings, existingGrants: [], writer: 'variables' }) === null) return refuse('deployment_invalid');
                const opened = readDeploymentTargetLinkArtifactV1(platformLink, await open(platformLink.contentArtifactId));
                if (!opened.ok) return refuse(opened.error);
                const synchronized = await host.preparePlatformBindings({ input, environment: loaded, content: candidate.content,
                    previousContent: current.content, targetLink: platformLink, linkContent: opened.content, context });
                providerVariables = synchronized.providerVariables;
                const binding = context.externalActionExecutionAuthorization?.binding;
                const artifactId = binding?.actionId === DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1
                    ? createDeploymentLinkContentArtifactIdV1({ ...binding, deploymentLinkAdmission: { environmentId: input.environmentId } }) : undefined;
                const created = await createDeploymentArtifactForHost({ artifacts, owner: loaded.environment.owner, assertCurrent,
                    ...(artifactId ? { publication: 'create' as const } : {}), content: { ...(artifactId ? { artifactId } : {}),
                        header: { kind: DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, title: candidate.content.name },
                        body: JSON.stringify(synchronized.linkContent), signal: context.signal, beforeWrite: assertCurrent, authorizationHeaders: headers } });
                targetLinkContent = { targetLinkId: platformLink.id,
                    expectedTargetLinkRevision: platformLink.revision, contentArtifactId: created.artifactId,
                    contentHeaderVersion: created.revision.headerVersion, contentBodyVersion: created.revision.bodyVersion };
                if (dataRoleTargetLinkIds.length === 0) return { ...await complete([]), providerVariables, targetLinkContent };
            }
            if (candidate.content.bindings.length === 0 && current.content.bindings.length === 0) {
                await assertAuthority();
                return await complete([]);
            }
            // References can be authored before placement. The shared binding owner
            // decides which uses need a destination; no secret is acquired without one.
            if (!targetLinkId && !loaded.environment.buildMachineId && !request.buildMachineId && dataRoleTargetLinkIds.length === 0) {
                const prepared = await prepareEnvironmentSecretBindings({ environmentId: input.environmentId,
                    bindings: candidate.content.bindings, previousBindings: current.content.bindings,
                    runtimeInstallations: [], existingGrants: [], assertCurrent });
                return await complete(prepared.grants);
            }
            if (targetLinkId && !loaded.targetLinks.some(link => link.id === targetLinkId)) return refuse('deployment_unavailable');
            const identity = readInstallationIdentityIfExistsSync();
            if (!identity) return refuse('secret_missing');
            admission = await readEnvironmentSecretBindingPreparationForHost({ credentials,
                serverId: storageServerId, serverHttpBaseUrl: host.serverHttpBaseUrl, machineId: host.machineId,
                installationId: identity.installationId, environmentId: input.environmentId,
                ...(targetLinkId ? { targetLinkId } : {}),
                createRequestHeaders: body => headers({ method: 'POST',
                    path: `/v1/deployments/environments/${encodeURIComponent(input.environmentId)}/secret-launch-admission`, body }),
                expectedRevision: input.expectedRevision, ...(request.buildMachineId ? { buildMachineId: request.buildMachineId } : {}),
                ...(request.environmentUpdate ? { environmentUpdate: true } : {}),
                domainIds: request.environmentUpdate ? [] : [...new Set([...candidate.content.bindings, ...current.content.bindings].flatMap(binding =>
                    binding.purpose === 'domainCredential' ? [binding.domainId] : []))],
                dataRoleTargetLinkIds,
                context, signal: context.signal ?? new AbortController().signal });
            const retainedAdmission = admission;
            const retainedOperationalGrants = request.environmentUpdate
                ? readRetainedOperationalEnvironmentBindingGrantsV1({ previousBindings: current.content.bindings,
                    bindings: candidate.content.bindings, existingGrants: retainedAdmission.grants }) : [];
            if (retainedOperationalGrants === null) return refuse('deployment_invalid');
            if (retainedAdmission.bindingPreparation.buildInstallation?.machineId !== loaded.environment.buildMachineId
                || request.buildMachineId && retainedAdmission.bindingPreparation.proposedBuildInstallation?.machineId !== request.buildMachineId) {
                return refuse('deployment_conflict');
            }
            const materializer = operation ? async () => {
                if (!await operation.isCurrent(context.signal)) return refuse('action_forbidden');
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
            const preparedBindings = request.environmentUpdate
                ? candidate.content.bindings.filter(binding => isEnvironmentSecretBindingManagedByBindingsWriterV1(binding)) : candidate.content.bindings;
            const previousBindings = request.environmentUpdate
                ? current.content.bindings.filter(binding => isEnvironmentSecretBindingManagedByBindingsWriterV1(binding)) : current.content.bindings;
            const controllerInstallation = retainedAdmission.bindingPreparation.controllerInstallation;
            const managedDataRoleDestinations = controllerInstallation
                ? [...preparedBindings, ...previousBindings].flatMap(binding => binding.purpose === 'dataRole'
                    && 'targetLinkId' in binding && dataRoleTargetLinkIds.includes(binding.targetLinkId)
                    ? [{ binding, installations: [decodeInstallation(controllerInstallation)] }] : []) : [];
            if (!request.environmentUpdate && [...preparedBindings, ...previousBindings].some(binding =>
                binding.purpose === 'dataRole' && 'service' in binding) && host.prepareDataRoleBindings) {
                dataRolePreparation = await host.prepareDataRoleBindings({ input, environment: loaded, content: candidate.content,
                    previousContent: current.content, context,
                    runtimeInstallations: retainedAdmission.bindingPreparation.runtimeInstallations.map(decodeInstallation),
                    existingGrants: retainedAdmission.grants });
            }
            const operationalDestinations = [...(dataRolePreparation?.operationalDestinations ?? []), ...managedDataRoleDestinations];
            const prepared = await prepareEnvironmentSecretBindings({ environmentId: input.environmentId,
                bindings: preparedBindings, previousBindings,
                runtimeInstallations: retainedAdmission.bindingPreparation.runtimeInstallations.map(decodeInstallation),
                ...(buildInstallation ? { buildInstallation: decodeInstallation(buildInstallation) } : {}),
                ...(decodedDomainDestinations ? { domainDestinations: decodedDomainDestinations } : {}),
                ...(operationalDestinations.length ? { operationalDestinations } : {}),
                ...(request.buildMachineId ? { previousDestinations: {
                    runtimeInstallations: retainedAdmission.bindingPreparation.runtimeInstallations.map(decodeInstallation),
                    ...(decodedDomainDestinations ? { domainDestinations: decodedDomainDestinations } : {}),
                    ...(operationalDestinations.length ? { operationalDestinations } : {}),
                    ...(retainedAdmission.bindingPreparation.buildInstallation
                        ? { buildInstallation: decodeInstallation(retainedAdmission.bindingPreparation.buildInstallation) } : {}),
                } } : {}),
                existingGrants: retainedAdmission.grants, materializer, assertCurrent });
            if (!matchesDeploymentBindingSavedSecretCapturesV1(request.environmentUpdate
                ? captureDeploymentBindingSavedSecretRevisionsV1(preparedBindings) : selectedCaptures,
                prepared.referencedSavedSecretRevisions)) return refuse('deployment_invalid');
            const grants = new Map([...prepared.grants, ...retainedOperationalGrants]
                .map(grant => [machineSecretGrantSubjectKey(grant), grant]));
            await dataRolePreparation?.complete([...grants.values()]);
            return { ...await complete([...grants.values()]), ...(providerVariables ? { providerVariables } : {}),
                ...(targetLinkContent ? { targetLinkContent } : {}) };
        } catch (error) {
            const result = failure(request.context.signal?.aborted ? { code: 'cancelled' } : error);
            return providerVariables ? { ...result, effectAttempted: true, details: { providerVariables } } : result;
        }
        finally { try { await dataRolePreparation?.dispose(); } finally { admission?.release(); } }
    });
}
