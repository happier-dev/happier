import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ProjectCommandAttachmentV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { relative } from 'node:path';
import type { HostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import type { TerminalPtySessionManager, TerminalPtyCustody } from '@/terminal/pty/sessions';
import { ProjectNativeEnvironmentUncertainError, type ProjectNativeEnvironmentIo } from '@/workspaces/environment/produceProjectNativeEnvironment';
import { configuration } from '@/configuration';
import { resolveFiniteTerminalShell } from '@/terminal/pty/shells';
import {
    authorizePluginExecLaunchForHost,
    authorizeResolvedProjectExecLaunchForHost,
    produceProjectLaunchEnvironmentForHost,
    type HostAuthorizedPluginExecLaunch,
    type HostProjectNativeLaunchAdmission,
    type ProjectNativeEffectCaptureForHost,
    type ProjectNativeEnvironmentIoForHost,
} from '@/plugins/runtime/invocation/services/exec';
import { prepareProjectSetup, type PreparedProjectSetupPlan, type PreparedProjectSetupCommand } from './projectSetupPreparation';
import { createProjectSetupSuccessStore } from './projectSetupSuccess';
import { isProjectNativeProcessUncertain, type ProjectNativeAdapterProductionV1 } from '@/plugins/runtime/lifecycle/contributions/targetProjectNativeAdapters';

export type ProjectSetupOperationContext = Parameters<Parameters<HostActionOperationRuntime['observeExecution']>[0]['execute']>[0];
export type ProjectSetupExecutionInput = Readonly<{
    preparation: Parameters<typeof prepareProjectSetup>[0];
    requesterAccountId: string;
    terminalCustody?: TerminalPtyCustody;
    operation: ProjectSetupOperationContext;
    terminalSessions: Pick<TerminalPtySessionManager, 'ensure' | 'waitForExit' | 'requestStop'>;
    environmentIo: ProjectNativeEnvironmentIoForHost;
    hostEnvironment?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    originRun?: ProjectCommandAttachmentV1['originRun'];
    sourceWorkspace?: ProjectCommandAttachmentV1['sourceWorkspace'];
    script?: ProjectCommandAttachmentV1['script'];
    lastCleanSyncAtMs?: ProjectCommandAttachmentV1['lastCleanSyncAtMs'];
}>;

export type ProjectSetupExecutionOutcome = Readonly<{
    kind: 'no_launch' | 'process_settled' | 'outcome_uncertain';
    result: ActionExecuteResult;
}>;

/** Resource custody for selected callbacks under the original host operation. */
export function createProjectNativeInvocationCustody(operation: Pick<ProjectSetupOperationContext, 'signal' | 'operationCancellation'> &
    Partial<Pick<ProjectSetupOperationContext, 'operationOwnerUpdate'>>,
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
        return outcome;
    } catch (error) {
        uncertain = isProjectNativeProcessUncertain(error) || error instanceof ProjectNativeEnvironmentUncertainError;
        throw error;
    } finally {
        if (!uncertain && outcome?.kind !== 'outcome_uncertain') {
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
        ...(input.lastCleanSyncAtMs !== undefined ? { lastCleanSyncAtMs: input.lastCleanSyncAtMs } : {}),
    };
    input.operation.operationOwnerUpdate.update({ domainRef: attachment });
    return attachment;
}

export type ProjectFiniteProcessInput = ProjectFiniteAdmissionInput & Readonly<{
    terminalSessions: ProjectSetupExecutionInput['terminalSessions'];
    launch: HostAuthorizedPluginExecLaunch;
    signal?: AbortSignal;
    step?: number;
    totalSteps?: number;
}>;

/** Single finite process consumer of an already admitted final Exec tuple. */
export async function executeProjectFiniteProcess(input: ProjectFiniteProcessInput): Promise<ProjectSetupExecutionOutcome> {
    const signal = input.signal ?? input.operation.signal;
    const operationId = input.operation.operationAcceptance?.operationId ?? input.operation.actionRequestId;
    const failure = (kind: ProjectSetupExecutionOutcome['kind'], code: string, details?: unknown): ProjectSetupExecutionOutcome => ({ kind, result: actionFailure(code, details) });
    if (signal.aborted) return failure('no_launch', 'cancelled');
    if (!operationId || !input.requesterAccountId) return failure('no_launch', 'project_setup_operation_unavailable');
    const attachment = publishProjectFiniteAdmission(input);
    let terminal: ReturnType<TerminalPtySessionManager['ensure']>;
    try {
        terminal = input.terminalSessions.ensure({ terminalKey: `${operationId}:${input.purpose}:${input.step ?? 0}`,
            cwd: input.launch.cwd ?? input.workspace.rootPath,
            requesterAccountId: input.requesterAccountId, holdUntilExit: true,
            ...(input.terminalCustody ? { custody: input.terminalCustody } : {}),
            launchProcess: { file: input.launch.command, args: input.launch.args, env: input.launch.env,
                ...(input.launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
            },
        });
    } catch { return failure('outcome_uncertain', 'outcome_uncertain'); }
    if (!terminal.ok) return failure('no_launch', terminal.errorCode);
    input.operation.operationOwnerUpdate.update({ state: 'running',
        domainRef: { ...attachment, cwd: input.launch.cwd ?? attachment.cwd, terminalId: terminal.terminalId },
        progress: { phase: input.purpose, label: 'Running project command', ...(input.totalSteps ? { current: input.step ?? 0, total: input.totalSteps } : {}) },
    });
    const stop = () => {
        input.operation.operationProgress.update({ phase: 'stopping', label: 'Stopping project command' });
        // A stop request cannot settle the admitted process. Keep observing the
        // real exit without the caller cancellation signal.
        void input.terminalSessions.requestStop({ terminalId: terminal.terminalId }).then(observation => {
            if (observation.kind === 'unconfirmed' || observation.kind === 'unavailable') {
                input.operation.operationOwnerUpdate.update({ observation: {
                    kind: observation.kind === 'unconfirmed' ? 'stop_unconfirmed' : 'outcome_uncertain',
                    code: observation.kind === 'unconfirmed' ? 'stop_unconfirmed' : 'outcome_uncertain',
                } });
            }
        }).catch(() => {
            input.operation.operationOwnerUpdate.update({ observation: { kind: 'stop_unconfirmed', code: 'stop_unconfirmed' } });
        });
    };
    const cancellation = input.operation.operationCancellation;
    const unsubscribe = cancellation?.onRequest(stop);
    const onAbort = () => {
        // The retained operation owner delivers each Stop itself. A separate
        // preparation/caller abort still stops this exact process once.
        if (!cancellation || !input.operation.signal.aborted) stop();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) stop();
    let observation: Awaited<ReturnType<TerminalPtySessionManager['waitForExit']>>;
    try { observation = await input.terminalSessions.waitForExit({ terminalId: terminal.terminalId,
        onOutcomeUncertain: () => input.operation.operationOwnerUpdate.update({
            observation: { kind: 'outcome_uncertain', code: 'outcome_uncertain' },
        }),
    }); }
    catch { return failure('outcome_uncertain', signal.aborted ? 'stop_unconfirmed' : 'outcome_uncertain'); }
    finally { signal.removeEventListener('abort', onAbort); unsubscribe?.(); }
    if (observation.kind === 'unavailable') return failure('outcome_uncertain', signal.aborted ? 'stop_unconfirmed' : 'outcome_uncertain');
    input.operation.operationOwnerUpdate.update({ domainRef: { ...attachment,
        cwd: input.launch.cwd ?? attachment.cwd, terminalId: terminal.terminalId,
        ...(observation.exit.exitCode !== null ? { exitCode: observation.exit.exitCode } : {}),
    } });
    if (signal.aborted) return failure('process_settled', 'cancelled');
    if (observation.exit.exitCode !== 0 || observation.exit.signal !== null && observation.exit.signal !== 0) {
        return failure('process_settled', 'project_command_step_failed', { step: input.step ?? 0, ...observation.exit });
    }
    return { kind: 'process_settled', result: { ok: true, result: { kind: 'success' } } };
}

export function createProjectNativeLaunchAdmission(input: ProjectSetupExecutionInput, plan: PreparedProjectSetupPlan, command?: PreparedProjectSetupCommand,
    signal = input.preparation.signal ?? input.operation.signal) {
    const nativeCommandEnvironment = command?.kind === 'native' ? command.resolution.nativeCommandEnvironment
        : command?.kind === 'pluginNative' ? command.resolution.environmentApplied : undefined;
    let environmentProduction: ProjectNativeAdapterProductionV1 | undefined;
    if (plan.environmentAdapterLease) {
        if (!input.preparation.retainNativeInvocation) throw Object.assign(new Error('native_adapter_invocation_unavailable'), { code: 'native_adapter_invocation_unavailable' });
        const acquired = plan.environmentAdapterLease.acquireProduction({ root: plan.workspace.rootPath,
            environment: projectBaseEnvironment(input, plan), signal });
        if (acquired.kind !== 'ready') throw Object.assign(new Error(acquired.code), { code: acquired.code });
        environmentProduction = acquired.production;
        input.preparation.retainNativeInvocation(environmentProduction);
    }
    let environmentIo: ProjectNativeEnvironmentIo = input.environmentIo;
    if (plan.environment.kind === 'toolchain') {
        if (!input.preparation.retainNativeInvocation) throw Object.assign(new Error('native_adapter_invocation_unavailable'), { code: 'native_adapter_invocation_unavailable' });
        environmentIo = input.environmentIo.createInvocation({ signal, retainCapture: input.preparation.retainNativeInvocation });
    }
    return {
        status: 'ready' as const, reviewedEffectDigest: plan.reviewedEffectDigest,
        environment: { selection: plan.environment, root: plan.workspace.rootPath,
            platform: input.platform ?? process.platform, io: environmentIo,
            ...(nativeCommandEnvironment ? { nativeCommandEnvironment } : {}),
        },
        ...(environmentProduction ? { nativeAdapter: {
            lease: environmentProduction, files: plan.environmentReviewInputs,
        } } : {}),
        ...(input.preparation.secretEnvironment ? { secretReferences: {
            ...input.preparation.secretEnvironment, requirements: plan.manifest?.environmentVariables ?? [],
            ...(input.preparation.environmentBindings ? { secretReferenceOverlay: input.preparation.environmentBindings } : {}),
        } } : {}),
    } satisfies HostProjectNativeLaunchAdmission;
}

export async function authorizePreparedProjectCommand(input: ProjectSetupExecutionInput, plan: PreparedProjectSetupPlan,
    command: PreparedProjectSetupCommand, signal: AbortSignal): Promise<HostAuthorizedPluginExecLaunch> {
    const assertCurrent = () => {
        if (signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
        if (plan.environmentAdapterLease && !plan.environmentAdapterLease.isCurrent()
            || command.kind === 'pluginNative' && !command.lease.isCurrent()) {
            throw Object.assign(new Error('native_adapter_retired'), { code: 'native_adapter_retired' });
        }
    };
    assertCurrent();
    const env = projectBaseEnvironment(input, plan);
    Object.assign(env, command.kind === 'native' ? command.resolution.environmentOverlay : {});
    const projectLaunch = createProjectNativeLaunchAdmission(input, plan, command, signal);
    if (command.kind === 'pluginNative') {
        const launch = await authorizePluginExecLaunchForHost(command.lease.exec, {
            executable: command.resolution.executable, args: command.resolution.args,
            cwd: { root: 'workspace', relativePath: relative(plan.workspace.rootPath, command.resolution.cwd).replaceAll('\\', '/') }, env,
        }, { signal, projectLaunch, ...(projectLaunch.nativeAdapter ? { nativeExecutableOwner: projectLaunch.nativeAdapter.lease.exec } : {}) });
        try { assertCurrent(); return launch; }
        catch (error) { launch.release(); throw error; }
    }
    const tuple = command.kind === 'literal'
        ? { ...resolveFiniteTerminalShell(command.source.command, input.hostEnvironment ?? process.env, input.platform ?? process.platform), cwd: command.cwd }
        : { file: command.resolution.command, args: command.resolution.args, cwd: command.resolution.cwd };
    return await authorizeResolvedProjectExecLaunchForHost({
        launch: { command: tuple.file, args: tuple.args, cwd: tuple.cwd, env }, projectLaunch, signal, assertCurrent,
        ...(projectLaunch.nativeAdapter ? { nativeExecutableOwner: projectLaunch.nativeAdapter.lease.exec } : {}),
    });
}

function projectBaseEnvironment(input: ProjectSetupExecutionInput, plan: PreparedProjectSetupPlan): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.hostEnvironment ?? process.env)) {
        if (value !== undefined) env[key] = value;
    }
    return Object.assign(env, plan.configEnvironment);
}

