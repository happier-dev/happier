import { AcquireResultV1Schema, ProviderObservationV1Schema, type ProviderObservationV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { ManagedControllerSubmitOutputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MachineProvisionerPowerResultV1Schema, MachineProvisionerRebuildResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { ManagedActivityBridgeResultV1 } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ManagedPolicyPurposeV1 } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { isDeepStrictEqual } from 'node:util';
import { ManagedMachineControllerError, ManagedMachineNativeRefusal, ManagedMachineNativeEffectGuardRefusal } from './acquire';
import { createManagedNativeInvocation, reconcileManagedMachine, type ManagedMachineReconciliationInput } from './reconcile';
import { createManagedGuestActivityTransport } from './managedActivityTransport';

/** Network observations only; the native intent decision remains in this owner. */
export type ManagedGuestActivityTransport = Readonly<{
    read(machine: ManagedMachineV1, signal?: AbortSignal): Promise<ManagedActivityBridgeResultV1>;
    confirmIdle(machine: ManagedMachineV1, signal?: AbortSignal): Promise<ManagedActivityBridgeResultV1>;
    reopen(machine: ManagedMachineV1): Promise<unknown>;
    waitForChange(signal?: AbortSignal): Promise<void>;
    dispose?(): Promise<void>;
}>;

function assertLive(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ManagedMachineControllerError('cancelled');
}

async function waitForActivity(bridge: ManagedGuestActivityTransport, signal?: AbortSignal, remaining?: number): Promise<void> {
    assertLive(signal);
    const waiting = new AbortController();
    const cancel = () => waiting.abort(signal?.reason);
    signal?.addEventListener('abort', cancel, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        // Node timers have a signed 32-bit millisecond boundary. A longer
        // selected interval is rechecked, never shortened into an effect.
        const deadline = remaining === undefined ? new Promise<never>(() => {}) : new Promise<void>(resolve => {
            timer = setTimeout(resolve, Math.min(remaining, 2_147_483_647));
        });
        await Promise.race([bridge.waitForChange(waiting.signal), deadline]);
        assertLive(signal);
    } catch (error) {
        assertLive(signal);
        throw error;
    } finally {
        if (timer !== undefined) clearTimeout(timer);
        waiting.abort();
        signal?.removeEventListener('abort', cancel);
    }
}

function remainingIdleDuration(activity: Extract<ManagedActivityBridgeResultV1, { kind: 'idle' }>, duration: number): number {
    if (!('evidence' in activity) && duration > 0) throw new ManagedMachineControllerError('admission_unavailable');
    const elapsed = 'evidence' in activity ? activity.evidence.decision.confirmedAt - activity.evidence.decision.since : 0;
    return Math.max(0, duration - elapsed);
}

async function waitForIdle(params: Readonly<{
    machine: ManagedMachineV1; bridge: ManagedGuestActivityTransport; duration: number; signal?: AbortSignal;
    isCurrent(): Promise<boolean>; onDrain(active: boolean): void;
}>) {
    for (;;) {
        assertLive(params.signal);
        if (!await params.isCurrent()) throw new ManagedMachineControllerError('intent_changed');
        const activity = await params.bridge.read(params.machine, params.signal);
        if (activity.kind === 'refused') throw new ManagedMachineControllerError(activity.code);
        let remaining: number | undefined;
        if (activity.kind === 'idle') {
            params.onDrain(true);
            const fresh = await params.bridge.confirmIdle(params.machine, params.signal);
            if (fresh.kind === 'refused') throw new ManagedMachineControllerError(fresh.code);
            if (fresh.kind === 'idle') {
                // Both timestamps belong to the actual guest clock. A read
                // followed by a short committed probe must not mix that clock
                // with this controller's Date.now or hold drain for the wait.
                remaining = remainingIdleDuration(fresh, params.duration);
                if (remaining === 0) return fresh;
            }
            await params.bridge.reopen(params.machine);
            params.onDrain(false);
        }
        await waitForActivity(params.bridge, params.signal, remaining);
    }
}

/** Policy preparation shares the same selected timer, actual guest inventory and drain owner. */
export async function prepareManagedRetentionPolicy(params: Readonly<{
    input: ManagedMachineReconciliationInput['input']; options: ManagedMachineReconciliationInput['options'];
    machine: ManagedMachineV1; purpose: Extract<ManagedPolicyPurposeV1, { kind: 'retention' }>;
}>): Promise<{ purpose: ManagedPolicyPurposeV1; bridge?: ManagedGuestActivityTransport; draining: boolean }> {
    const { machine, input, options, purpose } = params;
    if (machine.retention.kind === 'until-delete') throw new ManagedMachineControllerError('intent_changed');
    if (purpose.evidence || machine.submittedNativeEffect) return { purpose, draining: Boolean(purpose.evidence) };
    const bridge = input.managedGuestActivity ?? createManagedGuestActivityTransport(input, options, machine);
    let draining = false;
    const isCurrent = async () => {
        if (!input.readPolicyCurrent) throw new ManagedMachineControllerError('admission_unavailable');
        const current = await input.readPolicyCurrent(machine.id, options.signal);
        const verified = Boolean(current && current.homeId === machine.homeId && current.intentRevision === machine.intentRevision
            && isDeepStrictEqual(current.controller, machine.controller) && isDeepStrictEqual(current.resource, machine.resource)
            && isDeepStrictEqual(current.retention, machine.retention) && current.creationState === 'active');
        if (verified && current) options.context?.operationOwnerUpdate?.update({ domainRef: { kind: 'managedMachine', id: current.id } });
        return verified;
    };
    try {
        if (machine.retention.kind === 'deadline') {
            options.context?.operationOwnerUpdate?.update({ progress: { phase: 'managed.intent.waiting-deadline', label: 'Waiting for selected deadline' } });
            for (;;) {
                assertLive(options.signal);
                if (!await isCurrent()) throw new ManagedMachineControllerError('intent_changed');
                const remaining = machine.retention.at - Date.now();
                if (remaining <= 0) return { purpose, bridge, draining };
                await waitForActivity(bridge, options.signal, remaining);
            }
        }
        if (!machine.enrolledMachineId) throw new ManagedMachineControllerError('admission_unavailable');
        options.context?.operationOwnerUpdate?.update({ progress: { phase: 'managed.intent.waiting-idle', label: 'Waiting for unused machine' } });
        const fresh = await waitForIdle({ machine, bridge, duration: machine.retention.afterMs, signal: options.signal,
            isCurrent, onDrain: active => { draining = active; } });
        if (!('evidence' in fresh)) throw new ManagedMachineControllerError('admission_unavailable');
        return { purpose: { kind: 'retention', evidence: fresh.evidence }, bridge, draining };
    } catch (error) {
        if (draining) await bridge.reopen(machine);
        await bridge.dispose?.();
        throw error;
    }
}

/** One live admitted Action, one exact retained native resource, no replay queue. */
export async function reconcileManagedIntent(params: ManagedMachineReconciliationInput): Promise<ManagedMachineV1> {
    let machine = params.machine;
    const { client, options } = params;
    let bridge = params.input.managedGuestActivity;
    let draining = options.policyPurpose?.kind === 'retention' && Boolean(options.policyPurpose.evidence);
    let submitted = false;
    let releaseDrain = !machine.submittedNativeEffect;
    const admittedMachine = machine;
    let drainMachine = options.policyPurpose?.kind === 'retention' && options.policyPurpose.evidence
        ? { ...machine, intentRevision: options.policyPurpose.evidence.managedTarget.expectedRevision } : machine;
    try {
        if (draining && !bridge) bridge = createManagedGuestActivityTransport(params.input, options, machine);
        client.assertConnection(machine);
        const canceledCleanup = params.action === 'machines.managed.delete' && options.policyPurpose?.kind === 'creation-cleanup'
            && machine.creationState === 'canceled' && machine.desired === 'delete' && machine.desiredWhen === 'now' && machine.archivedAt === undefined;
        const pendingCleanup = machine.allocation === 'may-exist' && !machine.resource && Boolean(machine.nativeOperationRef)
            && (machine.desired === 'delete' || params.action === 'machines.managed.inspect' && machine.submittedNativeEffect?.intent === 'delete');
        if ((params.action !== 'machines.managed.inspect' && machine.creationState !== 'active' && !canceledCleanup)
            || (!pendingCleanup && (machine.allocation !== 'bound' || !machine.resource))) throw new ManagedMachineControllerError('native_resource_unavailable');
        let effectContext = options.context;
        // Keep the same captured native occurrence while the installed Action
        // owner decorates only this live operation's acceptance/context.
        const native = createManagedNativeInvocation({ ...params, options: { ...options, get context() { return effectContext; } } }, () => machine);
        if (pendingCleanup) {
            const retained = machine.nativeOperationRef!;
            if (!native.contribution.definition.reconciliation) throw new ManagedMachineControllerError('provider_unavailable');
            if (retained.contributionRef.pluginId !== machine.launch.provider.pluginId
                || retained.contributionRef.localId !== machine.launch.provider.localId
                || retained.schemaVersion !== machine.launch.schemaVersion) throw new ManagedMachineControllerError('resource_mismatch');
        }
        const reconcileOutstanding = async (outstanding: NonNullable<ManagedMachineV1['submittedNativeEffect']>) => {
            const correlation = { homeId: machine.homeId, managedId: machine.id,
                expectedIntentRevision: outstanding.intentRevision, requestId: outstanding.requestId, controller: outstanding.controller };
            if (!machine.resource && machine.nativeOperationRef && native.contribution.definition.reconciliation) {
                const recovered = AcquireResultV1Schema.parse(await native.invoke('reconcile', { nativeOperation: machine.nativeOperationRef.value }));
                if (recovered.kind === 'bound' || recovered.kind === 'pending') {
                    machine = await client.row('report', { ...client.correlation(machine), result: recovered }, null);
                }
                if (!machine.resource) return await client.row('report-intent', { ...correlation,
                    result: { kind: 'unknown', code: 'native_cleanup_unconfirmed' } }, null);
            }
            if (outstanding.intent === 'rebuild' && native.contribution.definition.reconciliation) {
                const value = machine.resource!.value;
                // Retain the admitted rebuild's review even if a newer policy
                // changed current admission while native delivery was unknown.
                const nativeOperation = outstanding.reviewedEffectDigest && value !== null && typeof value === 'object' && !Array.isArray(value)
                    ? { ...value, reviewedEffectDigest: outstanding.reviewedEffectDigest } : value;
                const recovered = AcquireResultV1Schema.parse(await native.invoke('reconcile', { nativeOperation }));
                const result = recovered.kind === 'bound' ? recovered : recovered.kind === 'unknown' ? recovered
                    : { kind: 'unknown' as const, recovery: { reference: machine.recovery?.reference ?? outstanding.requestId,
                        reason: recovered.kind === 'rejected' ? recovered.code : 'native_rebuild_unknown' } };
                return await client.row('report-intent', { ...correlation, result }, null);
            }
            const observation = ProviderObservationV1Schema.parse(await native.invoke('inspect', { resource: machine.resource!.value }));
            return await client.row('report-intent', { ...correlation, result: { kind: 'unknown' }, observation }, null);
        };
        if (params.action === 'machines.managed.inspect') {
            const outstanding = machine.submittedNativeEffect;
            if (!outstanding) return machine;
            return await reconcileOutstanding(outstanding);
        }
        if (!native.contribution.definition.retention.supportedIntents.includes(machine.desired)) {
            throw new ManagedMachineControllerError('native_intent_unsupported');
        }
        if (machine.desired === 'rebuild' && (!params.rebuild || params.rebuild.managedMachineId !== machine.id
            || !native.contribution.definition.actions.rebuild)) {
            throw new ManagedMachineControllerError('admission_unavailable');
        }
        const unusedPolicy = options.policyPurpose?.kind === 'retention' && machine.retention.kind === 'unused';
        const needsIdle = machine.desiredWhen === 'after-idle' || unusedPolicy;
        const idleDuration = unusedPolicy && machine.retention.kind === 'unused'
            ? machine.retention.afterMs : machine.desiredAfterMs ?? 0;
        for (;;) {
            if (needsIdle && !machine.submittedNativeEffect) {
                if (!machine.enrolledMachineId || !['stop', 'delete'].includes(machine.desired)) {
                    throw new ManagedMachineControllerError('admission_unavailable');
                }
                options.context?.operationOwnerUpdate?.update({ progress: {
                    phase: 'managed.intent.waiting-idle', label: 'Waiting for unused machine',
                } });
                bridge ??= createManagedGuestActivityTransport(params.input, options, machine);
                await waitForIdle({ machine, bridge, duration: idleDuration, signal: options.signal,
                    isCurrent: () => client.isCurrent(machine), onDrain: active => { draining = active; drainMachine = machine; } });
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
                if (!await client.isCurrent(machine)) throw new ManagedMachineControllerError('intent_changed');
                const submission = machine.desired === 'rebuild' ? await client.submitIntent(machine)
                    : ManagedControllerSubmitOutputV1Schema.parse(await client.post(
                        '/v1/machines/managed/controller/submit-intent', client.correlation(machine),
                    ));
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
                        machine = await reconcileOutstanding(outstanding);
                        if (!machine.submittedNativeEffect && outstanding.intentRevision !== admittedMachine.intentRevision) {
                            if (!await client.isCurrent(admittedMachine)) throw new ManagedMachineControllerError('intent_changed');
                            // Only the still-live new intent re-enters normal fresh
                            // admission. The old native effect is never resubmitted.
                            return await reconcileManagedIntent({ ...params, machine });
                        }
                    }
                    if (!outstanding || machine.submittedNativeEffect) throw new ManagedMachineControllerError('native_intent_unconfirmed');
                    return machine;
                }
                submitted = true;
                try {
                    assertLive(options.signal);
                    if (!await client.isCurrent(admittedMachine)) throw new ManagedMachineControllerError('intent_changed');
                } catch (error) {
                    await client.row('report-intent', { ...correlation, result: { kind: 'refused', code: options.signal?.aborted ? 'cancelled' : 'intent_changed' } }, null);
                    throw error;
                }
                let result: ReturnType<typeof MachineProvisionerPowerResultV1Schema.parse> | ReturnType<typeof MachineProvisionerRebuildResultV1Schema.parse>;
                try {
                    options.context?.operationOwnerUpdate?.update({ progress: {
                        phase: 'managed.intent.native-effect', label: 'Applying native machine intent',
                    } });
                    // Once native IO may have been issued, reopening guest admission
                    // could let new work race a delayed Stop/Delete. Only definite
                    // refusal releases this cause; observed power is separate truth.
                    releaseDrain = false;
                    result = machine.desired === 'rebuild'
                        ? MachineProvisionerRebuildResultV1Schema.parse(await native.invoke('rebuild', {
                            resource: machine.resource!.value, reviewedEffectDigest: params.rebuild!.reviewedEffectDigest,
                        })) : MachineProvisionerPowerResultV1Schema.parse(await native.invoke(
                        machine.desired === 'delete' ? 'destroy' : 'power',
                        machine.resource ? { resource: machine.resource.value, ...(machine.desired === 'delete' ? {} : { intent: machine.desired }) }
                            : { nativeOperation: machine.nativeOperationRef!.value },
                        needsIdle && bridge ? { beforeNativeEffect: async () => {
                            // The incumbent private custody calls this again at
                            // beforeHandlerInvocation, after its async credentials
                            // and currentness reads. Our passive preparation must
                            // not count itself as colocated guest material.
                            options.context?.operationOwnerUpdate?.update({ progress: {
                                phase: 'managed.intent.waiting-idle', label: 'Waiting for unused machine',
                            } });
                            try {
                                assertLive(options.signal);
                                const fresh = await bridge!.confirmIdle(machine, options.signal);
                                if (fresh.kind === 'refused') throw new ManagedMachineControllerError(fresh.code);
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
                        } } : undefined,
                    ));
                } catch (error) {
                    if (error instanceof ManagedMachineNativeEffectGuardRefusal) {
                        // The actual private pre-handler refused before native IO.
                        // Clear only this unused submission and keep the same
                        // accepted operation waiting when new guest work won.
                        machine = await client.row('report-intent', { ...correlation, result: { kind: 'refused', code: error.code } }, null);
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
                    await client.row('report-intent', { ...correlation, result: { kind: 'unknown', code: 'native_intent_unconfirmed' } }, null);
                    throw error;
                }
                if (result.kind === 'refused') releaseDrain = true;
                let observation: ProviderObservationV1 | undefined;
                if (!options.signal?.aborted && result.kind !== 'refused' && machine.desired !== 'rebuild') {
                    if (!machine.resource && result.kind === 'confirmed') {
                        // Pending destroy confirms complete observed cleanup of
                        // the exact owned attachments, not command acceptance.
                        observation = ProviderObservationV1Schema.parse({ observedAt: Date.now(), availability: 'absent' });
                    } else if (machine.resource) {
                        try { observation = ProviderObservationV1Schema.parse(await native.invoke('inspect', { resource: machine.resource.value })); }
                        catch { /* Command acceptance is still not an observed power/absence fact. */ }
                    }
                }
                machine = result.kind === 'bound' ? await client.reportIssuedRebuildBound(machine, result)
                    : await client.row('report-intent', { ...correlation, result, ...(observation ? { observation } : {}) }, null);
                if (result.kind === 'refused') throw new ManagedMachineNativeRefusal(result.code);
                if (result.kind === 'bound') {
                    // Persist replacement identity before ordinary fresh enrollment.
                    // Cancellation or newer intent can stop bootstrap, not erase it.
                    assertLive(options.signal);
                    if (!await client.isCurrent(machine)) throw new ManagedMachineControllerError('intent_changed');
                    await reconcileManagedMachine({ ...params, machine });
                    return await client.row('current', client.correlation(machine));
                }
                if (result.kind !== 'confirmed') throw new ManagedMachineControllerError('native_intent_unconfirmed');
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
        if (draining && releaseDrain) {
            try { await bridge?.reopen(drainMachine); }
            catch (error) { if (!submitted) throw error; }
        }
        await bridge?.dispose?.();
    }
}
