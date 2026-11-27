import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { isPluginError } from '@happier-dev/protocol/plugins/errors';
import type { ProcessEnvInput } from '@/utils/processEnv/buildScopedProcessEnv';
import type { ProjectCommandAttachmentV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { QualifiedProjectTrustProjectV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectTrustRowV1';
import { createHash } from 'node:crypto';
import { composeProjectLaunchEnvironment, prepareProjectLaunchEnvironment } from './projectLaunchEnvironment';
import { relative, resolve } from 'node:path';
import type { HostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import type { TerminalPtySessionManager, TerminalPtyCustody, TerminalPtyEnsureInput } from '@/terminal/pty/sessions';
import { ProjectNativeToolchainUncertainError, type ProjectNativeToolchainIo } from '@/workspaces/toolchain/prepareProjectNativeToolchain';
import { configuration } from '@/configuration';
import { resolveFiniteTerminalShell } from '@/terminal/pty/shells';
import { executeHostFiniteTerminalProcess } from '@/terminal/pty/finiteProcess';
import {
    authorizePluginExecLaunchForHost,
    authorizeResolvedProjectExecLaunchForHost,
    produceProjectLaunchEnvironmentForHost,
    type HostAuthorizedPluginExecLaunch,
    type HostProjectNativeLaunchAdmission,
    type ProjectNativeEffectCaptureForHost,
    type ProjectNativeToolchainIoForHost,
} from '@/plugins/runtime/invocation/services/exec';
import { prepareProjectSetup, type PreparedProjectSetupPlan, type PreparedProjectSetupCommand } from './projectSetupPreparation';
import { createProjectSetupSuccessStore } from './projectSetupSuccess';
import { isProjectNativeProcessUncertain, type ProjectNativeAdapterProductionV1 } from '@/plugins/runtime/lifecycle/contributions/targetProjectNativeAdapters';
import { validateWorkspacePath } from '@/rpc/handlers/pathSecurity';
import { readProjectDefinitionFileBytes } from './nativeDefinitionFiles';
import { resolveProjectNativeCommand } from './projectNativeResolution';
import { readLiteralCommandExecutedFiles } from './literalCommandFiles';
import { prepareProjectWorktreeRuntime } from '@/workspaces/execution/projectWorktreeRuntime';
import { readProjectEffectiveDefinition } from './projectEffectiveDefinition';
import { createProjectDotenvPreparation } from './projectDotenv';

export type ProjectSetupOperationContext = Parameters<Parameters<HostActionOperationRuntime['observeExecution']>[0]['execute']>[0]
    & Pick<ActionExecutorContext, 'externalActionExecutionAuthorization' | 'externalActionTarget'>
    & Readonly<{ setupAutostart?: import('./projectSetupAutostart').ProjectSetupAutostartContext }>;
export type ProjectSetupExecutionInput = Readonly<{
    preparation: Parameters<typeof prepareProjectSetup>[0];
    requesterAccountId: string;
    terminalCustody?: TerminalPtyCustody;
    operation: ProjectSetupOperationContext;
    terminalSessions: Pick<TerminalPtySessionManager, 'ensure' | 'waitForExit' | 'requestStop' | 'observeOutput'>;
    environmentIo: ProjectNativeToolchainIoForHost;
    hostEnvironment?: ProcessEnvInput;
    produceProcessEnvironment?: import('@/daemon/connectedServices/materialize/processConnectedAccountEnvironment').ConnectedAccountProcessEnvironmentProducer;
    agentIsolation?: import('@/daemon/agentIsolation/agentIsolationLaunchPolicy').HostAgentIsolationLaunchContext;
    nativeExecutionIdentity?: TerminalPtyEnsureInput['nativeExecutionIdentity'];
    /** Issued only by the admitted person terminal owner, never an Action operand. */
    executionKind?: 'person_break_glass';
    requesterIdentity?: import('@/daemon/agentIsolation/agentIsolationLaunchPolicy').HostRequesterExecutionIdentity;
    platform?: NodeJS.Platform;
    originRun?: ProjectCommandAttachmentV1['originRun'];
    sourceWorkspace?: ProjectCommandAttachmentV1['sourceWorkspace'];
    script?: ProjectCommandAttachmentV1['script'];
    lastCleanSyncAtMs?: ProjectCommandAttachmentV1['lastCleanSyncAtMs'];
    /** Containing installed operation revalidates Home/Machine after native preparation. */
    beforeNativeEffect?: () => Promise<void>;
    /** A containing finite command produces its environment with the real final launch. */
    deferToolchainToLaunch?: boolean;
}>;

/** Settled setup effects for the owning Host Event consumer; never process content. */
export type ProjectSetupSettlement = Readonly<{
    workspace: WorkspaceRefV1;
    project: QualifiedProjectTrustProjectV1;
    operationId: string;
    originRunId?: string;
} & ({ outcome: 'finished' } | { outcome: 'failed'; errorCode: string })>;

export type ProjectSetupExecutionOutcome = Readonly<{
    kind: 'no_launch' | 'process_settled' | 'outcome_uncertain';
    result: ActionExecuteResult;
    setupSettlement?: ProjectSetupSettlement;
}>;

/** Resource custody for selected callbacks under the original host operation. */
export function createProjectNativeInvocationCustody(operation: Pick<ProjectSetupOperationContext, 'signal'> &
    Partial<Pick<ProjectSetupOperationContext, 'operationOwnerUpdate' | 'operationCancellation'>>,
    invocations = new Set<ProjectNativeEffectCaptureForHost>()) {
    const observers = new Set<() => void>();
    const observeUncertainty = (error: unknown) => operation.operationOwnerUpdate?.update({ observation: {
        kind: 'outcome_uncertain', code: isProjectNativeProcessUncertain(error) ? 'plugin_exec_termination_incomplete' : 'outcome_uncertain',
    } });
    const observe = (production: ProjectNativeEffectCaptureForHost) => observers.add(production.onOutcomeUncertain(observeUncertainty));
    for (const production of invocations) observe(production);
    const stop = () => { for (const production of invocations) void production.requestStop().catch(observeUncertainty); };
    const unsubscribeCancellation = operation.operationCancellation?.onRequest(stop);
    const onAbort = () => { if (!operation.operationCancellation || !operation.signal.aborted) stop(); };
    operation.signal.addEventListener('abort', onAbort, { once: true });
    return {
        retain(production: ProjectNativeEffectCaptureForHost) {
            if (invocations.has(production)) return;
            invocations.add(production);
            observe(production);
        },
        async release(options?: Readonly<{ waitForSettlement?: boolean }>) {
            await Promise.all([...invocations].map(async production => {
                try { await production.release(); }
                catch (error) {
                    // Finite execution waits for its terminal fact. A retained Service
                    // must instead expose incomplete Stop and keep the same capture retryable.
                    if (!isProjectNativeProcessUncertain(error) || options?.waitForSettlement === false) throw error;
                    await production.waitForSettlement();
                    await production.release();
                }
            }));
        },
        dispose() {
            operation.signal.removeEventListener('abort', onAbort);
            unsubscribeCancellation?.();
            for (const unsubscribe of observers) unsubscribe();
        },
    };
}

export async function executeProjectSetup(input: ProjectSetupExecutionInput): Promise<ProjectSetupExecutionOutcome> {
    const nativeCustody = input.preparation.retainNativeInvocation ? undefined : createProjectNativeInvocationCustody(input.operation);
    let outcome: ProjectSetupExecutionOutcome | undefined;
    let uncertain = false;
    try {
        outcome = await executePreparedProjectSetup({ ...input, preparation: { ...input.preparation,
            retainNativeInvocation: input.preparation.retainNativeInvocation ?? nativeCustody!.retain,
        } });
        if (input.preparation.purpose === 'setup' && outcome.kind === 'process_settled') {
            // Resolution reaches the caller only after the finally block has
            // released this invocation's native custody. A containing invocation
            // retains its own custody and consumes the result at its settlement.
            return { ...outcome, setupSettlement: {
                workspace: input.preparation.workspace,
                project: input.preparation.projectAssociation.project,
                operationId: input.operation.operationAcceptance?.operationId ?? input.operation.actionRequestId!,
                ...(input.operation.operationAcceptance?.originRunId
                    ? { originRunId: input.operation.operationAcceptance.originRunId } : {}),
                ...(outcome.result.ok ? { outcome: 'finished' as const }
                    : { outcome: 'failed' as const, errorCode: outcome.result.errorCode }),
            } };
        }
        return outcome;
    } catch (error) {
        uncertain = isProjectNativeProcessUncertain(error) || error instanceof ProjectNativeToolchainUncertainError;
        throw error;
    } finally {
        // Checkpoint uncertainty concerns the saved prefix after a confirmed
        // effect, so it must not retain native process custody indefinitely.
        const checkpointUncertain = outcome?.result.ok === false
            && outcome.result.errorCode === 'project_setup_success_unavailable';
        if (!uncertain && (outcome?.kind !== 'outcome_uncertain' || checkpointUncertain)) {
            await nativeCustody?.release();
            nativeCustody?.dispose();
        }
    }
}

const actionFailure = (errorCode: string, details?: unknown): ActionExecuteResult => ({
    ok: false, errorCode, error: errorCode, ...(details === undefined ? {} : { details }),
});

export type ProjectFiniteAdmissionInput = Readonly<{
    workspace: WorkspaceRefV1;
    purpose: ProjectCommandAttachmentV1['purpose'];
    requesterAccountId: string;
    terminalCustody?: TerminalPtyCustody;
    operation: ProjectSetupOperationContext;
    originRun?: ProjectCommandAttachmentV1['originRun'];
    sourceWorkspace?: ProjectCommandAttachmentV1['sourceWorkspace'];
    script?: ProjectCommandAttachmentV1['script'];
    lastCleanSyncAtMs?: ProjectCommandAttachmentV1['lastCleanSyncAtMs'];
    steps?: ProjectCommandAttachmentV1['steps'];
}>;

/** Qualified output association, before native preparation or an OS launch. */
export function publishProjectFiniteAdmission(input: ProjectFiniteAdmissionInput): ProjectCommandAttachmentV1 {
    const attachment: ProjectCommandAttachmentV1 = {
        kind: 'projectCommand', purpose: input.purpose,
        serverId: input.workspace.serverId, machineId: input.workspace.machineId,
        workspaceRefId: input.workspace.id, cwd: input.workspace.rootPath,
        ...(input.originRun ? { originRun: input.originRun } : {}),
        ...(input.sourceWorkspace ? { sourceWorkspace: input.sourceWorkspace } : {}),
        ...(input.script ? { script: input.script } : {}),
        ...(input.steps ? { steps: input.steps } : {}),
        ...(input.lastCleanSyncAtMs !== undefined ? { lastCleanSyncAtMs: input.lastCleanSyncAtMs } : {}),
    };
    input.operation.operationOwnerUpdate.update({ domainRef: attachment });
    return attachment;
}

export type ProjectFiniteProcessInput = ProjectFiniteAdmissionInput & Readonly<{
    terminalSessions: ProjectSetupExecutionInput['terminalSessions'];
    launch: HostAuthorizedPluginExecLaunch;
    nativeExecutionIdentity?: TerminalPtyEnsureInput['nativeExecutionIdentity'];
    signal?: AbortSignal;
    step?: number;
    totalSteps?: number;
    onObservation?: (observation: Readonly<{ terminalId: string; exitCode?: number }>) => ProjectCommandAttachmentV1['steps'];
}>;

/** Single finite process consumer of an already admitted final Exec tuple. */
export async function executeProjectFiniteProcess(input: ProjectFiniteProcessInput): Promise<ProjectSetupExecutionOutcome> {
    const signal = input.signal ?? input.operation.signal;
    if (signal.aborted) return { kind: 'no_launch', result: actionFailure('cancelled') };
    const operationId = input.operation.operationAcceptance?.operationId ?? input.operation.actionRequestId;
    if (!operationId || !input.requesterAccountId) return { kind: 'no_launch', result: actionFailure('project_setup_operation_unavailable') };
    const attachment = publishProjectFiniteAdmission(input);
    return await executeHostFiniteTerminalProcess({
        operation: input.operation, terminalSessions: input.terminalSessions,
        requesterAccountId: input.requesterAccountId, terminalCustody: input.terminalCustody,
        terminalKey: `${operationId}:${input.purpose}:${input.step ?? 0}`, signal,
        launch: { ...input.launch, cwd: input.launch.cwd ?? input.workspace.rootPath },
        authorizedNativeLaunch: input.launch,
        ...(input.nativeExecutionIdentity ? { nativeExecutionIdentity: input.nativeExecutionIdentity } : {}),
        progress: { phase: input.purpose, label: 'Running project command',
            ...(input.totalSteps ? { current: input.step ?? 0, total: input.totalSteps } : {}) },
        failureCode: 'project_command_step_failed', failureStep: input.step ?? 0,
        attachment: observation => {
            const steps = input.onObservation?.(observation) ?? input.steps;
            return { ...attachment, ...(steps ? { steps } : {}), cwd: input.launch.cwd ?? attachment.cwd, ...observation };
        },
    });
}

export function createProjectNativeLaunchAdmission(input: Pick<ProjectSetupExecutionInput, 'preparation' | 'environmentIo' | 'hostEnvironment' | 'platform' | 'agentIsolation' | 'executionKind' | 'requesterIdentity' | 'beforeNativeEffect' | 'produceProcessEnvironment'> &
    Readonly<{ operation: Pick<ProjectSetupOperationContext, 'signal'> }>, plan: PreparedProjectSetupPlan, command?: PreparedProjectSetupCommand,
    signal = input.preparation.signal ?? input.operation.signal) {
    const nativeCommandToolchain = command?.kind === 'native' ? command.resolution.nativeCommandToolchain
        : command?.kind === 'pluginNative' ? command.resolution.toolchainApplied : undefined;
    let toolchainProduction: ProjectNativeAdapterProductionV1 | undefined;
    if (plan.toolchainAdapterLease) {
        if (!input.preparation.retainNativeInvocation) throw Object.assign(new Error('native_adapter_invocation_unavailable'), { code: 'native_adapter_invocation_unavailable' });
        const acquired = plan.toolchainAdapterLease.acquireProduction({ root: plan.workspace.rootPath,
            environment: projectBaseEnvironment(input, plan), signal, executionKind: input.executionKind,
            requesterIdentity: input.requesterIdentity,
            assertLaunchCurrent: input.beforeNativeEffect });
        if (acquired.kind !== 'ready') throw Object.assign(new Error(acquired.code), { code: acquired.code });
        toolchainProduction = acquired.production;
        input.preparation.retainNativeInvocation(toolchainProduction);
    }
    let environmentIo: ProjectNativeToolchainIo = input.environmentIo;
    if (plan.toolchain.kind === 'toolchain') {
        if (!input.preparation.retainNativeInvocation) throw Object.assign(new Error('native_adapter_invocation_unavailable'), { code: 'native_adapter_invocation_unavailable' });
        environmentIo = input.environmentIo.createInvocation({ signal, retainCapture: input.preparation.retainNativeInvocation,
            agentIsolation: input.agentIsolation, executionKind: input.executionKind,
            requesterIdentity: input.requesterIdentity,
            assertLaunchCurrent: input.beforeNativeEffect });
    }
    return {
        status: 'ready' as const, reviewedEffectDigest: plan.reviewedEffectDigest,
        launchEnvironment: command?.kind === 'native'
            ? composeProjectLaunchEnvironment({ originalEnvironment: projectBaseEnvironment(input, plan),
                requirements: plan.manifest?.environmentVariables ?? [], invocationEnvironment: command.resolution.environmentOverlay,
                platform: input.platform }).environment
            : projectBaseEnvironment(input, plan),
        ...(input.produceProcessEnvironment ? { produceProcessEnvironment: input.produceProcessEnvironment } : {}),
        toolchain: { selection: plan.toolchain, root: plan.workspace.rootPath,
            platform: input.platform ?? process.platform, io: environmentIo,
            ...(nativeCommandToolchain ? { nativeCommandToolchain } : {}),
        },
        ...(toolchainProduction ? { nativeAdapter: {
            lease: toolchainProduction, files: plan.toolchainReviewInputs,
        } } : {}),
        ...(input.preparation.secretEnvironment ? { secretReferences: {
            ...input.preparation.secretEnvironment, requirements: plan.manifest?.environmentVariables ?? [],
            ...(input.preparation.environmentBindings ? { secretReferenceOverlay: input.preparation.environmentBindings } : {}),
        } } : {}),
    } satisfies HostProjectNativeLaunchAdmission;
}

export async function authorizePreparedProjectCommand(input: ProjectSetupExecutionInput, plan: PreparedProjectSetupPlan,
    command: PreparedProjectSetupCommand, signal: AbortSignal): Promise<HostAuthorizedPluginExecLaunch> {
    // Launch production can activate toolchain hooks or a native adapter before
    // a terminal exists; it is itself an effect, not passive tuple inspection.
    await input.beforeNativeEffect?.();
    const assertCurrent = () => {
        if (signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
        if (plan.toolchainAdapterLease && !plan.toolchainAdapterLease.isCurrent()
            || (command.kind === 'pluginNative' || command.kind === 'pluginNativeReference') && !command.lease.isCurrent()) {
            throw Object.assign(new Error('native_adapter_retired'), { code: 'native_adapter_retired' });
        }
    };
    assertCurrent();
    if (plan.runtimeEnvironment === undefined) {
        const runtime = await prepareProjectWorktreeRuntime({ workspace: plan.workspace, manifest: plan.manifest, signal });
        if (runtime.kind !== 'ready') throw Object.assign(new Error(runtime.code), { code: runtime.code, details: { reason: runtime.reason } });
        const finalInput = await prepareProjectLaunchEnvironment({ workspace: plan.workspace,
            requirements: plan.manifest?.environmentVariables ?? [], originalEnvironment: plan.preparedLaunchInput.originalEnvironment,
            dotenvPreparation: plan.dotenvPreparation, projectEnvironment: plan.configEnvironment,
            runtimeEnvironment: runtime.runtimeEnvironment, profileEnvironment: input.preparation.profileEnvironment,
            invocationEnvironment: input.preparation.invocationEnvironment, platform: input.platform });
        if (finalInput.kind === 'refused') throw Object.assign(new Error(finalInput.code), { code: finalInput.code });
        plan = { ...plan, runtimeEnvironment: runtime.runtimeEnvironment, preparedLaunchInput: finalInput.launchInput };
    }
    if (command.kind === 'pluginNativeReference') {
        if (!input.preparation.retainNativeInvocation) throw Object.assign(new Error('native_adapter_invocation_unavailable'), { code: 'native_adapter_invocation_unavailable' });
        const acquired = command.lease.acquireProduction({ root: plan.workspace.rootPath,
            environment: projectBaseEnvironment(input, plan), signal, executionKind: input.executionKind,
            requesterIdentity: input.requesterIdentity,
            assertLaunchCurrent: input.beforeNativeEffect });
        if (acquired.kind !== 'ready') throw Object.assign(new Error(acquired.code), { code: acquired.code });
        const lease = acquired.production;
        input.preparation.retainNativeInvocation(lease);
        const resolved = await resolveProjectNativeCommand({ root: plan.workspace.rootPath, source: command.source,
            usage: 'setup', io: input.preparation.nativeIo, signal, plugin: { lease } });
        assertCurrent();
        if (!lease.isCurrent()) throw Object.assign(new Error('native_adapter_retired'), { code: 'native_adapter_retired' });
        if (resolved.kind !== 'pluginResolved') {
            const code = resolved.kind === 'refused' ? resolved.code : 'native_adapter_result_invalid';
            throw Object.assign(new Error(code), { code });
        }
        const cwd = await validateWorkspacePath(resolved.command.cwd, plan.workspace.rootPath);
        if (!cwd.valid) throw Object.assign(new Error('outside_root'), { code: 'outside_root' });
        // A contributed resolver may discover extra dependencies only when they
        // were already included in the reviewed explicit setupInputs basis.
        for (const fact of [...command.reviewInputs, ...resolved.command.reviewInputs]) {
            const file = relative(plan.workspace.rootPath, resolve(plan.workspace.rootPath, fact.file.replaceAll('\\', '/'))).replaceAll('\\', '/');
            const reviewed = plan.reviewedEffect.files.find(input => input.file === file);
            const read = await readProjectDefinitionFileBytes(plan.workspace.rootPath, fact.file);
            if (!reviewed || read.kind !== 'read' || read.bytes.toString('utf8') !== fact.content
                || createHash('sha256').update(read.bytes).digest('hex') !== reviewed.digest) {
                throw Object.assign(new Error('project_setup_effect_changed'), { code: 'project_setup_effect_changed' });
            }
        }
        assertCurrent();
        command = { kind: 'pluginNative', source: command.source, resolution: resolved.command, lease };
    }
    const projectLaunch = createProjectNativeLaunchAdmission(input, plan, command, signal);
    const env = projectLaunch.launchEnvironment;
    if (command.kind === 'pluginNative') {
        const launch = await authorizePluginExecLaunchForHost(command.lease.exec, {
            executable: command.resolution.executable, args: command.resolution.args,
            cwd: { root: 'workspace', relativePath: relative(plan.workspace.rootPath, command.resolution.cwd).replaceAll('\\', '/') }, env,
        }, { signal, projectLaunch, agentIsolation: input.agentIsolation ?? null,
            ...(projectLaunch.nativeAdapter ? { nativeExecutableOwner: projectLaunch.nativeAdapter.lease.exec } : {}) });
        try { assertCurrent(); return launch; }
        catch (error) { launch.release(); throw error; }
    }
    const tuple = command.kind === 'literal'
        ? { ...resolveFiniteTerminalShell(command.source.command, input.hostEnvironment ?? process.env, input.platform ?? process.platform), cwd: command.cwd }
        : { file: command.resolution.command, args: command.resolution.args, cwd: command.resolution.cwd };
    return await authorizeResolvedProjectExecLaunchForHost({
        launch: { command: tuple.file, args: tuple.args, cwd: tuple.cwd, env }, projectLaunch, signal, assertCurrent,
        agentIsolation: input.agentIsolation,
        executionKind: input.executionKind, requesterIdentity: input.requesterIdentity,
        ...(projectLaunch.nativeAdapter ? { nativeExecutableOwner: projectLaunch.nativeAdapter.lease.exec } : {}),
    });
}

export function projectBaseEnvironment(_input: Pick<ProjectSetupExecutionInput, 'hostEnvironment'>, plan: PreparedProjectSetupPlan): Record<string, string> {
    return { ...plan.preparedLaunchInput.environment };
}

/** Only bytes consumed by this command/environment can change its admitted launch. */
async function assertPreparedProjectInputsCurrent(plan: PreparedProjectSetupPlan, command?: PreparedProjectSetupCommand): Promise<void> {
    const root = plan.workspace.rootPath;
    const expected = [...(plan.toolchainInputFiles ?? []), ...plan.reviewedEffect.setupInputs,
        ...(command?.inputFiles ?? []),
        ...(command?.kind === 'pluginNativeReference' ? command.reviewInputs.map(fact => ({ file: fact.file,
            digest: createHash('sha256').update(fact.content).digest('hex') })) : [])]
        .map(fact => ({ ...fact, file: relative(root, resolve(root, fact.file.replaceAll('\\', '/'))).replaceAll('\\', '/') }));
    const current = command?.kind === 'literal'
        ? await readLiteralCommandExecutedFiles(root, command.cwd, command.source.command, { files: expected.map(fact => fact.file) })
        : await readLiteralCommandExecutedFiles(root, root, '', { files: expected.map(fact => fact.file) });
    if (current.kind === 'refused') throw Object.assign(new Error(current.code), { code: current.code });
    const facts = new Map(current.files.map(fact => [fact.file, fact]));
    const expectedFiles = new Set(expected.map(fact => fact.file));
    if (expected.some(fact => JSON.stringify(facts.get(fact.file)) !== JSON.stringify(fact))
        || command?.kind === 'literal' && current.files.some(fact => !expectedFiles.has(fact.file))) {
        throw Object.assign(new Error('project_setup_effect_changed'), { code: 'project_setup_effect_changed' });
    }
}

async function executePreparedProjectSetup(input: ProjectSetupExecutionInput): Promise<ProjectSetupExecutionOutcome> {
    const admittedInput = { ...input, hostEnvironment: { ...(input.hostEnvironment ?? process.env) } };
    let kind: ProjectSetupExecutionOutcome['kind'] = 'no_launch';
    const finish = (result: ActionExecuteResult): ProjectSetupExecutionOutcome => ({ kind, result });
    const failure = (errorCode: string, details?: unknown) => finish(actionFailure(errorCode, details));
    const signal = input.preparation.signal
        ? AbortSignal.any([input.operation.signal, input.preparation.signal]) : input.operation.signal;
    const launchFailure = (error: unknown): ProjectSetupExecutionOutcome => {
        if (error instanceof ProjectNativeToolchainUncertainError || isProjectNativeProcessUncertain(error)) {
            kind = 'outcome_uncertain';
            const code = error instanceof ProjectNativeToolchainUncertainError ? error.code : 'plugin_exec_termination_incomplete';
            input.operation.operationOwnerUpdate.update({ observation: { kind: 'outcome_uncertain', code } });
            return failure(code);
        }
        if (signal.aborted) return failure('cancelled');
        if (isPluginError(error)) return finish({ ok: false, ...normalizeActionExecutorThrownError(error, 'projects.prepare') });
        return failure(error instanceof Error && 'code' in error && typeof error.code === 'string'
            ? error.code : 'project_setup_launch_refused');
    };
    const originalEnvironment = Object.freeze({ ...(input.preparation.originalEnvironment ?? admittedInput.hostEnvironment) });
    const dotenvPreparation = input.preparation.dotenvPreparation
        ?? createProjectDotenvPreparation(input.preparation.workspace.rootPath, originalEnvironment);
    let runtimeEnvironment = input.preparation.runtimeEnvironment;
    let acceptedSetup = input.preparation.acceptedSetup;
    if (runtimeEnvironment === undefined) {
        try {
            const definition = await readProjectEffectiveDefinition({ root: input.preparation.workspace.rootPath,
                account: input.preparation.requester, project: input.preparation.projectAssociation.project,
                serverHttpBaseUrl: input.preparation.requester.serverHttpBaseUrl, acceptedSetup, signal });
            acceptedSetup = definition.acceptedSetup;
            const runtime = await prepareProjectWorktreeRuntime({ workspace: input.preparation.workspace,
                manifest: definition.effectiveDefinition.effectiveManifest, signal });
            if (runtime.kind !== 'ready') return failure(runtime.code, { reason: runtime.reason });
            runtimeEnvironment = runtime.runtimeEnvironment;
        } catch (error) { return launchFailure(error); }
    }
    const preparation = { ...input.preparation, signal, originalEnvironment, dotenvPreparation, runtimeEnvironment, acceptedSetup,
        requesterIdentity: input.preparation.requesterIdentity ?? input.requesterIdentity,
        successHomeDir: input.preparation.successHomeDir ?? configuration.happyHomeDir };
    const prepared = await prepareProjectSetup(preparation);
    if (signal.aborted) return failure('cancelled');
    if (prepared.kind === 'refused') return failure(prepared.code);
    if (prepared.kind === 'pendingApproval') return failure(prepared.code, {
        kind: 'pendingApproval', code: prepared.code, reviewedEffectDigest: prepared.plan.reviewedEffectDigest,
        reviewedEffect: prepared.plan.reviewedEffect,
    });
    const { plan } = prepared;
    if (plan.purpose === 'teardown' && prepared.kind === 'notRequired') {
        await createProjectSetupSuccessStore({ homeDir: preparation.successHomeDir }).invalidate({
            serverId: plan.workspace.serverId, machineId: plan.workspace.machineId, workspaceRefId: plan.workspace.id,
        });
    }
    if (prepared.kind === 'notRequired' || prepared.kind === 'skippedForInvocation') {
        return finish({ ok: true, result: { kind: prepared.kind, reviewedEffectDigest: plan.reviewedEffectDigest } });
    }
    if (prepared.previousSuccess && plan.purpose === 'setup') {
        return finish({ ok: true, result: { kind: 'success', reviewedEffectDigest: plan.reviewedEffectDigest } });
    }
    if (plan.purpose === 'setup' && plan.commands.length === 0 && input.deferToolchainToLaunch) {
        // Consent and current inputs were checked above. With no setup process,
        // environment production belongs to the following real launch; it may
        // require that command to wrap it. No setup completion is claimed here.
        return finish({ ok: true, result: { kind: 'notRequired', reviewedEffectDigest: plan.reviewedEffectDigest } });
    }
    const operationId = input.operation.operationAcceptance?.operationId ?? input.operation.actionRequestId;
    if (!operationId || !input.requesterAccountId) return failure('project_setup_operation_unavailable');
    const store = createProjectSetupSuccessStore({ homeDir: preparation.successHomeDir });
    const target = { serverId: plan.workspace.serverId, machineId: plan.workspace.machineId, workspaceRefId: plan.workspace.id };
    const confirmedCommandCount = plan.purpose === 'setup' ? prepared.confirmedCommandCount : 0;
    if (confirmedCommandCount === 0) await store.invalidate(target);
    let steps: NonNullable<ProjectCommandAttachmentV1['steps']> = plan.commands.map((command, index) => ({
        index, source: command.source, state: index < confirmedCommandCount ? 'succeeded' : 'pending',
    }));
    const admitted = { workspace: plan.workspace, purpose: plan.purpose, requesterAccountId: input.requesterAccountId,
        ...(input.terminalCustody ? { terminalCustody: input.terminalCustody } : {}),
        operation: input.operation, ...(input.originRun ? { originRun: input.originRun } : {}),
        ...(input.sourceWorkspace ? { sourceWorkspace: input.sourceWorkspace } : {}), ...(input.script ? { script: input.script } : {}),
        ...(input.lastCleanSyncAtMs !== undefined ? { lastCleanSyncAtMs: input.lastCleanSyncAtMs } : {}), steps };
    const attachment = publishProjectFiniteAdmission(admitted);
    const checkpoint = async (count: number, completed = false) => {
        if (plan.purpose !== 'setup') return true;
        try {
            await store.recordCompletion(target, { v: 1, workspaceRefId: plan.workspace.id, ...plan.successBasis,
                confirmedCommandCount: count, ...(completed ? { completedAtMs: Date.now() } : {}) });
            return true;
        } catch {
            kind = 'outcome_uncertain';
            input.operation.operationOwnerUpdate.update({ observation: { kind: 'outcome_uncertain', code: 'project_setup_success_unavailable' } });
            return false;
        }
    };

    if (plan.commands.length === 0) {
        try {
            await assertPreparedProjectInputsCurrent(plan);
            await input.beforeNativeEffect?.();
            await produceProjectLaunchEnvironmentForHost({
                cwd: plan.workspace.rootPath, env: projectBaseEnvironment(admittedInput, plan),
                projectLaunch: createProjectNativeLaunchAdmission(admittedInput, plan), signal,
                assertCurrent() {
                    if (signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
                    if (plan.toolchainAdapterLease && !plan.toolchainAdapterLease.isCurrent()) {
                        throw Object.assign(new Error('native_adapter_retired'), { code: 'native_adapter_retired' });
                    }
                },
            });
            await assertPreparedProjectInputsCurrent(plan);
        } catch (error) {
            return launchFailure(error);
        }
        if (!await checkpoint(0, true)) return failure('project_setup_success_unavailable');
    }
    for (const step of plan.commands.keys()) {
        if (step < confirmedCommandCount) continue;
        if (signal.aborted) return failure('cancelled');
        const command = plan.commands[step]!;
        let launch: HostAuthorizedPluginExecLaunch;
        try {
            if (command.kind === 'pluginNative' || command.kind === 'pluginNativeReference') {
                // Plugin production can consume its own reviewed command inputs.
                await assertPreparedProjectInputsCurrent(plan, command);
            } else if (plan.toolchain.kind !== 'host' || input.produceProcessEnvironment) {
                // Environment production consumes shared inputs, before the command consumes its own.
                await assertPreparedProjectInputsCurrent(plan,
                    command.kind === 'native' && command.resolution.nativeCommandToolchain ? command : undefined);
            }
            launch = await authorizePreparedProjectCommand(admittedInput, plan, command, signal);
        }
        catch (error) {
            return launchFailure(error);
        }
        let processOutcomeUncertain = false;
        try {
            if (signal.aborted) return failure('cancelled');
            // Native production may await tools; retain admission and remeasure
            // only this command's inputs immediately before its OS effect.
            await assertPreparedProjectInputsCurrent(plan, command);
            if (signal.aborted) return failure('cancelled');
            if (plan.toolchainAdapterLease && !plan.toolchainAdapterLease.isCurrent()
                || (command.kind === 'pluginNative' || command.kind === 'pluginNativeReference') && !command.lease.isCurrent()) return failure('native_adapter_retired');
            await input.beforeNativeEffect?.();
            let observation: Readonly<{ terminalId: string; exitCode?: number }> | undefined;
            const executed = await executeProjectFiniteProcess({ ...admitted, steps, terminalSessions: input.terminalSessions,
                launch, ...(input.nativeExecutionIdentity ? { nativeExecutionIdentity: input.nativeExecutionIdentity } : {}),
                signal, step, totalSteps: plan.commands.length,
                onObservation(value) {
                    observation = value;
                    steps = steps.map<(typeof steps)[number]>(row => row.index === step ? { ...row, state: 'running', ...value } : row);
                    return steps;
                },
            });
            if (executed.kind !== 'no_launch') kind = executed.kind;
            processOutcomeUncertain = executed.kind === 'outcome_uncertain';
            steps = steps.map<(typeof steps)[number]>(row => row.index === step ? { ...row, ...observation,
                state: executed.kind === 'outcome_uncertain' ? 'outcome_uncertain' : executed.result.ok ? 'succeeded'
                    : executed.result.errorCode === 'cancelled' ? 'cancelled' : 'failed' } : row);
            input.operation.operationOwnerUpdate.update({ domainRef: { ...attachment,
                cwd: launch.cwd ?? plan.workspace.rootPath, ...observation, steps } });
            if (!executed.result.ok) return executed.result.errorCode === 'project_command_step_failed'
                ? failure('project_setup_step_failed', executed.result.details) : finish(executed.result);
            if (!await checkpoint(step + 1, step + 1 === plan.commands.length)) return failure('project_setup_success_unavailable');
        } catch (error) {
            if (isProjectNativeProcessUncertain(error) || error instanceof ProjectNativeToolchainUncertainError) {
                processOutcomeUncertain = true;
                kind = 'outcome_uncertain';
            }
            return launchFailure(error);
        } finally { if (!processOutcomeUncertain) launch.release(); }
    }
    return finish({ ok: true, result: { kind: 'success', reviewedEffectDigest: plan.reviewedEffectDigest } });
}
