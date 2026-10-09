import axios from 'axios';
import { isDeepStrictEqual } from 'node:util';
import type { ApiMachineClient } from '@/api/apiMachine';
import type { ManagedControllerV1, ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedMachineControllerError } from '@/machines/managed/acquire';
import type { createDaemonManagedMachineActionAdapter } from './managedMachineActionAdapter';
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
}>): Promise<ManagedMachinePolicyCensus> {
    input.signal?.throwIfAborted();
    const body = ManagedPolicyCensusInputV1Schema.parse({ homeId: input.homeId, controller: input.controller,
        proof: createManagedPolicyCensusProofV1(input) });
    const response = await axios.post<unknown>(`${input.serverUrl}/v1/machines/managed/controller/policies`, body,
        { headers: { Authorization: `Bearer ${input.token}`, 'Content-Type': 'application/json' },
            validateStatus: () => true, ...(input.signal ? { signal: input.signal } : {}) });
    input.signal?.throwIfAborted();
    if (response.status < 200 || response.status >= 300) throw new ManagedMachineControllerError('admission_unavailable');
    const census = ManagedPolicyCensusOutputV1Schema.parse(response.data);
    if ([...census.machines, ...census.targets].some(item => item.homeId !== body.homeId
        || item.controller.machineId !== body.controller.machineId
        || item.controller.installationId !== body.controller.installationId)) {
        throw new ManagedMachineControllerError('controller_unavailable');
    }
    return census;
}

/** Scheduling only: the existing native driver owns policy admission, approval and selected waits. */
export function createDaemonManagedMachinePolicyRuntime(params: Readonly<{
    apiMachine?: Pick<ApiMachineClient, 'onUpdate' | 'onConnectionStateChange'>;
    readCensus(signal: AbortSignal): Promise<ManagedMachinePolicyCensus>;
    executePolicy: ReturnType<typeof createDaemonManagedMachineActionAdapter>['executePolicy'];
    onSettled?: () => void;
    onUnavailable?: (error: unknown) => void;
}>) {
    const lifetime = new AbortController();
    // These are actual outstanding driver lifetimes, not a copied activity or intent store.
    const active = new Map<string, { signature: PolicySchedulingFacts; cancel: AbortController; task: Promise<void> }>();
    let stopped = false;
    let changed = false;
    let pump: Promise<void> | null = null;
    const reconcile = (census: ManagedMachinePolicyCensus) => {
        const current = new Set<string>();
        for (const machine of census.machines) {
            const canceledCleanup = machine.creationState === 'canceled' && machine.desired === 'delete' && machine.desiredWhen === 'now';
            if (machine.archivedAt !== undefined || !(machine.allocation === 'bound' && machine.resource
                || canceledCleanup && machine.allocation === 'may-exist' && machine.nativeOperationRef)) continue;
            if (machine.creationState !== 'active' && !canceledCleanup) continue;
            const target = !canceledCleanup && machine.wakeOnAcceptedMessage
                ? census.targets.find(target => target.managedId === machine.id) : undefined;
            const purpose: ManagedPolicyPurposeV1 | null = canceledCleanup ? { kind: 'creation-cleanup' } : target
                ? { kind: 'accepted-input-start', target }
                : machine.retention.kind !== 'until-delete' ? { kind: 'retention' } : null;
            if (!purpose) continue;
            current.add(machine.id);
            // Intent revisions created by this same driver do not cancel its
            // native completion. A replaced native resource or enrollment does
            // retire its held lifetime. Exact row currentness stays in the driver.
            const signature: PolicySchedulingFacts = { controller: machine.controller, resource: machine.resource,
                nativeOperationRef: machine.nativeOperationRef, enrolledMachineId: machine.enrolledMachineId, retention: machine.retention,
                wakeOnAcceptedMessage: machine.wakeOnAcceptedMessage, purpose: purpose.kind,
                ...(purpose.kind === 'accepted-input-start' ? { origin: purpose.target.origin } : {}) };
            const prior = active.get(machine.id);
            if (prior && isDeepStrictEqual(prior.signature, signature) && !prior.cancel.signal.aborted) continue;
            prior?.cancel.abort();
            const cancel = new AbortController();
            const onStop = () => cancel.abort(lifetime.signal.reason);
            lifetime.signal.addEventListener('abort', onStop, { once: true });
            if (lifetime.signal.aborted) onStop();
            const entry = { signature, cancel, task: Promise.resolve() };
            entry.task = (async () => {
                try {
                    await prior?.task;
                    cancel.signal.throwIfAborted();
                    await params.executePolicy({ machine, purpose, signal: cancel.signal });
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
        for (const [id, entry] of active) if (!current.has(id)) entry.cancel.abort();
    };
    const notifyChanged = () => {
        if (stopped) return;
        changed = true;
        if (pump) return;
        pump = (async () => {
            while (changed && !stopped) {
                changed = false;
                try {
                    const census = await params.readCensus(lifetime.signal);
                    lifetime.signal.throwIfAborted();
                    reconcile(census);
                } catch (error) {
                    for (const entry of active.values()) entry.cancel.abort(error);
                    if (!stopped) params.onUnavailable?.(error);
                }
            }
        })().finally(() => { pump = null; if (changed && !stopped) notifyChanged(); });
    };
    const subscriptions: Array<() => void> = [];
    if (params.apiMachine) {
        subscriptions.push(params.apiMachine.onUpdate(update => {
            if (update.body.t === 'account-change'
                || update.body.t === 'pending-changed'
                || update.body.t === 'automation-run-updated') notifyChanged();
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
