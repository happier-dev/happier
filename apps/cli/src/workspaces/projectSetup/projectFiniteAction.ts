import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { createWorkspaceExecutionConfigClientV1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigClientV1';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { HostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import type { ProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import type { ProjectSetupExecutionInput } from './projectSetupExecution';
import type { ProjectSetupPreparationInput } from './projectSetupPreparation';
import type { StoredCredentials } from '@/persistence';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { WorkspaceSyncPrepareBetweenResultV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { ProjectManifestFileSnapshot } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestDocument';
import type { ProjectDefinitionInspectOutput } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { projectWorkspaceRefV1, workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { WorkspaceSyncWorkerTargetBasis } from '@/workspaces/sync/workspaceSyncPreparation';
import { FiniteAdmissionV1Schema } from '@happier-dev/protocol/workspaces/projectWorkerExecutionV1';
import { createHash } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { PROJECT_ACTION_INPUT_SCHEMAS_V1, ProjectWorkerNoAcceptanceFailureDetailsV1Schema,
    readProjectSetupConsentFailureV1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { resolveProjectExecutionChoiceV1, projectExecutionChoicesEqualV1, type ProjectExecutionChoiceV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import { assertProjectReceivingPlacement } from '@/workspaces/execution/projectReceivingPlacement';
import type { ActionExecuteResult, ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ProjectNativeEnvironmentUncertainError } from '@/workspaces/environment/produceProjectNativeEnvironment';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import type { ProjectCommandSourceV1, ProjectMemoryDemandV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import { resolveProjectMemoryDemandV1 as maximumDemand } from '@happier-dev/protocol/workspaces/projectSetup/projectMemoryDemandV1';
import { isProjectNativeProcessUncertain, preserveUnconfirmedNativeProcess, type ProjectNativeAdapterProductionV1 } from '@/plugins/runtime/lifecycle/contributions/targetProjectNativeAdapters';
import { authorizeResolvedProjectExecLaunchForHost, type ProjectNativeEffectCaptureForHost } from '@/plugins/runtime/invocation/services/exec';
import { validatePath } from '@/rpc/handlers/pathSecurity';
import { getPathRemainderWithinBase, resolveSessionHandoffWorkspaceSessionPath } from '@/session/handoff/paths/sessionHandoffPathNormalization';
import { resolveProjectSetupAcceptedWorkspace } from './projectSetupAcceptedWorkspace';
import { RequesterWorkAttributionV1Schema } from '@/daemon/lifecycle/requesterWorkAttribution';
import { resolveProjectEnvironmentSelection, resolveProjectNativeCommand, readProjectExecutionInputs } from './projectNativeResolution';
import { inspectProjectDefinitionExecutionFacts } from './projectDefinitionInspection';
import { readProjectDefinitionFileBytes } from './nativeDefinitionFiles';
import { readProjectManifest } from './projectManifestFile';
import { prepareProjectSetup, resolveProjectSetupConfigEnvironment, type PreparedProjectSetupCommand, type PreparedProjectSetupPlan } from './projectSetupPreparation';
import { executeProjectSetup, executeProjectFiniteProcess, publishProjectFiniteAdmission, authorizePreparedProjectCommand,
    createProjectNativeLaunchAdmission, createProjectNativeInvocationCustody, type ProjectSetupExecutionOutcome, type ProjectSetupOperationContext } from './projectSetupExecution';

export type ProjectFiniteActionRuntime = Readonly<{
    serverId: string;
    machineId: string;
    accountId: string;
    credentials: StoredCredentials;
    serverHttpBaseUrl: string;
    /** Exact Home credential lifetime supplied by the installed host constructor. */
    isCurrent?: () => Promise<boolean>;
    operationRuntime: Pick<HostActionOperationRuntime, 'observeExecution'>;
    workerAdmission: ProjectWorkerAdmission;
    /** Captures the actual requester Action and credential lifetime in B6's Account/Home carrier. */
    resolveWorkspaceExecutionConfig: (context: Parameters<NonNullable<ActionExecutorDeps['projectAction']>>[0]['context'], ingress: RpcHandlerContext,
        actionId: 'projects.script.run' | 'projects.compute.exec' | 'localServices.launcher.start')
        => Promise<(Pick<ReturnType<typeof createWorkspaceExecutionConfigClientV1>, 'get'> & Partial<Pick<ReturnType<typeof createWorkspaceExecutionConfigClientV1>, 'getService'>>) | null>;
    nativeIo: ProjectSetupPreparationInput['nativeIo'];
    environmentIo: ProjectSetupExecutionInput['environmentIo'];
    terminalSessions: ProjectSetupExecutionInput['terminalSessions'];
    platform?: NodeJS.Platform;
    arch?: string;
    hostEnvironment?: NodeJS.ProcessEnv;
    successHomeDir?: string;
    secretEnvironment?: ProjectSetupPreparationInput['secretEnvironment'];
    configEnvironment?: ProjectSetupPreparationInput['configEnvironment'];
    plugins?: ProjectSetupPreparationInput['plugins'];
    /** Canonical projects.inspect on the exact accepted SOURCE, with requester Home authority. */
    inspectSourceProjectManifest?: (input: Readonly<{ source: WorkspaceRefV1; signal: AbortSignal }>) => Promise<ProjectManifestFileSnapshot
        & Pick<ProjectDefinitionInspectOutput, 'commands' | 'environmentExecutionInputs'>>;
    resolveWorkerTarget?: (input: Readonly<{ source: WorkspaceRefV1; signal: AbortSignal }>) => Promise<WorkspaceSyncWorkerTargetBasis>;
    /** Real B7 Sync/dequeue preparation; revalidation follows this callback. */
    prepareDequeue?: (input: Readonly<{ workspace: WorkspaceRefV1; choice: ProjectExecutionChoiceV1; basis?: WorkspaceSyncWorkerTargetBasis; signal: AbortSignal }>) => Promise<Extract<WorkspaceSyncPrepareBetweenResultV1, { ok: true }> | void>;
}>;

const failure = (errorCode: string, details?: unknown): ActionExecuteResult => ({ ok: false, errorCode, error: errorCode,
    ...(details === undefined ? {} : { details }) });
const coded = (errorCode: string, details?: unknown): Error & { code: string; details?: unknown } => Object.assign(new Error(errorCode), { code: errorCode,
    ...(details === undefined ? {} : { details }) });
const codeOf = (error: unknown) => error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code : 'project_finite_execution_unavailable';
const digest = (value: unknown) => createHash('sha256').update(createCanonicalJsonSigningInput(projectNativeJsonValueForTransport(value))).digest('hex');

/** The current restricted proof producer admits Session messages, not finite Project effects. */
export function readProjectFiniteIngressRefusal(ingress: RpcHandlerContext): ActionExecuteFailure | null {
    return ingress.callerInputConstraints || ingress.callerInputAuthorization
        ? { ok: false, errorCode: 'project_requester_authorization_unavailable', error: 'project_requester_authorization_unavailable' } : null;
}

type FiniteRequest =
    | Readonly<{ actionId: 'projects.prepare'; input: import('@happier-dev/protocol/actions/projectActionFamily').ProjectPrepareInputV1 }>
    | Readonly<{ actionId: 'projects.script.run'; input: import('zod').infer<typeof PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.script.run']> }>
    | Readonly<{ actionId: 'projects.compute.exec'; input: import('zod').infer<typeof PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.compute.exec']> }>;
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
export function createProjectFiniteAction(runtime: ProjectFiniteActionRuntime, ingress: RpcHandlerContext): NonNullable<ActionExecutorDeps['projectAction']> {
    return async args => {
        const ingressRefusal = readProjectFiniteIngressRefusal(ingress);
        if (ingressRefusal) return ingressRefusal;
        if (args.actionId !== 'projects.prepare' && args.actionId !== 'projects.script.run' && args.actionId !== 'projects.compute.exec') {
            return failure('unsupported_action');
        }
        const parsed = PROJECT_ACTION_INPUT_SCHEMAS_V1[args.actionId].safeParse(args.input);
        if (!parsed.success) return failure('invalid_parameters');
        const request = { actionId: args.actionId, input: parsed.data } as FiniteRequest;
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
            || request.input.workspace.serverId !== runtime.serverId || args.context.serverId && args.context.serverId !== runtime.serverId) return failure('target_mismatch');
        if (admission.actorAccountId !== runtime.accountId || admission.custodianAccountId !== runtime.accountId) return failure('project_requester_credentials_unavailable');
        const requesterBaseline = Object.freeze(RequesterWorkAttributionV1Schema.parse({ serverId: runtime.serverId,
            accountId: admission.actorAccountId, machineId: admission.machineId, installationId: admission.installationId }));
        const acceptedAttribution = (value: unknown) => {
            const parsed = RequesterWorkAttributionV1Schema.safeParse(value);
            return parsed.success && parsed.data.serverId === requesterBaseline.serverId && parsed.data.accountId === requesterBaseline.accountId
                && parsed.data.machineId === requesterBaseline.machineId && parsed.data.installationId === requesterBaseline.installationId
                ? parsed.data : undefined;
        };
        const assertCurrent = async () => {
            if (signal.aborted) throw coded('cancelled');
            if (runtime.isCurrent && !await runtime.isCurrent()) throw coded('project_requester_credentials_unavailable');
            if (!await ingress.verifyMachineAdmissionCurrent!()) throw coded('machine_admission_changed');
            if (runtime.isCurrent && !await runtime.isCurrent()) throw coded('project_requester_credentials_unavailable');
            if (signal.aborted) throw coded('cancelled');
        };
        let workerBasis: WorkspaceSyncWorkerTargetBasis | undefined;
        const resolveAccepted = async () => {
            await assertCurrent();
            const association = await resolveProjectSetupAcceptedWorkspace({ address: request.input.workspace,
                credentials: runtime.credentials, serverId: runtime.serverId, serverHttpBaseUrl: runtime.serverHttpBaseUrl, signal });
            await assertCurrent();
            if (!workerBasis) return association;
            if (association.workspace.id !== workerBasis.source.id || association.workspace.machineId !== workerBasis.source.machineId
                || association.workspace.rootPath !== workerBasis.source.rootPath || association.workspace.projectKey !== workerBasis.source.projectKey) throw coded('project_workspace_changed');
            const target = await resolveProjectSetupAcceptedWorkspace({ address: { serverId: workerBasis.target.serverId, workspaceId: workerBasis.target.id,
                machineId: workerBasis.target.machineId, rootPath: workerBasis.target.rootPath }, credentials: runtime.credentials,
                serverId: runtime.serverId, serverHttpBaseUrl: runtime.serverHttpBaseUrl, signal });
            await assertCurrent();
            if (target.workspace.machineId !== runtime.machineId || target.workspace.projectKey !== association.workspace.projectKey) throw coded('project_workspace_changed');
            return target;
        };
        let association: Awaited<ReturnType<typeof resolveAccepted>>;
        try { association = await resolveAccepted(); } catch (error) { return failure(codeOf(error)); }
        const sourceAssociation = association;
        const assertReceivingPlacement = async (choice: ProjectExecutionChoiceV1) => {
            await assertProjectReceivingPlacement({ choice, sourceMachineId: sourceAssociation.workspace.machineId,
                receivingMachineId: runtime.machineId, ...(args.executeCanonicalAction ? { readPool: async poolId => {
                    await assertCurrent();
                    const result = await args.executeCanonicalAction!('machines.pools.get', { poolId });
                    await assertCurrent();
                    return result;
                } } : {}) });
        };
        let acceptedChoice: ProjectExecutionChoiceV1 | undefined;
        let acceptedMemory: ProjectMemoryDemandV1 | undefined;
        let acceptedScript: ProjectSetupExecutionInput['script'] = request.actionId === 'projects.script.run'
            && request.input.selection.kind === 'native' ? { source: request.input.selection.source } : undefined;
        let workerRelativeCwd: string | undefined;
        const selectedExecutionDeclaration = (definition: ProjectManifestFileSnapshot) => {
            if (definition.document?.status === 'invalid') throw coded('invalid_manifest');
            const manifest = definition.document?.manifest ?? null;
            const config = resolveProjectSetupConfigEnvironment(manifest, runtime.configEnvironment);
            if (config.kind === 'refused') throw coded(config.code);
            const named = request.actionId === 'projects.script.run' && request.input.selection.kind === 'named'
                ? manifest?.scripts?.[request.input.selection.name] : undefined;
            const source = request.actionId === 'projects.script.run'
                ? request.input.selection.kind === 'named' ? named?.source : request.input.selection.source : undefined;
            if (request.actionId === 'projects.script.run' && !source) throw coded('project_script_not_found');
            return projectNativeJsonValueForTransport({ purpose: request.actionId === 'projects.script.run' ? 'script' : 'exec',
                command: source ?? (request.actionId === 'projects.compute.exec' ? { executable: request.input.executable, argv: request.input.argv } : undefined),
                execution: named?.execution ?? 'primary', environment: manifest?.environment ?? { kind: 'host' },
                environmentVariables: manifest?.environmentVariables ?? [], configEnvironment: config.environment });
        };
        const scriptChangedDetails = (reviewedEffect: unknown) => ({ kind: 'pendingApproval' as const,
            code: 'project_script_effect_changed' as const, reviewedEffect: projectNativeJsonValueForTransport(reviewedEffect),
            reviewedEffectDigest: digest(reviewedEffect) });
        const reviewSourcePlacement = async () => {
            if (sourceAssociation.workspace.machineId !== runtime.machineId && !runtime.inspectSourceProjectManifest) {
                throw coded('project_source_declaration_unavailable');
            }
            const sourceDefinition: ProjectManifestFileSnapshot & Pick<ProjectDefinitionInspectOutput, 'commands' | 'environmentExecutionInputs'> = sourceAssociation.workspace.machineId === runtime.machineId
                ? await readProjectManifest({ root: sourceAssociation.workspace.rootPath })
                : await runtime.inspectSourceProjectManifest!({ source: sourceAssociation.workspace, signal });
            await assertCurrent();
            if (sourceDefinition.document?.status === 'invalid') throw coded('invalid_manifest');
            const sourceManifest = sourceDefinition.document?.manifest;
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
            const execution = request.actionId === 'projects.compute.exec' ? 'portable'
                : named?.execution ?? 'primary';
            const config = await runtime.resolveWorkspaceExecutionConfig(args.context, ingress, request.actionId);
            await assertCurrent();
            if (!config) throw coded('preferences_unavailable');
            const policy = await config.get({ workspace: { serverId: sourceAssociation.workspace.serverId, refId: sourceAssociation.workspace.id } });
            await assertCurrent();
            const placement = resolveProjectExecutionChoiceV1({ execution, sourceMachineId: sourceAssociation.workspace.machineId,
                adHoc: request.actionId === 'projects.compute.exec',
                ...(args.context.executionRunTargetMachineId ? { acceptedMachineId: args.context.executionRunTargetMachineId } : {}),
                ...(request.actionId === 'projects.script.run' && request.input.selection.kind === 'named' ? { scriptName: request.input.selection.name } : {}),
                invocation: request.input.choice, preference: policy.status === 'ready' ? { status: 'ready', value: policy.preference } : { status: policy.status } });
            if (placement.status === 'refused') throw coded(placement.reason);
            await assertReceivingPlacement(placement.choice);
            const script = request.actionId === 'projects.script.run' && request.input.selection.kind === 'named' && named
                ? { name: request.input.selection.name, source: named.source } : acceptedScript;
            return { choice: placement.choice, script, sourceDefinition, unavailable: policy.status === 'ready' ? policy.preference.unavailable : undefined,
                memoryDemand: maximumDemand(request.input.memoryDemand, named?.memoryDemand, sourceManifest?.workspace?.memoryDemand) };
        };
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
            } catch (error) { return failure(codeOf(error)); }
        } else if (sourceAssociation.workspace.machineId !== runtime.machineId) return failure('target_not_local');
        const readWorkerExecutionBasis = async (definition: typeof initialSourceDefinition) => {
            const manifest = definition.document?.manifest;
            const declaredEffect = selectedExecutionDeclaration(definition);
            const inspection = sourceAssociation.workspace.machineId === runtime.machineId
                ? await inspectProjectDefinitionExecutionFacts({ root: sourceAssociation.workspace.rootPath,
                    ...(manifest ? { manifest } : {}), detection: { entries: [], environments: [], devcontainers: [], coverage: 'complete', diagnostics: [] },
                    io: runtime.nativeIo, signal }) : definition;
            await assertCurrent();
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
            if (manifest?.environment && manifest.environment.kind !== 'host') {
                if (!inspection.environmentExecutionInputs?.length) throw coded('project_source_declaration_unavailable');
                for (const input of inspection.environmentExecutionInputs) files.set(input.file, input.hash);
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
            const definition = await readProjectManifest({ root: association.workspace.rootPath });
            await assertCurrent();
            const declaredEffect = selectedExecutionDeclaration(definition);
            const executionInputs = await readProjectExecutionInputs(association.workspace.rootPath, acceptedWorkerBasis.executionInputs.map(input => input.file));
            await assertCurrent();
            const current = { declaredEffect, ...(executionInputs ? { executionInputs } : { executionInputsUnavailable: true }) };
            if (!executionInputs || digest(current) !== digest(acceptedWorkerBasis)) throw coded('project_script_effect_changed', scriptChangedDetails(current));
        };
        const invocationCwd = () => request.actionId === 'projects.compute.exec'
            ? workerRelativeCwd === undefined ? request.input.cwd : resolveSessionHandoffWorkspaceSessionPath({
                targetRoot: association.workspace.rootPath, sessionRelativeCwd: workerRelativeCwd,
            }) : association.workspace.rootPath;
        const preparation = (): Parameters<typeof prepareProjectSetup>[0] => ({ workspace: association.workspace, projectAssociation: association,
            requester: { credentials: runtime.credentials, serverHttpBaseUrl: runtime.serverHttpBaseUrl },
            purpose: request.actionId === 'projects.prepare' ? request.input.phase : 'setup',
            platform: { os: (runtime.platform ?? process.platform) === 'win32' ? 'windows' : runtime.platform ?? process.platform, arch: runtime.arch ?? process.arch },
            nativeIo: runtime.nativeIo, signal: nativeExecutionSignal(),
            retainNativeInvocation,
            ...(runtime.successHomeDir ? { successHomeDir: runtime.successHomeDir } : {}),
            ...(runtime.secretEnvironment ? { secretEnvironment: runtime.secretEnvironment } : {}),
            ...(runtime.configEnvironment ? { configEnvironment: runtime.configEnvironment } : {}),
            ...(runtime.plugins ? { plugins: runtime.plugins } : {}),
            ...(request.actionId === 'projects.compute.exec' && request.input.environmentBindings ? { environmentBindings: request.input.environmentBindings } : {}),
            ...(request.actionId === 'projects.prepare' ? { expectedEffectDigest: request.input.expectedEffectDigest, skipForInvocation: request.input.skipForInvocation } : {}),
        });
        const reviewPath = (value: string) => {
            const root = association.workspace.rootPath;
            const local = relative(root, value);
            return isAbsolute(value) && local !== '..' && !local.startsWith('../') && !local.startsWith('..\\') && !isAbsolute(local)
                ? local.replaceAll('\\', '/') || '.' : value;
        };
        // Primary admission can retain reviewed bytes without giving a selected
        // plugin an invocation/Exec context before the finite reservation.
        async function readPrimaryAdmissionBasis(): Promise<string> {
            const snapshot = await readProjectManifest({ root: association.workspace.rootPath });
            await assertCurrent();
            if (snapshot.document?.status === 'invalid') throw coded('invalid_manifest');
            const manifest = snapshot.document?.manifest ?? null;
            const config = resolveProjectSetupConfigEnvironment(manifest, runtime.configEnvironment);
            if (config.kind === 'refused') throw coded(config.code);
            const files = new Map<string, string>();
            const addFile = async (file: string) => {
                const read = await readProjectDefinitionFileBytes(association.workspace.rootPath, file);
                await assertCurrent();
                if (read.kind !== 'read') throw coded(read.kind === 'refused' ? read.code : 'native_configuration_missing');
                files.set(file.replaceAll('\\', '/'), createHash('sha256').update(read.bytes).digest('hex'));
            };
            const nativeDeclaration = async (source: ProjectCommandSourceV1) => {
                if (source.kind === 'command') return { source };
                await addFile(source.file);
                if (source.kind === 'pluginNative') {
                    if (!runtime.plugins) throw coded('native_adapter_unavailable');
                    const selected = await runtime.plugins.resolveProjectNativeAdapter(source.adapter, 'resolveCommand');
                    await assertCurrent();
                    if (selected.kind === 'refused') throw coded(selected.code);
                    return { source, adapterVersion: selected.lease.pluginVersion };
                }
                const resolved = await resolveProjectNativeCommand({ root: association.workspace.rootPath, source, usage: 'script',
                    io: runtime.nativeIo, signal });
                await assertCurrent();
                if (resolved.kind !== 'resolved') throw coded(resolved.kind === 'refused' ? resolved.code : 'native_adapter_result_invalid');
                for (const fact of resolved.reviewInputs) await addFile(fact.file);
                const executable = reviewPath(resolved.command);
                if (executable !== resolved.command) await addFile(relative(association.workspace.rootPath, resolved.command));
                return { source, ...(executable !== resolved.command ? { executable } : {}), args: resolved.reviewInvocation.args.map(reviewPath),
                    cwd: reviewPath(resolved.cwd), toolchain: resolved.toolchain,
                    nativeCommandEnvironment: resolved.nativeCommandEnvironment,
                    environmentOverlay: resolved.reviewInvocation.environmentOverlay && Object.fromEntries(Object.entries(resolved.reviewInvocation.environmentOverlay)
                        .map(([key, value]) => [key, reviewPath(value)])) };
            };
            const environment = await resolveProjectEnvironmentSelection({ root: association.workspace.rootPath,
                selection: manifest?.environment ?? { kind: 'host' } });
            await assertCurrent();
            if (environment.kind === 'refused') throw coded(environment.code);
            if (environment.file !== undefined) await addFile(environment.file);
            let environmentProvenance: unknown;
            if (environment.selection.kind === 'pluginToolchain') {
                if (!runtime.plugins) throw coded('native_adapter_unavailable');
                const selected = await runtime.plugins.resolveProjectNativeAdapter(environment.selection.adapter, 'produceEnvironment');
                await assertCurrent();
                if (selected.kind === 'refused') throw coded(selected.code);
                environmentProvenance = { adapterVersion: selected.lease.pluginVersion };
            } else if (environment.selection.kind === 'toolchain') {
                const tool = await runtime.nativeIo.resolveTool(environment.selection.tool === 'nix_flake' ? 'nix' : environment.selection.tool,
                    { cwd: association.workspace.rootPath, signal });
                await assertCurrent();
                if (!tool) throw coded('native_tool_unavailable');
                const executable = reviewPath(tool.executablePath);
                if (executable !== tool.executablePath) await addFile(relative(association.workspace.rootPath, tool.executablePath));
                environmentProvenance = { ...(executable !== tool.executablePath ? { executable } : {}), version: tool.version };
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
            return digest({ environment: environment.selection, environmentProvenance, configEnvironment: config.environment,
                command,
                files: [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0) });
        }
        let acceptedPrimaryBasis: string | undefined;
        if (!workerBasis) {
            try { acceptedPrimaryBasis = await readPrimaryAdmissionBasis(); }
            catch (error) { preserveUnconfirmedNativeProcess(error); return failure(codeOf(error)); }
        }
        async function review(): Promise<Review> {
            const prepared = await prepareProjectSetup(preparation());
            await assertCurrent();
            if (prepared.kind === 'refused') return { kind: 'failed', result: failure(prepared.code) };
            if (prepared.kind === 'pendingApproval') return { kind: 'failed', result: withRequestedConsentScope(failure(prepared.code, {
                kind: 'pendingApproval', code: prepared.code, reviewedEffect: prepared.plan.reviewedEffect, reviewedEffectDigest: prepared.plan.reviewedEffectDigest,
            })) };
            const plan = prepared.plan;
            if (request.actionId === 'projects.prepare') return { kind: 'reviewed', invocation: { plan, reviewedEffect: plan.reviewedEffect,
                reviewedEffectDigest: plan.reviewedEffectDigest, executionEffectDigest: plan.reviewedEffectDigest,
                choice: { kind: 'primary' }, memoryDemand: plan.manifest?.workspace?.memoryDemand,
            } };
            const config = await runtime.resolveWorkspaceExecutionConfig(args.context, ingress, request.actionId);
            await assertCurrent();
            if (!config) return { kind: 'failed', result: failure('preferences_unavailable') };
            const policy = await config.get({ workspace: { serverId: sourceAssociation.workspace.serverId, refId: sourceAssociation.workspace.id } });
            await assertCurrent();
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
                        await assertCurrent();
                        if (selected.kind === 'refused') return { kind: 'failed', result: failure(selected.code) };
                        const acquired = selected.lease.acquireProduction({ root: plan.workspace.rootPath,
                            environment: runtime.configEnvironment, signal: nativeExecutionSignal() });
                        if (acquired.kind !== 'ready') return { kind: 'failed', result: failure(acquired.code) };
                        lease = acquired.production;
                        retainNativeInvocation(lease);
                    }
                    const resolved = await resolveProjectNativeCommand({ root: plan.workspace.rootPath, source, usage: 'script', io: runtime.nativeIo, signal: nativeExecutionSignal(),
                        ...(lease ? { plugin: { lease } } : {}) });
                    await assertCurrent();
                    if (resolved.kind === 'refused') return { kind: 'failed', result: failure(resolved.code) };
                    if (source.kind === 'native' && resolved.kind === 'resolved') command = { kind: 'native', source, resolution: resolved };
                    else if (source.kind === 'pluginNative' && resolved.kind === 'pluginResolved' && lease?.isCurrent()) command = { kind: 'pluginNative', source, resolution: resolved.command, lease };
                    else return { kind: 'failed', result: failure('native_adapter_retired') };
                }
            } else {
                execution = 'portable';
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
                    await assertCurrent();
                    if (read.kind !== 'read') return { kind: 'failed', result: failure(read.kind === 'refused' ? read.code : 'native_configuration_missing') };
                    if (native.reviewInputs.some(fact => fact.file === file && fact.content !== read.bytes.toString('utf8'))) return { kind: 'failed', result: failure('project_script_effect_changed') };
                    reviewedFiles.set(file.replaceAll('\\', '/'), createHash('sha256').update(read.bytes).digest('hex'));
                }
            }
            const reviewedCommand = command?.kind === 'literal' ? { source, cwd: reviewPath(command.cwd) }
                : native ? { source, executable: command?.kind === 'native' ? reviewPath(command.resolution.command)
                    : command?.kind === 'pluginNative' ? command.resolution.executable : undefined,
                    args: (command?.kind === 'native' ? command.resolution.reviewInvocation.args : native.args).map(reviewPath), cwd: reviewPath(native.cwd),
                    files: [...reviewedFiles].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([file, digest]) => ({ file, digest })),
                    ...(command?.kind === 'native' ? { toolchain: command.resolution.toolchain, environmentOverlay: command.resolution.reviewInvocation.environmentOverlay && Object.fromEntries(Object.entries(command.resolution.reviewInvocation.environmentOverlay).map(([key, value]) => [key, reviewPath(value)])),
                        nativeCommandEnvironment: command.resolution.nativeCommandEnvironment } : {}),
                    ...(command?.kind === 'pluginNative' ? { adapterVersion,
                        nativeCommandEnvironment: command.resolution.environmentApplied } : {}),
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
        }
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
            try {
            const operationId = operation.operationAcceptance?.operationId ?? operation.actionRequestId;
            if (!operationId) return failure('project_finite_operation_unavailable');
            const operationSignal = AbortSignal.any([signal, operation.signal]);
            let lastCleanSyncAtMs: ProjectSetupExecutionInput['lastCleanSyncAtMs'];
            const prepareDequeue = async () => {
                const prepared = await runtime.prepareDequeue?.({ workspace: workerBasis?.source ?? association.workspace, choice: acceptedChoice!,
                    ...(workerBasis ? { basis: workerBasis } : {}), signal: operationSignal });
                association = await resolveAccepted();
                await assertCopiedExecutionCurrent();
                lastCleanSyncAtMs = prepared ? prepared.traversed.at(-1)?.status.lastCleanSyncAtMs : undefined;
                if (lastCleanSyncAtMs !== undefined) publishProjectFiniteAdmission({ workspace: association.workspace, purpose,
                    requesterAccountId: runtime.accountId, operation, ...commandIdentity, lastCleanSyncAtMs,
                    ...(originRun ? { originRun } : {}) });
            };
            const executionInput = (): ProjectSetupExecutionInput => ({ preparation: { ...preparation(), signal: operationSignal }, operation,
                ...commandIdentity,
                ...(lastCleanSyncAtMs !== undefined ? { lastCleanSyncAtMs } : {}),
                requesterAccountId: runtime.accountId, terminalSessions: runtime.terminalSessions, environmentIo: runtime.environmentIo,
                terminalCustody: {
                    serverId: requesterBaseline.serverId, requesterAccountId: requesterBaseline.accountId, machineId: requesterBaseline.machineId,
                    installationId: requesterBaseline.installationId, workspaceRefId: association.workspace.id,
                    projectKey: projectWorkspaceRefV1(association.workspace).projectKey, rootPath: association.workspace.rootPath,
                },
                ...(runtime.platform ? { platform: runtime.platform } : {}), ...(runtime.hostEnvironment ? { hostEnvironment: runtime.hostEnvironment } : {}),
                ...(originRun ? { originRun } : {}),
            });
            const admitted = await runtime.workerAdmission.execute({ operationId, workspaceRefId: association.workspace.id, requesterAccountId: runtime.accountId,
                memoryDemand: acceptedMemory, signal: operationSignal,
                ...(workerBasis ? { relatedWorkspaces: workerBasis.relationships.flatMap(relationship => [
                    { workspaceRefId: relationship.alphaWorkspaceRefId, relationshipId: relationship.relationshipId },
                    { workspaceRefId: relationship.betaWorkspaceRefId, relationshipId: relationship.relationshipId },
                ]) } : {}),
                accept(handle) { publishProjectFiniteAdmission({ workspace: association.workspace, purpose, requesterAccountId: runtime.accountId, operation,
                    ...commandIdentity, ...(originRun ? { originRun } : {}) }); operation.operationAcceptance?.accept(handle); },
                onQueue: ahead => operation.operationProgress.update({ phase: 'queued', queueAhead: ahead, label: `Queued — ${ahead} ahead` }),
                onReserved: () => operation.operationProgress.update({ phase: 'preparing', label: 'Preparing workspace' }),
                onUnknown: error => { nativeUncertain = true; operation.operationOwnerUpdate.update({ observation: {
                    kind: codeOf(error) === 'stop_unconfirmed' ? 'stop_unconfirmed' : 'outcome_uncertain', code: codeOf(error),
                } }); },
                run: async reservation => {
                    let kind: ProjectSetupExecutionOutcome['kind'] = 'no_launch';
                    const resumeSetupReview = async (result: ActionExecuteResult) => {
                        const pending = readProjectSetupConsentFailureV1(withRequestedConsentScope(result));
                        if (kind !== 'no_launch' || !pending || !operation.operationReview) return false;
                        reservation.phase('setup');
                        await operation.operationReview.waitForResume(pending.details, { review: async () => {
                            await assertCurrent();
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
                            reservation.phase('copying');
                            await prepareDequeue();
                            reservation.phase('setup');
                            const refreshed = await prepareProjectSetup(preparation());
                            await assertCurrent();
                            if (refreshed.kind === 'refused') throw coded(refreshed.code);
                            if (refreshed.kind !== 'pendingApproval') return null;
                            const reviewed = readProjectSetupConsentFailureV1(withRequestedConsentScope(failure(refreshed.code, {
                                kind: 'pendingApproval', code: refreshed.code, reviewedEffect: refreshed.plan.reviewedEffect,
                                reviewedEffectDigest: refreshed.plan.reviewedEffectDigest,
                            })));
                            if (!reviewed) throw coded('project_setup_effect_unavailable');
                            return reviewed.details;
                        } });
                        await assertCurrent();
                        association = await resolveAccepted();
                        const source = await reviewSourcePlacement();
                        if (!projectExecutionChoicesEqualV1(source.choice, acceptedChoice!)
                            || source.memoryDemand?.bytes !== acceptedMemory?.bytes) throw coded('project_script_effect_changed');
                        await assertSourceExecutionCurrent(source);
                        if (acceptedPrimaryBasis !== undefined && await readPrimaryAdmissionBasis() !== acceptedPrimaryBasis) throw coded('project_script_effect_changed');
                        reservation.phase('copying');
                        await prepareDequeue();
                        return true;
                    };
                    const reviewBeforeEffects = async (): Promise<Review> => {
                        while (true) {
                            const current = await review();
                            if (current.kind === 'failed' && await resumeSetupReview(current.result)) continue;
                            return current;
                        }
                    };
                    const finish = (result: ActionExecuteResult) => {
                        if (kind === 'outcome_uncertain') throw coded(result.ok ? 'outcome_uncertain' : result.errorCode);
                        return { kind, result: kind === 'no_launch' && operationSignal.aborted ? failure('cancelled') : withRequestedConsentScope(result) };
                    };
                    try {
                        const source = await reviewSourcePlacement();
                        if (!projectExecutionChoicesEqualV1(source.choice, acceptedChoice!)
                            || source.memoryDemand?.bytes !== acceptedMemory?.bytes) return finish(failure('project_script_effect_changed'));
                        await assertSourceExecutionCurrent(source);
                        if (acceptedPrimaryBasis !== undefined && await readPrimaryAdmissionBasis() !== acceptedPrimaryBasis) return finish(failure('project_script_effect_changed'));
                        reservation.phase('copying');
                        await prepareDequeue();
                        const current = await reviewBeforeEffects();
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
                        reservation.phase('setup');
                        let setup = await executeProjectSetup({ ...executionInput(), preparation: { ...executionInput().preparation,
                            expectedEffectDigest: current.invocation.plan.reviewedEffectDigest } });
                        while (setup.kind === 'no_launch' && await resumeSetupReview(setup.result)) {
                            const rechecked = await reviewBeforeEffects();
                            if (rechecked.kind === 'failed') return finish(rechecked.result);
                            if (!unchanged(rechecked.invocation)) return finish(failure('project_script_effect_changed', {
                                kind: 'pendingApproval', code: 'project_script_effect_changed', reviewedEffectDigest: rechecked.invocation.reviewedEffectDigest, reviewedEffect: rechecked.invocation.reviewedEffect,
                            }));
                            setup = await executeProjectSetup({ ...executionInput(), preparation: { ...executionInput().preparation,
                                expectedEffectDigest: rechecked.invocation.plan.reviewedEffectDigest } });
                        }
                        kind = setup.kind;
                        if (setup.kind === 'outcome_uncertain') throw coded(setup.result.ok ? 'outcome_uncertain' : setup.result.errorCode);
                        if (!setup.result.ok || request.actionId === 'projects.prepare') return finish(setup.result);
                        const afterSetup = await review();
                        if (afterSetup.kind === 'failed') return finish(afterSetup.result);
                        if (!unchanged(afterSetup.invocation)) return finish(failure('project_script_effect_changed', {
                            kind: 'pendingApproval', code: 'project_script_effect_changed', reviewedEffectDigest: afterSetup.invocation.reviewedEffectDigest, reviewedEffect: afterSetup.invocation.reviewedEffect,
                        }));
                        const invocation = afterSetup.invocation;
                        const input = executionInput();
                        const assertSynchronousCurrent = () => { if (operationSignal.aborted) throw coded('cancelled'); };
                        await assertCurrent();
                        let launch: Awaited<ReturnType<typeof authorizePreparedProjectCommand>>;
                        if (invocation.command) launch = await authorizePreparedProjectCommand(input, invocation.plan, invocation.command, operationSignal);
                        else if (request.actionId === 'projects.compute.exec') {
                            const env: Record<string, string> = {};
                            for (const [key, value] of Object.entries(runtime.hostEnvironment ?? process.env)) if (value !== undefined) env[key] = value;
                            Object.assign(env, invocation.plan.configEnvironment);
                            const projectLaunch = createProjectNativeLaunchAdmission(input, invocation.plan);
                            launch = await authorizeResolvedProjectExecLaunchForHost({ launch: { command: request.input.executable, args: request.input.argv,
                                cwd: validatePath(invocationCwd().replaceAll('\\', '/'), association.workspace.rootPath).resolvedPath!, env },
                                projectLaunch, signal: operationSignal, assertCurrent: assertSynchronousCurrent,
                                ...(projectLaunch.nativeAdapter ? { nativeExecutableOwner: projectLaunch.nativeAdapter.lease.exec } : {}) });
                        } else return finish(failure('project_script_unavailable'));
                        try {
                            await assertCurrent();
                            association = await resolveAccepted();
                            const final = await review();
                            if (final.kind === 'failed') return finish(final.result);
                            if (!unchanged(final.invocation)) return finish(failure('project_script_effect_changed', {
                                kind: 'pendingApproval', code: 'project_script_effect_changed', reviewedEffectDigest: final.invocation.reviewedEffectDigest, reviewedEffect: final.invocation.reviewedEffect,
                            }));
                            await assertCurrent();
                            if (invocation.plan.environmentAdapterLease && !invocation.plan.environmentAdapterLease.isCurrent()
                                || invocation.command?.kind === 'pluginNative' && !invocation.command.lease.isCurrent()) throw coded('native_adapter_retired');
                            reservation.phase('running');
                            const outcome = await executeProjectFiniteProcess({ workspace: association.workspace, purpose, requesterAccountId: runtime.accountId,
                                ...commandIdentity,
                                ...(lastCleanSyncAtMs !== undefined ? { lastCleanSyncAtMs } : {}),
                                ...(executionInput().terminalCustody ? { terminalCustody: executionInput().terminalCustody } : {}),
                                operation, terminalSessions: runtime.terminalSessions, launch, signal: operationSignal, ...(originRun ? { originRun } : {}) });
                            kind = outcome.kind;
                            if (outcome.kind === 'outcome_uncertain') throw coded(outcome.result.ok ? 'outcome_uncertain' : outcome.result.errorCode);
                            return finish(outcome.result);
                        } catch (error) {
                            if (isProjectNativeProcessUncertain(error) || error instanceof ProjectNativeEnvironmentUncertainError) kind = 'outcome_uncertain';
                            throw error;
                        } finally { if (kind !== 'outcome_uncertain') launch.release(); }
                    } catch (error) {
                        preserveUnconfirmedNativeProcess(error);
                        if (error instanceof ProjectNativeEnvironmentUncertainError) throw error;
                        if (kind === 'outcome_uncertain') throw error;
                        return { kind, result: failure(operationSignal.aborted ? 'cancelled' : codeOf(error),
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
            return admitted;
            } finally {
                if (!nativeUncertain) await releaseNativeInvocations();
                nativeCustody.dispose();
            }
        };
        let result: ActionExecuteResult;
        const local = args.context.operationAcceptance?.actionId === request.actionId ? args.context : ingress.localActionContext;
        if (local?.operationOwnerUpdate && local.operationAcceptance?.actionId === request.actionId) {
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
        } else result = await runtime.operationRuntime.observeExecution({ actionId: request.actionId, input: request.input,
            rpcContext: ingress,
            actionRequestId: args.context.actionRequestId ?? ingress.transportRequestId,
            sessionId: ingress.sessionActionOrigin?.caller.sessionId,
            execute: run });
        return result.ok ? result.result : withRequestedConsentScope(result);
        } catch (error) {
            nativeUncertain = isProjectNativeProcessUncertain(error) || error instanceof ProjectNativeEnvironmentUncertainError;
            throw error;
        } finally { if (!runStarted && !nativeUncertain) await releaseNativeInvocations(); }
    };
}
