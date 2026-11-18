import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { ProcessEnvInput } from '@/utils/processEnv/buildScopedProcessEnv';
import type { createWorkspaceExecutionConfigClientV1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigClientV1';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { ApiMachineClient } from '@/api/apiMachine';
import type { HostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import type { ProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import type { ProjectSetupExecutionInput, ProjectSetupSettlement } from './projectSetupExecution';
import type { ProjectSetupPreparationInput } from './projectSetupPreparation';
import { projectRuntimeAccountRowsInput, type ProjectRuntimeAccountAccess } from '@/workspaces/projectAccountRows';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { WorkspaceSyncPrepareBetweenResultV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { ProjectDefinitionInspectRead, ProjectDefinitionInspectOutput } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { projectWorkspaceRefV1, workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { WorkspaceSyncWorkerTargetBasis } from '@/workspaces/sync/workspaceSyncPreparation';
import { FiniteAdmissionV1Schema } from '@happier-dev/protocol/workspaces/projectWorkerExecutionV1';
import { createHash } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { PROJECT_ACTION_INPUT_SCHEMAS_V1, ProjectWorkerNoAcceptanceFailureDetailsV1Schema,
    readProjectSetupConsentFailureV1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { resolveProjectExecutionChoiceV1, projectExecutionChoicesEqualV1, type ProjectExecutionChoiceV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import { assertProjectReceivingPlacement } from '@/workspaces/execution/projectReceivingPlacement';
import { prepareProjectWorktreeRuntime } from '@/workspaces/execution/projectWorktreeRuntime';
import { PROJECT_PREPARE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/projectActionIdsV1';
import type { ActionExecuteResult, ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ProjectNativeToolchainUncertainError } from '@/workspaces/toolchain/prepareProjectNativeToolchain';
import { projectNativeJsonValueForTransport, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ProjectCommandSourceV1, ProjectMemoryDemandV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import { resolveProjectMemoryDemandV1 as maximumDemand } from '@happier-dev/protocol/workspaces/projectSetup/projectMemoryDemandV1';
import { isProjectNativeProcessUncertain, preserveUnconfirmedNativeProcess, type ProjectNativeAdapterProductionV1 } from '@/plugins/runtime/lifecycle/contributions/targetProjectNativeAdapters';
import { authorizeResolvedProjectExecLaunchForHost, type ProjectNativeEffectCaptureForHost } from '@/plugins/runtime/invocation/services/exec';
import { validatePath } from '@/rpc/handlers/pathSecurity';
import { getPathRemainderWithinBase, resolveSessionHandoffWorkspaceSessionPath } from '@/session/handoff/paths/sessionHandoffPathNormalization';
import { resolveProjectSetupAcceptedWorkspace, type ProjectSetupAcceptedAssociation } from './projectSetupAcceptedWorkspace';
import { RequesterWorkAttributionV1Schema } from '@/daemon/lifecycle/requesterWorkAttribution';
import { isServerProfileHomeIdentity, resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
import { resolveHostRequesterAgentPlacementForHost, type HostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { readRequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";
import { readAdmittedRequesterAccountReadRuntime, resolveAdmittedRequesterAccountReadRuntime } from "@/daemon/sessionEncryption/requesterAccountActionProjection";
import { projectActionOperationFailure } from '@/daemon/actionOperations/actionOperationFailure';
import { runTracedExternalActionStage, traceExternalActionStage } from '@/daemon/externalActions/externalActionPhase';
import { resolveProjectRequesterSecretInputs } from './projectSetupRequesterInputs';
import { resolveProjectToolchainSelection, inspectProjectNativeCommand, resolveProjectNativeCommand, readProjectExecutionInputs } from './projectNativeResolution';
import { inspectProjectDefinitionExecutionFacts } from './projectDefinitionInspection';
import { selectProjectDefinitionRead } from './projectDefinitionRead';
import { readProjectDefinitionFileBytes } from './nativeDefinitionFiles';
import { readProjectEffectiveDefinition } from './projectEffectiveDefinition';
import { createProjectDotenvPreparation, type ProjectDotenvPreparation } from './projectDotenv';
import { startProjectSetupAutostartServices } from './projectSetupAutostart';
import { readLiteralCommandExecutedFiles } from './literalCommandFiles';
import { prepareProjectSetup, resolveProjectSetupConfigEnvironment, type PreparedProjectSetupCommand, type PreparedProjectSetupPlan } from './projectSetupPreparation';
import { executeProjectSetup, executeProjectFiniteProcess, publishProjectFiniteAdmission, authorizePreparedProjectCommand, projectBaseEnvironment,
    createProjectNativeLaunchAdmission, createProjectNativeInvocationCustody, type ProjectSetupExecutionOutcome, type ProjectSetupOperationContext } from './projectSetupExecution';

export type ProjectFiniteActionRuntime = ProjectRuntimeAccountAccess & Readonly<{
    serverId: string;
    machineId: string;
    accountId: string;
    serverHttpBaseUrl: string;
    /** Installed native Account sink consumes only the setup owner's settled safe fact. */
    publishSetupSettlement?: (settlement: ProjectSetupSettlement) => void;
    /** Installed receiving connection Home, never a profile label or workspace operand. */
    resolveHostHomeServerIdentityId?: (signal?: AbortSignal) => Promise<string | null>;
    /** Captured by the installed Project runtime owner, never an Action operand. */
    requesterIdentity?: HostRequesterExecutionIdentity;
    /** Exact Account custody lifetime supplied by the installed host constructor. */
    isCurrent?: () => Promise<boolean>;
    operationRuntime: Pick<HostActionOperationRuntime, 'observeExecution' | 'decideSetupReview'>
        & Readonly<{ store: Pick<HostActionOperationRuntime['store'], 'get'> }>
        & Partial<Pick<HostActionOperationRuntime, 'attachOwner'>>;
    workerAdmission: ProjectWorkerAdmission;
    /** Captures the actual requester Action and credential lifetime in B6's Account/Home carrier. */
    resolveWorkspaceExecutionConfig: (context: Parameters<NonNullable<ActionExecutorDeps['projectAction']>>[0]['context'], ingress: RpcHandlerContext,
        actionId: 'projects.script.run' | 'projects.compute.exec' | 'localServices.launcher.start')
        => Promise<(Pick<ReturnType<typeof createWorkspaceExecutionConfigClientV1>, 'get'> & Partial<Pick<ReturnType<typeof createWorkspaceExecutionConfigClientV1>, 'getService'>>) | null>;
    nativeIo: ProjectSetupPreparationInput['nativeIo'];
    environmentIo: ProjectSetupExecutionInput['environmentIo'];
    agentIsolation?: ProjectSetupExecutionInput['agentIsolation'];
    nativeOperationRuntime?: Pick<ApiMachineClient, 'prepareNativeOperation' | 'prepareConnectedAccountProcessEnvironment'>;
    terminalSessions: ProjectSetupExecutionInput['terminalSessions'];
    platform?: NodeJS.Platform;
    arch?: string;
    hostEnvironment?: ProcessEnvInput;
    successHomeDir?: string;
    secretEnvironment?: ProjectSetupPreparationInput['secretEnvironment'];
    /** Private Account owner; invoked only when this Project effect selects Saved Secrets. */
    resolveSecretEnvironment?: (bindings?: ProjectSetupPreparationInput['environmentBindings'], signal?: AbortSignal)
        => Promise<ProjectSetupPreparationInput['secretEnvironment']>;
    configEnvironment?: ProjectSetupPreparationInput['configEnvironment'];
    plugins?: ProjectSetupPreparationInput['plugins'];
    /** Canonical projects.inspect on the exact accepted SOURCE, with requester Home authority. */
    inspectSourceProjectManifest?: (input: Readonly<{ source: WorkspaceRefV1; signal: AbortSignal;
        command?: Extract<ProjectDefinitionInspectRead, { kind: 'execution' }>['command'] }>) => Promise<ProjectDefinitionInspectOutput['definition']
        & Pick<ProjectDefinitionInspectOutput, 'commands' | 'toolchainExecutionInputs' | 'commandExecutedFiles' | 'effectiveDefinition'>>;
    resolveWorkerTarget?: (input: Readonly<{ source: WorkspaceRefV1; signal: AbortSignal }>) => Promise<WorkspaceSyncWorkerTargetBasis>;
    /** Real B7 Sync/dequeue preparation; revalidation follows this callback. */
    prepareDequeue?: (input: Readonly<{ workspace: WorkspaceRefV1; choice: ProjectExecutionChoiceV1; basis?: WorkspaceSyncWorkerTargetBasis; signal: AbortSignal }>) => Promise<Extract<WorkspaceSyncPrepareBetweenResultV1, { ok: true }> | void>;
}>;

const failure = (errorCode: string, details?: unknown): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode,
    ...(details === undefined ? {} : { details }) });
const coded = (errorCode: string, details?: unknown): Error & { code: string; details?: unknown } => Object.assign(new Error(errorCode), { code: errorCode,
    ...(details === undefined ? {} : { details }) });
const codeOf = (error: unknown, fallback = 'project_finite_execution_unavailable') => readRpcErrorCode(error)
    ?? (error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : fallback);
const failureFromError = async (error: unknown, details?: unknown): Promise<ActionExecuteFailure> => {
    return { ...await projectActionOperationFailure(error, 'project_finite_execution_unavailable'),
        ...(details === undefined ? {} : { details }) };
};
const digest = (value: unknown) => createHash('sha256').update(createCanonicalJsonSigningInput(projectNativeJsonValueForTransport(value))).digest('hex');

/** Wire-only or constrained callers without admitted private Account ports stay fail-closed. */
export function readProjectFiniteIngressRefusal(ingress: RpcHandlerContext): ActionExecuteFailure | null {
    const authorization = ingress.callerInputAuthorization;
    return (ingress.callerInputConstraints || authorization)
        && (!authorization?.requesterAccountProjection || !authorization.requesterHttpProjection)
        ? { ok: false, errorCode: 'project_requester_authorization_unavailable', error: 'project_requester_authorization_unavailable' } : null;
}

/** Both finite execution and Service Start consume the installed admission owner, not owner credentials. */
export async function readProjectRuntimeRequesterRefusal(runtime: ProjectFiniteActionRuntime, ingress: RpcHandlerContext): Promise<ActionExecuteFailure | null> {
    const refused = readProjectRuntimeRequesterBindingRefusal(runtime, ingress);
    if (refused) return refused;
    if (!ingress.callerInputAuthorization) return null;
    const requester = await resolveAdmittedRequesterAccountReadRuntime({ ingress, serverId: runtime.serverId, machineId: runtime.machineId,
        installationId: ingress.machineAdmission!.installationId, isInstalledCurrent: runtime.isCurrent ?? (() => true) });
    if (ingress.signal.aborted) return failure('cancelled');
    return requester ? null : failure('project_requester_credentials_unavailable');
}

function readProjectRuntimeRequesterBindingRefusal(runtime: ProjectFiniteActionRuntime, ingress: RpcHandlerContext): ActionExecuteFailure | null {
    if (ingress.signal.aborted) return failure('cancelled');
    const refused = readProjectFiniteIngressRefusal(ingress);
    if (refused) return refused;
    const admission = ingress.machineAdmission;
    if (!admission) return failure('machine_admission_required');
    if (ingress.callerInputAuthorization) {
        const requester = runtime.accountAuthorization === ingress.callerInputAuthorization
            ? readAdmittedRequesterAccountReadRuntime({ ingress, serverId: runtime.serverId, machineId: runtime.machineId,
                installationId: admission.installationId, isInstalledCurrent: runtime.isCurrent ?? (() => true) }) : null;
        if (requester && requester.accountId === runtime.accountId && requester.serverHttpBaseUrl === runtime.serverHttpBaseUrl) return null;
    } else if (runtime.credentials && admission.actorAccountId === runtime.accountId && admission.custodianAccountId === runtime.accountId) return null;
    return failure('project_requester_credentials_unavailable');
}

/** Currentness can refuse because the containing request ended during its read. */
export async function readProjectRuntimeCurrentnessRefusal(runtime: ProjectFiniteActionRuntime, signal: AbortSignal): Promise<ActionExecuteFailure | null> {
    if (signal.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    const current = !runtime.isCurrent || await runtime.isCurrent();
    if (signal.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    return current ? null : { ok: false, errorCode: 'project_requester_credentials_unavailable', error: 'project_requester_credentials_unavailable' };
}

/** One natural admission: finite dequeue, Service Start, or passive inspection entry. */
export async function readProjectRuntimeAdmissionRefusal(runtime: ProjectFiniteActionRuntime, ingress: RpcHandlerContext): Promise<ActionExecuteFailure | null> {
    const requester = await readProjectRuntimeRequesterRefusal(runtime, ingress);
    if (requester) return requester;
    // Restricted requester resolution already verifies the installed, Account,
    // HTTP and Machine custody together at its canonical owner.
    if (ingress.callerInputAuthorization) return null;
    const custody = await readProjectRuntimeCurrentnessRefusal(runtime, ingress.signal);
    if (custody) return custody;
    if (!ingress.verifyMachineAdmissionCurrent) return failure('machine_admission_required');
    if (!await ingress.verifyMachineAdmissionCurrent()) return failure('machine_admission_changed');
    return ingress.signal.aborted ? failure('cancelled') : null;
}

type FiniteRequest =
    | Readonly<{ actionId: 'projects.prepare'; input: import('@happier-dev/protocol/actions/projectActionFamily').ProjectPrepareInputV1 }>
    | Readonly<{ actionId: 'projects.script.run'; input: import('zod/mini').infer<typeof PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.script.run']> }>
    | Readonly<{ actionId: 'projects.compute.exec'; input: import('zod/mini').infer<typeof PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.compute.exec']> }>;
type Invocation = Readonly<{
    plan: PreparedProjectSetupPlan;
    command?: PreparedProjectSetupCommand;
    reviewedEffect: unknown;
    reviewedEffectDigest: string;
    executionEffectDigest: string;
    choice: ProjectExecutionChoiceV1;
    memoryDemand?: ProjectMemoryDemandV1;
}>;
type Review = Readonly<{ kind: 'reviewed'; invocation: Invocation }> | Readonly<{ kind: 'failed'; result: ActionExecuteResult }>;

/** Receiving host adapter. Action invocation approval has already completed at the outer executor. */
export function createProjectFiniteAction(runtime: ProjectFiniteActionRuntime, ingress: RpcHandlerContext,
    removal?: Readonly<{ operation: ProjectSetupOperationContext; association?: ProjectSetupAcceptedAssociation;
        requireRememberedConsent?: boolean }>): NonNullable<ActionExecutorDeps['projectAction']> {
    const authorityRuntime = runtime;
    return async args => {
        const rootRequestId = args.context.actionRequestId ?? ingress.transportRequestId;
        const stage = <T>(name: string, operation: () => T | Promise<T>) =>
            runTracedExternalActionStage(args.actionId, rootRequestId, name, operation);
        // Requester custody retains its installed profile; Project refs use the
        // qualified Home admitted independently for this invocation.
        let runtime = authorityRuntime;
        const ingressRefusal = readProjectFiniteIngressRefusal(ingress);
        if (ingressRefusal) return ingressRefusal;
        if (args.actionId !== 'projects.prepare' && args.actionId !== 'projects.script.run' && args.actionId !== 'projects.compute.exec') {
            return failure('unsupported_action');
        }
        const parsed = PROJECT_ACTION_INPUT_SCHEMAS_V1[args.actionId].safeParse(args.input);
        if (!parsed.success) return failure('invalid_parameters');
        const request = { actionId: args.actionId, input: parsed.data } as FiniteRequest;
        // Remembered consent is an approving-Account effect. Native preparation
        // cannot reinterpret it as This time or become a second Trust writer.
        if (request.actionId === 'projects.prepare' && request.input.consentScope === 'untilChanged') {
            return failure('project_setup_consent_invalid');
        }
        const nativeInvocations = new Set<ProjectNativeEffectCaptureForHost>();
        let nativeOperation: ProjectSetupOperationContext | undefined;
        let nativeCustody: ReturnType<typeof createProjectNativeInvocationCustody> | undefined;
        let runStarted = false;
        let nativeUncertain = false;
        const retainNativeInvocation = (production: ProjectNativeEffectCaptureForHost) => {
            if (nativeCustody) nativeCustody.retain(production);
            else nativeInvocations.add(production);
        };
        const releaseNativeInvocations = async () => {
            if (nativeCustody) await nativeCustody.release();
            else await Promise.all([...nativeInvocations].map(production => production.release()));
        };
        try {
        const requestedConsentScope = request.actionId === 'projects.prepare' ? request.input.consentScope : undefined;
        const withRequestedConsentScope = (result: ActionExecuteResult): ActionExecuteResult => {
            if (!requestedConsentScope) return result;
            const pending = readProjectSetupConsentFailureV1(result);
            return pending ? { ...pending, details: { ...pending.details, consentScope: requestedConsentScope } } : result;
        };
        const signal = args.context.signal ? AbortSignal.any([ingress.signal, args.context.signal]) : ingress.signal;
        const nativeExecutionSignal = () => nativeOperation ? AbortSignal.any([signal, nativeOperation.signal]) : signal;
        const admission = ingress.machineAdmission;
        if (!admission || !ingress.verifyMachineAdmissionCurrent) return failure('machine_admission_required');
        if (admission.machineId !== runtime.machineId
            || !await isServerProfileHomeIdentity(runtime.serverId, request.input.workspace.serverId)
            || args.context.serverId && args.context.serverId !== runtime.serverId
                && args.context.serverId !== request.input.workspace.serverId) return failure('target_mismatch');
        const requesterRefusal = readProjectRuntimeRequesterBindingRefusal(authorityRuntime, { ...ingress, signal });
        if (requesterRefusal) return requesterRefusal;
        if (runtime.serverId !== request.input.workspace.serverId) runtime = { ...runtime, serverId: request.input.workspace.serverId };
        // The installed profile/Home relation and Account projection were checked
        // above. Keep this host-selected identity through every native helper and
        // final launch; the shared Machine receiver is not the payload finalizer.
        const hostHomeServerIdentityId = runtime.resolveHostHomeServerIdentityId
            ? await runtime.resolveHostHomeServerIdentityId(signal)
            : await resolveServerProfileHomeIdentityId(authorityRuntime.serverId);
        const requesterIdentity: HostRequesterExecutionIdentity = runtime.requesterIdentity
            ?? { kind: 'unknown', reason: 'requester_authority_unavailable' };
        if (runtime.agentIsolation) runtime = { ...runtime, agentIsolation: { ...runtime.agentIsolation, requesterIdentity } };
        const requesterBaseline = Object.freeze(RequesterWorkAttributionV1Schema.parse({ serverId: runtime.serverId,
            accountId: admission.actorAccountId, machineId: admission.machineId, installationId: admission.installationId }));
        const acceptedAttribution = (value: unknown) => {
            const parsed = RequesterWorkAttributionV1Schema.safeParse(value);
            return parsed.success && parsed.data.serverId === requesterBaseline.serverId && parsed.data.accountId === requesterBaseline.accountId
                && parsed.data.machineId === requesterBaseline.machineId && parsed.data.installationId === requesterBaseline.installationId
                ? parsed.data : undefined;
        };
        const assertNotCancelled = async () => {
            if (nativeExecutionSignal().aborted) throw coded('cancelled');
        };
        let workerBasis: WorkspaceSyncWorkerTargetBasis | undefined;
        const resolveAccepted = () => stage('project.workspace.resolve', async () => {
            await assertNotCancelled();
            if (removal?.association) return removal.association;
            const association = await resolveProjectSetupAcceptedWorkspace({ address: request.input.workspace,
                ...projectRuntimeAccountRowsInput(runtime), serverId: runtime.serverId, serverHttpBaseUrl: runtime.serverHttpBaseUrl, signal });
            await assertNotCancelled();
            if (!workerBasis) return association;
            if (association.workspace.id !== workerBasis.source.id || association.workspace.machineId !== workerBasis.source.machineId
                || association.workspace.rootPath !== workerBasis.source.rootPath || association.workspace.projectKey !== workerBasis.source.projectKey) throw coded('project_workspace_changed');
            const target = await resolveProjectSetupAcceptedWorkspace({ address: { serverId: workerBasis.target.serverId, workspaceId: workerBasis.target.id,
                machineId: workerBasis.target.machineId, rootPath: workerBasis.target.rootPath }, ...projectRuntimeAccountRowsInput(runtime),
                serverId: runtime.serverId, serverHttpBaseUrl: runtime.serverHttpBaseUrl, signal });
            await assertNotCancelled();
            if (target.workspace.machineId !== runtime.machineId || target.workspace.projectKey !== association.workspace.projectKey) throw coded('project_workspace_changed');
            return target;
        });
        let association: Awaited<ReturnType<typeof resolveAccepted>>;
        try { association = await resolveAccepted(); } catch (error) { return failure(codeOf(error)); }
        if (request.actionId === 'projects.prepare' && request.input.heldOperationId) {
            const refusal = await readProjectRuntimeAdmissionRefusal(authorityRuntime, { ...ingress, signal });
            if (refusal) return refusal;
            // Action admission owns approval; retained automation context is
            // not a second authority decision for this admitted response.
            await assertNotCancelled();
            const operation = await runtime.operationRuntime.decideSetupReview({ accountId: runtime.accountId, machineId: runtime.machineId },
                request.input.heldOperationId, request.input.workspace, request.input.phase, {
                    reviewedEffectDigest: request.input.expectedEffectDigest!, skipForInvocation: request.input.skipForInvocation === true,
                });
            await assertNotCancelled();
            return operation ? { operation } : failure('project_setup_review_unavailable');
        }
        const sourceAssociation = association;
        const assertReceivingPlacement = async (choice: ProjectExecutionChoiceV1) => {
            await assertProjectReceivingPlacement({ choice, sourceMachineId: sourceAssociation.workspace.machineId,
                receivingMachineId: runtime.machineId, ...(args.executeCanonicalAction ? { readPool: async poolId => {
                    await assertNotCancelled();
                    const result = await args.executeCanonicalAction!('machines.pools.get', { poolId });
                    await assertNotCancelled();
                    return result;
                } } : {}) });
        };
        let acceptedChoice: ProjectExecutionChoiceV1 | undefined;
        let acceptedMemory: ProjectMemoryDemandV1 | undefined;
        let acceptedScript: ProjectSetupExecutionInput['script'] = request.actionId === 'projects.script.run'
            && request.input.selection.kind === 'native' ? { source: request.input.selection.source } : undefined;
        let workerRelativeCwd: string | undefined;
        const selectedCommand = request.actionId === 'projects.script.run' && request.input.selection.kind === 'named'
            ? { usage: 'script' as const, name: request.input.selection.name } : undefined;
        const readEffective = async (selected: typeof association) => {
            const read = await readProjectEffectiveDefinition({ root: selected.workspace.rootPath,
                account: projectRuntimeAccountRowsInput(runtime), serverHttpBaseUrl: runtime.serverHttpBaseUrl,
                project: selected.project, signal });
            return { ...read.snapshot, effectiveDefinition: read.effectiveDefinition };
        };
        const selectedExecutionDeclaration = (definition: ProjectDefinitionInspectOutput['definition'] & Pick<ProjectDefinitionInspectOutput, 'effectiveDefinition'>) => {
            if (definition.document?.status === 'invalid') throw coded('invalid_manifest');
            const manifest = definition.effectiveDefinition?.effectiveManifest ?? definition.document?.manifest ?? null;
            const config = resolveProjectSetupConfigEnvironment(manifest, runtime.configEnvironment);
            if (config.kind === 'refused') throw coded(config.code);
            const named = request.actionId === 'projects.script.run' && request.input.selection.kind === 'named'
                ? manifest?.scripts?.[request.input.selection.name] : undefined;
            const source = request.actionId === 'projects.script.run'
                ? request.input.selection.kind === 'named' ? named?.source : request.input.selection.source : undefined;
            if (request.actionId === 'projects.script.run' && !source) throw coded('project_script_not_found');
            return projectNativeJsonValueForTransport({ purpose: request.actionId === 'projects.script.run' ? 'script' : 'exec',
                command: source ?? (request.actionId === 'projects.compute.exec' ? { executable: request.input.executable, argv: request.input.argv } : undefined),
                execution: named?.execution ?? 'primary', toolchain: manifest?.toolchain ?? { kind: 'host' },
                environmentVariables: manifest?.environmentVariables ?? [], configEnvironment: config.environment });
        };
        const scriptChangedDetails = (reviewedEffect: unknown) => ({ kind: 'pendingApproval' as const,
            code: 'project_script_effect_changed' as const, reviewedEffect: projectNativeJsonValueForTransport(reviewedEffect),
            reviewedEffectDigest: digest(reviewedEffect) });
        const readExecutionPolicy = async () => {
            if (request.actionId === 'projects.prepare') throw coded('unsupported_action');
            const config = await runtime.resolveWorkspaceExecutionConfig(args.context, ingress, request.actionId);
            await assertNotCancelled();
            if (!config) throw coded('preferences_unavailable');
            const policy = await config.get({ workspace: { serverId: sourceAssociation.workspace.serverId, refId: sourceAssociation.workspace.id } });
            await assertNotCancelled();
            return policy;
        };
        const reviewSourcePlacement = () => stage('project.placement.review', async () => {
            if (sourceAssociation.workspace.machineId !== runtime.machineId && !runtime.inspectSourceProjectManifest) {
                throw coded('project_source_declaration_unavailable');
            }
            // Both passive reads depend only on the admitted SOURCE address.
            // Settle both before leaving this request; definition/currentness
            // failures retain precedence and neither read authorizes execution.
            const [definitionRead, policyRead] = await Promise.allSettled([
                sourceAssociation.workspace.machineId === runtime.machineId
                    ? readEffective(sourceAssociation)
                    : runtime.inspectSourceProjectManifest!({ source: sourceAssociation.workspace, signal, ...(selectedCommand ? { command: selectedCommand } : {}) }),
                request.actionId === 'projects.prepare' ? null : readExecutionPolicy(),
            ]);
            if (definitionRead.status === 'rejected') throw definitionRead.reason;
            const sourceDefinition: ProjectDefinitionInspectOutput['definition'] & Pick<ProjectDefinitionInspectOutput, 'commands' | 'toolchainExecutionInputs' | 'commandExecutedFiles' | 'effectiveDefinition'> = definitionRead.value;
            await assertNotCancelled();
            if (sourceDefinition.document?.status === 'invalid') throw coded('invalid_manifest');
            const sourceManifest = sourceDefinition.effectiveDefinition?.effectiveManifest ?? sourceDefinition.document?.manifest;
            if (acceptedDeclaration) {
                let current: ReturnType<typeof selectedExecutionDeclaration>;
                try { current = selectedExecutionDeclaration(sourceDefinition); }
                catch (error) {
                    if (codeOf(error) !== 'project_script_not_found') throw error;
                    throw coded('project_script_effect_changed', scriptChangedDetails({ selectedExecutionUnavailable: true }));
                }
                if (digest(current) !== digest(acceptedDeclaration)) throw coded('project_script_effect_changed', scriptChangedDetails(current));
            }
            if (request.actionId === 'projects.prepare') return { choice: { kind: 'primary' as const }, script: undefined, sourceDefinition,
                memoryDemand: sourceManifest?.workspace?.memoryDemand };
            const named = request.actionId === 'projects.script.run' && request.input.selection.kind === 'named'
                ? sourceManifest?.scripts?.[request.input.selection.name] : undefined;
            if (request.actionId === 'projects.script.run' && request.input.selection.kind === 'named' && !named) throw coded('project_script_not_found');
            const execution = request.actionId === 'projects.compute.exec' ? request.input.execution ?? 'portable'
                : named?.execution ?? 'primary';
            if (policyRead.status === 'rejected') throw policyRead.reason;
            // projects.prepare returned above without reading preferences.
            const policy = policyRead.value!;
            const placement = resolveProjectExecutionChoiceV1({ execution, sourceMachineId: sourceAssociation.workspace.machineId,
                adHoc: request.actionId === 'projects.compute.exec',
                ...(args.context.executionRunTargetMachineId ? { acceptedMachineId: args.context.executionRunTargetMachineId } : {}),
                ...(request.actionId === 'projects.script.run' && request.input.selection.kind === 'named' ? { scriptName: request.input.selection.name } : {}),
                invocation: request.input.choice, preference: policy.status === 'ready' ? { status: 'ready', value: policy.preference } : { status: policy.status } });
            if (placement.status === 'refused') throw coded(placement.reason);
            await assertReceivingPlacement(placement.choice);
            const script = request.actionId === 'projects.script.run' && request.input.selection.kind === 'named' && named
                ? { name: request.input.selection.name, source: named.source } : acceptedScript;
            return { choice: placement.choice, script, sourceDefinition, policy, unavailable: policy.status === 'ready' ? policy.preference.unavailable : undefined,
                memoryDemand: maximumDemand(request.input.memoryDemand, named?.memoryDemand, sourceManifest?.workspace?.memoryDemand) };
        });
        let workerUnavailable: 'ask' | 'primary' | 'fail' | undefined;
        let acceptedDeclaration: ReturnType<typeof selectedExecutionDeclaration> | undefined;
        let initialSourceDefinition: Awaited<ReturnType<typeof reviewSourcePlacement>>['sourceDefinition'];
        try {
            const placement = await reviewSourcePlacement();
            acceptedChoice = placement.choice;
            acceptedMemory = placement.memoryDemand;
            acceptedScript = placement.script;
            initialSourceDefinition = placement.sourceDefinition;
            if (request.actionId !== 'projects.prepare') acceptedDeclaration = selectedExecutionDeclaration(placement.sourceDefinition);
            workerUnavailable = 'unavailable' in placement ? placement.unavailable : undefined;
        } catch (error) { return failure(codeOf(error)); }
        if (request.actionId !== 'projects.prepare' && (acceptedChoice.kind === 'workers'
            || sourceAssociation.workspace.machineId !== runtime.machineId && request.input.choice?.kind !== 'primary')) {
            if (request.actionId === 'projects.compute.exec') {
                const relativeCwd = getPathRemainderWithinBase(request.input.cwd, sourceAssociation.workspace.rootPath);
                if (relativeCwd === null) return failure('outside_root');
                try { resolveSessionHandoffWorkspaceSessionPath({ targetRoot: sourceAssociation.workspace.rootPath, sessionRelativeCwd: relativeCwd }); }
                catch { return failure('outside_root'); }
                workerRelativeCwd = relativeCwd;
            }
            try {
                if (!runtime.resolveWorkerTarget || !runtime.prepareDequeue) return failure('workspace_sync_source_unavailable');
                workerBasis = await runtime.resolveWorkerTarget({ source: sourceAssociation.workspace, signal });
                association = await resolveAccepted();
            } catch (error) {
                const code = codeOf(error);
                if (code === 'worker_copy_missing' && workerUnavailable) return failure(code,
                    ProjectWorkerNoAcceptanceFailureDetailsV1Schema.parse({ kind: 'no_worker_can_accept', reason: code,
                        unavailable: workerUnavailable, workerCopy: { serverId: sourceAssociation.workspace.serverId,
                            sourceWorkspaceRefId: sourceAssociation.workspace.id, sourceMachineId: sourceAssociation.workspace.machineId,
                            targetMachineId: runtime.machineId } }));
                return failure(code);
            }
        } else if (sourceAssociation.workspace.machineId !== runtime.machineId) return failure('target_not_local');
        const readWorkerExecutionBasis = async (definition: typeof initialSourceDefinition) => {
            const manifest = definition.effectiveDefinition?.effectiveManifest ?? (definition.document?.status === 'valid' ? definition.document.manifest : undefined);
            const declaredEffect = selectedExecutionDeclaration(definition);
            const selected = selectProjectDefinitionRead(definition, {
                entries: [], toolchains: [], devcontainers: [], coverage: 'complete', diagnostics: [],
            }, { kind: 'execution', ...(selectedCommand ? { command: selectedCommand } : {}) }, definition.effectiveDefinition);
            const inspection = sourceAssociation.workspace.machineId === runtime.machineId
                ? await inspectProjectDefinitionExecutionFacts({ root: sourceAssociation.workspace.rootPath,
                    ...(selected.commandManifest ? { manifest: selected.commandManifest } : {}), detection: selected.detection,
                    io: runtime.nativeIo, signal, ...(selectedCommand ? { command: selectedCommand } : {}),
                    entries: [], includeTools: false, includeExecutionInputs: true }) : definition;
            await assertNotCancelled();
            const files = new Map<string, string>();
            const selectedSource = request.actionId === 'projects.script.run'
                ? request.input.selection.kind === 'named' ? manifest?.scripts?.[request.input.selection.name]?.source : request.input.selection.source : undefined;
            if (selectedSource && selectedSource.kind !== 'command') {
                const command = inspection.commands?.find(entry => entry.usage === 'script'
                    && (request.actionId !== 'projects.script.run' || request.input.selection.kind !== 'named' || entry.name === request.input.selection.name)
                    && digest(entry.source) === digest(selectedSource));
                if (!command?.executionInputs?.length) throw coded('project_source_declaration_unavailable');
                for (const input of command.executionInputs) files.set(input.file, input.hash);
            }
            if (manifest?.toolchain && manifest.toolchain.kind !== 'host') {
                if (!inspection.toolchainExecutionInputs?.length) throw coded('project_source_declaration_unavailable');
                for (const input of inspection.toolchainExecutionInputs) files.set(input.file, input.hash);
            }
            return { declaredEffect, executionInputs: [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([file, hash]) => ({ file, hash })) };
        };
        let acceptedWorkerBasis: Awaited<ReturnType<typeof readWorkerExecutionBasis>> | undefined;
        if (workerBasis && request.actionId !== 'projects.prepare') {
            try { acceptedWorkerBasis = await readWorkerExecutionBasis(initialSourceDefinition!); }
            catch (error) { return failure(codeOf(error)); }
        }
        const assertSourceExecutionCurrent = async (placement: Awaited<ReturnType<typeof reviewSourcePlacement>>) => {
            if (!acceptedDeclaration) return;
            const current = selectedExecutionDeclaration(placement.sourceDefinition);
            if (digest(current) !== digest(acceptedDeclaration)) throw coded('project_script_effect_changed', scriptChangedDetails(current));
            if (!acceptedWorkerBasis) return;
            let basis: Awaited<ReturnType<typeof readWorkerExecutionBasis>>;
            try { basis = await readWorkerExecutionBasis(placement.sourceDefinition); }
            catch (error) {
                if (codeOf(error) !== 'project_source_declaration_unavailable') throw error;
                throw coded('project_script_effect_changed', scriptChangedDetails({ declaredEffect: current, executionInputsUnavailable: true }));
            }
            if (digest(basis) !== digest(acceptedWorkerBasis)) throw coded('project_script_effect_changed', scriptChangedDetails(basis));
        };
        const assertCopiedExecutionCurrent = async () => {
            if (!acceptedWorkerBasis) return;
            const definition = await readEffective(association);
            await assertNotCancelled();
            const declaredEffect = selectedExecutionDeclaration(definition);
            const executionInputs = await readProjectExecutionInputs(association.workspace.rootPath, acceptedWorkerBasis.executionInputs.map(input => input.file));
            await assertNotCancelled();
            const current = { declaredEffect, ...(executionInputs ? { executionInputs } : { executionInputsUnavailable: true }) };
            if (!executionInputs || digest(current) !== digest(acceptedWorkerBasis)) throw coded('project_script_effect_changed', scriptChangedDetails(current));
        };
        const invocationCwd = () => request.actionId === 'projects.compute.exec'
            ? workerRelativeCwd === undefined ? request.input.cwd : resolveSessionHandoffWorkspaceSessionPath({
                targetRoot: association.workspace.rootPath, sessionRelativeCwd: workerRelativeCwd,
            }) : association.workspace.rootPath;
        let secretEnvironment = runtime.secretEnvironment;
        let environmentBindings: ProjectSetupPreparationInput['environmentBindings'];
        let setupDecision: import('@/daemon/actionOperations/actionOperationTypes').ActionOperationSetupDecision | undefined;
        const originalEnvironment = Object.freeze({ ...(runtime.hostEnvironment ?? process.env) });
        const dotenvPreparations = new Map<string, ProjectDotenvPreparation>();
        const runtimeEnvironments = new Map<string, Readonly<Record<string, string>>>();
        const dotenvPreparation = () => {
            const root = association.workspace.rootPath;
            let selected = dotenvPreparations.get(root);
            if (!selected) { selected = createProjectDotenvPreparation(root, originalEnvironment); dotenvPreparations.set(root, selected); }
            return selected;
        };
        const preparation = (): Parameters<typeof prepareProjectSetup>[0] => ({ workspace: association.workspace, projectAssociation: association,
            ...(removal?.requireRememberedConsent ? { requireRememberedConsent: true } : {}),
            dotenvPreparation: dotenvPreparation(),
            originalEnvironment,
            runtimeEnvironment: runtimeEnvironments.get(association.workspace.rootPath),
            requesterIdentity,
            approvalContext: args.context,
            requester: { ...projectRuntimeAccountRowsInput(runtime), serverHttpBaseUrl: runtime.serverHttpBaseUrl },
            purpose: request.actionId === 'projects.prepare' ? request.input.phase : 'setup',
            platform: { os: (runtime.platform ?? process.platform) === 'win32' ? 'windows' : runtime.platform ?? process.platform, arch: runtime.arch ?? process.arch },
            nativeIo: runtime.nativeIo, signal: nativeExecutionSignal(),
            retainNativeInvocation,
            ...(runtime.successHomeDir ? { successHomeDir: runtime.successHomeDir } : {}),
            ...(secretEnvironment ? { secretEnvironment } : {}),
            ...(runtime.configEnvironment ? { configEnvironment: runtime.configEnvironment } : {}),
            ...(runtime.plugins ? { plugins: runtime.plugins } : {}),
            ...(environmentBindings ? { environmentBindings } : {}),
            ...(request.actionId === 'projects.prepare' ? { expectedEffectDigest: request.input.expectedEffectDigest, skipForInvocation: request.input.skipForInvocation } : {}),
            ...(request.actionId === 'projects.prepare' && request.input.consentScope === 'thisTime'
                && request.input.expectedEffectDigest
                ? { effectDecision: { project: association.project,
                    reviewedEffectDigest: request.input.expectedEffectDigest } } : {}),
            ...(setupDecision ? { expectedEffectDigest: setupDecision.reviewedEffectDigest,
                skipForInvocation: setupDecision.skipForInvocation,
                ...(!setupDecision.skipForInvocation ? { effectDecision: {
                    project: association.project, reviewedEffectDigest: setupDecision.reviewedEffectDigest } } : {}),
            } : {}),
        });
        const reviewPath = (value: string) => {
            const root = association.workspace.rootPath;
            const local = relative(root, value);
            return isAbsolute(value) && local !== '..' && !local.startsWith('../') && !local.startsWith('..\\') && !isAbsolute(local)
                ? local.replaceAll('\\', '/') || '.' : value;
        };
        // Primary admission can retain reviewed bytes without giving a selected
        // plugin an invocation/Exec context before the finite reservation.
        const readPrimaryAdmissionBasis = () => stage('project.primary.review', async (): Promise<string> => {
            const snapshot = await readEffective(association);
            await assertNotCancelled();
            if (snapshot.document?.status === 'invalid') throw coded('invalid_manifest');
            const manifest = snapshot.effectiveDefinition.effectiveManifest;
            const config = resolveProjectSetupConfigEnvironment(manifest, runtime.configEnvironment);
            if (config.kind === 'refused') throw coded(config.code);
            const files = new Map<string, string>();
            const addFile = async (file: string) => {
                const read = await readProjectDefinitionFileBytes(association.workspace.rootPath, file);
                await assertNotCancelled();
                if (read.kind !== 'read') throw coded(read.kind === 'refused' ? read.code : 'native_configuration_missing');
                files.set(file.replaceAll('\\', '/'), createHash('sha256').update(read.bytes).digest('hex'));
            };
            const nativeDeclaration = async (source: ProjectCommandSourceV1) => {
                if (source.kind === 'command') {
                    const cwd = validatePath((source.cwd ?? '.').replaceAll('\\', '/'), association.workspace.rootPath);
                    if (!cwd.valid || !cwd.resolvedPath) throw coded('outside_root');
                    const executed = await readLiteralCommandExecutedFiles(association.workspace.rootPath, cwd.resolvedPath, source.command);
                    await assertNotCancelled();
                    if (executed.kind === 'refused') throw coded(executed.code);
                    return { source, ...(executed.files.length ? { files: executed.files } : {}) };
                }
                await addFile(source.file);
                if (source.kind === 'pluginNative') {
                    if (!runtime.plugins) throw coded('native_adapter_unavailable');
                    const selected = await runtime.plugins.resolveProjectNativeAdapter(source.adapter, 'resolveCommand');
                    await assertNotCancelled();
                    if (selected.kind === 'refused') throw coded(selected.code);
                    return { source, adapterVersion: selected.lease.pluginVersion };
                }
                const resolved = await inspectProjectNativeCommand({ root: association.workspace.rootPath, source, usage: 'script',
                    io: runtime.nativeIo, signal });
                await assertNotCancelled();
                if (resolved.kind !== 'resolved') throw coded(resolved.kind === 'refused' ? resolved.code : 'native_adapter_result_invalid');
                for (const fact of resolved.reviewInputs) await addFile(fact.file);
                const executable = reviewPath(resolved.command);
                if (executable !== resolved.command) await addFile(relative(association.workspace.rootPath, resolved.command));
                return { source, ...(executable !== resolved.command ? { executable } : {}), args: resolved.reviewInvocation.args.map(reviewPath),
                    cwd: reviewPath(resolved.cwd), toolchain: resolved.toolchain,
                    ...(resolved.executedFiles ? { executedFiles: resolved.executedFiles } : {}),
                    nativeCommandToolchain: resolved.nativeCommandToolchain,
                    environmentOverlay: resolved.reviewInvocation.environmentOverlay && Object.fromEntries(Object.entries(resolved.reviewInvocation.environmentOverlay)
                        .map(([key, value]) => [key, reviewPath(value)])) };
            };
            const environment = await resolveProjectToolchainSelection({ root: association.workspace.rootPath,
                selection: manifest?.toolchain ?? { kind: 'host' } });
            await assertNotCancelled();
            if (environment.kind === 'refused') throw coded(environment.code);
            if (environment.file !== undefined) await addFile(environment.file);
            let toolchainProvenance: unknown;
            if (environment.selection.kind === 'pluginToolchain') {
                if (!runtime.plugins) throw coded('native_adapter_unavailable');
                const selected = await runtime.plugins.resolveProjectNativeAdapter(environment.selection.adapter, 'prepareToolchain');
                await assertNotCancelled();
                if (selected.kind === 'refused') throw coded(selected.code);
                toolchainProvenance = { adapterVersion: selected.lease.pluginVersion };
            } else if (environment.selection.kind === 'toolchain') {
                const tool = await runtime.nativeIo.resolveTool(environment.selection.tool === 'nix_flake' ? 'nix' : environment.selection.tool,
                    { cwd: association.workspace.rootPath, signal });
                await assertNotCancelled();
                if (!tool) throw coded('native_tool_unavailable');
                const executable = reviewPath(tool.executablePath);
                if (executable !== tool.executablePath) await addFile(relative(association.workspace.rootPath, tool.executablePath));
                toolchainProvenance = { ...(executable !== tool.executablePath ? { executable } : {}), version: tool.version };
            }
            // Setup is reviewed from the current declaration under this same
            // reservation. A queued setup edit must reach its own consent hold,
            // rather than be treated as a changed Script execution.
            let command: unknown;
            if (request.actionId === 'projects.script.run') {
                const source = request.input.selection.kind === 'named' ? manifest?.scripts?.[request.input.selection.name]?.source : request.input.selection.source;
                if (!source) throw coded('project_script_not_found');
                command = await nativeDeclaration(source);
            } else if (request.actionId === 'projects.compute.exec') {
                const executable = reviewPath(request.input.executable);
                if (executable !== request.input.executable) await addFile(relative(association.workspace.rootPath, request.input.executable));
            }
            return digest({ toolchain: environment.selection, toolchainProvenance, configEnvironment: config.environment,
                ...(environment.executedFiles ? { toolchainFiles: environment.executedFiles } : {}),
                command,
                files: [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0) });
        });
        let acceptedPrimaryBasis: string | undefined;
        if (!workerBasis) {
            try { acceptedPrimaryBasis = await readPrimaryAdmissionBasis(); }
            catch (error) { preserveUnconfirmedNativeProcess(error); return failure(codeOf(error)); }
        }
        let admittedSecretInputs: ReturnType<typeof resolveProjectRequesterSecretInputs> | undefined;
        const review = (sourceReview?: Awaited<ReturnType<typeof reviewSourcePlacement>>) => stage('project.command.review', async (): Promise<Review> => {
            const definition = sourceReview?.sourceDefinition ?? initialSourceDefinition;
            ({ secretEnvironment, environmentBindings } = await (admittedSecretInputs ??= stage('project.secret_environment.resolve', () => resolveProjectRequesterSecretInputs(runtime, {
                project: sourceAssociation.project,
                requirements: definition.effectiveDefinition?.effectiveManifest?.environmentVariables
                    ?? (definition.document?.status === 'valid' ? definition.document.manifest.environmentVariables ?? [] : []),
                ...(request.actionId === 'projects.compute.exec' && request.input.environmentBindings
                    ? { environmentBindings: request.input.environmentBindings } : {}),
            }, nativeExecutionSignal()))));
            const targetDefinition = await readProjectEffectiveDefinition({ root: association.workspace.rootPath,
                account: projectRuntimeAccountRowsInput(runtime), serverHttpBaseUrl: runtime.serverHttpBaseUrl,
                project: association.project, signal: nativeExecutionSignal() });
            if (!runtimeEnvironments.has(association.workspace.rootPath)) {
                const binding = await prepareProjectWorktreeRuntime({ workspace: association.workspace,
                    manifest: targetDefinition.effectiveDefinition.effectiveManifest, signal: nativeExecutionSignal() });
                if (binding.kind !== 'ready') return { kind: 'failed', result: failure(binding.code, { reason: binding.reason }) };
                runtimeEnvironments.set(association.workspace.rootPath, binding.runtimeEnvironment);
            }
            const prepared = await stage('project.setup.review', () => prepareProjectSetup({ ...preparation(),
                acceptedSetup: targetDefinition.acceptedSetup }));
            await assertNotCancelled();
            if (prepared.kind === 'refused') return { kind: 'failed', result: failure(prepared.code) };
            if (prepared.kind === 'pendingApproval') return { kind: 'failed', result: withRequestedConsentScope(failure(prepared.code, {
                kind: 'pendingApproval', code: prepared.code, reviewedEffect: prepared.plan.reviewedEffect, reviewedEffectDigest: prepared.plan.reviewedEffectDigest,
            })) };
            const plan = prepared.plan;
            if (request.actionId === 'projects.prepare') return { kind: 'reviewed', invocation: { plan, reviewedEffect: plan.reviewedEffect,
                reviewedEffectDigest: plan.reviewedEffectDigest, executionEffectDigest: plan.reviewedEffectDigest,
                choice: { kind: 'primary' }, memoryDemand: plan.manifest?.workspace?.memoryDemand,
            } };
            // SOURCE placement and command preparation are one dequeue decision.
            // Final native admission and a consent wake still read fresh policy.
            const policy = sourceReview && 'policy' in sourceReview && sourceReview.policy
                ? sourceReview.policy : await readExecutionPolicy();
            let command: PreparedProjectSetupCommand | undefined;
            let source: ProjectCommandSourceV1 | undefined;
            let execution: 'primary' | 'portable' = 'primary';
            let memoryDemand = request.input.memoryDemand;
            if (request.actionId === 'projects.script.run') {
                if (request.input.selection.kind === 'named') {
                    const named = plan.manifest?.scripts?.[request.input.selection.name];
                    if (!named) return { kind: 'failed', result: failure('project_script_not_found') };
                    source = named.source; execution = named.execution ?? 'primary'; memoryDemand = maximumDemand(memoryDemand, named.memoryDemand);
                } else { source = request.input.selection.source; }
                if (source.kind === 'command') {
                    const os = preparation().platform.os;
                    if (source.platforms && !source.platforms.some(platform => platform === os)) return { kind: 'failed', result: failure('project_script_platform_unsupported') };
                    if (source.command.includes('\0')) return { kind: 'failed', result: failure('project_command_invalid') };
                    const cwd = validatePath((source.cwd ?? '.').replaceAll('\\', '/'), plan.workspace.rootPath);
                    if (!cwd.valid || !cwd.resolvedPath) return { kind: 'failed', result: failure('outside_root') };
                    command = { kind: 'literal', source, cwd: cwd.resolvedPath };
                } else {
                    let lease: ProjectNativeAdapterProductionV1 | undefined;
                    if (source.kind === 'pluginNative') {
                        if (!runtime.plugins) return { kind: 'failed', result: failure('native_adapter_unavailable') };
                        const selected = await runtime.plugins.resolveProjectNativeAdapter(source.adapter, 'resolveCommand');
                        await assertNotCancelled();
                        if (selected.kind === 'refused') return { kind: 'failed', result: failure(selected.code) };
                        const acquired = selected.lease.acquireProduction({ root: plan.workspace.rootPath,
                            environment: runtime.configEnvironment, signal: nativeExecutionSignal(), requesterIdentity,
                            assertLaunchCurrent: assertNotCancelled });
                        if (acquired.kind !== 'ready') return { kind: 'failed', result: failure(acquired.code) };
                        lease = acquired.production;
                        retainNativeInvocation(lease);
                    }
                    const resolved = await resolveProjectNativeCommand({ root: plan.workspace.rootPath, source, usage: 'script', io: runtime.nativeIo, signal: nativeExecutionSignal(),
                        ...(lease ? { plugin: { lease } } : {}) });
                    await assertNotCancelled();
                    if (resolved.kind === 'refused') return { kind: 'failed', result: failure(resolved.code) };
                    if (source.kind === 'native' && resolved.kind === 'resolved') command = { kind: 'native', source, resolution: resolved };
                    else if (source.kind === 'pluginNative' && resolved.kind === 'pluginResolved' && lease?.isCurrent()) command = { kind: 'pluginNative', source, resolution: resolved.command, lease };
                    else return { kind: 'failed', result: failure('native_adapter_retired') };
                }
            } else {
                execution = request.input.execution ?? 'portable';
                if (!isAbsolute(request.input.executable) || request.input.executable.includes('\0') || request.input.argv.some(arg => arg.includes('\0'))) return { kind: 'failed', result: failure('project_command_invalid') };
                const cwd = validatePath(invocationCwd().replaceAll('\\', '/'), plan.workspace.rootPath);
                if (!cwd.valid || !cwd.resolvedPath) return { kind: 'failed', result: failure('outside_root') };
            }
            memoryDemand = maximumDemand(memoryDemand, plan.manifest?.workspace?.memoryDemand);
            const placement = resolveProjectExecutionChoiceV1({ execution, sourceMachineId: sourceAssociation.workspace.machineId,
                ...(args.context.executionRunTargetMachineId ? { acceptedMachineId: args.context.executionRunTargetMachineId } : {}),
                ...(request.actionId === 'projects.script.run' && request.input.selection.kind === 'named' ? { scriptName: request.input.selection.name } : {}),
                adHoc: request.actionId === 'projects.compute.exec', invocation: request.input.choice,
                preference: policy.status === 'ready' ? { status: 'ready', value: policy.preference } : { status: policy.status },
            });
            if (placement.status === 'refused') return { kind: 'failed', result: failure(placement.reason) };
            await assertReceivingPlacement(placement.choice);
            const native = command?.kind === 'native' ? command.resolution : command?.kind === 'pluginNative' ? command.resolution : undefined;
            const pluginCommand = command?.kind === 'pluginNative' ? command : undefined;
            const adapterVersion = pluginCommand?.lease.pluginVersion;
            const reviewedFiles = new Map<string, string>();
            if (native && command && command.kind !== 'literal') {
                const files = new Set([command.source.file, ...native.reviewInputs.map(file => file.file)]);
                if (command.kind === 'native' && reviewPath(command.resolution.command) !== command.resolution.command) files.add(relative(plan.workspace.rootPath, command.resolution.command));
                for (const file of files) {
                    const read = await readProjectDefinitionFileBytes(plan.workspace.rootPath, file);
                    await assertNotCancelled();
                    if (read.kind !== 'read') return { kind: 'failed', result: failure(read.kind === 'refused' ? read.code : 'native_configuration_missing') };
                    if (native.reviewInputs.some(fact => fact.file === file && fact.content !== read.bytes.toString('utf8'))) return { kind: 'failed', result: failure('project_script_effect_changed') };
                    reviewedFiles.set(file.replaceAll('\\', '/'), createHash('sha256').update(read.bytes).digest('hex'));
                }
            }
            const executed = command?.kind === 'literal' ? await readLiteralCommandExecutedFiles(plan.workspace.rootPath, command.cwd, command.source.command) : undefined;
            await assertNotCancelled();
            if (executed?.kind === 'refused') return { kind: 'failed', result: failure(executed.code) };
            const reviewedCommand = command?.kind === 'literal' ? { source, cwd: reviewPath(command.cwd), ...(executed?.files.length ? { files: executed.files } : {}) }
                : native ? { source, executable: command?.kind === 'native' ? reviewPath(command.resolution.command)
                    : command?.kind === 'pluginNative' ? command.resolution.executable : undefined,
                    args: (command?.kind === 'native' ? command.resolution.reviewInvocation.args : native.args).map(reviewPath), cwd: reviewPath(native.cwd),
                    files: [...reviewedFiles].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([file, digest]) => ({ file, digest })),
                    ...(command?.kind === 'native' ? { toolchain: command.resolution.toolchain,
                        ...(command.resolution.executedFiles ? { executedFiles: command.resolution.executedFiles } : {}), environmentOverlay: command.resolution.reviewInvocation.environmentOverlay && Object.fromEntries(Object.entries(command.resolution.reviewInvocation.environmentOverlay).map(([key, value]) => [key, reviewPath(value)])),
                        nativeCommandToolchain: command.resolution.nativeCommandToolchain } : {}),
                    ...(command?.kind === 'pluginNative' ? { adapterVersion,
                        nativeCommandToolchain: command.resolution.toolchainApplied } : {}),
                } : request.actionId === 'projects.compute.exec' ? { executable: request.input.executable, argv: request.input.argv, cwd: reviewPath(invocationCwd()) } : {};
            // Only references and config/review inputs enter the digest; preparation has already excluded materialized secrets.
            const reviewedEffect = projectNativeJsonValueForTransport({ v: 1, purpose: request.actionId === 'projects.script.run' ? 'script' : 'exec', setupEffect: plan.reviewedEffectDigest, command: reviewedCommand });
            const reviewedEffectDigest = digest(reviewedEffect);
            // Setup has its own current-effect consent. Script/Exec freshness still covers the exact command and environment.
            const executionEffectDigest = digest({ v: 1, purpose: request.actionId === 'projects.script.run' ? 'script' : 'exec',
                command: reviewedCommand, environmentEffect: plan.executionEnvironmentEffectDigest });
            if (request.actionId === 'projects.script.run' && request.input.expectedEffectDigest !== undefined && request.input.expectedEffectDigest !== reviewedEffectDigest) {
                return { kind: 'failed', result: failure('project_script_effect_changed', { kind: 'pendingApproval', code: 'project_script_effect_changed', reviewedEffectDigest, reviewedEffect }) };
            }
            return { kind: 'reviewed', invocation: { plan, command, reviewedEffect, reviewedEffectDigest, executionEffectDigest,
                choice: placement.choice, ...(memoryDemand ? { memoryDemand } : {}) } };
        });
        let baseline: Invocation | undefined;
        // Selected SOURCE stays independent of the copied execution target and
        // the temporary setup purpose; neither can rewrite the accepted Script.
        const commandIdentity = { sourceWorkspace: workspaceAddressFromRefV1(sourceAssociation.workspace),
            ...(acceptedScript ? { script: acceptedScript } : {}) } satisfies Pick<ProjectSetupExecutionInput, 'sourceWorkspace' | 'script'>;
        const unchanged = (current: Invocation) => baseline !== undefined && current.executionEffectDigest === baseline.executionEffectDigest
            && projectExecutionChoicesEqualV1(current.choice, baseline.choice)
            && current.memoryDemand?.bytes === baseline.memoryDemand?.bytes;
        const originRunId = ingress.localActionContext?.executionRunWorkflowRunId;
        const originRun = originRunId ? { kind: 'workflow_run' as const, serverId: runtime.serverId, runId: originRunId } : undefined;
        const purpose = request.actionId === 'projects.prepare' ? request.input.phase : request.actionId === 'projects.script.run' ? 'script' : 'exec';
        const run = async (operation: ProjectSetupOperationContext): Promise<ActionExecuteResult> => {
            runStarted = true;
            nativeOperation = operation;
            nativeCustody = createProjectNativeInvocationCustody(operation, nativeInvocations);
            const requesterAccount = readRequesterAccountActionContext(runtime.accountAuthorization);
            const releaseRequester = requesterAccount?.retain();
            let nativePreparation: Awaited<ReturnType<ApiMachineClient['prepareNativeOperation']>> | undefined;
            let processCredentials: Promise<Awaited<ReturnType<ApiMachineClient['prepareConnectedAccountProcessEnvironment']>>> | undefined;
            let materialLive = true;
            const retirePreparation = async () => {
                materialLive = false;
                try { await nativePreparation?.dispose(); }
                finally { await processCredentials?.then(prepared => prepared.dispose(), () => undefined); }
            };
            try {
            const operationId = operation.operationAcceptance?.operationId ?? operation.actionRequestId;
            if (!operationId) return failure('project_finite_operation_unavailable');
            const operationSignal = AbortSignal.any([signal, operation.signal]);
            const material = Object.freeze({ materializationKey: operationId, environment: Object.freeze({}), selectedMaterials: Object.freeze([]) });
            let lastCleanSyncAtMs: ProjectSetupExecutionInput['lastCleanSyncAtMs'];
            const prepareDequeue = () => stage('project.sync.prepare', async () => {
                try {
                    if (workerBasis) await assertNotCancelled();
                    const prepared = await runtime.prepareDequeue?.({ workspace: workerBasis?.source ?? association.workspace, choice: acceptedChoice!,
                        ...(workerBasis ? { basis: workerBasis } : {}), signal: operationSignal });
                    // Primary preparation performs no copy. Keep its accepted root
                    // until an actual setup/native effect needs fresh association.
                    if (workerBasis) association = await resolveAccepted();
                    await assertCopiedExecutionCurrent();
                    lastCleanSyncAtMs = prepared ? prepared.traversed.at(-1)?.status.lastCleanSyncAtMs : undefined;
                    if (lastCleanSyncAtMs !== undefined) publishProjectFiniteAdmission({ workspace: association.workspace, purpose,
                        requesterAccountId: runtime.accountId, operation, ...commandIdentity, lastCleanSyncAtMs,
                        ...(originRun ? { originRun } : {}) });
                } catch (error) {
                    // Sync preparation has not launched the command. Keep its
                    // typed refusal (including RPC codes) and only the reason,
                    // never HTTP configuration, credentials or response bodies.
                    throw Object.assign(new Error(error instanceof Error && error.message.trim()
                        ? error.message : 'Workspace preparation failed'), { code: codeOf(error, 'workspace_sync_prepare_failed'),
                        ...(error instanceof Error && 'details' in error ? { details: error.details } : {}) });
                }
            });
            const executionInput = (): ProjectSetupExecutionInput => ({ preparation: { ...preparation(), signal: operationSignal }, operation,
                ...(runtime.nativeOperationRuntime ? { produceProcessEnvironment: async (environment: Readonly<Record<string, string>>, processSignal: AbortSignal) => {
                    processCredentials ??= runtime.nativeOperationRuntime!.prepareConnectedAccountProcessEnvironment({
                        authorization: runtime.accountAuthorization, requesterAccountId: runtime.accountId,
                        ...(nativePreparation?.material ? { requesterMaterial: nativePreparation.material } : {}),
                        ...(ingress.sessionActionOrigin?.caller.sessionId ? { sessionId: ingress.sessionActionOrigin.caller.sessionId } : {}),
                        operationId, actionId: request.actionId, signal: operationSignal });
                    return await (await processCredentials).produce(environment, processSignal);
                } } : {}),
                deferToolchainToLaunch: request.actionId !== 'projects.prepare',
                beforeNativeEffect: assertNotCancelled,
                ...commandIdentity,
                ...(lastCleanSyncAtMs !== undefined ? { lastCleanSyncAtMs } : {}),
                requesterAccountId: runtime.accountId, terminalSessions: runtime.terminalSessions, environmentIo: runtime.environmentIo,
                agentIsolation: runtime.agentIsolation,
                ...(nativePreparation?.memberIdentity ? { nativeExecutionIdentity: nativePreparation.memberIdentity } : {}),
                requesterIdentity,
                // PTY custody names the receiver's routing profile, like every other
                // terminal owner; the portable Home birth is homeServerIdentityId.
                terminalCustody: {
                    ...(hostHomeServerIdentityId ? { homeServerIdentityId: hostHomeServerIdentityId } : {}),
                    serverId: authorityRuntime.serverId, requesterAccountId: requesterBaseline.accountId, machineId: requesterBaseline.machineId,
                    installationId: requesterBaseline.installationId, workspaceRefId: association.workspace.id,
                    projectKey: projectWorkspaceRefV1(association.workspace).projectKey, rootPath: association.workspace.rootPath,
                },
                ...(runtime.platform ? { platform: runtime.platform } : {}), hostEnvironment: originalEnvironment,
                ...(originRun ? { originRun } : {}),
            });
            const setupState: { settled?: Readonly<{ outcome: ProjectSetupExecutionOutcome; manifest: PreparedProjectSetupPlan['manifest'] }> } = {};
            const admitted = await runtime.workerAdmission.execute({ operationId, workspaceRefId: association.workspace.id, requesterAccountId: runtime.accountId,
                memoryDemand: acceptedMemory, signal: operationSignal,
                ...(workerBasis ? { relatedWorkspaces: workerBasis.relationships.flatMap(relationship => [
                    { workspaceRefId: relationship.alphaWorkspaceRefId, relationshipId: relationship.relationshipId },
                    { workspaceRefId: relationship.betaWorkspaceRefId, relationshipId: relationship.relationshipId },
                ]) } : {}),
                accept(handle) { publishProjectFiniteAdmission({ workspace: association.workspace, purpose, requesterAccountId: runtime.accountId, operation,
                    ...commandIdentity, ...(originRun ? { originRun } : {}) });
                    if (!removal) operation.operationAcceptance?.accept(handle); },
                onQueue: ahead => {
                    traceExternalActionStage(args.actionId, rootRequestId, 'project.reservation.queued');
                    operation.operationProgress.update({ phase: 'queued', queueAhead: ahead, label: `Queued — ${ahead} ahead` });
                },
                onReserved: () => {
                    traceExternalActionStage(args.actionId, rootRequestId, 'project.reservation.ready');
                    operation.operationProgress.update({ phase: 'preparing', label: 'Preparing workspace' });
                },
                onUnknown: error => { nativeUncertain = true; operation.operationOwnerUpdate.update({ observation: {
                    kind: codeOf(error) === 'stop_unconfirmed' ? 'stop_unconfirmed' : 'outcome_uncertain', code: codeOf(error),
                } }); },
                run: async reservation => {
                    let kind: ProjectSetupExecutionOutcome['kind'] = 'no_launch';
                    const preparationPhase = (phase: 'copying' | 'setup') => {
                        reservation.phase(phase);
                        if (phase === 'copying' && !workerBasis) return;
                        operation.operationProgress.update({ phase,
                            label: phase === 'copying' ? 'Copying current files' : 'Preparing project' });
                    };
                    const resumeSetupReview = async (result: ActionExecuteResult) => {
                        const pending = readProjectSetupConsentFailureV1(withRequestedConsentScope(result));
                        if (kind !== 'no_launch' || !pending || !operation.operationReview || removal?.requireRememberedConsent) return false;
                        preparationPhase('setup');
                        await operation.operationReview.waitForResume(pending.details, { review: async decision => {
                            await assertNotCancelled();
                            association = await resolveAccepted();
                            const source = await reviewSourcePlacement();
                            if (!projectExecutionChoicesEqualV1(source.choice, acceptedChoice!)
                                || source.memoryDemand?.bytes !== acceptedMemory?.bytes) throw coded('project_script_effect_changed',
                                    scriptChangedDetails(selectedExecutionDeclaration(source.sourceDefinition)));
                            await assertSourceExecutionCurrent(source);
                            if (acceptedPrimaryBasis !== undefined && await readPrimaryAdmissionBasis() !== acceptedPrimaryBasis) throw coded('project_script_effect_changed',
                                scriptChangedDetails(selectedExecutionDeclaration(source.sourceDefinition)));
                            // Remember must compare the current copied effect before
                            // writing Trust, not discover changed SOURCE only after
                            // a stale grant has woken this retained invocation.
                            preparationPhase('copying');
                            await prepareDequeue();
                            preparationPhase('setup');
                            const refreshed = await prepareProjectSetup(preparation());
                            await assertNotCancelled();
                            if (refreshed.kind === 'refused') throw coded(refreshed.code);
                            if (refreshed.kind !== 'pendingApproval') return null;
                            if (decision && decision.reviewedEffectDigest === refreshed.plan.reviewedEffectDigest) {
                                // The retained producer, after current SOURCE/copy/target review,
                                // admits this choice only for its original invocation.
                                setupDecision = decision;
                                return null;
                            }
                            const code = decision ? 'project_setup_effect_changed' : refreshed.code;
                            const reviewed = readProjectSetupConsentFailureV1(withRequestedConsentScope(failure(code, {
                                kind: 'pendingApproval', code, reviewedEffect: refreshed.plan.reviewedEffect,
                                reviewedEffectDigest: refreshed.plan.reviewedEffectDigest,
                            })));
                            if (!reviewed) throw coded('project_setup_effect_unavailable');
                            return reviewed.details;
                        } });
                        await assertNotCancelled();
                        association = await resolveAccepted();
                        const source = await reviewSourcePlacement();
                        if (!projectExecutionChoicesEqualV1(source.choice, acceptedChoice!)
                            || source.memoryDemand?.bytes !== acceptedMemory?.bytes) throw coded('project_script_effect_changed');
                        await assertSourceExecutionCurrent(source);
                        if (acceptedPrimaryBasis !== undefined && await readPrimaryAdmissionBasis() !== acceptedPrimaryBasis) throw coded('project_script_effect_changed');
                        preparationPhase('copying');
                        await prepareDequeue();
                        return true;
                    };
                    const reviewBeforeEffects = async (sourceReview?: Awaited<ReturnType<typeof reviewSourcePlacement>>): Promise<Review> => {
                        while (true) {
                            const current = await review(sourceReview);
                            sourceReview = undefined;
                            if (current.kind === 'failed' && await resumeSetupReview(current.result)) continue;
                            return current;
                        }
                    };
                    const finish = (result: ActionExecuteResult) => {
                        if (kind === 'outcome_uncertain') throw coded(result.ok ? 'outcome_uncertain' : result.errorCode);
                        return { kind, result: kind === 'no_launch' && operationSignal.aborted ? failure('cancelled') : withRequestedConsentScope(result) };
                    };
                    try {
                        const refusal = await readProjectRuntimeAdmissionRefusal(authorityRuntime, { ...ingress, signal: operationSignal });
                        if (refusal) return finish(refusal);
                        if (requesterIdentity.kind === 'isolated' && resolveHostRequesterAgentPlacementForHost({ identity: requesterIdentity,
                            snapshot: runtime.agentIsolation?.read() }) !== 'daemon') {
                            if (!runtime.nativeOperationRuntime) throw coded('agent_isolation_unavailable');
                            nativePreparation = await runtime.nativeOperationRuntime.prepareNativeOperation({ requesterIdentity,
                                ...(requesterAccount ? { requesterAccount } : {}), ingress, signal: operationSignal,
                                readMaterial: () => materialLive ? material : undefined });
                            runtime = { ...runtime, agentIsolation: nativePreparation.agentIsolation };
                        }
                        const source = await reviewSourcePlacement();
                        if (!projectExecutionChoicesEqualV1(source.choice, acceptedChoice!)
                            || source.memoryDemand?.bytes !== acceptedMemory?.bytes) return finish(failure('project_script_effect_changed'));
                        await assertSourceExecutionCurrent(source);
                        if (acceptedPrimaryBasis !== undefined && await readPrimaryAdmissionBasis() !== acceptedPrimaryBasis) return finish(failure('project_script_effect_changed'));
                        preparationPhase('copying');
                        await prepareDequeue();
                        // A real Sync copy may await remote work and change policy.
                        const current = await reviewBeforeEffects(workerBasis ? undefined : source);
                        if (current.kind === 'failed') return finish(current.result);
                        if (!baseline) {
                            if (!projectExecutionChoicesEqualV1(current.invocation.choice, acceptedChoice!)
                                || current.invocation.memoryDemand?.bytes !== acceptedMemory?.bytes) return finish(failure('project_script_effect_changed', {
                                    kind: 'pendingApproval', code: 'project_script_effect_changed', reviewedEffectDigest: current.invocation.reviewedEffectDigest, reviewedEffect: current.invocation.reviewedEffect,
                                }));
                            baseline = current.invocation;
                        }
                        if (!unchanged(current.invocation)) return finish(failure('project_script_effect_changed', {
                            kind: 'pendingApproval', code: 'project_script_effect_changed', reviewedEffectDigest: current.invocation.reviewedEffectDigest, reviewedEffect: current.invocation.reviewedEffect,
                        }));
                        preparationPhase('setup');
                        const beforeSetupEffect = async () => {
                            // A primary no-op Sync no longer spends a row read;
                            // real setup effects retain current association admission.
                            if (!workerBasis) association = await resolveAccepted();
                            await assertNotCancelled();
                        };
                        let setupReview = current;
                        let setup = await stage('project.setup.execute', () => executeProjectSetup({ ...executionInput(), preparation: { ...executionInput().preparation,
                            expectedEffectDigest: current.invocation.plan.reviewedEffectDigest }, beforeNativeEffect: beforeSetupEffect }));
                        while (setup.kind === 'no_launch' && await resumeSetupReview(setup.result)) {
                            const rechecked = await reviewBeforeEffects();
                            if (rechecked.kind === 'failed') return finish(rechecked.result);
                            if (!unchanged(rechecked.invocation)) return finish(failure('project_script_effect_changed', {
                                kind: 'pendingApproval', code: 'project_script_effect_changed', reviewedEffectDigest: rechecked.invocation.reviewedEffectDigest, reviewedEffect: rechecked.invocation.reviewedEffect,
                            }));
                            preparationPhase('setup');
                            setupReview = rechecked;
                            setup = await stage('project.setup.execute', () => executeProjectSetup({ ...executionInput(), preparation: { ...executionInput().preparation,
                                expectedEffectDigest: rechecked.invocation.plan.reviewedEffectDigest }, beforeNativeEffect: beforeSetupEffect }));
                        }
                        if (setup.setupSettlement) runtime.publishSetupSettlement?.(setup.setupSettlement);
                        kind = setup.kind;
                        if (setup.kind === 'outcome_uncertain') throw coded(setup.result.ok ? 'outcome_uncertain' : setup.result.errorCode);
                        setupState.settled = { outcome: setup, manifest: setupReview.invocation.plan.manifest };
                        if (!setup.result.ok || request.actionId === 'projects.prepare') return finish(setup.result);
                        // No setup process or environment effect ran. The final
                        // post-authorization review still checks current bytes.
                        const afterSetup = setup.kind === 'no_launch' ? setupReview : await review();
                        if (afterSetup.kind === 'failed') return finish(afterSetup.result);
                        if (!unchanged(afterSetup.invocation)) return finish(failure('project_script_effect_changed', {
                            kind: 'pendingApproval', code: 'project_script_effect_changed', reviewedEffectDigest: afterSetup.invocation.reviewedEffectDigest, reviewedEffect: afterSetup.invocation.reviewedEffect,
                        }));
                        const invocation = afterSetup.invocation;
                        const input = executionInput();
                        const assertSynchronousCurrent = () => { if (operationSignal.aborted) throw coded('cancelled'); };
                        await assertNotCancelled();
                        let launch: Awaited<ReturnType<typeof authorizePreparedProjectCommand>>;
                        const command = invocation.command;
                        if (command) launch = await stage('project.native.authorize', () =>
                            authorizePreparedProjectCommand(input, invocation.plan, command, operationSignal));
                        else if (request.actionId === 'projects.compute.exec') {
                            await assertNotCancelled();
                            const launchPlan = invocation.plan;
                            const env = projectBaseEnvironment(input, launchPlan);
                            const projectLaunch = createProjectNativeLaunchAdmission(input, launchPlan);
                            launch = await authorizeResolvedProjectExecLaunchForHost({ launch: { command: request.input.executable, args: request.input.argv,
                                cwd: validatePath(invocationCwd().replaceAll('\\', '/'), association.workspace.rootPath).resolvedPath!, env },
                                projectLaunch, signal: operationSignal, assertCurrent: assertSynchronousCurrent,
                                agentIsolation: runtime.agentIsolation,
                                requesterIdentity,
                                ...(projectLaunch.nativeAdapter ? { nativeExecutableOwner: projectLaunch.nativeAdapter.lease.exec } : {}) });
                        } else return finish(failure('project_script_unavailable'));
                        try {
                            await assertNotCancelled();
                            association = await resolveAccepted();
                            const final = await review();
                            if (final.kind === 'failed') return finish(final.result);
                            if (!unchanged(final.invocation)) return finish(failure('project_script_effect_changed', {
                                kind: 'pendingApproval', code: 'project_script_effect_changed', reviewedEffectDigest: final.invocation.reviewedEffectDigest, reviewedEffect: final.invocation.reviewedEffect,
                            }));
                            await assertNotCancelled();
                            if (invocation.plan.toolchainAdapterLease && !invocation.plan.toolchainAdapterLease.isCurrent()
                                || invocation.command?.kind === 'pluginNative' && !invocation.command.lease.isCurrent()) throw coded('native_adapter_retired');
                            reservation.phase('running');
                            traceExternalActionStage(args.actionId, rootRequestId, 'project.native.launch');
                            const outcome = await executeProjectFiniteProcess({ workspace: association.workspace, purpose, requesterAccountId: runtime.accountId,
                                ...commandIdentity,
                                ...(nativePreparation?.memberIdentity ? { nativeExecutionIdentity: nativePreparation.memberIdentity } : {}),
                                ...(lastCleanSyncAtMs !== undefined ? { lastCleanSyncAtMs } : {}),
                                ...(executionInput().terminalCustody ? { terminalCustody: executionInput().terminalCustody } : {}),
                                operation, terminalSessions: runtime.terminalSessions, launch, signal: operationSignal, ...(originRun ? { originRun } : {}) });
                            kind = outcome.kind;
                            if (outcome.kind === 'outcome_uncertain') throw coded(outcome.result.ok ? 'outcome_uncertain' : outcome.result.errorCode);
                            return finish(outcome.result);
                        } catch (error) {
                            if (isProjectNativeProcessUncertain(error) || error instanceof ProjectNativeToolchainUncertainError) kind = 'outcome_uncertain';
                            throw error;
                        } finally { if (kind !== 'outcome_uncertain') launch.release(); }
                    } catch (error) {
                        const cancelledBuiltinEnvironment = operationSignal.aborted
                            && baseline?.plan.toolchain.kind === 'toolchain' && nativeInvocations.size > 0;
                        if (error instanceof ProjectNativeToolchainUncertainError
                            || cancelledBuiltinEnvironment && isProjectNativeProcessUncertain(error)) {
                            // Keep the reservation and Stop listener until the
                            // native owner proves settlement, then settle the
                            // operation instead of rethrowing the stale unknown.
                            await releaseNativeInvocations();
                            return { kind: 'process_settled', result: failure(operationSignal.aborted ? 'cancelled' : codeOf(error)) };
                        }
                        preserveUnconfirmedNativeProcess(error);
                        if (kind === 'outcome_uncertain') throw error;
                        return { kind, result: operationSignal.aborted ? failure('cancelled') : await failureFromError(error,
                            !operationSignal.aborted && codeOf(error) === 'project_script_effect_changed' && error instanceof Error && 'details' in error
                                ? error.details : undefined) };
                    } finally {
                        if (kind !== 'outcome_uncertain') await releaseNativeInvocations();
                    }
                },
            });
            const admissionResult = admitted.ok ? FiniteAdmissionV1Schema.safeParse(admitted.result) : null;
            if (admissionResult?.success && admissionResult.data.kind === 'not_accepted') {
                const details = acceptedChoice.kind === 'workers' && workerUnavailable !== undefined
                    ? ProjectWorkerNoAcceptanceFailureDetailsV1Schema.safeParse({ kind: 'no_worker_can_accept',
                        unavailable: workerUnavailable, reason: admissionResult.data.reason }) : null;
                return failure(admissionResult.data.reason, details?.success ? details.data : undefined);
            }
            // Release the containing finite reservation before a Service child
            // admits its own setup. A one-slot host must not queue behind itself.
            if (setupState.settled) {
                const autostartFailure = await startProjectSetupAutostartServices({ ...setupState.settled, context: args.context,
                    parent: { actionId: request.actionId, input: projectNativeJsonValueForTransport(request.input) as Record<string, JsonValue> } });
                if (autostartFailure) return autostartFailure;
            }
            return admitted;
            } finally {
                try { if (!nativeUncertain) await releaseNativeInvocations(); }
                finally {
                    nativeCustody.dispose();
                    if (releaseRequester) {
                        try { await Promise.all([...nativeInvocations].map(production => production.waitForSettlement())); }
                        finally { try { await retirePreparation(); } finally { await releaseRequester(); } }
                    } else await retirePreparation();
                }
            }
        };
        let result: ActionExecuteResult;
        const local = args.context.operationAcceptance?.actionId === request.actionId ? args.context : ingress.localActionContext;
        if (removal && request.actionId === PROJECT_PREPARE_ACTION_ID_V1 && request.input.phase === 'teardown') {
            result = await run(removal.operation);
        } else if (local?.operationOwnerUpdate && local.operationAcceptance?.actionId === request.actionId) {
            const attribution = acceptedAttribution('requesterWorkAttributionV1' in local ? local.requesterWorkAttributionV1 : undefined);
            const ingressReview = ingress.localActionContext?.operationAcceptance?.actionId === request.actionId
                && ingress.localActionContext.operationAcceptance.operationId === local.operationAcceptance.operationId
                ? ingress.localActionContext.operationReview : undefined;
            result = await run({ signal, actionRequestId: args.context.actionRequestId ?? local.actionRequestId ?? undefined,
                ...(attribution ? { requesterWorkAttributionV1: attribution } : {}),
                operationOwnerUpdate: local.operationOwnerUpdate, operationAcceptance: local.operationAcceptance,
                ...(local.operationCancellation ? { operationCancellation: local.operationCancellation } : {}),
                ...(ingressReview ? { operationReview: ingressReview } : {}),
                operationProgress: local.operationProgress ?? { update() {} } });
            if (result.ok && request.actionId !== 'projects.prepare') {
                // The containing runner already owns this invocation. Return its
                // canonical handle, just as observeExecution does for a new one;
                // the PTY success marker is not a public Project Action output.
                const current = runtime.operationRuntime.store.get({ accountId: runtime.accountId, machineId: runtime.machineId }, local.operationAcceptance.operationId);
                result = current?.actionId === request.actionId
                    ? { ok: true, result: { operation: current } }
                    : failure('project_finite_operation_unavailable');
            }
        } else result = await runtime.operationRuntime.observeExecution({ actionId: request.actionId, input: request.input,
            rpcContext: ingress,
            actionRequestId: args.context.actionRequestId ?? ingress.transportRequestId,
            sessionId: ingress.sessionActionOrigin?.caller.sessionId,
            execute: run });
        return result.ok ? result.result : withRequestedConsentScope(result);
        } catch (error) {
            nativeUncertain = isProjectNativeProcessUncertain(error) || error instanceof ProjectNativeToolchainUncertainError;
            throw error;
        } finally { if (!runStarted && !nativeUncertain) await releaseNativeInvocations(); }
    };
}
