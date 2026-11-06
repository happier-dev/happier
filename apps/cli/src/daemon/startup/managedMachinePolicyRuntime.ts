import axios from 'axios';
import { isDeepStrictEqual } from 'node:util';
import type { ApiMachineClient } from '@/api/apiMachine';
import type { Machine } from '@/api/types';
import type { ManagedControllerV1, ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedMachineControllerError } from '@/machines/managed/controllerErrors';
import { hasSubmittedManagedRetentionEffect } from '@/machines/managed/managedRetentionPolicy';
import { logger } from '@/ui/logger';
import { MANAGED_MACHINE_POLICY_RETENTION_SATISFIED_ABORT,
    type createDaemonManagedMachineActionAdapter } from './managedMachineActionAdapter';
import { createManagedPolicyCensusProofV1, ManagedPolicyCensusInputV1Schema, ManagedPolicyCensusOutputV1Schema,
    type ManagedPolicyPurposeV1 } from '@happier-dev/protocol/machines/managed/managedPolicyV1';

export type ManagedMachinePolicyCensus = ReturnType<typeof ManagedPolicyCensusOutputV1Schema.parse>;

type PolicySchedulingFacts = Pick<ManagedMachineV1,
    'controller' | 'resource' | 'nativeOperationRef' | 'enrolledMachineId' | 'retention' | 'wakeOnAcceptedMessage'> & Readonly<{
    purpose: ManagedPolicyPurposeV1['kind'];
    origin?: Extract<ManagedPolicyPurposeV1, { kind: 'accepted-input-start' }>['target']['origin'];
}>;

export async function readManagedMachinePolicyCensus(input: Readonly<{
    homeId: string; controller: ManagedControllerV1; custodianAccountId: string;
    privateKey: string | Uint8Array; token: string; serverUrl: string; signal?: AbortSignal;
    nativeCredentialManagedId?: string;
}>): Promise<ManagedMachinePolicyCensus> {
    input.signal?.throwIfAborted();
    const body = ManagedPolicyCensusInputV1Schema.parse({ homeId: input.homeId, controller: input.controller,
        proof: createManagedPolicyCensusProofV1(input),
        ...(input.nativeCredentialManagedId ? { managedId: input.nativeCredentialManagedId, includeNativeCredentialBindings: true } : {}) });
    const response = await axios.post<unknown>(`${input.serverUrl}/v1/machines/managed/controller/policies`, body,
        { headers: { Authorization: `Bearer ${input.token}`, 'Content-Type': 'application/json' },
            validateStatus: () => true, ...(input.signal ? { signal: input.signal } : {}) });
    input.signal?.throwIfAborted();
    if (response.status < 200 || response.status >= 300) throw new ManagedMachineControllerError('admission_unavailable');
    const census = ManagedPolicyCensusOutputV1Schema.parse(response.data);
    if ([...census.machines, ...census.targets].some(item => item.homeId !== body.homeId
        || item.controller && (item.controller.machineId !== body.controller.machineId
            || item.controller.installationId !== body.controller.installationId))) {
        throw new ManagedMachineControllerError('controller_unavailable');
    }
    return census;
}

