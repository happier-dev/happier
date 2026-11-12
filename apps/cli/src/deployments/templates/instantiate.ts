import { readActionOutputDiagnostic } from '@happier-dev/protocol/actions/executor/resultProjection';
import { deploymentOutputValidationFailure } from '../outputValidation';
import { captureDeploymentBindingSavedSecretRevisionsV1 } from '@happier-dev/protocol/deployments/deploymentBindingPatchV1';
import axios from '@/api/client/credentialAxios';
import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { ActionExecutorContext, ActionExecutorDeps, DeploymentTemplateInstantiateInputV1,
    DeploymentTemplateInstantiateResultV1, DeploymentArtifactContentReferenceV1,
    DeploymentTemplateInstantiationReviewV1, StoredAppPresetInputV1, DeploymentDeployIntentInputV1,
    DeploymentEnvironmentCreateIntentInputV1, DeploymentEnvironmentCreationReviewV1 } from '@happier-dev/protocol';
import type { ActionExecuteResult, HostReviewedChildrenPreparationV1 } from '@happier-dev/protocol/actions/executor/types';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { actionInputIssueFailure } from '@happier-dev/protocol/actions/executor/actionInputValidation';
import { DeploymentDomainMutationResultV1Schema, DeploymentEnvironmentCreateResultV1Schema,
    DeploymentBindingsSetResultV1Schema, DeploymentTargetLinkResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentTemplateInstantiateInputV1Schema, areDeploymentTemplateReviewFactsEqualV1,
    readDeploymentTemplateDeployIntentV1, buildCatalogAppTemplateBindings } from '@happier-dev/protocol/deployments/deploymentTemplateInstantiationV1';