async function executePreparedProjectSetup(input: ProjectSetupExecutionInput): Promise<ProjectSetupExecutionOutcome> {
    let kind: ProjectSetupExecutionOutcome['kind'] = 'no_launch';
    const finish = (result: ActionExecuteResult): ProjectSetupExecutionOutcome => ({ kind, result });
    const failure = (errorCode: string, details?: unknown) => finish(actionFailure(errorCode, details));
    const signal = input.preparation.signal
        ? AbortSignal.any([input.operation.signal, input.preparation.signal]) : input.operation.signal;
    const launchFailure = (error: unknown): ProjectSetupExecutionOutcome => {
        if (error instanceof ProjectNativeEnvironmentUncertainError || isProjectNativeProcessUncertain(error)) {
            kind = 'outcome_uncertain';
            const code = error instanceof ProjectNativeEnvironmentUncertainError ? error.code : 'plugin_exec_termination_incomplete';
            input.operation.operationOwnerUpdate.update({ observation: { kind: 'outcome_uncertain', code } });
            return failure(code);
        }
        return failure(signal.aborted ? 'cancelled' : error instanceof Error && 'code' in error && typeof error.code === 'string'
            ? error.code : 'project_setup_launch_refused');
    };
    const preparation = { ...input.preparation, signal,
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
    const operationId = input.operation.operationAcceptance?.operationId ?? input.operation.actionRequestId;
    if (!operationId || !input.requesterAccountId) return failure('project_setup_operation_unavailable');
    const store = createProjectSetupSuccessStore({ homeDir: preparation.successHomeDir });
    const target = { serverId: plan.workspace.serverId, machineId: plan.workspace.machineId, workspaceRefId: plan.workspace.id };
    await store.invalidate(target);
    const admitted = { workspace: plan.workspace, purpose: plan.purpose, requesterAccountId: input.requesterAccountId,
        ...(input.terminalCustody ? { terminalCustody: input.terminalCustody } : {}),
        operation: input.operation, ...(input.originRun ? { originRun: input.originRun } : {}),
        ...(input.sourceWorkspace ? { sourceWorkspace: input.sourceWorkspace } : {}), ...(input.script ? { script: input.script } : {}),
        ...(input.lastCleanSyncAtMs !== undefined ? { lastCleanSyncAtMs: input.lastCleanSyncAtMs } : {}) };
    publishProjectFiniteAdmission(admitted);

    if (plan.commands.length === 0) {
        const fresh = await prepareProjectSetup({ ...preparation, expectedEffectDigest: plan.reviewedEffectDigest });
        if (signal.aborted) return failure('cancelled');
        if (fresh.kind !== 'prepared') return fresh.kind === 'refused' ? failure(fresh.code)
            : failure(fresh.kind === 'pendingApproval' ? fresh.code : 'project_setup_effect_changed');
        try {
            await produceProjectLaunchEnvironmentForHost({
                cwd: fresh.plan.workspace.rootPath, env: projectBaseEnvironment(input, fresh.plan),
                projectLaunch: createProjectNativeLaunchAdmission(input, fresh.plan), signal,
                assertCurrent() {
                    if (signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
                    if (fresh.plan.environmentAdapterLease && !fresh.plan.environmentAdapterLease.isCurrent()) {
                        throw Object.assign(new Error('native_adapter_retired'), { code: 'native_adapter_retired' });
                    }
                },
            });
        } catch (error) {
            return launchFailure(error);
        }
    }
    for (const step of plan.commands.keys()) {
        const fresh = await prepareProjectSetup({ ...preparation, expectedEffectDigest: plan.reviewedEffectDigest });
        if (signal.aborted) return failure('cancelled');
        if (fresh.kind !== 'prepared') return fresh.kind === 'refused' ? failure(fresh.code)
            : failure(fresh.kind === 'pendingApproval' ? fresh.code : 'project_setup_effect_changed');
        const command = fresh.plan.commands[step];
        if (!command) return failure('project_setup_effect_changed');
        let launch: HostAuthorizedPluginExecLaunch;
        try { launch = await authorizePreparedProjectCommand(input, fresh.plan, command, signal); }
        catch (error) {
            return launchFailure(error);
        }
        try {
            if (signal.aborted) return failure('cancelled');
            // Native production may await tools. Re-read reviewed inputs after it,
            // immediately before the OS launch; no stale command is admitted.
            const current = await prepareProjectSetup({ ...preparation, expectedEffectDigest: plan.reviewedEffectDigest });
            if (signal.aborted) return failure('cancelled');
            if (current.kind !== 'prepared') return current.kind === 'refused' ? failure(current.code)
                : failure(current.kind === 'pendingApproval' ? current.code : 'project_setup_effect_changed');
            if (fresh.plan.environmentAdapterLease && !fresh.plan.environmentAdapterLease.isCurrent()
                || command.kind === 'pluginNative' && !command.lease.isCurrent()) return failure('native_adapter_retired');
            const executed = await executeProjectFiniteProcess({ ...admitted, terminalSessions: input.terminalSessions,
                launch, signal, step, totalSteps: plan.commands.length });
            if (executed.kind !== 'no_launch') kind = executed.kind;
            if (!executed.result.ok) return executed.result.errorCode === 'project_command_step_failed'
                ? failure('project_setup_step_failed', executed.result.details) : finish(executed.result);
        } catch (error) {
            if (isProjectNativeProcessUncertain(error) || error instanceof ProjectNativeEnvironmentUncertainError) kind = 'outcome_uncertain';
            throw error;
        } finally { if (kind !== 'outcome_uncertain') launch.release(); }
    }
    const current = await prepareProjectSetup({ ...preparation, expectedEffectDigest: plan.reviewedEffectDigest });
    if (signal.aborted) return failure('cancelled');
    if (current.kind !== 'prepared') return current.kind === 'refused' ? failure(current.code)
        : failure(current.kind === 'pendingApproval' ? current.code : 'project_setup_effect_changed');
    if (plan.purpose === 'setup') await store.recordCompletion(target, {
        v: 1, workspaceRefId: plan.workspace.id, completedAtMs: Date.now(), ...current.plan.successBasis,
    });
    return finish({ ok: true, result: { kind: 'success', reviewedEffectDigest: plan.reviewedEffectDigest } });
}
