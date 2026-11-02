import axios from '@/api/client/credentialAxios';
import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DeploymentTemplateInstantiateInputV1Schema, DeploymentEnvironmentCreateResultV1Schema, DeploymentTargetLinkResultV1Schema,
    areDeploymentTemplateReviewFactsEqualV1, DeploymentReceiptAcceptedResultV1Schema,
    type ActionExecutorContext, type ActionExecutorDeps, type DeploymentTemplateInstantiateInputV1,
    type DeploymentTemplateInstantiateResultV1, type DeploymentArtifactContentReferenceV1,
    type DeploymentTemplateInstantiationReviewV1, type StoredAppPresetInputV1, type DeploymentDeployIntentInputV1,
    type DeploymentEnvironmentCreateIntentInputV1, type DeploymentEnvironmentCreationReviewV1 } from '@happier-dev/protocol';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1, registryContentRefEqualV1, RegistryFetchErrorV1 } from '@happier-dev/protocol/registries';
import { classifyHomeDomainHttpMutationFailureV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { DeploymentEnvironmentContentV1Schema, DeploymentEnvironmentTemplateSetInputV1Schema,
    DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1,
    environmentSecretBindingIdentityV1, resolveDeploymentStoredDefinitionRevisionV1, createOwnServerEnvironmentConfigurationV1,
    type DeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol';
import { prepareDeploymentTemplateInstantiationV1, resolveDeploymentCreationDefaultsV1, resolveDeploymentTemplateInstantiationBaselineRefV1 } from '@happier-dev/deployments';
import type { StoredCredentials } from '@/persistence';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { createCliRegistryHostV1 } from '@/registries/createCliRegistryHost';
import { createCliProjectSourceActionDeps } from '@/session/actions/projectSourceActionDeps';
import { admitStoredComposeDefinition, parseNativeComposeSource } from '@/workspaces/projectSetup/nativeComposeSource';
import { captureDeploymentBindingSavedSecretRevisionsV1 } from '../secrets/prepareDeploymentBindingsForHost';
import { createDeploymentTemplateGeneratedSecretForHost, validateDeploymentTemplateGeneratedSecretProfileForHost } from './generatedSecretForHost';
import type { DeploymentCreationDefaultRequestForHost, DeploymentCreationDefaultInputsForHost } from '../readCreationDefaultsForHost';
import { createPublishCatalogPreparation } from '@/workspaces/publishProject';

const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };
const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
function errorCode(error: unknown): string {
    return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'template_unavailable';
}
type SavedSecrets = Extract<DeploymentTemplateInstantiateResultV1, { kind: 'applied' }>['savedSecrets'];
type TemplateCreateEnvironment = Extract<DeploymentTemplateInstantiateInputV1['environment'], { kind: 'create' }>;
type TemplatePreparationInput = Omit<DeploymentTemplateInstantiateInputV1, 'environment'> & Readonly<{
    environment: Exclude<DeploymentTemplateInstantiateInputV1['environment'], { kind: 'create' }>
        | Omit<TemplateCreateEnvironment, 'controllerMachineId'> & { controllerMachineId?: string };
}>;
type Host = Readonly<{
    credentials: StoredCredentials; serverId: string; machineId: string; serverHttpBaseUrl: string;
    savedSecretOperationContext?: SavedSecretOperationContextV1;
    readMachineVitals?: () => MachineVitalsSampleV1 | null;
    assertCurrent(context: ActionExecutorContext): Promise<void>;
    headers(context: ActionExecutorContext, actionId: string, request: Readonly<{ method: string; path: string; body?: unknown }>): Promise<Readonly<Record<string, string>>>;
    storage: NonNullable<ActionExecutorDeps['deploymentAction']>;
    deploy?(input: DeploymentDeployIntentInputV1, context: ActionExecutorContext): ReturnType<NonNullable<ActionExecutorDeps['deploymentAction']>>;
    readEnvironment(request: Readonly<{ environmentId: string; context: ActionExecutorContext }>): Promise<DeploymentEnvironmentDetailV1>;
    readCreationDefaultInputs(request: DeploymentCreationDefaultRequestForHost): Promise<DeploymentCreationDefaultInputsForHost>;
    createContent(content: unknown, kind: string, context: ActionExecutorContext, authority: Readonly<{
        owner: DeploymentEnvironmentDetailV1['environment']['owner'];
        assertCurrent(): Promise<void>;
    }>): Promise<DeploymentArtifactContentReferenceV1>;
}>;

/** Semantic composition only. P40, P42 and the private template CAS retain every write. */
export function createDeploymentTemplateInstantiationForHost(host: Host) {
    const sources = createCliProjectSourceActionDeps({ serverHttpBaseUrl: host.serverHttpBaseUrl,
        admitAccount: async (serverId, context) => { await host.assertCurrent(context); return serverId === host.serverId ? null : failure('server_scope_mismatch'); },
        resolveRequestHeaders: host.headers });
    async function readProjectSource(projectSourceId: string, context: ActionExecutorContext) {
        const source = await sources.projectSourcesRead!({ serverId: host.serverId, sourceId: projectSourceId }, context);
        if (!source.ok) return refuse('errorCode' in source ? source.errorCode : source.error);
        if (source.source.id !== projectSourceId || !source.canManage) return refuse('source_access_denied');
        return source;
    }
    async function readPinnedTemplate(input: Pick<DeploymentTemplateInstantiateInputV1, 'templateRef'>, context: ActionExecutorContext) {
        const registry = createCliRegistryHostV1({ credentials: host.credentials, signal: context.signal,
            operationContext: host.savedSecretOperationContext });
        const selected = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await registry.execute('registries.items.read', {
            kind: 'app', sourceId: input.templateRef.sourceId, itemId: input.templateRef.itemId, version: input.templateRef.version })).item;
        if (selected.payload.kind !== 'app' || selected.payload.state !== 'ready') return refuse('template_needs_review');
        if (!registryContentRefEqualV1(selected.payload.ref, input.templateRef.ref)) return refuse('template_changed');
        return selected.payload.app;
    }
    const preparePublishEntry = createPublishCatalogPreparation({
        async readSelection(input, context) {
            if (input.machineId !== host.machineId || input.serverId !== host.serverId
                || readInstallationIdentityIfExistsSync()?.installationId !== input.installationId) return refuse('target_mismatch');
            await host.assertCurrent(context);
            const source = input.projectSourceId ? await readProjectSource(input.projectSourceId, context) : undefined;
            if (source && source.source.revision !== input.sourceRevision) return refuse('source_changed');
            const template = await readPinnedTemplate(input, context);
            const projectOwner = input.newProject?.owner ?? source?.source.owner
                ?? (source ? { kind: 'account' as const, accountId: source.source.createdByAccountId } : refuse('invalid_parameters'));
            const defaultInputs = await host.readCreationDefaultInputs({ projectSourceId: input.projectSourceId,
                sourceRevision: input.sourceRevision, projectOwner, context, actionId: 'deployments.publish.prepare' });
            return { source: source?.source, newProject: input.newProject, template, defaultInputs };
        },
    });
    async function prepareInput(input: TemplatePreparationInput, context: ActionExecutorContext,
        actionId: DeploymentCreationDefaultRequestForHost['actionId'] = 'deployments.templates.instantiate',
        creationReview?: DeploymentTemplateInstantiationReviewV1) {
        // Receiver identity is checked before any fetch, entropy, Artifact or native acquisition.
        if (input.machineId !== host.machineId || input.serverId !== host.serverId) return refuse('target_mismatch');
        await host.assertCurrent(context);
        const identity = readInstallationIdentityIfExistsSync();
        if (!identity || identity.installationId !== input.target.installationId) return refuse('target_mismatch');
        const source = input.projectSourceId ? await readProjectSource(input.projectSourceId, context) : undefined;
        const current = input.environment.kind === 'existing'
            ? await host.readEnvironment({ environmentId: input.environment.environmentId, context }) : undefined;
        if (current) {
            if (input.environment.kind !== 'existing' || current.environment.id !== input.environment.environmentId
                || current.environment.projectSourceId !== input.projectSourceId || !current.environment.capabilities.manage
                || !current.environment.capabilities.manageBindings) return refuse('deployment_access_denied');
            if (current.environment.revision !== input.environment.expectedRevision || current.content.definition.kind !== 'stored'
                || !('contentRevision' in input.destination) || current.content.definition.contentRevision !== input.destination.contentRevision
                || current.content.definition.composeDigest !== input.destination.composeDigest) return refuse('deployment_conflict');
            if (input.target.kind === 'existing') {
                const selectedTarget = input.target;
                const link = current.targetLinks.find(item => item.targetLink.id === selectedTarget.targetLinkId)?.targetLink;
                if (!link || link.role !== 'runtime' || link.targetKind !== 'ownServer' || link.deletedAtMs !== undefined
                    || link.detachedAtMs !== undefined || link.revision !== input.target.expectedRevision
                    || current.environment.runtimeTargetLinkId !== link.id
                    || !link.members.some(member => member.machineId === input.machineId && member.installationId === input.target.installationId)) return refuse('target_mismatch');
            } else if (current.environment.runtimeTargetLinkId || !current.environment.capabilities.manageTargets
                || !context.actionRequestId) return refuse('target_mismatch');
        }
        const template = await readPinnedTemplate(input, context);
        const sourceDocument = await parseNativeComposeSource(template.compose.document);
        const existingSource = current?.content.definition.kind === 'stored' ? await parseNativeComposeSource(current.content.definition.document) : undefined;
        const currentInput = current && existingSource ? { content: current.content, source: existingSource } : undefined;
        const recorded = resolveDeploymentTemplateInstantiationBaselineRefV1({ templateRef: input.templateRef, source: sourceDocument, current: currentInput });
        const baseline = recorded
            ? { templateRef: recorded, source: await parseNativeComposeSource((await readPinnedTemplate({ templateRef: recorded }, context).catch(error => {
                if (error instanceof RegistryFetchErrorV1 && error.code !== 'auth_failed') return refuse('template_source_unavailable');
                throw error;
            })).compose.document) }
            : undefined;
        // Snapshot the existing sampler once, only when declared memory needs it.
        // No new collection, timer, freshness budget or Docker-filesystem guess.
        const sample = template.minimumResources?.memoryBytes !== undefined ? host.readMachineVitals?.() : undefined;
        const prepareInput = { template, templateRef: input.templateRef, source: sourceDocument,
            ...(sample ? { targetResources: { sampledAt: sample.sampledAt,
                ...(sample.memory.reported ? { memoryBytes: sample.memory.totalBytes } : {}) } } : {}),
            ...(currentInput ? { current: { ...currentInput, ...(baseline ? { baseline } : {}) } } : {}),
            bindings: input.bindings, connectTo: input.connectTo, replace: input.replace, domainBindings: input.domainBindings };
        const prepared = prepareDeploymentTemplateInstantiationV1(prepareInput);
        const candidateDefinition = { kind: 'stored' as const,
            composeDigest: `sha256:${createHash('sha256').update(prepared.document).digest('hex')}`,
            document: prepared.document, profiles: prepared.profiles, services: prepared.services,
            ...(prepared.primaryService ? { primaryService: prepared.primaryService } : {}) };
        const contentRevision = resolveDeploymentStoredDefinitionRevisionV1(current?.content.definition, candidateDefinition);
        if (contentRevision === null) return refuse('deployment_conflict');
        const definition = { ...candidateDefinition, contentRevision };
        await admitStoredComposeDefinition(definition);
        // Domain selection is not route creation. Never report an applied route without its real owner.
        if (prepared.domains.length) return refuse('template_domain_route_required');
        const name = current?.content.name ?? (input.environment.kind === 'create' ? input.environment.name : '');
        const projectOwner = input.newProject?.owner ?? source?.source.owner
            ?? (source ? { kind: 'account' as const, accountId: source.source.createdByAccountId } : refuse('invalid_parameters'));
        const defaultInputs: DeploymentCreationDefaultInputsForHost = input.environment.kind === 'create' && !creationReview?.creationDefaults ? await host.readCreationDefaultInputs({ projectSourceId: input.projectSourceId,
            sourceRevision: source?.source.revision, projectOwner, context, actionId }) : {};
        const defaults = creationReview?.creationDefaults ?? resolveDeploymentCreationDefaultsV1({ projectSourceId: input.projectSourceId,
            projectOwner, ...defaultInputs,
            target: { kind: 'ownServer', machines: [input.machineId] },
            explicit: input.environment.kind === 'create' ? { controllerMachineId: input.environment.controllerMachineId,
                ...(input.environment.buildMachineId ? { buildMachineId: input.environment.buildMachineId } : {}),
                ...(input.environment.retainPreviousDeployments === undefined ? {} : { retainPreviousDeployments: input.environment.retainPreviousDeployments }) } : undefined });
        const content = DeploymentEnvironmentContentV1Schema.parse(current ? { ...current.content, definition }
            : { name, retainPreviousDeployments: defaults.values.retainPreviousDeployments, definition, bindings: [],
                ownServer: createOwnServerEnvironmentConfigurationV1() });
        for (const secret of prepared.generatedSecrets) validateDeploymentTemplateGeneratedSecretProfileForHost({ name: `${name} · ${secret.name}`, profile: secret.profile });
        context.signal?.throwIfAborted();
        const review: DeploymentTemplateInstantiationReviewV1 = { templateRef: input.templateRef,
            profiles: prepared.profiles, services: prepared.services, ...(prepared.primaryService ? { primaryService: prepared.primaryService } : {}),
            bindings: prepared.bindings, generatedSecrets: prepared.generatedSecrets, domains: prepared.domains,
            capacity: prepared.capacity,
            ...(input.deploy ? { deploy: input.deploy } : {}),
            ...(prepared.template.firstRunSetup ? { firstRunSetup: prepared.template.firstRunSetup } : {}),
            ...(input.environment.kind === 'create' ? { creationDefaults: defaults,
                ...(creationReview?.creationDefaultsBasis ?? defaultInputs.reviewBasis
                    ? { creationDefaultsBasis: creationReview?.creationDefaultsBasis ?? defaultInputs.reviewBasis } : {}) } : {}),
            ...(template.minimumResources ? { minimumResources: template.minimumResources } : {}) };
        const contentAuthority = { owner: projectOwner, async assertCurrent() {
            if (input.newProject) { await host.assertCurrent(context); return; }
            if (!input.projectSourceId) return refuse('invalid_parameters');
            const latest = await readProjectSource(input.projectSourceId, context);
            const owner = latest.source.owner ?? { kind: 'account', accountId: latest.source.createdByAccountId };
            if (!isDeepStrictEqual(owner, projectOwner)) return refuse('deployment_conflict');
        } };
        return { input, current, prepared, prepareInput, definition, review, name, defaults, content, contentAuthority };
    }
    function prepare(raw: DeploymentTemplateInstantiateInputV1, context: ActionExecutorContext,
        creationReview?: DeploymentTemplateInstantiationReviewV1) {
        return prepareInput(DeploymentTemplateInstantiateInputV1Schema.parse(raw), context,
            context.externalActionExecutionAuthorization?.binding.actionId === 'deployments.environments.create'
                ? 'deployments.environments.create' : 'deployments.templates.instantiate', creationReview);
    }
    /** P40's catalog create is an adapter into this same P45 preparation and apply owner. */
    function fromCreate(input: DeploymentEnvironmentCreateIntentInputV1): TemplatePreparationInput {
        const target = input.firstTargetLink?.machines[0];
        if (input.definition?.from !== 'catalogApp' || input.purpose !== 'standard'
            || !target || input.firstTargetLink?.machines.length !== 1 || input.copyFrom) return refuse('unsupported_action');
        return { mode: input.mode ?? 'apply', serverId: input.serverId, machineId: target.machineId,
            projectSourceId: input.projectSourceId, newProject: input.newProject, templateRef: input.definition.templateRef,
            environment: { kind: 'create', name: input.name, requestKey: input.requestKey,
                protection: input.protection, purpose: 'standard', deployerMode: input.deployerMode,
                deployerPrincipals: input.deployerPrincipals, controllerMachineId: input.controllerMachineId,
                buildMachineId: input.buildMachineId, retainPreviousDeployments: input.retainPreviousDeployments },
            target: { kind: 'new', installationId: target.installationId }, destination: { kind: 'stored' },
            bindings: input.bindings ?? [], generatedSecretAudience: input.generatedSecretAudience, domainBindings: input.domainBindings };
    }
    async function instantiate(raw: DeploymentTemplateInstantiateInputV1, context: ActionExecutorContext,
        reviewed?: DeploymentTemplateInstantiationReviewV1,
        creationReview?: DeploymentTemplateInstantiationReviewV1): Promise<DeploymentTemplateInstantiateResultV1 | ActionExecuteFailure> {
        const savedSecrets: SavedSecrets = [];
        let phase: Extract<DeploymentTemplateInstantiateResultV1, { kind: 'partial' }>['phase'] = 'generation';
        let environmentId: string | undefined; let revision: number | undefined; let targetLinkId: string | undefined;
        let appliedDefinition: Extract<DeploymentTemplateInstantiateResultV1, { kind: 'applied' }>['definition'] | undefined;
        let unknownSecret: Extract<DeploymentTemplateInstantiateResultV1, { kind: 'partial' }>['unknownSecret'];
        let deployment: Extract<DeploymentTemplateInstantiateResultV1, { kind: 'partial' }>['deployment'];
        let effectIssued = false;
        try {
            const plan = await prepare(raw, context, creationReview);
            if (plan.input.mode === 'preview') return { kind: 'preview', review: plan.review };
            if (reviewed && !areDeploymentTemplateReviewFactsEqualV1(reviewed, plan.review)) return failure('deployment_conflict');
            const { input } = plan;
            const createContent = (content: unknown, kind: string) => host.createContent(content, kind, context, plan.contentAuthority);
            const bindings: StoredAppPresetInputV1['bindings'] = [...input.bindings];
            for (const secret of plan.prepared.generatedSecrets) {
                context.signal?.throwIfAborted();
                effectIssued = true;
                try {
                    const source = await createDeploymentTemplateGeneratedSecretForHost({ name: `${plan.name} · ${secret.name}`, profile: secret.profile,
                        audience: input.generatedSecretAudience ?? refuse('invalid_parameters'),
                        expectedScopeKey: resolveAccountSettingsScopeKey(host.credentials), signal: context.signal ?? new AbortController().signal,
                        readCredentials: async () => host.credentials,
                        operationContext: host.savedSecretOperationContext });
                    savedSecrets.push({ name: secret.name, phase: secret.phase, source });
                    const index = bindings.findIndex(binding => binding.name === secret.name && binding.phase === secret.phase);
                    bindings[index] = { purpose: 'variable', name: secret.name, phase: secret.phase, source };
                } catch (error) {
                    const details = error && typeof error === 'object' && 'details' in error ? error.details : undefined;
                    if (errorCode(error) === 'outcome_unknown' && details && typeof details === 'object'
                        && 'candidateRef' in details && typeof details.candidateRef === 'string') unknownSecret = { name: secret.name, phase: secret.phase, ref: details.candidateRef };
                    throw error;
                }
            }
            const finalPrepared = prepareDeploymentTemplateInstantiationV1({ ...plan.prepareInput, bindings });
            const defaults = plan.defaults;
            const candidateDefinition = { kind: 'stored' as const, contentRevision: plan.definition.contentRevision, composeDigest: plan.definition.composeDigest };
            let content = DeploymentEnvironmentContentV1Schema.parse(plan.current ? plan.content
                : { ...plan.content, template: { ...finalPrepared.template, definition: candidateDefinition } });
            const commit = async (actionId: 'deployments.environments.create' | 'deployments.environments.update' | 'deployments.bindings.set', input: Parameters<Host['storage']>[1]) => {
                const result = await host.storage(actionId, input, context);
                if ('errorCode' in result) return refuse(result.errorCode);
                const parsed = DeploymentEnvironmentCreateResultV1Schema.parse(result);
                if (!parsed.ok) return refuse(parsed.error);
                environmentId = parsed.environmentId; revision = parsed.revision;
            };
            phase = 'environment';
            const artifact = await createContent(content, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1);
            effectIssued = true;
            if (input.environment.kind === 'existing') {
                await commit('deployments.environments.update', { serverId: input.serverId, environmentId: input.environment.environmentId,
                    expectedRevision: input.environment.expectedRevision, ...artifact });
            } else {
                const linkArtifact = await createContent({}, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1);
                await commit('deployments.environments.create', { serverId: input.serverId, projectSourceId: input.projectSourceId, newProject: input.newProject,
                    requestKey: input.environment.requestKey, protection: input.environment.protection, purpose: input.environment.purpose,
                    deployerMode: input.environment.deployerMode,
                    ...(input.environment.deployerPrincipals === undefined ? {} : { deployerPrincipals: input.environment.deployerPrincipals }),
                    controllerMachineId: defaults.values.controllerMachineId ?? refuse('target_mismatch'),
                    buildMachineId: defaults.values.buildMachineId, ...artifact,
                    firstTargetLink: { ...linkArtifact, machines: [{ machineId: input.machineId, installationId: input.target.installationId }] } });
            }
            appliedDefinition = { kind: 'stored', contentRevision: plan.definition.contentRevision, composeDigest: plan.definition.composeDigest };
            phase = 'target';
            if (input.target.kind === 'new' && input.environment.kind === 'existing') {
                const linked = await host.storage('deployments.targets.link', { serverId: input.serverId,
                    environmentId: environmentId!, expectedRevision: revision!, requestKey: context.actionRequestId!,
                    targetId: 'own-server', role: 'runtime', machines: [{ machineId: input.machineId, installationId: input.target.installationId }],
                    ...await createContent({}, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1) }, context);
                if ('errorCode' in linked) return refuse(linked.errorCode);
                const result = DeploymentTargetLinkResultV1Schema.parse(linked);
                if (!result.ok) return refuse(result.error);
                revision = result.revision; targetLinkId = result.targetLinkId;
            }
            const created = await host.readEnvironment({ environmentId: environmentId ?? refuse('deployment_unavailable'), context });
            targetLinkId = created.environment.runtimeTargetLinkId;
            if (!targetLinkId || !created.targetLinks.some(item => item.targetLink.id === targetLinkId
                && item.targetLink.members.some(member => member.machineId === input.machineId && member.installationId === input.target.installationId))) return refuse('target_mismatch');
            phase = 'bindings';
            const merged = new Map(content.bindings.map(binding => [environmentSecretBindingIdentityV1(binding), binding]));
            for (const binding of finalPrepared.bindings) merged.set(environmentSecretBindingIdentityV1(binding), binding);
            content = DeploymentEnvironmentContentV1Schema.parse({ ...content, bindings: [...merged.values()] });
            await commit('deployments.bindings.set', { serverId: input.serverId, environmentId: environmentId!, expectedRevision: revision!,
                ...await createContent(content, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1),
                referencedSavedSecretRevisions: captureDeploymentBindingSavedSecretRevisionsV1(content.bindings) });
            if (input.environment.kind === 'existing') {
                phase = 'metadata';
                const finalContent = DeploymentEnvironmentContentV1Schema.parse({ ...content, template: { ...finalPrepared.template, definition: appliedDefinition } });
                const body = DeploymentEnvironmentTemplateSetInputV1Schema.parse({ serverId: context.externalActionExecutionAuthorization?.binding.serverIdentityId ?? input.serverId,
                    environmentId, expectedRevision: revision, ...await createContent(finalContent, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1) });
                const path = `/v1/deployments/environments/${encodeURIComponent(body.environmentId)}/template`;
                const headers = await host.headers(context, 'deployments.templates.instantiate', { method: 'POST', path, body });
                const response = await axios.request<unknown>({ method: 'POST', url: `${host.serverHttpBaseUrl}${path}`, headers, data: body,
                    signal: context.signal, validateStatus: () => true }).catch(error => refuse(classifyHomeDomainHttpMutationFailureV1({
                        error, issued: true, aborted: context.signal?.aborted === true })));
                const result = DeploymentEnvironmentCreateResultV1Schema.safeParse(response.data);
                if (!result.success) return refuse('outcome_unknown');
                if (!result.data.ok) return refuse(result.data.error);
                environmentId = result.data.environmentId; revision = result.data.revision;
            }
            if (input.deploy) {
                phase = 'deploy';
                if (!host.deploy) return refuse('unsupported_action');
                const result = await host.deploy({ serverId: input.serverId, environmentId: environmentId!, targetLinkId,
                    requestKey: input.deploy.requestKey, sourceIntent: plan.definition }, context);
                if ('errorCode' in result) {
                    const retained = DeploymentReceiptAcceptedResultV1Schema.safeParse(result.details);
                    if (retained.success) { deployment = retained.data; revision = deployment.revision; }
                    return refuse(result.errorCode);
                }
                const accepted = DeploymentReceiptAcceptedResultV1Schema.safeParse(result);
                if (!accepted.success) return refuse('ok' in result && !result.ok && 'error' in result ? result.error : 'invalid_action_output');
                deployment = accepted.data;
                revision = deployment.revision;
                if ('kind' in deployment) return refuse('deployment_in_progress');
                if (deployment.state !== 'succeeded' && deployment.state !== 'running_unverified') return refuse(
                    deployment.state === 'failed' ? 'deployment_failed' : deployment.state === 'cancelled' ? 'cancelled'
                        : deployment.state === 'outcome_unknown' ? 'outcome_unknown' : 'deployment_in_progress');
            }
            return { kind: 'applied', environmentId: environmentId!, revision: revision!, targetLinkId, definition: appliedDefinition, savedSecrets,
                ...(deployment ? { deployment } : {}) };
        } catch (error) {
            const code = context.signal?.aborted && !effectIssued ? 'cancelled' : errorCode(error);
            if (!effectIssued) return failure(code);
            return { kind: 'partial', phase, errorCode: code, savedSecrets,
                ...(environmentId ? { environmentId, revision } : {}), ...(targetLinkId ? { targetLinkId } : {}),
                ...(deployment ? { deployment } : {}),
                ...(appliedDefinition ? { definition: appliedDefinition } : {}), ...(unknownSecret ? { unknownSecret } : {}) };
        }
    }
    return { instantiate, preparePublishEntry,
        async prepareCreate(input: DeploymentEnvironmentCreateIntentInputV1, context: ActionExecutorContext,
            review?: DeploymentEnvironmentCreationReviewV1) {
            try {
                const plan = await prepareInput(fromCreate(input), context, 'deployments.environments.create', review?.template);
                if (!plan.defaults.values.controllerMachineId) return failure('client_required');
                return { input: { ...input, mode: 'apply' as const, ...plan.defaults.values }, preview: normalizeStrictJsonValue({
                    creationDefaults: plan.defaults, ...(plan.review.creationDefaultsBasis ? { creationDefaultsBasis: plan.review.creationDefaultsBasis } : {}),
                    template: plan.review,
                }) };
            } catch (error) { return failure(context.signal?.aborted ? 'cancelled' : errorCode(error)); }
        },
        async instantiateCreate(input: DeploymentEnvironmentCreateIntentInputV1, context: ActionExecutorContext,
            review?: DeploymentEnvironmentCreationReviewV1) {
            try {
                const result = await instantiate(DeploymentTemplateInstantiateInputV1Schema.parse(fromCreate(input)), context,
                    review?.template, review?.template);
                if ('kind' in result && result.kind === 'partial') {
                    return { ok: false as const, errorCode: result.errorCode, error: result.errorCode, details: result };
                }
                return 'errorCode' in result ? result : result.kind === 'applied'
                    ? { ok: true as const, environmentId: result.environmentId, revision: result.revision }
                    : failure('invalid_action_output');
            } catch (error) { return failure(context.signal?.aborted ? 'cancelled' : errorCode(error)); }
        },
        async prepare(input: DeploymentTemplateInstantiateInputV1, context: ActionExecutorContext) {
        try { return { input, preview: normalizeStrictJsonValue((await prepare(input, context)).review) }; }
        catch (error) { return failure(errorCode(error)); }
    } };
}
