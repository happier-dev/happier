import { PluginError } from '@happier-dev/plugin-sdk';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { projectRuntimeAccountRowsInput } from '@/workspaces/projectAccountRows';
import type { HostProjectNativeLaunchAdmission } from '@/plugins/runtime/invocation/services/exec';
import type { ProjectFiniteActionRuntime } from './projectFiniteAction';
import { prepareProjectAgentLaunch, type ProjectAgentLaunchPreparation, type ProjectAgentLaunchPreparationInput } from './projectAgentLaunch';
import { createProjectNativeInvocationCustody, createProjectNativeLaunchAdmission, executeProjectSetup,
    publishProjectFiniteAdmission, type ProjectSetupOperationContext, type ProjectSetupExecutionOutcome } from './projectSetupExecution';
import { admitReviewedProjectSetup, type ProjectSetupPreparationInput, type ProjectSetupReviewPresentation } from './projectSetupPreparation';
import type { ActionOperationSetupDecision } from '@/daemon/actionOperations/actionOperationTypes';
import { workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { ProjectSetupConsentFailureDetailsV1Schema } from '@happier-dev/protocol/actions/projectActionFamily';
import { validatePath } from '@/rpc/handlers/pathSecurity';
import { createProjectDotenvPreparation, type ProjectDotenvPreparation } from './projectDotenv';
import { isProjectNativeProcessUncertain } from '@/plugins/runtime/lifecycle/contributions/targetProjectNativeAdapters';
import { ProjectNativeToolchainUncertainError } from '@/workspaces/toolchain/prepareProjectNativeToolchain';
import { startProjectSetupAutostartServices, type ProjectSetupAutostartContext } from './projectSetupAutostart';
import { prepareProjectWorktreeRuntime } from '@/workspaces/execution/projectWorktreeRuntime';


/** An invocation's existing Project IO custody, activated only by an exact native launch. */
export function createProjectAgentNativeLaunchOwner(input: Readonly<{
    runtime: ProjectFiniteActionRuntime;
    ingress: RpcHandlerContext;
    cwd: string;
    sessionId?: string;
    operation?: ProjectSetupOperationContext;
    setupAutostart?: ProjectSetupAutostartContext;
    resolveSecretInputs?: NonNullable<ProjectAgentLaunchPreparationInput['resolveSecretInputs']>;
}>) {
    const { runtime, ingress } = input;
    const custody = createProjectNativeInvocationCustody(input.operation ?? { signal: ingress.signal });
    let pendingPhase: Parameters<NonNullable<ProjectAgentLaunchPreparationInput['onPhase']>>[0]
        | 'currentness' | 'worker_admission' | 'setup_review' | 'setup_execution' = 'currentness';
    let launchSignal: AbortSignal | undefined;
    let preparationSignal: AbortSignal | undefined;
    const fail = (code: string, details?: Readonly<Record<string, unknown>>): never => {
        throw new PluginError({ code, message: 'Project Agent launch preparation was refused',
            ...(details ? { details: projectNativeJsonValueForTransport(details) } : {}) });
    };
    const assertCurrent = async (signal: AbortSignal) => {
        signal.throwIfAborted();
        pendingPhase = 'currentness';
        if (runtime.isCurrent && !await runtime.isCurrent()
            || ingress.requesterSessionBootstrap && !await ingress.requesterSessionBootstrap.isCurrent()) fail('project_requester_credentials_unavailable');
        signal.throwIfAborted();
    };
    return Object.freeze({
        readPreparationDiagnostic() {
            const abortSources = [
                ...(launchSignal?.aborted ? ['launch'] : []),
                ...(ingress.signal.aborted ? ['ingress'] : []),
                ...(input.operation?.signal.aborted ? ['operation'] : []),
            ];
            const reason: unknown = preparationSignal?.reason;
            return { pendingPhase, ...(preparationSignal?.aborted ? { abortSources,
                abortReason: reason instanceof Error ? reason.name === 'AbortError' ? 'abort'
                    : reason.name === 'TimeoutError' ? 'timeout' : 'error' : 'other' } : {}) };
        },
        async prepare(signal: AbortSignal, cwd?: string, environment?: Readonly<Record<string, string>>) {
            const dotenvPreparations = new Map<string, ProjectDotenvPreparation>();
            const runtimeEnvironments = new Map<string, Readonly<Record<string, string>>>();
            const originalEnvironment = Object.freeze({ ...(environment ?? runtime.hostEnvironment ?? process.env) });
            launchSignal = signal;
            signal = AbortSignal.any([signal, ingress.signal, ...(input.operation ? [input.operation.signal] : [])]);
            preparationSignal = signal;
            await assertCurrent(signal);
            // The host invocation selects the Project. A native child may use a
            // contained cwd, but cannot select another Project by changing cwd.
            if (cwd && !validatePath(cwd.replaceAll('\\', '/'), input.cwd).valid) fail('outside_root');
            const read = (presentation?: Pick<ProjectSetupReviewPresentation, 'provenance'>) => prepareProjectAgentLaunch({
                onPhase: phase => { pendingPhase = phase; },
                cwd: input.cwd, machineId: runtime.machineId, serverId: runtime.serverId,
                requesterIdentity: runtime.requesterIdentity,
                serverHttpBaseUrl: runtime.serverHttpBaseUrl, account: projectRuntimeAccountRowsInput(runtime),
                nativeIo: runtime.nativeIo, plugins: runtime.plugins, successHomeDir: runtime.successHomeDir,
                originalEnvironment,
                async readRuntimeEnvironment(workspace, manifest) {
                    let selected = runtimeEnvironments.get(workspace.rootPath);
                    if (!selected) {
                        const bindings = await prepareProjectWorktreeRuntime({ workspace, manifest, signal });
                        if (bindings.kind !== 'ready') return fail(bindings.code, { reason: bindings.reason });
                        selected = bindings.runtimeEnvironment;
                        runtimeEnvironments.set(workspace.rootPath, selected);
                    }
                    return selected;
                },
                readDotenvPreparation(root) {
                    let selected = dotenvPreparations.get(root);
                    if (!selected) { selected = createProjectDotenvPreparation(root, originalEnvironment); dotenvPreparations.set(root, selected); }
                    return selected;
                },
                platform: { os: (runtime.platform ?? process.platform) === 'win32' ? 'windows' : runtime.platform ?? process.platform,
                    arch: runtime.arch ?? process.arch },
                ...(environment ? { configEnvironment: environment } : runtime.configEnvironment ? { configEnvironment: runtime.configEnvironment } : {}),
                ...(runtime.secretEnvironment ? { secretEnvironment: runtime.secretEnvironment } : {}),
                ...(input.resolveSecretInputs ? { resolveSecretInputs: input.resolveSecretInputs } : {}),
                ...(ingress.localActionContext ? { approvalContext: ingress.localActionContext } : {}), signal,
            }, presentation);
            let prepared = await read();
            await assertCurrent(signal);
            if (prepared.kind === 'notAssociated') return undefined;
            if (prepared.kind === 'refused') return fail(prepared.code);
            const pending = (outcome: Extract<Extract<ProjectAgentLaunchPreparation, { kind: 'prepared' }>['outcome'], { kind: 'pendingApproval' }>) => ProjectSetupConsentFailureDetailsV1Schema.parse({
                kind: 'pendingApproval', code: outcome.code, reviewedEffectDigest: outcome.plan.reviewedEffectDigest,
                reviewedEffect: outcome.plan.reviewedEffect });
            const baseline = prepared.outcome.plan;
            let decision: ActionOperationSetupDecision | undefined;
            const preparation = (): ProjectSetupPreparationInput & Readonly<{ expectedEffectDigest?: string; skipForInvocation?: boolean }> => {
                if (prepared.kind !== 'prepared') return fail('project_workspace_changed');
                return { ...prepared.preparation, signal, retainNativeInvocation: custody.retain,
                    ...(decision ? { expectedEffectDigest: decision.reviewedEffectDigest, skipForInvocation: decision.skipForInvocation,
                        ...(!decision.skipForInvocation ? { effectDecision: {
                            project: prepared.outcome.plan.project, reviewedEffectDigest: decision.reviewedEffectDigest } } : {}) } : {}) };
            };
            const refresh = async (presentation?: Pick<ProjectSetupReviewPresentation, 'provenance'>) => {
                const current = await read(presentation);
                await assertCurrent(signal);
                if (current.kind === 'refused') return fail(current.code);
                if (current.kind !== 'prepared' || current.outcome.plan.workspace.id !== baseline.workspace.id
                    || current.outcome.plan.project.serverId !== baseline.project.serverId
                    || current.outcome.plan.project.projectId !== baseline.project.projectId) return fail('project_workspace_changed');
                prepared = current;
                const outcome = decision ? await admitReviewedProjectSetup(preparation(), current.outcome.plan) : current.outcome;
                if (outcome.kind === 'refused') return fail(outcome.code);
                prepared = { ...current, outcome };
                return outcome;
            };
            const operation = input.operation;
            const needsSetup = prepared.outcome.kind === 'pendingApproval'
                || prepared.outcome.kind === 'prepared' && !prepared.outcome.previousSuccess && baseline.commands.length > 0;
            if (needsSetup) {
                if (!operation || !(operation.operationAcceptance?.operationId ?? operation.actionRequestId)) {
                    return prepared.outcome.kind === 'pendingApproval'
                        ? fail(prepared.outcome.code, pending(prepared.outcome)) : fail('project_setup_operation_unavailable');
                }
                const operationId = operation.operationAcceptance?.operationId ?? operation.actionRequestId;
                const publish = () => publishProjectFiniteAdmission({ workspace: baseline.workspace, purpose: 'setup',
                    sourceWorkspace: workspaceAddressFromRefV1(baseline.workspace), requesterAccountId: runtime.accountId, operation });
                publish();
                pendingPhase = 'worker_admission';
                const setupState: { outcome?: ProjectSetupExecutionOutcome } = {};
                const result = await runtime.workerAdmission.execute({ operationId: operationId!, workspaceRefId: baseline.workspace.id,
                    requesterAccountId: runtime.accountId, signal, accept() {},
                    onQueue: queueAhead => operation.operationProgress.update({ phase: 'queued', queueAhead }),
                    onReserved: () => operation.operationProgress.update({ phase: 'setup' }),
                    onUnknown: () => operation.operationOwnerUpdate.update({ observation: { kind: 'outcome_uncertain', code: 'outcome_uncertain' } }),
                    run: reservation => (async () : Promise<ProjectSetupExecutionOutcome> => {
                        let kind: ProjectSetupExecutionOutcome['kind'] = 'no_launch';
                        try {
                            reservation.phase('setup');
                            while (true) {
                                const current = await refresh();
                                if (current.kind !== 'pendingApproval') break;
                                if (!operation.operationReview) return { kind, result: { ok: false, errorCode: current.code, error: current.code } };
                                pendingPhase = 'setup_review';
                                await operation.operationReview.waitForResume(pending(current), { review: selected => (async () => {
                                    const reviewed = await refresh();
                                    if (reviewed.kind !== 'pendingApproval') return null;
                                    if (selected?.reviewedEffectDigest === reviewed.plan.reviewedEffectDigest) {
                                        decision = selected;
                                        return null;
                                    }
                                    return pending(selected ? { ...reviewed, code: 'project_setup_effect_changed' } : reviewed);
                                })() });
                                await (() => assertCurrent(signal))();
                                if (decision) break;
                            }
                            pendingPhase = 'setup_execution';
                            const executed = await executeProjectSetup({ preparation: preparation(), requesterAccountId: runtime.accountId,
                                operation, terminalSessions: runtime.terminalSessions, environmentIo: runtime.environmentIo,
                                deferToolchainToLaunch: true, beforeNativeEffect: async () => {
                                    await (() => assertCurrent(signal))();
                                    pendingPhase = 'setup_execution';
                                },
                                ...(runtime.platform ? { platform: runtime.platform } : {}),
                                hostEnvironment: originalEnvironment });
                            if (executed.setupSettlement) runtime.publishSetupSettlement?.(executed.setupSettlement);
                            kind = executed.kind;
                            setupState.outcome = executed;
                            return executed;
                        } catch (error) {
                            const code = signal.aborted ? 'cancelled' : error && typeof error === 'object' && 'code' in error
                                && typeof error.code === 'string' ? error.code : 'project_setup_launch_refused';
                            // A failed passive remeasurement started no process. Only
                            // native custody's explicit uncertainty retains the slot.
                            return { kind: isProjectNativeProcessUncertain(error) || error instanceof ProjectNativeToolchainUncertainError
                                ? 'outcome_uncertain' : kind, result: { ok: false, errorCode: code, error: code } };
                        }
                    })() });
                await assertCurrent(signal);
                if (!result.ok) return fail(result.errorCode);
                if (result.result && typeof result.result === 'object' && 'kind' in result.result && result.result.kind === 'not_accepted') {
                    return fail('project_worker_not_accepted');
                }
                if (setupState.outcome?.setupSettlement?.outcome === 'finished') {
                    const autostart = input.setupAutostart ?? operation.setupAutostart;
                    if (autostart) {
                        const refusal = await startProjectSetupAutostartServices({ outcome: setupState.outcome, manifest: baseline.manifest, ...autostart,
                            callerInputAuthorization: autostart.callerInputAuthorization ?? ingress.callerInputAuthorization });
                        if (refusal) return fail(refusal.errorCode);
                    } else if (Object.values(baseline.manifest?.services ?? {}).some(service => service.runtime?.autostart === true)) {
                        return fail('project_service_action_context_unavailable');
                    }
                }
                await refresh();
            }
            const final = prepared.outcome;
            if (final.kind === 'pendingApproval') return fail(final.code, pending(final));
            const plan = final.plan;
            const verifyCurrent = () => (async () => {
                await assertCurrent(signal);
                const current = await refresh({ provenance: plan.reviewedEffect.presentation.provenance });
                await assertCurrent(signal);
                const currentPlan = current.plan;
                if (currentPlan.workspace.id !== plan.workspace.id || currentPlan.project.serverId !== plan.project.serverId
                    || currentPlan.project.projectId !== plan.project.projectId) return fail('project_workspace_changed');
                if (currentPlan.reviewedEffectDigest !== plan.reviewedEffectDigest) return fail('project_setup_effect_changed');
                if (current.kind === 'pendingApproval') fail(current.code);
            })();
            const projectLaunch = { ...createProjectNativeLaunchAdmission({
                preparation: preparation(), environmentIo: runtime.environmentIo, hostEnvironment: originalEnvironment,
                platform: runtime.platform, operation: { signal },
            }, plan), verifyCurrent } satisfies HostProjectNativeLaunchAdmission;
            return { projectLaunch, ...(projectLaunch.nativeAdapter
                ? { nativeExecutableOwner: projectLaunch.nativeAdapter.lease.exec } : {}) };
        },
        async dispose() { try { await custody.release(); } finally { custody.dispose(); } },
    });
}
