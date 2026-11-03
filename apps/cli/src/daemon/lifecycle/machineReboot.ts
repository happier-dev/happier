import type { ActionExecuteResult, ActionOperationDomainRefV1, MachineRebootInputV1, MachineRebootResultV1 } from '@happier-dev/protocol';
import type { MachineDeploymentReferencesPageV1 } from '@happier-dev/protocol/machines/machineReferenceCensusV1';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import type { HostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import type { MachineVitalsSampler } from '@/daemon/vitals/createMachineVitalsSampler';
import type { DaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { readMachineMaintenanceAdmission, type ManagedActivityInventory } from '@/daemon/lifecycle/managedActivity';
import { MachineNativeEffectAdmissionError, type MachineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { runElevatedMachineReboot, type MachineElevationDependencies } from '@/machines/adminAccess/runElevatedEffect';
import { getLiveSystemTasksRunnerAdapter } from '@/capabilities/systemTasks/liveSystemTasksRunner';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import type { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { assertMachineSystemTaskResponseCurrent } from '@/capabilities/service';
import { MachineSudoPasswordPromptV1Schema } from '@happier-dev/protocol';
import { SystemTaskExecutionError } from '@happier-dev/cli-common/systemTasks';
import type { MachineServiceDisclosureRequest } from '@/daemon/local/services/launch/machineServiceDisclosure';

/** Projection produced by the incumbent managed-services semantic entries.
 * It is private: a Machine manager must not learn another Account's app names.
 * Native observations/restart policy remain in their existing supervisor.
 */
export type MachineRebootServiceFacts = Awaited<ReturnType<ReturnType<typeof createManagedServicesOwner>['readMachineRebootServices']>>;

export type DaemonMachineRebootRoutes = Readonly<{
    admissionDrain: DaemonAdmissionDrain;
    inventory: ManagedActivityInventory;
    nativeAdmission: MachineNativeEffectAdmission;
    vitals: Pick<MachineVitalsSampler, 'host'>;
    target(): Readonly<{ serverId: string; machineId: string; installationId: string; custodianAccountId: string }> | null;
    /** Actual managed-services owner projection, not a discovery or Resource read. */
    readServiceFacts(request: MachineServiceDisclosureRequest & Readonly<{ serverId: string; machineId: string }>): Promise<MachineRebootServiceFacts>;
}>;

export type MachineRebootDirectTargetInvocation = Readonly<{
    input: MachineRebootInputV1;
    context: RpcActionExecutorContext;
    signal?: AbortSignal;
    /** Captured original Account read; never accepted from the Action operand. */
    canReadEnvironments?: (environmentIds: readonly string[]) => Promise<ReadonlySet<string>>;
    readDeploymentReferences?: () => Promise<MachineDeploymentReferencesPageV1>;
}>;

type RebootOperation = Pick<Parameters<Parameters<HostActionOperationRuntime['observeExecution']>[0]['execute']>[0],
    'signal' | 'operationAcceptance' | 'operationOwnerUpdate'>;

/** The installed daemon's actual lifecycle Action owner. The public Action
 * executor calls this only through its private direct-target callback. */
export function createMachineRebootAction(input: Readonly<{
    routes: DaemonMachineRebootRoutes;
    operations: HostActionOperationRuntime;
    captureElevation(): Omit<MachineElevationDependencies, 'verifyCurrent' | 'prompt' | 'emit'>;
}>) {
    return async (request: MachineRebootDirectTargetInvocation): Promise<unknown> => {
        const { routes, operations } = input;
        const target = routes.target();
        const lifetime = request.signal ?? request.context.signal;
        const failure = (errorCode: string): ActionExecuteResult => ({ ok: false, errorCode, error: errorCode });
        const domain = (result: MachineRebootResultV1): ActionExecuteResult => ({ ok: true, result });
        const matches = () => {
            const current = routes.target();
            const admission = request.context.machineAdmission;
            return !!target && !!current && !!admission && admission.role === 'manage'
                && !lifetime?.aborted && current.serverId === target.serverId
                && current.machineId === target.machineId && current.installationId === target.installationId
                && current.custodianAccountId === target.custodianAccountId
                && request.input.machineId === current.machineId
                && request.input.expectedInstallationId === current.installationId
                && admission.machineId === current.machineId && admission.installationId === current.installationId
                && admission.custodianAccountId === current.custodianAccountId;
        };
        // The public Action already admitted the requester. Bind its local
        // Home/installation once; the final dispatch edge checks local custody.
        if (!matches() || !await isServerProfileHomeIdentity(target!.serverId, request.input.serverId) || !matches()) {
            return failure(lifetime?.aborted ? 'cancelled' : 'plan_changed');
        }

        const run = async (operation: RebootOperation): Promise<ActionExecuteResult> => {
            const operationId = operation.operationAcceptance?.operationId;
            if (!target || !operationId || operation.operationAcceptance?.actionId !== 'machines.reboot') return failure('admission_unavailable');
            const scope = { accountId: request.context.machineAdmission!.actorAccountId, machineId: target.machineId };
            const retained = operations.store.get(scope, operationId);
            if (retained?.actionId !== 'machines.reboot' || retained.state !== 'running') return failure('admission_unavailable');
            const signal = lifetime ? AbortSignal.any([lifetime, operation.signal]) : operation.signal;
            let lifecycleRefusal: 'daemon_shutting_down' | 'daemon_draining' | undefined;
            const lifecycleCurrent = () => {
                if (routes.admissionDrain.isPublicationQuiescing()) {
                    lifecycleRefusal = routes.admissionDrain.isFinalShutdown() ? 'daemon_shutting_down' : 'daemon_draining';
                    return false;
                }
                return true;
            };
            const verifyCurrent = async () => !signal.aborted && lifecycleCurrent() && matches()
                && operations.store.get(scope, operationId)?.state === 'running';
            if (!await verifyCurrent()) return lifecycleRefusal ? domain({ kind: 'unavailable', reason: lifecycleRefusal })
                : failure(signal.aborted ? 'cancelled' : 'plan_changed');
            // Never take over another lifecycle decision, even a reversible one.
            if (routes.admissionDrain.isQuiescing()) return domain({ kind: 'unavailable',
                reason: routes.admissionDrain.isFinalShutdown() ? 'daemon_shutting_down' : 'daemon_draining' });
            const releaseDrain = routes.admissionDrain.beginTemporaryDrain();
            let mayHaveDispatched = false;
            let positivelyNotDispatched = false;
            try {
                return await routes.nativeAdmission.run({ operation: { operationId, kind: 'reboot', signal },
                    keys: [], allNative: true }, async nativeContext => {
                    try {
                        // Exclusion precedes this fresh all-owner read. An earlier
                        // async startup remains in its incumbent owner's custody.
                        const maintenance = await readMachineMaintenanceAdmission(routes.inventory, { excludeOperationId: operationId });
                        if (maintenance.kind !== 'eligible') return domain({ kind: 'blocked', reasons: [...maintenance.reasons] });
                        const host = routes.vitals.host();
                        if (!host) return domain({ kind: 'unavailable', reason: 'required_fact_unavailable' });
                        let basis: Omit<NonNullable<Extract<ActionOperationDomainRefV1, { kind: 'machineReboot' }>['basis']>, 'dispatchStarted'> = {
                            bootedAt: host.bootedAt, expectedRunningServiceIds: [], expectedRunningServicesKnown: false,
                        };
                        const accepted = () => ({ kind: 'accepted' as const, operation: { operationId }, bootedAt: basis.bootedAt });
                        let finalMaintenance: Exclude<Awaited<ReturnType<typeof readMachineMaintenanceAdmission>>, { kind: 'eligible' }> | undefined;
                        const tasks = getLiveSystemTasksRunnerAdapter();
                        let taskReference!: Readonly<{ taskId: string }>;
                        const publishTask = (task: Readonly<{ taskId: string }>, prompt?: import('@happier-dev/protocol').MachineSudoPasswordPromptV1) => {
                            operation.operationOwnerUpdate.update({ domainRef: { kind: 'machineReboot', serverId: request.input.serverId,
                                machineId: target.machineId, installationId: target.installationId,
                                task: { id: task.taskId, taskKind: 'machine.reboot.v1', ...(prompt ? { prompt } : {}) },
                                ...(mayHaveDispatched ? { basis: { ...basis, dispatchStarted: true } } : {}) } });
                        };
                        let outcome: ActionExecuteResult | undefined;
                        const task = await tasks.startAdmitted({ run: async taskContext => {
                            const taskSignal = taskContext.signal ? AbortSignal.any([signal, taskContext.signal]) : signal;
                            const result = await runElevatedMachineReboot({ machineId: target.machineId, operationId,
                                signal: taskSignal, async onRebootDispatch() {
                                    // Ask may have remained open while observation
                                    // adoption changed the current residency set.
                                    const [services, references] = await Promise.all([
                                        routes.readServiceFacts({ serverId: target.serverId, machineId: target.machineId,
                                            context: request.context, requesterAccountId: scope.accountId,
                                            ...(request.canReadEnvironments ? { canReadEnvironments: request.canReadEnvironments } : {}) }).catch(() => null),
                                        request.readDeploymentReferences?.().catch(() => null) ?? null,
                                    ]);
                                    basis = { bootedAt: routes.vitals.host()?.bootedAt ?? host.bootedAt,
                                        expectedRunningServiceIds: services?.services.filter(service => service.phase === 'running').map(service => service.serviceId) ?? [],
                                        expectedRunningServicesKnown: services?.coverage === 'complete'
                                            && services.services.every(service => service.phase === 'running' || service.phase === 'stopped'),
                                        ...(references ? { domains: references.references.flatMap(reference => reference.deploymentDomains ?? [])
                                            .filter(domain => domain.machineId === target.machineId && domain.installationId === target.installationId) } : {}),
                                    };
                                    // Set BEFORE writing the one irreversible frame.
                                    // Transport loss can no longer prove no dispatch.
                                    mayHaveDispatched = true;
                                    // Existing encrypted/plain operation push carries
                                    // these before-facts to an outside admitted holder.
                                    // No target-local recovery Map can survive reboot.
                                    publishTask(taskReference);
                                    operation.operationOwnerUpdate.update({ state: 'running', cancellation: 'unsupported',
                                        progress: { phase: 'reboot.dispatching', label: retained.title } });
                                    try { await operations.publishCurrentSnapshot(scope, operationId); }
                                    catch { /* No outside holder is unknown, never a new dispatch veto. */ }
                                } }, { ...input.captureElevation(), prompt: async prompt => await taskContext.prompt({ ...prompt,
                                    validateResponse: async authorization => {
                                        await assertMachineSystemTaskResponseCurrent(authorization, {
                                            admission: request.context.machineAdmission!, verifyCurrent,
                                        });
                                        await prompt.validateResponse?.(authorization);
                                    },
                                }), emit: taskContext.emit,
                                verifyCurrent: async boundary => {
                                    if (taskSignal.aborted || !await verifyCurrent()) return false;
                                    if (boundary !== 'reboot_dispatch') return true;
                                    // Only final dispatch reads all live work again.
                                    // Earlier root frames check local custody only.
                                    const maintenance = await readMachineMaintenanceAdmission(routes.inventory, { excludeOperationId: operationId });
                                    if (maintenance.kind !== 'eligible') { finalMaintenance = maintenance; return false; }
                                    return !taskSignal.aborted && await verifyCurrent();
                                } });
                            if (result.outcome === 'not_applied') {
                                positivelyNotDispatched = true;
                                outcome = lifecycleRefusal ? domain({ kind: 'unavailable', reason: lifecycleRefusal })
                                    : result.reasonCode === 'cancelled' ? failure('cancelled')
                                    : finalMaintenance ? domain({ kind: 'blocked', reasons: [...finalMaintenance.reasons] })
                                    : result.reasonCode === 'plan_stale' ? failure('plan_changed')
                                    : domain({ kind: 'failed', reasonCode: result.reasonCode });
                            } else if (result.outcome === 'needs_attendance') {
                                outcome = domain({ kind: 'unavailable', reason: 'needs_attendance' });
                            } else {
                                // An unknown carrier result is never positive
                                // no-dispatch proof, even if its receipt or local
                                // callback was lost. Fail closed at this SAME
                                // native/drain owner rather than reopening work.
                                mayHaveDispatched = true;
                                publishTask(taskReference);
                                // Accepted dispatch is deliberately not restored success.
                                operation.operationOwnerUpdate.update({ state: 'running', cancellation: 'unsupported',
                                    outcome: failure('action_outcome_unknown'), progress: { phase: 'reboot.awaiting_recovery', label: retained.title } });
                                if (result.outcome === 'dispatched') operation.operationAcceptance?.accept(accepted());
                                outcome = result.outcome === 'dispatched' ? domain(accepted()) : failure('action_outcome_unknown');
                            }
                            return { operationId };
                        } }, 'machine.reboot.v1', {
                            started: task => { taskReference = task; publishTask(task); },
                            prompt: (task, question) => {
                                const data: unknown = question?.data;
                                const prompt = question?.kind === 'sudo.password' && data && typeof data === 'object' && !Array.isArray(data)
                                    && 'machineId' in data && data.machineId === target.machineId
                                    && 'installationId' in data && data.installationId === target.installationId
                                    && 'operationId' in data && data.operationId === operationId && 'administratorUsername' in data
                                    ? MachineSudoPasswordPromptV1Schema.safeParse({ kind: question.kind, adminUsername: data.administratorUsername }) : null;
                                publishTask(task, prompt?.success ? prompt.data : undefined);
                            },
                        });
                        const cancel = () => { if (!mayHaveDispatched) void tasks.cancel(task); };
                        // Final shutdown or plugin handoff withdraws an open
                        // attendance question at its existing task owner. A
                        // neighboring temporary drain must keep its own custody.
                        const retireAttendance = () => { if (!lifecycleCurrent()) cancel(); };
                        const unsubscribeDrain = routes.admissionDrain.subscribe(retireAttendance);
                        signal.addEventListener('abort', cancel, { once: true });
                        if (signal.aborted) cancel();
                        retireAttendance();
                        try {
                            await tasks.wait(task);
                            return outcome ?? failure(mayHaveDispatched ? 'action_outcome_unknown' : signal.aborted ? 'cancelled' : 'admission_unavailable');
                        } finally { unsubscribeDrain(); signal.removeEventListener('abort', cancel); }
                    } finally {
                        if (mayHaveDispatched && !positivelyNotDispatched) routes.nativeAdmission.markUnsettled(nativeContext);
                    }
                });
            } catch (error) {
                if (mayHaveDispatched && !positivelyNotDispatched) {
                    operation.operationOwnerUpdate.update({ state: 'running', cancellation: 'unsupported', outcome: failure('action_outcome_unknown') });
                    return failure('action_outcome_unknown');
                }
                if (error instanceof MachineNativeEffectAdmissionError) return { ok: false, errorCode: error.code, error: error.code,
                    ...(error.details ? { details: error.details } : {}) };
                return failure(signal.aborted ? 'cancelled' : 'admission_unavailable');
            } finally {
                if (!mayHaveDispatched || positivelyNotDispatched) releaseDrain();
            }
        };
        // The receiving Action front door normally supplies this owner. An
        // admitted direct invocation joins the SAME observation path, never a
        // second operation or client-owned completion tracker.
        const context = request.context;
        const result = context.operationAcceptance && context.operationOwnerUpdate
            ? await run({ signal: context.signal ?? lifetime ?? new AbortController().signal,
                operationAcceptance: context.operationAcceptance, operationOwnerUpdate: context.operationOwnerUpdate })
            : await operations.observeExecution({ actionId: 'machines.reboot', input: request.input,
                actionRequestId: context.actionRequestId ?? undefined, rpcContext: context, execute: run });
        return result.ok ? result.result : result;
    };
}