/** Scheduling only: the existing native driver owns policy admission, approval and selected waits. */
export function createDaemonManagedMachinePolicyRuntime(params: Readonly<{
    apiMachine?: Pick<ApiMachineClient, 'onUpdate' | 'onConnectionStateChange' | 'onManagedMachinePolicyInvalidated'>;
    executorMachineId?: string;
    /** Local controller prerequisites only; census and native admission still decide authority. */
    isAvailable?: () => boolean;
    /** The incumbent authenticated Machine reader opens published registration readiness. */
    loadMachine?: (machineId: string, signal: AbortSignal) => Promise<Machine | null>;
    readCensus(signal: AbortSignal): Promise<ManagedMachinePolicyCensus>;
    executePolicy: ReturnType<typeof createDaemonManagedMachineActionAdapter>['executePolicy'];
    reconcileNativeCredentials?: (machine: ManagedMachineV1, signal: AbortSignal) => Promise<void>;
    onSettled?: () => void;
    onUnavailable?: (error: unknown) => void;
}>) {
    const lifetime = new AbortController();
    // These are actual outstanding driver lifetimes, not a copied activity or intent store.
    const active = new Map<string, { signature: PolicySchedulingFacts; cancel: AbortController; task: Promise<void> }>();
    let stopped = false;
    let changed = false;
    let schedulingRequested = false;
    let nativeInvalidations: Set<string> | null = new Set();
    let enrolledMachineIds = new Set<string>();
    let pump: Promise<void> | null = null;
    const abortPolicy = (managedId: string, cancel: AbortController, reasonCode:
        'retention_satisfied' | 'policy_replaced' | 'policy_target_missing' | 'controller_unavailable'
        | 'policy_runtime_stopped', reason?: unknown) => {
        if (cancel.signal.aborted) return;
        try { logger.warnLocalFile('[managed-policy.abort]', { managedId, reasonCode }); } catch { /* Diagnostic only. */ }
        cancel.abort(reasonCode === 'retention_satisfied' ? MANAGED_MACHINE_POLICY_RETENTION_SATISFIED_ABORT : reason);
    };
    const reconcile = async (census: ManagedMachinePolicyCensus, scheduleNew: boolean, nativeManagedIds: ReadonlySet<string> | null) => {
        const retentionContinuations = new Map(census.retentionContinuations?.map(item => [item.managedId, item.requestId]));
        enrolledMachineIds = new Set(census.machines.flatMap(machine => machine.enrolledMachineId ? [machine.enrolledMachineId] : []));
        const current = new Set<string>();
        for (const machine of census.machines) {
            const canceledCleanup = machine.creationState === 'canceled' && machine.desired === 'delete' && machine.desiredWhen === 'now';
            if (machine.archivedAt !== undefined || !(machine.allocation === 'bound' && machine.resource
                || canceledCleanup && machine.allocation === 'may-exist' && machine.nativeOperationRef)) continue;
            if (machine.creationState !== 'active' && !canceledCleanup) continue;
            if (scheduleNew && machine.creationState === 'active' && machine.resource
                && (nativeManagedIds === null || nativeManagedIds.has(machine.id))) {
                try {
                    await params.reconcileNativeCredentials?.(machine, lifetime.signal);
                } catch (error) {
                    lifetime.signal.throwIfAborted();
                    params.onUnavailable?.(error);
                }
            }
            const target = !canceledCleanup && machine.wakeOnAcceptedMessage
                ? census.targets.find(target => target.managedId === machine.id) : undefined;
            const purpose: ManagedPolicyPurposeV1 | null = canceledCleanup ? { kind: 'creation-cleanup' } : target
                ? { kind: 'accepted-input-start', target }
                : machine.retention.kind !== 'until-delete' ? { kind: 'retention' } : null;
            if (!purpose) continue;
            const localGuestPolicy = !machine.controller && machine.enrolledMachineId === params.executorMachineId;
            // Account daemons may observe a resource for accepted input. Its
            // unassigned retention still belongs to the enrolled guest.
            if (purpose.kind === 'retention' && !machine.controller && !localGuestPolicy) continue;
            current.add(machine.id);
            // Intent revisions created by this same driver do not cancel its
            // native completion. A replaced native resource or enrollment does
            // retire its held lifetime. Exact row currentness stays in the driver.
            const signature: PolicySchedulingFacts = { controller: machine.controller, resource: machine.resource,
                nativeOperationRef: machine.nativeOperationRef, enrolledMachineId: machine.enrolledMachineId, retention: machine.retention,
                wakeOnAcceptedMessage: machine.wakeOnAcceptedMessage, purpose: purpose.kind,
                ...(purpose.kind === 'accepted-input-start' ? { origin: purpose.target.origin } : {}) };
            const prior = active.get(machine.id);
            // Native Stop, or Suspend where that is how the provider parks, satisfies a Stop policy until compute runs again.
            // A submitted native effect still needs its incumbent reconciliation,
            // and an accepted wake target takes precedence over retention above.
            if (purpose.kind === 'retention' && machine.retention.kind !== 'until-delete'
                && machine.retention.effect === 'stop' && !machine.submittedNativeEffect
                && machine.observation?.availability === 'present' && (machine.observation.power === 'stopped' || machine.observation.power === 'suspended')) {
                if (prior) abortPolicy(machine.id, prior.cancel, 'retention_satisfied');
                continue;
            }
            // Observed satisfaction must retire an incumbent even when none of
            // its scheduling inputs changed. Only unsatisfied work can retain
            // the same outstanding driver lifetime.
            if (prior && isDeepStrictEqual(prior.signature, signature) && !prior.cancel.signal.aborted) continue;
            if (prior) abortPolicy(machine.id, prior.cancel, 'policy_replaced');
            // Controller publications only recheck an incumbent's currentness.
            // They cannot admit new work, including after that work has failed.
            if (!scheduleNew) continue;
            // Delete already owns this resource. Preserve any incumbent native
            // completion above, but never create competing retention work.
            if (purpose.kind === 'retention' && (machine.desired === 'delete' || machine.submittedNativeEffect?.intent === 'delete')) continue;
            const continuationRequestId = retentionContinuations.get(machine.id);
            const continuesRetention = hasSubmittedManagedRetentionEffect(machine, continuationRequestId);
            // A person's submitted Stop/Suspend already has its own execution
            // owner. Only Home-admitted policy custody can resume it here.
            if (purpose.kind === 'retention' && machine.submittedNativeEffect && !continuesRetention) continue;
            // New unused retention needs registration and positive guest evidence.
            // Only a policy-owned submitted Stop/Suspend continues without enrollment.
            if (purpose.kind === 'retention' && machine.retention.kind === 'unused' && !continuesRetention) {
                if (!machine.enrolledMachineId) continue;
                // A requester guest has no custodian-readable private Machine
                // state. Its exact registered RPC supplies readiness/activity;
                // registration and activity changes wake the existing row feed.
                if (!localGuestPolicy && (!machine.enrollmentAccountId || machine.enrollmentAccountId === machine.custodianAccountId)) {
                    let guest: Machine | null | undefined;
                    try {
                        guest = await params.loadMachine?.(machine.enrolledMachineId, lifetime.signal);
                    } catch (error) {
                        lifetime.signal.throwIfAborted();
                        params.onUnavailable?.(error);
                        continue;
                    }
                    lifetime.signal.throwIfAborted();
                    // ApiMachine publishes running only after core RPC registration.
                    // Presence alone (or retained running state while offline) is insufficient.
                    if (!guest || guest.id !== machine.enrolledMachineId || guest.active !== true
                        || guest.revokedAt != null || guest.replacedByMachineId
                        || guest.daemonState?.status !== 'running') continue;
                }
            }
            const cancel = new AbortController();
            const onStop = () => abortPolicy(machine.id, cancel, 'policy_runtime_stopped', lifetime.signal.reason);
            lifetime.signal.addEventListener('abort', onStop, { once: true });
            if (lifetime.signal.aborted) onStop();
            const entry = { signature, cancel, task: Promise.resolve() };
            entry.task = (async () => {
                try {
                    await prior?.task;
                    cancel.signal.throwIfAborted();
                    await params.executePolicy({ machine, purpose, signal: cancel.signal,
                        ...(continuesRetention ? { retentionContinuationRequestId: continuationRequestId } : {}) });
                } catch (error) {
                    if (!cancel.signal.aborted) params.onUnavailable?.(error);
                } finally {
                    lifetime.signal.removeEventListener('abort', onStop);
                    if (active.get(machine.id) === entry) active.delete(machine.id);
                    params.onSettled?.();
                }
            })();
            active.set(machine.id, entry);
        }
        for (const [id, entry] of active) if (!current.has(id)) abortPolicy(id, entry.cancel, 'policy_target_missing');
    };
    const notifyChanged = (currentnessOnly = false, nativeManagedIds?: readonly string[]): Promise<void> | undefined => {
        if (stopped) return;
        if (currentnessOnly && active.size === 0) return;
        changed = true;
        if (!currentnessOnly) {
            schedulingRequested = true;
            if (nativeManagedIds === undefined) nativeInvalidations = null;
            else for (const id of nativeManagedIds) nativeInvalidations?.add(id);
        }
        if (pump) return pump;
        pump = (async () => {
            while (changed && !stopped) {
                changed = false;
                const scheduleNew = schedulingRequested;
                schedulingRequested = false;
                const nativeManagedIds = nativeInvalidations;
                nativeInvalidations = new Set();
                try {
                    if (params.isAvailable?.() === false) {
                        for (const [id, entry] of active) abortPolicy(id, entry.cancel, 'controller_unavailable');
                        continue;
                    }
                    const census = await params.readCensus(lifetime.signal);
                    lifetime.signal.throwIfAborted();
                    await reconcile(census, scheduleNew, nativeManagedIds);
                } catch (error) {
                    // A failed read does not withdraw an admitted origin.
                    // Keep its held Ask/native owner; a successful census or
                    // runtime stop retires it, and effect admission stays fresh.
                    if (!stopped) params.onUnavailable?.(error);
                }
            }
        })().finally(() => { pump = null; if (changed && !stopped) notifyChanged(); });
        return pump;
    };
    const subscriptions: Array<() => void> = [];
    if (params.apiMachine) {
        subscriptions.push(params.apiMachine.onManagedMachinePolicyInvalidated(change => {
            if (change?.kind === 'machines' && !change.machineIds.some(id => enrolledMachineIds.has(id))) return;
            notifyChanged(change?.kind === 'currentness', change?.kind === 'managed' ? change.managedIds
                : change === undefined ? undefined : []);
        }));
        subscriptions.push(params.apiMachine.onUpdate(update => {
            const body = update.body;
            if (body.t === 'update-machine' && enrolledMachineIds.has(body.machineId)) notifyChanged(false, []);
            // ApiMachine discovers targeted work. Any change to an origin
            // already held here must also retire it after withdrawal/retargeting.
            if ((body.t === 'pending-changed' || body.t === 'automation-run-updated')
                && [...active.values()].some(({ signature }) => {
                    const origin = signature.origin;
                    if (body.t === 'pending-changed') return origin?.kind === 'session-input'
                        && origin.session.sessionId === (body.sessionId ?? body.sid);
                    return origin?.kind === 'workflow-assignment' && origin.runId === body.runId
                        || origin?.kind === 'context-delivery' && origin.delivery.runId === body.runId;
                })) notifyChanged(false, []);
        }));
        subscriptions.push(params.apiMachine.onConnectionStateChange(state => {
            if (state.phase === 'online') notifyChanged();
        }));
    }
    return {
        notifyChanged,
        async stop() {
            stopped = true;
            for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
            lifetime.abort();
            await pump;
            await Promise.all([...active.values()].map(entry => entry.task));
        },
    };
}
