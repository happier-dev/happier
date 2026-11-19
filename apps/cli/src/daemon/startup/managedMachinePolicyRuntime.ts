import axios from '@/api/client/credentialAxios';
import { isDeepStrictEqual } from 'node:util';
import type { ApiMachineClient } from '@/api/apiMachine';
import type { Machine } from '@/api/types';
import { isManagedOpaquePresetMachineV1, type ManagedControllerV1, type ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedMachineControllerError } from '@/machines/managed/controllerErrors';
import { canPrepareManagedRetentionPolicy, hasSubmittedManagedRetentionEffect } from '@/machines/managed/managedRetentionPolicy';
import { logger } from '@/ui/logger';
import { MANAGED_MACHINE_POLICY_RETENTION_SATISFIED_ABORT,
    type createDaemonManagedMachineActionAdapter } from './managedMachineActionAdapter';
import { createManagedPolicyCensusProofV1, isManagedCreationCleanupV1, ManagedPolicyCensusInputV1Schema, ManagedPolicyCensusOutputV1Schema,
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
    managedId?: string; nativeCredentialManagedId?: string;
}>): Promise<ManagedMachinePolicyCensus> {
    input.signal?.throwIfAborted();
    const managedId = input.nativeCredentialManagedId ?? input.managedId;
    const body = ManagedPolicyCensusInputV1Schema.parse({ homeId: input.homeId, controller: input.controller,
        proof: createManagedPolicyCensusProofV1(input),
        ...(managedId ? { managedId } : {}),
        ...(input.nativeCredentialManagedId ? { includeNativeCredentialBindings: true } : {}) });
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
    readCensus(signal: AbortSignal, managedId?: string): Promise<ManagedMachinePolicyCensus>;
    executePolicy: ReturnType<typeof createDaemonManagedMachineActionAdapter>['executePolicy'];
    reconcileObservation?: ReturnType<typeof createDaemonManagedMachineActionAdapter>['reconcileObservation'];
    reconcileNativeCredentials?: (machine: ManagedMachineV1, signal: AbortSignal) => Promise<void>;
    supportsNativeLifetimeRenewal?: (machine: ManagedMachineV1, signal: AbortSignal) => Promise<boolean>;
    onSettled?: () => void;
    onUnavailable?: (error: unknown) => void;
}>) {
    const lifetime = new AbortController();
    // These are actual outstanding driver lifetimes, not a copied activity or intent store.
    const active = new Map<string, { signature: PolicySchedulingFacts; cancel: AbortController; task: Promise<void> }>();
    let stopped = false;
    let changed = false;
    let schedulingRequested = false;
    let observationRefreshRequested = true;
    let nativeInvalidations: Set<string> | null = new Set();
    let censusInvalidations: Set<string> | null = null;
    const enrolledMachineIds = new Set<string>();
    // Enrollment is unique. Keep its row index so an exact missing/replaced row
    // withdraws its former readiness subscription without rebuilding siblings.
    const enrollments = new Map<string, string>();
    let pump: Promise<void> | null = null;
    const abortPolicy = (managedId: string, cancel: AbortController, reasonCode:
        'retention_satisfied' | 'policy_replaced' | 'policy_target_missing' | 'controller_unavailable'
        | 'policy_runtime_stopped', reason?: unknown) => {
        if (cancel.signal.aborted) return;
        try { logger.warnLocalFile('[managed-policy.abort]', { managedId, reasonCode }); } catch { /* Diagnostic only. */ }
        cancel.abort(reasonCode === 'retention_satisfied' ? MANAGED_MACHINE_POLICY_RETENTION_SATISFIED_ABORT : reason);
    };
    const reconcile = async (census: ManagedMachinePolicyCensus, scheduleNew: boolean,
        nativeManagedIds: ReadonlySet<string> | null, managedIds: ReadonlySet<string> | null, refreshObservations: boolean) => {
        const retentionContinuations = new Map(census.retentionContinuations?.map(item => [item.managedId, item.requestId]));
        if (managedIds === null) {
            enrolledMachineIds.clear();
            enrollments.clear();
        } else for (const id of managedIds) {
            const enrolledId = enrollments.get(id);
            if (enrolledId) enrolledMachineIds.delete(enrolledId);
            enrollments.delete(id);
        }
        for (const machine of census.machines) if (machine.enrolledMachineId) {
            enrollments.set(machine.id, machine.enrolledMachineId);
            enrolledMachineIds.add(machine.enrolledMachineId);
        }
        const current = new Set<string>();
        for (let machine of census.machines) {
            const canceledCleanup = isManagedCreationCleanupV1(machine);
            if (machine.archivedAt !== undefined || !(machine.allocation === 'bound' && machine.resource
                || canceledCleanup && (isManagedOpaquePresetMachineV1(machine)
                    || machine.allocation === 'may-exist' && machine.nativeOperationRef))) continue;
            if (machine.creationState !== 'active' && !canceledCleanup) continue;
            // A controller may have missed host/native power changes while down.
            // Inspect once at this connection boundary, never on our own report push.
            if (refreshObservations && machine.controller && machine.creationState === 'active' && machine.resource
                && params.reconcileObservation) {
                try {
                    machine = await params.reconcileObservation(machine, lifetime.signal);
                } catch (error) {
                    lifetime.signal.throwIfAborted();
                    params.onUnavailable?.(error);
                }
            }
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
                : machine.retention.kind !== 'until-delete' || await params.supportsNativeLifetimeRenewal?.(machine, lifetime.signal)
                    ? { kind: 'retention' } : null;
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
                // A bound resource's Delete handle is progress owned by this
                // driver. Only an unbound allocation uses it as native identity.
                nativeOperationRef: machine.resource ? undefined : machine.nativeOperationRef,
                enrolledMachineId: machine.enrolledMachineId, retention: machine.retention,
                wakeOnAcceptedMessage: machine.wakeOnAcceptedMessage, purpose: purpose.kind,
                ...(purpose.kind === 'accepted-input-start' ? { origin: purpose.target.origin } : {}) };
            const prior = active.get(machine.id);
            const continuationRequestId = retentionContinuations.get(machine.id);
            const canPrepareRetention = canPrepareManagedRetentionPolicy(machine, continuationRequestId);
            // A manual intent retires pre-effect work even while its activity
            // RPC is pending and the scheduling signature is unchanged. An
            // issued native effect still belongs to its incumbent completion.
            if (purpose.kind === 'retention' && !machine.submittedNativeEffect && !canPrepareRetention) {
                if (prior) abortPolicy(machine.id, prior.cancel, 'policy_replaced');
                continue;
            }
            // Native Stop, or Suspend where that is how the provider parks, satisfies a Stop policy until compute runs again.
            // Manual retirement above retains its cancellation outcome even
            // when the same census already observes that manual power-down.
            if (purpose.kind === 'retention' && machine.retention.kind !== 'until-delete'
                && machine.retention.effect === 'stop' && !machine.submittedNativeEffect
                && machine.observation?.availability === 'present' && (machine.observation.power === 'stopped' || machine.observation.power === 'suspended')) {
                if (prior) abortPolicy(machine.id, prior.cancel, 'retention_satisfied');
                continue;
            }
            // Observed satisfaction and manual retirement precede reuse of an
            // outstanding driver lifetime with unchanged scheduling inputs.
            if (prior && isDeepStrictEqual(prior.signature, signature) && !prior.cancel.signal.aborted) continue;
            if (prior) abortPolicy(machine.id, prior.cancel, 'policy_replaced');
            // Controller publications only recheck an incumbent's currentness.
            // They cannot admit new work, including after that work has failed.
            if (!scheduleNew) continue;
            const continuesRetention = hasSubmittedManagedRetentionEffect(machine, continuationRequestId);
            // Manual Stop/Suspend/Delete owns its entire intent, including the
            // admission-to-submission gap. Incumbent native completion stays
            // above; only Home-admitted retention custody may resume below.
            if (purpose.kind === 'retention' && !canPrepareRetention) continue;
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
                        ...(continuationRequestId ? { retentionContinuationRequestId: continuationRequestId } : {}) });
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
        for (const id of managedIds ?? active.keys()) {
            const entry = active.get(id);
            if (entry && !current.has(id)) abortPolicy(id, entry.cancel, 'policy_target_missing');
        }
    };
    const runPump = (): Promise<void> => {
        if (pump) return pump;
        pump = (async () => {
            while (changed && !stopped) {
                changed = false;
                const scheduleNew = schedulingRequested;
                schedulingRequested = false;
                const refreshObservations = observationRefreshRequested;
                observationRefreshRequested = false;
                const nativeManagedIds = nativeInvalidations;
                nativeInvalidations = new Set();
                const managedIds = censusInvalidations;
                censusInvalidations = new Set();
                try {
                    if (params.isAvailable?.() === false) {
                        for (const [id, entry] of active) abortPolicy(id, entry.cancel, 'controller_unavailable');
                        continue;
                    }
                    if (managedIds === null) {
                        const census = await params.readCensus(lifetime.signal);
                        lifetime.signal.throwIfAborted();
                        await reconcile(census, scheduleNew, nativeManagedIds, null, refreshObservations);
                    } else {
                        const censuses = await Promise.all([...managedIds].map(id => params.readCensus(lifetime.signal, id)));
                        lifetime.signal.throwIfAborted();
                        await reconcile({ machines: censuses.flatMap(census => census.machines),
                            targets: censuses.flatMap(census => census.targets),
                            retentionContinuations: censuses.flatMap(census => census.retentionContinuations ?? []),
                        }, scheduleNew, nativeManagedIds, managedIds, refreshObservations);
                    }
                } catch (error) {
                    // A failed read does not withdraw an admitted origin.
                    // Keep its held Ask/native owner; a successful census or
                    // runtime stop retires it, and effect admission stays fresh.
                    if (!stopped) params.onUnavailable?.(error);
                }
            }
        })().finally(() => { pump = null; if (changed && !stopped) runPump(); });
        return pump;
    };
    const notifyChanged = (currentnessOnly = false, nativeManagedIds?: readonly string[]) => {
        if (stopped) return;
        if (currentnessOnly && active.size === 0) return;
        changed = true;
        if (currentnessOnly || !nativeManagedIds?.length) censusInvalidations = null;
        else for (const id of nativeManagedIds) censusInvalidations?.add(id);
        if (!currentnessOnly) {
            schedulingRequested = true;
            if (nativeManagedIds === undefined) nativeInvalidations = null;
            else for (const id of nativeManagedIds) nativeInvalidations?.add(id);
        }
        return runPump();
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
            if (state.phase === 'online') {
                observationRefreshRequested = true;
                notifyChanged();
            }
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
