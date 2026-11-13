import { type ProviderObservationV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { ManagedControllerSubmitOutputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MachineProvisionerCleanupObservationV1Schema, MachineProvisionerDestroyResultV1Schema, MachineProvisionerPowerResultV1Schema, MachineProvisionerRebuildResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { ManagedActivityBridgeResultV1 } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ManagedPolicyPurposeV1 } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { readRpcErrorCode, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { isDeepStrictEqual } from 'node:util';
import { ManagedMachineControllerError, ManagedMachineNativeRefusal, ManagedMachineNativeEffectGuardRefusal, ManagedRetentionWaitSuperseded, isUncertainManagedControllerRequest } from './controllerErrors';
import { createManagedNativeInvocation, reconcileManagedAcquisitionIdentity, reconcileManagedMachine, type ManagedMachineReconciliationInput } from './reconcile';
import { createManagedGuestActivityTransport } from './managedActivityTransport';
import { waitForChangeOrDeadline } from '@/daemon/lifecycle/waitForChangeOrDeadline';
import { canPrepareManagedRetentionPolicy, hasSubmittedManagedRetentionEffect } from './managedRetentionPolicy';
import { assertManagedDeleteNativeResult, canObserveAcceptedManagedDelete, observeAcceptedManagedDelete } from './deleteObservation';
import { createManagedNativeObservationWait, executeManagedMachinePowerIntent, executeManagedMachineDeleteIntent, reconcileManagedBoundNativeIntent } from '@happier-dev/cli-common/machines/managed';
import type { MachineProvisionerRenewResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { resolveManagedCliReleaseChannelSync } from '@happier-dev/cli-common/firstPartyRuntime';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { logger } from '@/ui/logger';

/** In-process host receipt settlement, never part of the plugin or wire context. */
export type ManagedNativeOperationSettlement = Readonly<{
    managedId: string;
    controller: ManagedMachineV1['controller'];
    resource?: ManagedMachineV1['resource'];
    requestId: string;
    intentRevision: number;
    intent: Exclude<NonNullable<ManagedMachineV1['submittedNativeEffect']>['intent'], 'rebuild'>;
    succeeded: boolean;
}>;
export type ManagedMachineOperationSettlementContext = ActionExecutorContext & Readonly<{
    settleManagedNativeOperation?: (settlement: ManagedNativeOperationSettlement) => void;
}>;

/** Project only custody already settled by Home into the original operation. */
export function publishSettledManagedNativeOperation(context: ManagedMachineOperationSettlementContext | undefined,
    before: ManagedMachineV1, after: ManagedMachineV1, outstanding: NonNullable<ManagedMachineV1['submittedNativeEffect']>) {
    if (outstanding.intent === 'rebuild' || after.id !== before.id || after.homeId !== before.homeId
        || after.submittedNativeEffect || !isDeepStrictEqual(after.controller, outstanding.controller)
        || !isDeepStrictEqual(after.resource, before.resource)) return;
    const observation = after.observation;
    const succeeded = outstanding.intent === 'delete'
        ? after.allocation === 'confirmed-absent' && observation?.availability === 'absent'
        : observation?.availability === 'present' && observation.power === (
            outstanding.intent === 'start' || outstanding.intent === 'resume' ? 'running'
                : outstanding.intent === 'stop' ? 'stopped' : 'suspended');
    if (outstanding.intent === 'delete' && !succeeded) return;
    context?.settleManagedNativeOperation?.({ managedId: before.id, controller: outstanding.controller,
        ...(before.resource ? { resource: before.resource } : {}),
        requestId: outstanding.requestId, intentRevision: outstanding.intentRevision, intent: outstanding.intent, succeeded });
    return succeeded;
}

/** Network observations only; the native intent decision remains in this owner. */
export type ManagedGuestActivityTransport = Readonly<{
    read(machine: ManagedMachineV1, signal?: AbortSignal): Promise<ManagedActivityBridgeResultV1>;
    confirmIdle(machine: ManagedMachineV1, signal?: AbortSignal): Promise<ManagedActivityBridgeResultV1>;
    reopen(machine: ManagedMachineV1): Promise<unknown>;
    waitForChange(signal?: AbortSignal): Promise<'activity' | void>;
    dispose?(): Promise<void>;
}>;

function assertLive(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ManagedMachineControllerError('cancelled');
}

function isUnavailableGuestActivity(error: unknown): boolean {
    const code = readRpcErrorCode(error);
    return code === 'target_unavailable' || code === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
        || code === RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE;
}

function remainingIdleDuration(activity: Extract<ManagedActivityBridgeResultV1, { kind: 'idle' }>, duration: number): number {
    if (!('evidence' in activity) && duration > 0) throw new ManagedMachineControllerError('admission_unavailable');
    const elapsed = 'evidence' in activity ? activity.evidence.decision.confirmedAt - activity.evidence.decision.since : 0;
    return Math.max(0, duration - elapsed);
}

async function waitForIdle(params: Readonly<{
    machine: ManagedMachineV1; bridge: ManagedGuestActivityTransport; duration: number; signal?: AbortSignal;
    deferUnavailableTarget?: boolean;
    isCurrent(): Promise<boolean>;
    onActivity(kind: 'busy' | 'unknown' | 'idle' | 'waiting'): void;
    onWait?: (deadlineAt?: number) => Promise<number | undefined>;
}>) {
    for (;;) {
        assertLive(params.signal);
        if (!await params.isCurrent()) throw new ManagedMachineControllerError('intent_changed');
        let activity: ManagedActivityBridgeResultV1;
        try {
            activity = await params.bridge.read(params.machine, params.signal);
        } catch (error) {
            assertLive(params.signal);
            // A power-down reply can precede the scheduler's invalidation.
            // Retired idle work settles through its currentness owner before
            // any guest transport failure is classified for that old intent.
            if (!await params.isCurrent()) throw new ManagedMachineControllerError('intent_changed');
            if (!params.deferUnavailableTarget || !isUnavailableGuestActivity(error)) throw error;
            // An automatic preparation's ready snapshot can precede guest
            // registration or socket loss. Keep unknown evidence until its existing Machine
            // update/reconnect wake; Account currentness alone cannot retry it.
            activity = { kind: 'unknown', reasons: ['coverage_unknown'] };
        }
        if (activity.kind === 'refused') throw new ManagedMachineControllerError(activity.code);
        // The guest read commits evidence under a reversible local probe and
        // releases it before replying. Waiting never retains guest admission.
        params.onActivity(activity.kind === 'idle' ? 'waiting' : activity.kind);
        let deadlineAt: number | undefined;
        if (activity.kind === 'idle') {
            const remaining = remainingIdleDuration(activity, params.duration);
            deadlineAt = Date.now() + remaining;
            if (remaining === 0) {
                await params.onWait?.(deadlineAt);
                params.onActivity('idle');
                return activity;
            }
        }
        const renewAt = await params.onWait?.(deadlineAt);
        const wakeAt = deadlineAt === undefined ? renewAt : renewAt === undefined ? deadlineAt : Math.min(deadlineAt, renewAt);
        await waitForChangeOrDeadline({ waitForChange: async signal => {
            try {
                await params.bridge.waitForChange(signal);
            } catch (error) {
                assertLive(signal);
                if (!params.onWait || !params.deferUnavailableTarget || !isUnavailableGuestActivity(error)) throw error;
                // Lost idle coverage must immediately restore the native lifetime.
                // Busy/unknown waits resume at the existing vendor renewal deadline.
                if (activity.kind !== 'idle') await new Promise<void>(() => {});
            }
        }, signal: params.signal, remainingMs: wakeAt === undefined ? undefined : Math.max(0, wakeAt - Date.now()) });
    }
}

/** The operation describes the guest decision for this exact retained native resource. */
function publishActivity(options: ManagedMachineReconciliationInput['options'], machine: ManagedMachineV1,
    kind: 'busy' | 'unknown' | 'idle' | 'waiting') {
    options.context?.operationOwnerUpdate?.update({ domainRef: { kind: 'managedMachine', id: machine.id,
        controller: machine.controller, ...(machine.resource ? { resource: machine.resource } : {}) },
        progress: { phase: kind === 'idle' ? 'managed.intent.draining' : kind === 'busy' ? 'managed.intent.busy'
            : kind === 'waiting' ? 'managed.intent.waiting-idle' : 'managed.intent.activity-unknown',
            label: kind === 'idle' ? 'Preparing idle machine' : kind === 'busy' ? 'Waiting for guest work'
                : kind === 'waiting' ? 'Waiting for unused machine' : 'Guest activity unavailable' } });
}

/** Policy preparation shares the same selected timer, actual guest inventory and drain owner. */
export async function prepareManagedRetentionPolicy(params: Readonly<{
    input: ManagedMachineReconciliationInput['input']; options: ManagedMachineReconciliationInput['options'];
    machine: ManagedMachineV1; purpose: Extract<ManagedPolicyPurposeV1, { kind: 'retention' }>;
    renew?: (deadlineAt?: number) => Promise<MachineProvisionerRenewResultV1>;
}>): Promise<{ purpose: ManagedPolicyPurposeV1; bridge?: ManagedGuestActivityTransport; nativeExpiry?: number;
    onActivityChange?: () => Promise<boolean> }> {
    const { machine, input, options, purpose } = params;
    if (machine.retention.kind === 'until-delete' && !params.renew) throw new ManagedMachineControllerError('intent_changed');
    const continuesRetention = hasSubmittedManagedRetentionEffect(machine, options.retentionContinuationRequestId);
    if (!canPrepareManagedRetentionPolicy(machine, options.retentionContinuationRequestId)) {
        throw new ManagedMachineControllerError('admission_unavailable');
    }
    if (purpose.evidence || continuesRetention) return { purpose };
    if (machine.retention.kind === 'unused' && !machine.enrolledMachineId) {
        throw new ManagedMachineControllerError('admission_unavailable');
    }
    let renewal: Readonly<{ deadlineAt?: number; result: MachineProvisionerRenewResultV1 }> | undefined;
    const maintainNativeLifetime = async (deadlineAt?: number) => {
        if (!params.renew || renewal?.result.kind === 'unnecessary') return undefined;
        if (!renewal || renewal.deadlineAt !== deadlineAt
            || renewal.result.renewAt !== undefined && Date.now() >= renewal.result.renewAt) {
            renewal = { deadlineAt, result: await params.renew(deadlineAt) };
        }
        return renewal.result.kind === 'renewed' ? renewal.result.renewAt : undefined;
    };
    const prepared = (nextPurpose: ManagedPolicyPurposeV1) => {
        const nativeExpiry = renewal?.result.kind === 'renewed' ? renewal.result.nativeExpiry : undefined;
        return { purpose: nextPurpose,
            ...(nativeExpiry !== undefined && machine.retention.kind !== 'until-delete' && machine.retention.effect === 'stop'
                ? { nativeExpiry } : {}) };
    };
    const isCurrent = async () => {
        if (!input.readPolicyCurrent) throw new ManagedMachineControllerError('admission_unavailable');
        const current = await input.readPolicyCurrent(machine.id, options.signal);
        const verified = Boolean(current && current.homeId === machine.homeId && current.intentRevision === machine.intentRevision
            && isDeepStrictEqual(current.controller, machine.controller) && isDeepStrictEqual(current.resource, machine.resource)
            && isDeepStrictEqual(current.retention, machine.retention) && current.creationState === 'active');
        if (verified && current) options.context?.operationOwnerUpdate?.update({ domainRef: { kind: 'managedMachine', id: current.id,
            controller: current.controller, ...(current.resource ? { resource: current.resource } : {}) } });
        if (!verified) throw new ManagedRetentionWaitSuperseded();
        return verified;
    };
    if (machine.retention.kind === 'until-delete') {
        options.context?.operationOwnerUpdate?.update({ progress: { phase: 'managed.intent.waiting-deadline', label: 'Keeping machine available' } });
        for (;;) {
            assertLive(options.signal);
            await isCurrent();
            const nextRenewAt = await maintainNativeLifetime();
            if (renewal?.result.kind !== 'renewed') return prepared(purpose);
            // Keep forever has no activity dependency; policy changes cancel this owner.
            await waitForChangeOrDeadline({ waitForChange: () => new Promise<void>(() => {}),
                signal: options.signal, remainingMs: nextRenewAt === undefined ? undefined : Math.max(0, nextRenewAt - Date.now()) });
        }
    }
    const bridge = input.managedGuestActivity ?? createManagedGuestActivityTransport(input, options, machine);
    try {
        if (machine.retention.kind === 'deadline') {
            options.context?.operationOwnerUpdate?.update({ progress: { phase: 'managed.intent.waiting-deadline', label: 'Waiting for selected deadline' } });
            for (;;) {
                assertLive(options.signal);
                if (!await isCurrent()) throw new ManagedMachineControllerError('intent_changed');
                const remaining = machine.retention.at - Date.now();
                const nextRenewAt = await maintainNativeLifetime(machine.retention.at);
                if (remaining <= 0) return { ...prepared(purpose), bridge };
                await waitForChangeOrDeadline({ waitForChange: async signal => { await bridge.waitForChange(signal); },
                    signal: options.signal, remainingMs: nextRenewAt === undefined ? remaining : Math.min(remaining, Math.max(0, nextRenewAt - Date.now())) });
                assertLive(options.signal);
            }
        }
        options.context?.operationOwnerUpdate?.update({ progress: { phase: 'managed.intent.waiting-idle', label: 'Waiting for unused machine' } });
        const duration = machine.retention.afterMs;
        const waitUntilUnusedExpiry = async () => {
            const fresh = await waitForIdle({ machine, bridge, duration, signal: options.signal,
                deferUnavailableTarget: true,
                isCurrent, onActivity: kind => publishActivity(options, machine, kind),
                ...(params.renew ? { onWait: maintainNativeLifetime } : {}) });
            if (!('evidence' in fresh)) throw new ManagedMachineControllerError('admission_unavailable');
            return fresh;
        };
        const fresh = await waitUntilUnusedExpiry();
        // A lost guest channel during delayed native lapse is a coverage change.
        // The same unused owner re-reads it as unknown and restores the native TTL.
        const observationBridge: ManagedGuestActivityTransport = params.renew ? {
            read: (machine, signal) => bridge.read(machine, signal),
            confirmIdle: (machine, signal) => bridge.confirmIdle(machine, signal),
            reopen: machine => bridge.reopen(machine),
            dispose: () => bridge.dispose?.() ?? Promise.resolve(),
            waitForChange: async signal => {
                try { return await bridge.waitForChange(signal); }
                catch (error) {
                    assertLive(signal);
                    if (!isUnavailableGuestActivity(error)) throw error;
                    return 'activity';
                }
            },
        } : bridge;
        return { ...prepared({ kind: 'retention', evidence: fresh.evidence }), bridge: observationBridge,
            ...(params.renew ? { onActivityChange: async () => { await waitUntilUnusedExpiry(); return true; } } : {}) };
    } catch (error) {
        await bridge.dispose?.();
        throw error;
    }
}

/** One live admitted Action, one exact retained native resource, no replay queue. */
export async function reconcileManagedIntent(params: ManagedMachineReconciliationInput): Promise<ManagedMachineV1> {
    let machine = params.machine;
    const { client, options } = params;
    let bridge = params.input.managedGuestActivity;
    let draining = false;
    let submitted = false;
    let releaseDrain = !machine.submittedNativeEffect;
    const admittedMachine = machine;
    let drainMachine = machine;
    const publishSettledNativeOperation = (before: ManagedMachineV1, after: ManagedMachineV1,
        outstanding: NonNullable<ManagedMachineV1['submittedNativeEffect']>) =>
        publishSettledManagedNativeOperation(options.context, before, after, outstanding);
    const reportIntent = async (report: unknown): Promise<ManagedMachineV1> => {
        try { return await client.row('report-intent', report, null); }
        catch (error) {
            const outstanding = machine.submittedNativeEffect;
            if (outstanding?.intent !== 'delete' || !isUncertainManagedControllerRequest(error)) throw error;
            // A lost settlement reply can leave Home absent with no intent to
            // inspect later. Recover that fact once, without replaying native IO
            // or the report; Home still owns exact-request correlation.
            let current: ManagedMachineV1;
            try {
                current = await client.row('current', { homeId: machine.homeId, managedId: machine.id,
                    expectedIntentRevision: outstanding.intentRevision, requestId: outstanding.requestId,
                    controller: outstanding.controller, nativeRole: 'inspect' }, null);
            } catch { throw error; }
            if (publishSettledNativeOperation(machine, current, outstanding) !== true) throw error;
            return current;
        }
    };
    try {
        client.assertConnection(machine);
        options.context?.operationOwnerUpdate?.update({ domainRef: { kind: 'managedMachine', id: machine.id,
            controller: machine.controller, ...(machine.resource ? { resource: machine.resource } : {}) } });
        if (params.action === 'machines.managed.delete' && machine.desired === 'delete'
            && machine.allocation === 'confirmed-absent') return machine;
        let effectContext = options.context;
        // Acquisition recovery and Remove use one native correlation reader.
        let nativeOwner: ReturnType<typeof createManagedNativeInvocation> | undefined;
        const native = () => nativeOwner ??= createManagedNativeInvocation({ ...params,
            options: { ...options, get context() { return effectContext; } } }, () => machine);
        // Home's Delete admission can replace the cleanup diagnostic without releasing native ownership.
        const canceledCleanup = params.action === 'machines.managed.delete'
            && machine.creationState === 'canceled' && machine.desired === 'delete' && machine.desiredWhen === 'now'
            && machine.archivedAt === undefined;
        if (params.action === 'machines.managed.delete' && machine.desired === 'delete' && machine.desiredWhen === 'now'
            && machine.allocation === 'may-exist' && !machine.resource
            && (!machine.nativeOperationRef || canceledCleanup)) {
            machine = await reconcileManagedAcquisitionIdentity(params, machine, native());
            if (machine.allocation === 'confirmed-absent') return machine;
        }
        const pendingCleanup = machine.allocation === 'may-exist' && !machine.resource && Boolean(machine.nativeOperationRef)
            && (machine.desired === 'delete' || params.action === 'machines.managed.inspect' && machine.submittedNativeEffect?.intent === 'delete');
        if ((params.action !== 'machines.managed.inspect' && machine.creationState !== 'active' && !canceledCleanup)
            || (!pendingCleanup && (machine.allocation !== 'bound' || !machine.resource))) throw new ManagedMachineControllerError('native_resource_unavailable');
        if (pendingCleanup) {
            const retained = machine.nativeOperationRef!;
            if (!native().contribution.definition.reconciliation) throw new ManagedMachineControllerError('provider_unavailable');
            if (retained.contributionRef.pluginId !== machine.launch.provider.pluginId
                || retained.contributionRef.localId !== machine.launch.provider.localId
                || retained.schemaVersion !== machine.launch.schemaVersion) throw new ManagedMachineControllerError('resource_mismatch');
        }
        const reconcileOutstanding = async (outstanding: NonNullable<ManagedMachineV1['submittedNativeEffect']>) => {
            const correlation = { homeId: machine.homeId, managedId: machine.id,
                expectedIntentRevision: outstanding.intentRevision, requestId: outstanding.requestId, controller: outstanding.controller };
            // A bound resource's retained operation is deletion custody. An
            // unbound allocation still carries its acquisition/cleanup identity.
            if (params.action === 'machines.managed.delete' && outstanding.intent === 'delete' && machine.resource && machine.nativeOperationRef) {
                const result = MachineProvisionerDestroyResultV1Schema.parse(await native().invoke('destroy', {
                    nativeOperation: machine.nativeOperationRef.value,
                }));
                const reported = await reportIntent({ ...correlation, result,
                    ...(result.kind === 'confirmed' ? { observation: { observedAt: Date.now(), availability: 'absent' as const } } : {}),
                });
                assertManagedDeleteNativeResult(result);
                return { machine: reported, deleteResult: result };
            }
            if (outstanding.intent === 'delete' && !machine.resource && machine.nativeOperationRef
                && native().contribution.definition.reconciliation?.cleanup) {
                const observed = MachineProvisionerCleanupObservationV1Schema.parse(await native().invoke('cleanup', {
                    nativeOperation: machine.nativeOperationRef.value,
                }));
                let result: ReturnType<typeof MachineProvisionerDestroyResultV1Schema.parse> = observed.kind === 'confirmed'
                    ? { kind: 'confirmed' } : { kind: 'unknown', code: observed.kind === 'unknown' ? observed.code : 'native_cleanup_unconfirmed' };
                const continuesCleanup = observed.kind === 'retryable' && params.action === 'machines.managed.delete'
                    && outstanding.intentRevision === machine.intentRevision && machine.desired === 'delete';
                if (continuesCleanup) {
                    // The leaf qualified an exact idempotent continuation from
                    // fresh native facts. Reuse the original current submission;
                    // ordinary inspect and unqualified uncertainty never replay.
                    result = MachineProvisionerDestroyResultV1Schema.parse(await native().invoke('destroy', {
                        nativeOperation: machine.nativeOperationRef.value,
                    }));
                }
                if (observed.kind !== 'unknown') {
                    const reported = await reportIntent({ ...correlation, result,
                        ...(result.kind === 'confirmed' ? { observation: { observedAt: Date.now(), availability: 'absent' } } : {}),
                    });
                    if (continuesCleanup) assertManagedDeleteNativeResult(result);
                    return { machine: reported, deleteResult: continuesCleanup ? result : undefined };
                }
            }
            if (!machine.resource && machine.nativeOperationRef && native().contribution.definition.reconciliation) {
                machine = await reconcileManagedAcquisitionIdentity(params, machine, native());
                if (machine.allocation === 'confirmed-absent' && outstanding.intent === 'delete') {
                    return { machine: await reportIntent({ ...correlation,
                        result: { kind: 'confirmed' }, observation: machine.observation }), deleteResult: undefined };
                }
                if (!machine.resource) return { machine: await reportIntent({ ...correlation,
                    result: { kind: 'unknown', code: 'native_cleanup_unconfirmed' } }), deleteResult: undefined };
                if (params.action === 'machines.managed.inspect') {
                    return { machine: await reportIntent({ ...correlation,
                        result: { kind: 'unknown' }, observation: machine.observation }), deleteResult: undefined };
                }
            }
            return { machine: await reconcileManagedBoundNativeIntent({ machine, resource: machine.resource!, outstanding,
                provisioner: native().contribution.definition, home: {
                    row: async (_path, body) => await reportIntent(body),
                }, invoke: native().invoke }), deleteResult: undefined };
        };
        const observeDelete = () => observeAcceptedManagedDelete(params, machine, async (current, outstanding) => {
            machine = current;
            const observed = (await reconcileOutstanding(outstanding)).machine;
            publishSettledNativeOperation(current, observed, outstanding);
            return observed;
        });
        const settleDeleteObservation = async (result: ReturnType<typeof MachineProvisionerDestroyResultV1Schema.parse>) => {
            if (machine.submittedNativeEffect) assertManagedDeleteNativeResult(result);
            if (canObserveAcceptedManagedDelete(machine, result)) machine = await observeDelete();
        };
        if (params.action === 'machines.managed.inspect') {
            const outstanding = machine.submittedNativeEffect;
            if (!outstanding) return machine;
            const observed = (await reconcileOutstanding(outstanding)).machine;
            publishSettledNativeOperation(machine, observed, outstanding);
            return observed;
        }
        const localEffect = !machine.controller && options.policyPurpose?.kind === 'retention' && machine.desired === 'stop'
            && machine.enrolledMachineId === params.input.controller.machineId
            ? machine.reviewedFacts?.retentionCapabilities.guestLocalStop : undefined;
        const localStop = localEffect ? await params.input.managedGuestLocalStop?.prepare(localEffect, options.signal) : null;
        if (!localStop && !native().contribution.definition.retention.supportedIntents.includes(machine.desired)) {
            throw new ManagedMachineControllerError('native_intent_unsupported');
        }
        if (machine.desired === 'rebuild' && (!params.rebuild || params.rebuild.managedMachineId !== machine.id
            || !native().contribution.definition.actions.rebuild)) {
            throw new ManagedMachineControllerError('admission_unavailable');
        }
        const unusedPolicy = options.policyPurpose?.kind === 'retention' && machine.retention.kind === 'unused';
        const needsIdle = machine.desiredWhen === 'after-idle' || unusedPolicy;
        const idleDuration = unusedPolicy && machine.retention.kind === 'unused'
            ? machine.retention.afterMs : machine.desiredAfterMs ?? 0;
        for (;;) {
            if (needsIdle && !machine.submittedNativeEffect) {
                if (!machine.enrolledMachineId || !['stop', 'suspend', 'delete'].includes(machine.desired)) {
                    throw new ManagedMachineControllerError('admission_unavailable');
                }
                options.context?.operationOwnerUpdate?.update({ progress: {
                    phase: 'managed.intent.waiting-idle', label: 'Waiting for unused machine',
                } });
                bridge ??= createManagedGuestActivityTransport(params.input, options, machine);
                await waitForIdle({ machine, bridge, duration: idleDuration, signal: options.signal,
                    isCurrent: async () => await client.readCurrent(machine) !== null,
                    onActivity: kind => publishActivity(options, machine, kind) });
            }
            let waitingForGuestWork = false;
            const runApproved = async (context?: ActionExecutorContext): Promise<ManagedMachineV1> => {
                if (context) {
                    if (context.operationAcceptance?.operationId !== options.context?.operationAcceptance?.operationId
                        || context.signal !== options.signal || context.operationOwnerUpdate !== options.context?.operationOwnerUpdate) {
                        throw new ManagedMachineControllerError('admission_unavailable');
                    }
                    effectContext = context;
                }
                assertLive(options.signal);
                const submission = machine.desired === 'rebuild' ? await client.submitIntent(machine)
                    : await client.post(
                        '/v1/machines/managed/controller/submit-intent', client.correlation(machine),
                        ManagedControllerSubmitOutputV1Schema);
                machine = submission.machine;
                client.assertConnection(machine);
                const outstanding = machine.submittedNativeEffect;
                const correlation = outstanding ? {
                    homeId: machine.homeId, managedId: machine.id, expectedIntentRevision: outstanding.intentRevision,
                    requestId: outstanding.requestId, controller: outstanding.controller,
                } : client.correlation(admittedMachine);
                if (!submission.submitted) {
                    // Home retains settlement on this exact rebuild admission;
                    // retrying it cannot replace the already bound child again.
                    if (!outstanding && params.action === 'machines.managed.rebuild' && machine.desired === 'rebuild'
                        && machine.intentRevision === admittedMachine.intentRevision) return machine;
                    // Recovery observes the same native identity; an unknown delivery
                    // is not permission to issue the power/destroy role again.
                    if (outstanding) {
                        const before = machine;
                        const observed = await reconcileOutstanding(outstanding);
                        machine = observed.machine;
                        publishSettledNativeOperation(before, machine, outstanding);
                        if (admittedMachine.desired === 'delete' && observed.deleteResult) await settleDeleteObservation(observed.deleteResult);
                        if (!machine.submittedNativeEffect && outstanding.intentRevision !== admittedMachine.intentRevision) {
                            if (admittedMachine.desired === 'delete' && machine.allocation === 'confirmed-absent'
                                && machine.observation?.availability === 'absent' && machine.id === admittedMachine.id
                                && machine.homeId === admittedMachine.homeId && machine.intentRevision === admittedMachine.intentRevision
                                && isDeepStrictEqual(machine.controller, admittedMachine.controller)
                                && isDeepStrictEqual(machine.resource, admittedMachine.resource)) return machine;
                            if (!await client.readCurrent(admittedMachine)) throw new ManagedMachineControllerError('intent_changed');
                            // Only the still-live new intent re-enters normal fresh
                            // admission. The old native effect is never resubmitted.
                            const retried = await reconcileManagedIntent({ ...params, machine });
                            // The fresh retry can prove the earlier Delete's
                            // outcome too, but present-state retirement cannot.
                            publishSettledNativeOperation(before, retried, outstanding);
                            return retried;
                        }
                    }
                    if (!outstanding || machine.submittedNativeEffect) throw new ManagedMachineControllerError('native_intent_unconfirmed');
                    return machine;
                }
                submitted = true;
                try {
                    assertLive(options.signal);
                } catch (error) {
                    await reportIntent({ ...correlation, result: { kind: 'refused', code: options.signal?.aborted ? 'cancelled' : 'intent_changed' } });
                    throw error;
                }
                let result: ReturnType<typeof MachineProvisionerPowerResultV1Schema.parse>
                    | ReturnType<typeof MachineProvisionerDestroyResultV1Schema.parse>
                    | ReturnType<typeof MachineProvisionerRebuildResultV1Schema.parse>;
                let powerObservation: ProviderObservationV1 | undefined;
                let guestStartupError: ManagedMachineControllerError | undefined;
                try {
                    options.context?.operationOwnerUpdate?.update({ progress: {
                        phase: 'managed.intent.native-effect', label: 'Applying native machine intent',
                    } });
                    // Once native IO may have been issued, reopening guest admission
                    // could let new work race a delayed Stop/Delete. Only definite
                    // refusal releases this cause; observed power is separate truth.
                    releaseDrain = false;
                    const idleBridge = bridge;
                    const invocationOptions = needsIdle && idleBridge ? { beforeNativeEffect: async () => {
                        // The incumbent private custody calls this again at
                        // beforeHandlerInvocation, after its async credentials
                        // and currentness reads. Our passive preparation must
                        // not count itself as colocated guest material.
                        options.context?.operationOwnerUpdate?.update({ progress: {
                            phase: 'managed.intent.waiting-idle', label: 'Waiting for unused machine',
                        } });
                        try {
                            assertLive(options.signal);
                            draining = true;
                            drainMachine = machine;
                            const fresh = await idleBridge.confirmIdle(machine, options.signal);
                            if (fresh.kind === 'refused') throw new ManagedMachineControllerError(fresh.code);
                            publishActivity(options, machine, fresh.kind);
                            if (fresh.kind !== 'idle' || remainingIdleDuration(fresh, idleDuration) > 0) {
                                throw new ManagedMachineControllerError('activity_changed');
                            }
                            assertLive(options.signal);
                        } catch (error) {
                            throw new ManagedMachineNativeEffectGuardRefusal(options.signal?.aborted ? 'cancelled'
                                : error instanceof ManagedMachineControllerError ? error.code : 'admission_unavailable');
                        }
                        options.context?.operationOwnerUpdate?.update({ progress: {
                            phase: 'managed.intent.native-effect', label: 'Applying native machine intent',
                        } });
                    } } : undefined;
                    if (localStop) {
                        await invocationOptions?.beforeNativeEffect();
                        await localStop();
                        // Shutdown cannot confirm its final native state. Keep
                        // the dated observation until the next demanded Inspect.
                        return machine;
                    }
                    if (machine.desired === 'rebuild') {
                        result = MachineProvisionerRebuildResultV1Schema.parse(await native().invoke('rebuild', {
                            resource: machine.resource!.value, reviewedEffectDigest: params.rebuild!.reviewedEffectDigest,
                        }));
                    } else if (machine.desired === 'delete') {
                        const deletion = await executeManagedMachineDeleteIntent({ machine, invoke: native().invoke,
                            io: { ...invocationOptions, signal: options.signal } });
                        result = deletion.result;
                        powerObservation = deletion.observation;
                    } else {
                        const power = await executeManagedMachinePowerIntent({ machine, invoke: native().invoke,
                            guestStartup: { transport: native().contribution.definition.bootstrapTransport,
                                channel: resolveManagedCliReleaseChannelSync({ argv: process.argv, invokedPath: process.argv[1], processEnv: process.env }).label },
                            waitForObservation: createManagedNativeObservationWait(options.signal),
                            io: { ...invocationOptions, signal: options.signal } });
                        result = power.result;
                        powerObservation = power.observation;
                        guestStartupError = power.guestStartupError;
                    }
                } catch (error) {
                    if (error instanceof ManagedMachineNativeEffectGuardRefusal) {
                        // The actual private pre-handler refused before native IO.
                        // Clear only this unused submission and keep the same
                        // accepted operation waiting when new guest work won.
                        try {
                            machine = await reportIntent({ ...correlation, result: { kind: 'refused', code: error.code } });
                        } catch (reportError) {
                            logger.warn('[MANAGED MACHINE] Native outcome report failed', projectActionFailureCauseV1(reportError, params.action));
                            throw error;
                        }
                        submitted = false;
                        releaseDrain = true;
                        if (error.code === 'activity_changed' && bridge) {
                            await bridge.reopen(drainMachine);
                            draining = false;
                            waitingForGuestWork = true;
                            throw error;
                        }
                        throw error;
                    }
                    try {
                        await reportIntent({ ...correlation, result: { kind: 'unknown', code: 'native_intent_unconfirmed' } });
                    } catch (reportError) {
                        logger.warn('[MANAGED MACHINE] Native outcome report failed', projectActionFailureCauseV1(reportError, params.action));
                    }
                    throw error;
                }
                if (result.kind === 'refused') releaseDrain = true;
                const observation = powerObservation;
                const before = machine;
                machine = result.kind === 'bound' ? await client.reportIssuedRebuildBound(machine, result)
                    : await reportIntent({ ...correlation, result, ...(observation ? { observation } : {}) });
                const settled = outstanding ? publishSettledNativeOperation(before, machine, outstanding) : undefined;
                if (guestStartupError) throw guestStartupError;
                if (result.kind === 'refused') throw new ManagedMachineNativeRefusal(result.code, undefined,
                    result.nativeCause ? { kind: 'managedNative', nativeCause: result.nativeCause } : undefined);
                if (before.desired !== 'delete' && before.desired !== 'rebuild' && settled !== undefined) {
                    if (!settled) throw new ManagedMachineNativeRefusal('native_intent_unconfirmed');
                    return machine;
                }
                if (result.kind === 'bound') {
                    // Persist replacement identity before ordinary fresh enrollment.
                    // Cancellation or newer intent can stop bootstrap, not erase it.
                    assertLive(options.signal);
                    if (!await client.isCurrent(machine)) throw new ManagedMachineControllerError('intent_changed');
                    await reconcileManagedMachine({ ...params, machine });
                    return await client.row('current', client.correlation(machine));
                }
                if (before.desired === 'delete') await settleDeleteObservation(result);
                if (result.kind !== 'confirmed' && !(before.desired === 'delete' && machine.allocation === 'confirmed-absent'
                    && machine.observation?.availability === 'absent' && !machine.submittedNativeEffect)) throw new ManagedMachineControllerError('native_intent_unconfirmed', undefined,
                    'nativeCause' in result && result.nativeCause ? { kind: 'managedNative', nativeCause: result.nativeCause } : undefined);
                return machine;
            };
            try {
                return await (options.runPolicyAction ? options.runPolicyAction(machine, runApproved) : runApproved());
            } catch (error) {
                if (waitingForGuestWork) continue;
                throw error;
            }
        }
    } finally {
        // The exact guest bridge releases only unused-stop, never user refusal,
        // handoff or shutdown. A submitted effect also retains its native fact.
        try {
            if (draining && releaseDrain) {
                try { await bridge?.reopen(drainMachine); }
                catch (error) { if (!submitted) throw error; }
            }
        } finally { await bridge?.dispose?.(); }
    }
}