import { DeploymentDomainFailureDetailsV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainFailureV1';
import { projectDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { isRecord } from '@happier-dev/protocol/common/records';
import { DeploymentReceiptAcceptedResultV1Schema, DeploymentReceiptSettlementFailureDetailsV1Schema,
    projectDeploymentReceiptSettlementAcceptedResultV1 } from '@happier-dev/protocol/deployments/deploymentReceiptResultV1';
import { RegistryFetchErrorV1 } from '@happier-dev/protocol/registries';
import { classifyHomeDomainHttpMutationFailureV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { DeploymentEnvironmentContentV1Schema, DeploymentEnvironmentTemplateSetInputV1Schema,
    DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1,
    environmentSecretBindingIdentityV1, resolveDeploymentStoredDefinitionRevisionV1, createOwnServerEnvironmentConfigurationV1,
    type DeploymentDomainContentV1,
    type DeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol';
import { DeploymentTemplatePreparationErrorV1, prepareDeploymentTemplateInstantiationV1, resolveDeploymentCreationDefaultsV1, resolveDeploymentTemplateInstantiationBaselineRefV1 } from '@happier-dev/deployments';
import type { StoredCredentials } from '@/persistence';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { createCliProjectSourceActionDeps } from '@/session/actions/projectSourceActionDeps';
import { admitStoredComposeDefinition, parseNativeComposeSource, storedComposeDefinitionDigest } from '@/workspaces/projectSetup/nativeComposeSource';
import { createDeploymentTemplateGeneratedSecretForHost, validateDeploymentTemplateGeneratedSecretProfileForHost } from './generatedSecretForHost';
import type { DeploymentCreationDefaultRequestForHost, DeploymentCreationDefaultInputsForHost } from '../readCreationDefaultsForHost';
import { createPublishCatalogPreparation } from '@/workspaces/publishProject';
import { readDeploymentAuthorizationFailure } from '../deploymentAuthorizationFailure';
import { projectDeploymentFailure } from '../deploymentFailure';
import { readPinnedDeploymentTemplateForHost } from './readPinnedTemplateForHost';
import type { CliAdmittedProjectRowsReader } from '@/session/actions/cliActionDeps/projectAdmission';
import { resolveAdmittedRepositoryWorkspace, validateAdmittedRepositoryWorkspace } from '@/workspaces/admittedRepositoryWorkspace';
import { prepareRepositoryFilesPullRequest, openRepositoryFilesPullRequest, type RepositoryFilesPullRequestHost } from '@/scm/actions/repositoryFilesPullRequest';
import { DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';

const refuse = (failure: string | ActionExecuteFailure): never => {
    const code = typeof failure === 'string' ? failure : failure.errorCode;
    throw Object.assign(new Error(code, typeof failure === 'string' ? undefined : { cause: failure }), { code });
};
const deploymentTemplateDomainChildRole = (key: string) => `template.domain:${key}`;
const deploymentTemplateBindingsChildRole = 'template.bindings';
function deploymentTemplateReviewedChildren(review: DeploymentTemplateInstantiationReviewV1): HostReviewedChildrenPreparationV1 {
    const children = review.domains.map(domain => ({ action: 'deployments.domains.add' as const,
        role: deploymentTemplateDomainChildRole(domain.key) }));
    return { children: [{ action: DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1, role: deploymentTemplateBindingsChildRole }, ...children, ...(review.deploy ? [{ action: 'deployments.deploy' as const,
        role: 'template.deploy' }] : [])] };
}
function failure(errorCode: string, error?: unknown): ActionExecuteFailure {
    const authorizationFailure = readDeploymentAuthorizationFailure(error);
    if (authorizationFailure) return { ...authorizationFailure, effectAttempted: false };
    if (error instanceof DeploymentTemplatePreparationErrorV1 && error.code === errorCode) return { ok: false, effectAttempted: false, errorCode,
        error: error.message, ...(error.details ? { details: error.details } : {}) };
    return { ...projectDeploymentFailure(errorCode, error), effectAttempted: false };
}
function errorCode(error: unknown): string {
    return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'template_unavailable';
}
type SavedSecrets = Extract<DeploymentTemplateInstantiateResultV1, { kind: 'applied' }>['savedSecrets'];
type TemplateCreateEnvironment = Extract<DeploymentTemplateInstantiateInputV1['environment'], { kind: 'create' }>;
type TemplatePreparationInput = Omit<DeploymentTemplateInstantiateInputV1, 'environment' | 'target'> & Readonly<{
    target?: DeploymentTemplateInstantiateInputV1['target'];
    environment: Exclude<DeploymentTemplateInstantiateInputV1['environment'], { kind: 'create' }>
        | Omit<TemplateCreateEnvironment, 'controllerMachineId'> & { controllerMachineId?: string };
}>;
type TemplateAppliedResult = Extract<DeploymentTemplateInstantiateResultV1, { kind: 'applied' }>;
type TemplatePreparationResult = Exclude<DeploymentTemplateInstantiateResultV1, TemplateAppliedResult>
    | Omit<TemplateAppliedResult, 'targetLinkId'> & { targetLinkId?: string }
    | ActionExecuteFailure;
function projectTemplateResult(result: TemplatePreparationResult): DeploymentTemplateInstantiateResultV1 | ActionExecuteFailure {
    return 'kind' in result && result.kind === 'applied'
        ? { ...result, targetLinkId: result.targetLinkId ?? refuse('target_mismatch') } : result;
}
type Host = Readonly<{
    credentials: StoredCredentials; serverId: string; machineId: string; serverHttpBaseUrl: string;
    savedSecretOperationContext?: SavedSecretOperationContextV1;
    readMachineVitals?: () => MachineVitalsSampleV1 | null;
    readInstallation(machineId: string, context: ActionExecutorContext): Promise<string>;
    assertCurrent(context: ActionExecutorContext): Promise<void>;
    headers(context: ActionExecutorContext, actionId: string, request: Readonly<{ method: string; path: string; body?: unknown }>): Promise<Readonly<Record<string, string>>>;
    storage: NonNullable<ActionExecutorDeps['deploymentAction']>;
    sharedRepositoryWorkspace?: Readonly<{ readWorkspaceRows: CliAdmittedProjectRowsReader; readSource: NonNullable<ActionExecutorDeps['projectSourcesRead']> }>;
    /** Every repository effect stays inside the admitted checkout on this Machine. */
    repositoryFiles?: (cwd: string, context: ActionExecutorContext) => RepositoryFilesPullRequestHost;
    deploy?(input: DeploymentDeployIntentInputV1, context: ActionExecutorContext, source?: Readonly<{ id: string; revision: number }>): ReturnType<NonNullable<ActionExecutorDeps['deploymentAction']>>;
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
        if (!source.ok) return refuse('errorCode' in source ? source : source.error);
        if (source.source.id !== projectSourceId || !source.canManage) return refuse('source_access_denied');
        return source;
    }
    async function readPinnedTemplate(input: Pick<DeploymentTemplateInstantiateInputV1, 'templateRef' | 'appMappingCorrection'>, context: ActionExecutorContext) {
        return readPinnedDeploymentTemplateForHost(input.templateRef, { credentials: host.credentials, signal: context.signal,
            operationContext: host.savedSecretOperationContext }, input.appMappingCorrection);
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
        creationReview?: DeploymentTemplateInstantiationReviewV1,
        executeCanonicalAction?: (actionId: ActionId, input: unknown) => Promise<ActionExecuteResult>) {
        // Receiver identity is checked before any fetch, entropy, Artifact or native acquisition.
        if (input.serverId !== host.serverId || input.environment.kind === 'create'
            && input.environment.controllerMachineId !== undefined
            && input.environment.controllerMachineId !== host.machineId) return refuse('target_mismatch');
        if (!input.target && (input.domainBindings?.length || readDeploymentTemplateDeployIntentV1(input))) {
            return refuse(actionInputIssueFailure({ code: 'custom', path: ['firstTargetLink'] }));
        }
        await host.assertCurrent(context);
        const source = input.projectSourceId ? await readProjectSource(input.projectSourceId, context) : undefined;
        const current = input.environment.kind === 'existing'
            ? await host.readEnvironment({ environmentId: input.environment.environmentId, context }) : undefined;
        // Catalog preview may still be resolving creation defaults. An authored
        // controller or persisted Environment always owns the original root.
        if (current && input.destination.kind !== 'repositoryPullRequest' && current.environment.controllerMachineId !== host.machineId
            || input.target && await host.readInstallation(input.machineId, context) !== input.target.installationId) return refuse('target_mismatch');
        if (current) {
            const target = input.target ?? refuse('target_mismatch');
            if (input.environment.kind !== 'existing' || current.environment.id !== input.environment.environmentId
                || current.environment.projectSourceId !== input.projectSourceId || !current.environment.capabilities.manage
                || !current.environment.capabilities.manageBindings) return refuse('deployment_access_denied');
            if (current.environment.revision !== input.environment.expectedRevision
                || current.content.definition.kind !== (input.destination.kind === 'repositoryPullRequest' ? 'repository' : 'stored')
                || 'contentRevision' in input.destination && (current.content.definition.kind !== 'stored' || current.content.definition.contentRevision !== input.destination.contentRevision
                    || current.content.definition.composeDigest !== input.destination.composeDigest)) return refuse('deployment_conflict');
            if (target.kind === 'existing') {
                const selectedTarget = target;
                const link = current.targetLinks.find(item => item.targetLink.id === selectedTarget.targetLinkId)?.targetLink;
                if (!link || link.role !== 'runtime' || link.targetKind !== 'ownServer' || link.deletedAtMs !== undefined
                    || link.detachedAtMs !== undefined || link.revision !== target.expectedRevision
                    || current.environment.runtimeTargetLinkId !== link.id
                    || !link.members.some(member => member.machineId === input.machineId && member.installationId === target.installationId)) return refuse('target_mismatch');
            } else if (current.environment.runtimeTargetLinkId || !current.environment.capabilities.manageTargets
                || !context.actionRequestId) return refuse('target_mismatch');
        }
        const template = await readPinnedTemplate(input, context);
        const sourceDocument = await parseNativeComposeSource(template.compose.document);
        let repositoryFiles: RepositoryFilesPullRequestHost | undefined;
        let repositoryCwd: string | undefined;
        let existingDocument = current?.content.definition.kind === 'stored' ? current.content.definition.document : undefined;
        let repositoryPublicFiles: { path: string; content: string }[] | undefined;
        if (input.destination.kind === 'repositoryPullRequest') {
            const destination = input.destination;
            const ports = host.sharedRepositoryWorkspace ?? refuse('workspace_unavailable');
            if (!current || current.content.definition.kind !== 'repository' || !source) return refuse('source_changed');
            if (current.content.definition.compose?.path !== destination.composePath) return refuse('source_changed');
            const resolved = await resolveAdmittedRepositoryWorkspace({ workspace: destination.workspace,
                expected: { projectSourceId: source.source.id, sourceRevision: destination.sourceRevision, repository: destination.repository },
                context, readWorkspaceRows: ports.readWorkspaceRows, fallbackActionId: actionId });
            if ('ok' in resolved) return refuse(resolved);
            if (resolved.kind !== 'resolved') return refuse(resolved.reason);
            if (resolved.workspace.machineId !== host.machineId) return refuse('target_mismatch');
            repositoryCwd = resolved.workspace.rootPath;
            repositoryFiles = host.repositoryFiles?.(repositoryCwd, context) ?? refuse('credential_scope_denied');
            const native = await validateAdmittedRepositoryWorkspace({ workspace: resolved.workspace,
                projectSourceId: source.source.id, sourceRevision: destination.sourceRevision, repository: destination.repository,
                baseCommit: destination.baseCommit, context, readSource: ports.readSource, admittedSource: source.source,
                readScmStatus: () => repositoryFiles!.executeScm('scm.status.snapshot', { cwd: repositoryCwd, includeWorktreeStatus: false }) });
            if ('ok' in native) return refuse(native);
            if (native.kind !== 'validated') return refuse(native.reason);
            const before = await prepareRepositoryFilesPullRequest({ cwd: repositoryCwd, ...destination,
                files: [{ path: destination.composePath, content: '' }] }, repositoryFiles);
            existingDocument = before.files[0]?.before ?? refuse('compose_missing');
            repositoryPublicFiles = [];
        }
        const existingSource = existingDocument ? await parseNativeComposeSource(existingDocument) : undefined;
        const currentInput = current && existingSource ? { content: current.content, source: existingSource,
            ...(repositoryPublicFiles ? { publicFiles: repositoryPublicFiles } : {}) } : undefined;
        const recorded = resolveDeploymentTemplateInstantiationBaselineRefV1({ templateRef: input.templateRef, source: sourceDocument, current: currentInput,
            intent: input.intent });
        const baselineTemplate = recorded ? await readPinnedTemplate({ templateRef: recorded }, context).catch(error => {
                if (error instanceof RegistryFetchErrorV1 && error.code !== 'auth_failed') return refuse('template_source_unavailable');
                throw error;
            }) : undefined;
        const baseline = recorded && baselineTemplate ? { templateRef: recorded,
            source: await parseNativeComposeSource(baselineTemplate.compose.document), publicFiles: baselineTemplate.compose.publicFiles } : undefined;
        if (input.destination.kind === 'repositoryPullRequest' && repositoryFiles && repositoryCwd && currentInput) {
            const destination = input.destination;
            const paths = [...new Set([...(template.compose.publicFiles ?? []), ...(baseline?.publicFiles ?? [])].map(file => file.path))];
            const before = await prepareRepositoryFilesPullRequest({ cwd: repositoryCwd, ...destination,
                files: paths.map(path => ({ path: posix.join(posix.dirname(destination.composePath), path), content: '' })) }, repositoryFiles);
            currentInput.publicFiles = before.files.flatMap((file, index) => file.before === null ? [] : [{ path: paths[index]!, content: file.before }]);
        }
        // Snapshot the existing sampler once, only when declared memory needs it.
        // No new collection, timer, freshness budget or Docker-filesystem guess.
        const sample = template.minimumResources?.memoryBytes !== undefined && input.target && input.machineId === host.machineId
            ? host.readMachineVitals?.() : undefined;
        const prepareInput = { template, templateRef: input.templateRef, source: sourceDocument, intent: input.intent,
            ...(sample ? { targetResources: { sampledAt: sample.sampledAt,
                ...(sample.memory.reported ? { memoryBytes: sample.memory.totalBytes } : {}) } } : {}),
            ...(currentInput ? { current: { ...currentInput, ...(baseline ? { baseline } : {}) } } : {}),
            bindings: input.bindings, connectTo: input.connectTo, replace: input.replace, domainBindings: input.domainBindings,
            volumeBindings: input.volumeBindings, companions: input.companions };
        const prepared = prepareDeploymentTemplateInstantiationV1(prepareInput);
        const candidateDefinition = { kind: 'stored' as const,
            composeDigest: storedComposeDefinitionDigest(prepared),
            document: prepared.document, profiles: prepared.profiles, services: prepared.services,
            ...(prepared.publicFiles === undefined ? {} : { publicFiles: prepared.publicFiles }),
            ...(prepared.primaryService ? { primaryService: prepared.primaryService } : {}) };
        // Repository proposals use the stored parser for review only; they do not
        // transition the Environment's definition owner to stored content.
        const contentRevision = resolveDeploymentStoredDefinitionRevisionV1(
            input.destination.kind === 'repositoryPullRequest' ? undefined : current?.content.definition, candidateDefinition);
        if (contentRevision === null) return refuse('deployment_conflict');
        const definition = { ...candidateDefinition, contentRevision };
        await admitStoredComposeDefinition(definition);
        // Every install root reviews selected-Domain deployment before allocating its Environment.
        const deployIntent = readDeploymentTemplateDeployIntentV1(input);
        if (!input.deploy && deployIntent) {
            input = { ...input, deploy: creationReview?.deploy ?? deployIntent };
        }
        const name = current?.content.name ?? (input.environment.kind === 'create' ? input.environment.name : '');
        const projectOwner = input.newProject?.owner ?? source?.source.owner
            ?? (source ? { kind: 'account' as const, accountId: source.source.createdByAccountId } : refuse('invalid_parameters'));
        const defaultInputs: DeploymentCreationDefaultInputsForHost = input.environment.kind === 'create' && !creationReview?.creationDefaults ? await host.readCreationDefaultInputs({ projectSourceId: input.projectSourceId,
            sourceRevision: source?.source.revision, projectOwner, context, actionId }) : {};
        const defaults = creationReview?.creationDefaults ?? resolveDeploymentCreationDefaultsV1({ projectSourceId: input.projectSourceId,
            projectOwner, ...defaultInputs,
            target: { kind: 'ownServer', machines: input.target ? [input.machineId] : [] },
            explicit: input.environment.kind === 'create' ? { controllerMachineId: input.environment.controllerMachineId,
                ...(input.environment.buildMachineId ? { buildMachineId: input.environment.buildMachineId } : {}),
                ...(input.environment.retainPreviousDeployments === undefined ? {} : { retainPreviousDeployments: input.environment.retainPreviousDeployments }) } : undefined });
        const content = DeploymentEnvironmentContentV1Schema.parse(current ? { ...current.content, definition }
            : { name, retainPreviousDeployments: defaults.values.retainPreviousDeployments, definition, bindings: [],
                ownServer: createOwnServerEnvironmentConfigurationV1() });
        for (const secret of prepared.generatedSecrets) validateDeploymentTemplateGeneratedSecretProfileForHost({ name: `${name} · ${secret.name}`, profile: secret.profile });
        context.signal?.throwIfAborted();
        const review: DeploymentTemplateInstantiationReviewV1 = { templateRef: input.templateRef,
            document: prepared.document,
            profiles: prepared.profiles, services: prepared.services, ...(prepared.primaryService ? { primaryService: prepared.primaryService } : {}),
            bindings: prepared.bindings, generatedSecrets: prepared.generatedSecrets, domains: prepared.domains,
            capacity: prepared.capacity, connectToServices: prepared.connectToServices,
            ...(prepared.publicFiles === undefined ? {} : { publicFiles: prepared.publicFiles }),
            ...(input.deploy ? { deploy: input.deploy } : {}),
            ...(prepared.template.firstRunSetup ? { firstRunSetup: prepared.template.firstRunSetup } : {}),
            ...(input.environment.kind === 'create' ? { creationDefaults: defaults,
                ...(creationReview?.creationDefaultsBasis ?? defaultInputs.reviewBasis
                    ? { creationDefaultsBasis: creationReview?.creationDefaultsBasis ?? defaultInputs.reviewBasis } : {}) } : {}),
            ...(template.minimumResources ? { minimumResources: template.minimumResources } : {}) };
        const repositoryReview = input.destination.kind === 'repositoryPullRequest' && repositoryFiles && repositoryCwd
            ? await prepareRepositoryFilesPullRequest({ cwd: repositoryCwd, ...input.destination,
                files: [{ path: input.destination.composePath, content: prepared.document },
                    ...[...new Set([...(currentInput?.publicFiles ?? []), ...(prepared.publicFiles ?? [])].map(file => file.path))]
                        .map(path => ({ path: posix.join(posix.dirname(input.destination.kind === 'repositoryPullRequest' ? input.destination.composePath : ''), path),
                            content: prepared.publicFiles?.find(file => file.path === path)?.content ?? null }))] }, repositoryFiles) : undefined;
        if (repositoryReview && input.destination.kind === 'repositoryPullRequest') review.repositoryChange = { ...input.destination,
            files: repositoryReview.files.map(({ path, before, content }) => ({ path, before, content })) };
        // Source access and ownership belong to this admission. Later finite writes
        // consume these facts and stop only on the admitted invocation's cancellation.
        const contentAuthority = { owner: projectOwner, async assertCurrent() { context.signal?.throwIfAborted(); } };
        return { input, current, prepared, prepareInput, definition, review, name, defaults, content, contentAuthority, repositoryReview,
            source: source ? { id: source.source.id, revision: source.source.revision } : undefined };
    }
    function prepare(raw: DeploymentTemplateInstantiateInputV1, context: ActionExecutorContext,
        creationReview?: DeploymentTemplateInstantiationReviewV1,
        executeCanonicalAction?: (actionId: ActionId, input: unknown) => Promise<ActionExecuteResult>) {
        return prepareInput(DeploymentTemplateInstantiateInputV1Schema.parse(raw), context,
            context.externalActionExecutionAuthorization?.binding.actionId === 'deployments.environments.create'
                ? 'deployments.environments.create' : 'deployments.templates.instantiate', creationReview, executeCanonicalAction);
    }
    /** P40's catalog create is an adapter into this same P45 preparation and apply owner. */
    function fromCreate(input: DeploymentEnvironmentCreateIntentInputV1): TemplatePreparationInput {
        const target = input.firstTargetLink?.machines[0];
        if (input.definition?.from !== 'catalogApp' || input.purpose !== 'standard'
            || input.firstTargetLink && input.firstTargetLink.machines.length !== 1 || input.copyFrom) return refuse('unsupported_action');
        return { mode: input.mode ?? 'apply', serverId: input.serverId, machineId: target?.machineId ?? host.machineId,
            managedRetention: input.managedRetention,
            projectSourceId: input.projectSourceId, newProject: input.newProject, templateRef: input.definition.templateRef,
            environment: { kind: 'create', name: input.name, requestKey: input.requestKey,
                protection: input.protection, purpose: 'standard', deployerMode: input.deployerMode,
                deployerPrincipals: input.deployerPrincipals, controllerMachineId: input.controllerMachineId,
                buildMachineId: input.buildMachineId, retainPreviousDeployments: input.retainPreviousDeployments },
            ...(target ? { target: { kind: 'new' as const, installationId: target.installationId } } : {}), destination: { kind: 'stored' },
            bindings: input.bindings ?? [], generatedSecretAudience: input.generatedSecretAudience, domainBindings: input.domainBindings };
    }
    async function instantiate(raw: DeploymentTemplateInstantiateInputV1, context: ActionExecutorContext,
        reviewed?: DeploymentTemplateInstantiationReviewV1,
        creationReview?: DeploymentTemplateInstantiationReviewV1,
        executeCanonicalAction?: (actionId: ActionId, input: unknown) => Promise<ActionExecuteResult>): Promise<DeploymentTemplateInstantiateResultV1 | ActionExecuteFailure> {
        try {
            const plan = await prepare(raw, context, creationReview, executeCanonicalAction);
            if (reviewed && !areDeploymentTemplateReviewFactsEqualV1(reviewed, plan.review)) return failure('deployment_conflict');
            return projectTemplateResult(await instantiatePrepared(plan, context, executeCanonicalAction));
        } catch (error) { return failure(context.signal?.aborted ? 'cancelled' : errorCode(error), error); }
    }
    async function instantiatePrepared(plan: Awaited<ReturnType<typeof prepareInput>>, context: ActionExecutorContext,
        executeCanonicalAction?: (actionId: ActionId, input: unknown) => Promise<ActionExecuteResult>): Promise<TemplatePreparationResult> {
        const savedSecrets: SavedSecrets = [];
        let phase: Extract<DeploymentTemplateInstantiateResultV1, { kind: 'partial' }>['phase'] = 'generation';
        let environmentId: string | undefined; let revision: number | undefined; let targetLinkId: string | undefined;
        let appliedDefinition: Extract<DeploymentTemplateInstantiateResultV1, { kind: 'applied' }>['definition'] | undefined;
        let unknownSecret: Extract<DeploymentTemplateInstantiateResultV1, { kind: 'partial' }>['unknownSecret'];
        let deployment: Extract<DeploymentTemplateInstantiateResultV1, { kind: 'partial' }>['deployment'];
        let repositoryChange: Extract<DeploymentTemplateInstantiateResultV1, { kind: 'partial' }>['repositoryChange'];
        let effectIssued = false;
        try {
            if (plan.input.mode === 'preview') return { kind: 'preview', review: plan.review };
            const reviewedChild = context.hostReviewedChild;
            if (!reviewedChild) return failure('credential_scope_denied');
            const { input } = plan;
            const createContent = (content: unknown, kind: string) => host.createContent(content, kind, context, plan.contentAuthority);
            const bindings: StoredAppPresetInputV1['bindings'] = [...plan.prepared.bindings];
            const generatedSecretAudience = input.generatedSecretAudience
                ?? buildCatalogAppTemplateBindings(plan.prepareInput.template).generatedSecretAudience;
            for (const secret of plan.prepared.generatedSecrets) {
                context.signal?.throwIfAborted();
                effectIssued = true;
                try {
                    const source = await createDeploymentTemplateGeneratedSecretForHost({ name: `${plan.name} · ${secret.name}`, profile: secret.profile,
                        audience: generatedSecretAudience ?? refuse('invalid_parameters'),
                        expectedScopeKey: resolveAccountSettingsScopeKey(host.credentials), signal: context.signal ?? new AbortController().signal,
                        readCredentials: async () => host.credentials,
                        operationContext: host.savedSecretOperationContext });
                    savedSecrets.push({ name: secret.name, phase: secret.phase, source });
                    bindings.push({ purpose: 'variable', name: secret.name, phase: secret.phase, source });
                } catch (error) {
                    const details = error && typeof error === 'object' && 'details' in error ? error.details : undefined;
                    if (errorCode(error) === 'outcome_unknown' && details && typeof details === 'object'
                        && 'candidateRef' in details && typeof details.candidateRef === 'string') unknownSecret = { name: secret.name, phase: secret.phase, ref: details.candidateRef };
                    throw error;
                }
            }
            const finalPrepared = prepareDeploymentTemplateInstantiationV1({ ...plan.prepareInput, bindings });
            const defaults = plan.defaults;
            const storagePreparation = { creationDefaults: defaults, template: plan.review,
                templateBindingCaptures: captureDeploymentBindingSavedSecretRevisionsV1(finalPrepared.bindings)
                    .map(({ resourceId, revision }) => ({ resourceId, revision })) };
            const commitBindings = async (set: DeploymentEnvironmentDetailV1['content']['bindings']) => {
                const applied = await reviewedChild.invoke({ action: DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1,
                    role: deploymentTemplateBindingsChildRole, input: normalizeStrictJsonValue({ serverId: input.serverId,
                        environmentId: environmentId!, expectedRevision: revision!, set, remove: [] }) });
                if (!applied.ok) return refuse(applied);
                const parsedOutput = DeploymentBindingsSetResultV1Schema.safeParse(applied.result);
                if (!parsedOutput.success) return refuse(deploymentOutputValidationFailure('deployments.bindings.set', undefined, parsedOutput.error));
                const parsed = parsedOutput.data;
                if (!parsed.ok) return refuse(parsed.error);
                environmentId = parsed.environmentId; revision = parsed.revision;
            };
            const commit = async (actionId: 'deployments.environments.create' | 'deployments.environments.update', input: Parameters<Host['storage']>[1]) => {
                const result = await host.storage(actionId, input, context, storagePreparation);
                if ('errorCode' in result) return refuse(result);
                const parsedOutput = DeploymentEnvironmentCreateResultV1Schema.safeParse(result);
                if (!parsedOutput.success) return refuse(deploymentOutputValidationFailure('deployments.environments.commit', undefined, parsedOutput.error));
                const parsed = parsedOutput.data;
                if (!parsed.ok) return refuse(parsed.error);
                environmentId = parsed.environmentId; revision = parsed.revision;
            };
            if (input.destination.kind === 'repositoryPullRequest') {
                phase = 'repository';
                const repositoryReview = plan.repositoryReview ?? refuse('workspace_unavailable');
                const files = host.repositoryFiles?.(repositoryReview.cwd, context) ?? refuse('credential_scope_denied');
                effectIssued = true;
                const published = await openRepositoryFilesPullRequest(repositoryReview, files);
                repositoryChange = published;
                if (published.kind === 'partial') return { kind: 'partial', phase, errorCode: published.errorCode,
                    environmentId: plan.current!.environment.id, revision: plan.current!.environment.revision,
                    savedSecrets, repositoryChange: published };
                const current = plan.current ?? refuse('deployment_unavailable');
                environmentId = current.environment.id; revision = current.environment.revision;
                const merged = new Map(current.content.bindings.map(binding => [environmentSecretBindingIdentityV1(binding), binding]));
                for (const binding of finalPrepared.bindings) merged.set(environmentSecretBindingIdentityV1(binding), binding);
                const content = DeploymentEnvironmentContentV1Schema.parse({ ...current.content, bindings: [...merged.values()] });
                phase = 'bindings';
                await commitBindings(content.bindings);
                phase = 'metadata';
                const metadata = await commitTemplateMetadata(DeploymentEnvironmentContentV1Schema.parse({ ...content,
                    template: { ...finalPrepared.template, definition: current.content.definition } }), environmentId, revision, input, context, plan.contentAuthority);
                return { kind: 'pullRequest', environmentId, revision: metadata.revision, savedSecrets,
                    pullRequest: published.pullRequest, headCommit: published.headCommit, branchName: published.branchName };
            }
            const candidateDefinition = { kind: 'stored' as const, contentRevision: plan.definition.contentRevision, composeDigest: plan.definition.composeDigest };
            let content = DeploymentEnvironmentContentV1Schema.parse(plan.current ? plan.content
                : { ...plan.content, template: { ...finalPrepared.template, definition: candidateDefinition } });
            phase = 'environment';
            effectIssued = true;
            const artifact = await createContent(content, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1);
            if (input.environment.kind === 'existing') {
                await commit('deployments.environments.update', { serverId: input.serverId, environmentId: input.environment.environmentId,
                    expectedRevision: input.environment.expectedRevision, ...artifact });
            } else {
                const firstTargetLink = input.target ? {
                    ...await createContent({}, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1),
                    machines: [{ machineId: input.machineId, installationId: input.target.installationId }],
                } : undefined;
                await commit('deployments.environments.create', { serverId: input.serverId, projectSourceId: input.projectSourceId, newProject: input.newProject,
                    requestKey: input.environment.requestKey, protection: input.environment.protection, purpose: input.environment.purpose,
                    deployerMode: input.environment.deployerMode,
                    ...(input.environment.deployerPrincipals === undefined ? {} : { deployerPrincipals: input.environment.deployerPrincipals }),
                    controllerMachineId: defaults.values.controllerMachineId ?? refuse('target_mismatch'),
                    buildMachineId: defaults.values.buildMachineId, ...artifact,
                    ...(firstTargetLink ? { firstTargetLink } : {}) });
            }
            appliedDefinition = { kind: 'stored', contentRevision: plan.definition.contentRevision, composeDigest: plan.definition.composeDigest };
            phase = 'target';
            if (input.target?.kind === 'new' && input.environment.kind === 'existing') {
                const linked = await host.storage('deployments.targets.link', { serverId: input.serverId,
                    environmentId: environmentId!, expectedRevision: revision!, requestKey: context.actionRequestId!,
                    targetId: 'own-server', role: 'runtime', machines: [{ machineId: input.machineId, installationId: input.target.installationId }],
                    ...await createContent({}, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1) }, context);
                if ('errorCode' in linked) return refuse(linked);
                const result = DeploymentTargetLinkResultV1Schema.parse(linked);
                if (!result.ok) return refuse(result.error);
                revision = result.revision; targetLinkId = result.targetLinkId;
            }
            const created = await host.readEnvironment({ environmentId: environmentId ?? refuse('deployment_unavailable'), context });
            targetLinkId = created.environment.runtimeTargetLinkId;
            const selectedTarget = input.target;
            if (selectedTarget && (!targetLinkId || !created.targetLinks.some(item => item.targetLink.id === targetLinkId
                && item.targetLink.members.some(member => member.machineId === input.machineId && member.installationId === selectedTarget.installationId)))) return refuse('target_mismatch');
            phase = 'bindings';
            const merged = new Map(content.bindings.map(binding => [environmentSecretBindingIdentityV1(binding), binding]));
            for (const binding of finalPrepared.bindings) merged.set(environmentSecretBindingIdentityV1(binding), binding);
            content = DeploymentEnvironmentContentV1Schema.parse({ ...content, bindings: [...merged.values()] });
            await commitBindings(content.bindings);
            if (input.environment.kind === 'existing') {
                phase = 'metadata';
                const finalContent = DeploymentEnvironmentContentV1Schema.parse({ ...content, template: { ...finalPrepared.template, definition: appliedDefinition } });
                const result = await commitTemplateMetadata(finalContent, environmentId!, revision!, input, context, plan.contentAuthority);
                environmentId = result.environmentId; revision = result.revision;
            }
            if (input.deploy) {
                phase = 'deploy';
                if (!host.deploy) return refuse('unsupported_action');
                let source = plan.source;
                if (!source && input.newProject) {
                    // Home projects metadata through this create's admitted allocation;
                    // this is not a new Source/Team permission decision.
                    const loaded = await sources.projectSourcesRead!({ serverId: input.serverId,
                        sourceId: created.environment.projectSourceId }, context);
                    if (!loaded.ok) return refuse('errorCode' in loaded ? loaded : loaded.error);
                    source = { id: loaded.source.id, revision: loaded.source.revision };
                }
                const result = await host.deploy({ serverId: input.serverId, environmentId: environmentId!, targetLinkId: targetLinkId ?? refuse('target_mismatch'),
                    requestKey: input.deploy.requestKey, sourceIntent: plan.definition }, context, source);
                if ('errorCode' in result) {
                    const retained = DeploymentReceiptSettlementFailureDetailsV1Schema.safeParse(result.details);
                    if (retained.success) {
                        deployment = projectDeploymentReceiptSettlementAcceptedResultV1(retained.data);
                        revision = deployment.revision;
                    }
                    return refuse(result);
                }
                const accepted = DeploymentReceiptAcceptedResultV1Schema.safeParse(result);
                if (!accepted.success) return refuse('ok' in result && !result.ok && 'error' in result ? result.error : deploymentOutputValidationFailure('deployments.deploy', undefined, accepted.error));
                deployment = accepted.data;
                revision = deployment.revision;
                if ('kind' in deployment) return refuse('deployment_in_progress');
                if (deployment.state !== 'succeeded' && deployment.state !== 'running_unverified') return refuse(
                    deployment.state === 'failed' ? 'deployment_failed' : deployment.state === 'cancelled' ? 'cancelled'
                        : deployment.state === 'outcome_unknown' ? 'outcome_unknown' : 'deployment_in_progress');
            }
            if (finalPrepared.domains.length) {
                phase = 'domains';
                // Successful deploy settlement advances the runtime Link revision.
                const domainEnvironment = input.deploy
                    ? await host.readEnvironment({ environmentId: created.environment.id, context }) : created;
                const link = domainEnvironment.targetLinks.find(item => item.targetLink.id === targetLinkId)!.targetLink;
                for (const domain of finalPrepared.domains) {
                    const domainContent: DeploymentDomainContentV1 = { hostname: domain.hostname,
                        target: { service: domain.service, containerPort: domain.containerPort,
                            ...(domain.path ? { path: domain.path } : {}) },
                        ...(domain.healthCheck ? { healthCheck: domain.healthCheck } : {}) };
                    // Give each selected declaration a stable identity within this admitted install attempt.
                    const key = createHash('sha256').update(JSON.stringify([
                        environmentId, input.environment.kind === 'create' ? input.environment.requestKey : context.actionRequestId,
                        domain.key,
                    ])).digest('hex');
                    const result = await context.hostReviewedChild!.invoke({ action: 'deployments.domains.add',
                        role: deploymentTemplateDomainChildRole(domain.key), input: normalizeStrictJsonValue({
                            serverId: input.serverId, environmentId, targetLinkId, expectedRevision: revision,
                            expectedTargetLinkRevision: link.revision, domainId: `template-${key}`, requestKey: `template-domain-${key}`,
                            content: domainContent,
                        }) });
                    if (!result.ok) return refuse(result);
                    const settled = DeploymentDomainMutationResultV1Schema.safeParse(result.result);
                    if (!settled.success) return refuse(deploymentOutputValidationFailure('deployments.domains.add', undefined, settled.error));
                    if (!settled.data.ok) return refuse(settled.data.error);
                    revision = settled.data.revision;
                    if (settled.data.domain.state === 'failed') return refuse('native_route_unavailable');
                }
            }
            return { kind: 'applied', environmentId: environmentId!, revision: revision!, targetLinkId, definition: appliedDefinition, savedSecrets,
                ...(deployment ? { deployment } : {}) };
        } catch (error) {
            const code = context.signal?.aborted && !effectIssued ? 'cancelled' : errorCode(error);
            if (!effectIssued) return failure(code, error);
            const authorizationFailure = readDeploymentAuthorizationFailure(error);
            const diagnostic = authorizationFailure ?? failure(code, error);
            const domainFailure = phase === 'domains' ? DeploymentDomainFailureDetailsV1Schema.safeParse(diagnostic.details) : undefined;
            const recovery = projectDeploymentFailureRecoveryV1(isRecord(diagnostic.details) ? diagnostic.details : {}, code);
            const partial: Extract<DeploymentTemplateInstantiateResultV1, { kind: 'partial' }> = { kind: 'partial', phase, errorCode: code, savedSecrets,
                requiredFact: recovery.requiredFact, remedy: recovery.remedy,
                ...(domainFailure?.success ? { failure: domainFailure.data } : {}),
                ...(environmentId ? { environmentId, revision } : {}), ...(targetLinkId ? { targetLinkId } : {}),
                ...(deployment ? { deployment } : {}),
                ...(repositoryChange ? { repositoryChange } : {}),
                ...(appliedDefinition ? { definition: appliedDefinition } : {}), ...(unknownSecret ? { unknownSecret } : {}) };
            return authorizationFailure || diagnostic.failureCause || readActionOutputDiagnostic(diagnostic)
                ? { ...diagnostic, details: partial, effectAttempted: true } : partial;
        }
    }
    async function commitTemplateMetadata(content: DeploymentEnvironmentDetailV1['content'], environmentId: string, revision: number,
        input: TemplatePreparationInput, context: ActionExecutorContext, authority: Parameters<Host['createContent']>[3]) {
        const body = DeploymentEnvironmentTemplateSetInputV1Schema.parse({ serverId: context.externalActionExecutionAuthorization?.binding.serverIdentityId ?? input.serverId,
            environmentId, expectedRevision: revision, ...await host.createContent(content, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, context, authority) });
        const path = `/v1/deployments/environments/${encodeURIComponent(body.environmentId)}/template`;
        const headers = await host.headers(context, 'deployments.templates.instantiate', { method: 'POST', path, body });
        const response = await axios.request<unknown>({ method: 'POST', url: `${host.serverHttpBaseUrl}${path}`, headers, data: body,
            signal: context.signal, validateStatus: () => true }).catch(error => refuse(classifyHomeDomainHttpMutationFailureV1({
                error, issued: true, aborted: context.signal?.aborted === true })));
        const result = DeploymentEnvironmentCreateResultV1Schema.safeParse(response.data);
        if (!result.success) return refuse('outcome_unknown');
        if (!result.data.ok) return refuse(result.data.error);
        return result.data;
    }
    function projectCreateResult(result: TemplatePreparationResult) {
        if ('kind' in result && result.kind === 'partial') return { ok: false as const, effectAttempted: true,
            errorCode: result.errorCode, error: result.errorCode, details: result };
        return 'errorCode' in result ? result : result.kind === 'applied'
            ? { ok: true as const, environmentId: result.environmentId, revision: result.revision }
            : deploymentOutputValidationFailure('templates/instantiate', undefined);
    }
    function admittedPreparation(plan: Awaited<ReturnType<typeof prepareInput>>, create: boolean): HostReviewedChildrenPreparationV1 {
        return { ...deploymentTemplateReviewedChildren(plan.review), async executeAdmittedAction({ context }): Promise<ActionExecuteResult> {
            const result = await instantiatePrepared(plan, context);
            if (create) {
                const projected = projectCreateResult(result);
                return projected.ok ? { ok: true, result: projected } : projected;
            }
            if ('kind' in result && result.kind === 'partial') return { ok: false, effectAttempted: true, errorCode: result.errorCode, error: result.errorCode, details: result };
            if ('errorCode' in result) return result;
            return { ok: true, result: projectTemplateResult(result) };
        } };
    }
    return { instantiate, preparePublishEntry,
        async prepareCreate(input: DeploymentEnvironmentCreateIntentInputV1, context: ActionExecutorContext,
            review?: DeploymentEnvironmentCreationReviewV1) {
            try {
                const plan = await prepareInput(fromCreate(input), context, 'deployments.environments.create', review?.template);
                if (!plan.defaults.values.controllerMachineId) return failure('client_required');
                return { input: { ...input, mode: 'apply' as const, ...plan.defaults.values },
                    hostReviewedChildren: admittedPreparation(plan, true), preview: normalizeStrictJsonValue({
                    creationDefaults: plan.defaults, ...(plan.review.creationDefaultsBasis ? { creationDefaultsBasis: plan.review.creationDefaultsBasis } : {}),
                    template: plan.review,
                }) };
            } catch (error) { return failure(context.signal?.aborted ? 'cancelled' : errorCode(error), error); }
        },
        async instantiateCreate(input: DeploymentEnvironmentCreateIntentInputV1, context: ActionExecutorContext,
            review?: DeploymentEnvironmentCreationReviewV1) {
            try {
                const plan = await prepareInput(fromCreate(input), context, 'deployments.environments.create', review?.template);
                if (review?.template && !areDeploymentTemplateReviewFactsEqualV1(review.template, plan.review)) return failure('deployment_conflict');
                const result = await instantiatePrepared(plan, context);
                return projectCreateResult(result);
            } catch (error) { return failure(context.signal?.aborted ? 'cancelled' : errorCode(error), error); }
        },
        async prepare(input: DeploymentTemplateInstantiateInputV1, context: ActionExecutorContext,
            executeCanonicalAction?: (actionId: ActionId, input: unknown) => Promise<ActionExecuteResult>) {
        try {
            const plan = await prepare(input, context, undefined, executeCanonicalAction);
            return { input: DeploymentTemplateInstantiateInputV1Schema.parse(plan.input), preview: normalizeStrictJsonValue(plan.review),
                hostReviewedChildren: admittedPreparation(plan, false) };
        }
        catch (error) { return failure(errorCode(error), error); }
    } };
}
