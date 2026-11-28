import { MachineGuardPolicyV1Schema } from '@happier-dev/protocol/machines/guard/guardPolicyV1';
import type { MachineGuardStateV1 } from '@happier-dev/protocol/machines/guard/guardStateV1';
import type { ManagedActivityInventory } from '../lifecycle/managedActivity';
import type { MachineResourcesPolicyRuntime } from '../resources/machineResourcesPolicy';
import type { MachineResourceSummary } from '../resources/machineResourceSummary';
import type { MachineVitalsSampler } from '../vitals/createMachineVitalsSampler';
import type { KeepAwake } from '@/integrations/keepAwake';
import { waitForChangeOrDeadline } from '../lifecycle/waitForChangeOrDeadline';

import { createActivityLog, type ActivityLog } from './activityLog';
import type { GuardSessionHost } from './guardPlanner';
import { createGuardRuntime, type GuardPolicyWork, type GuardRuntimeInput } from './guardRuntime';
import { createGuardStatePublication, type GuardStatePublication } from './guardStatePublication';
import { createGuardWatch, type GuardWatchInput, type GuardViewRequester } from './view/guardWatch';

export type DaemonGuardPolicyWork = GuardPolicyWork & Readonly<{
    refreshOnTick?(): void;
    stop?(): void | Promise<void>;
    terminalState?: GuardWatchInput['terminalState'];
}>;

export type DaemonGuardInput = Readonly<{
    activeServerDir: string;
    policy: Pick<MachineResourcesPolicyRuntime, 'read' | 'subscribe'>;
    sampler: MachineVitalsSampler;
    keepAwake: Pick<KeepAwake, 'read' | 'subscribe'>;
    summary: Pick<MachineResourceSummary, 'setGuardState' | 'reportAutomaticAction'>;
    ownership: GuardWatchInput['ownership'];
    inventory: Pick<ManagedActivityInventory, 'subscribeFacts'>;
    readFacts: GuardWatchInput['readFacts'];
    readIdleSessionHost?(signal: AbortSignal): Promise<GuardSessionHost | undefined>;
    readLeftBehind: GuardWatchInput['readLeftBehind'];
    readTarget: GuardWatchInput['readTarget'];
    readManagedRetentionRef?: GuardWatchInput['readManagedRetentionRef'];
    createPolicyWork?: (activityLog: ActivityLog) => DaemonGuardPolicyWork;
    stopTarget: GuardRuntimeInput['stop'];
    onSessionStopRecorded?: GuardRuntimeInput['onSessionStopRecorded'];
    notice: GuardRuntimeInput['notice'];
    notifyEpisode: GuardRuntimeInput['notifyEpisode'];
    ceilingCapability: MachineGuardStateV1['capabilities']['ceiling'];
    signal?: AbortSignal;
    platform?: NodeJS.Platform;
    nowMs?: () => number;
    onError(error: unknown): void;
}>;
export type DaemonGuard = Readonly<{
    activityLog: ActivityLog;
    runtime: ReturnType<typeof createGuardRuntime>;
    watch: ReturnType<typeof createGuardWatch>;
    state: GuardStatePublication;
    keepRunning(request: Readonly<{ sessionId?: string }>, requester: GuardViewRequester,
        signal?: AbortSignal): Promise<Readonly<{ status: 'kept' | 'not_pending' }>>;
    refreshOnTick(): void;
    subscribeInvalidation(listener: () => void): () => void;
    stop(): Promise<void>;
}>;

/** Composes the incumbent policy, planner, Activity and summary owners for one daemon lifetime. */
export async function createDaemonGuard(input: DaemonGuardInput): Promise<DaemonGuard> {
    const activityLog = await createActivityLog({ activeServerDir: input.activeServerDir,
        resourceSummary: input.summary, nowMs: input.nowMs });
    const policyWork = input.createPolicyWork?.(activityLog);
    const nowMs = input.nowMs ?? Date.now;
    let policyMinute = Math.floor(nowMs() / 60000);
    let samplerState = JSON.stringify(input.sampler.state());
    const lifetime = new AbortController();
    const subscriptions = new Set<() => void>();
    const track = (releases: readonly (() => void)[]) => {
        let released = false;
        const release = () => {
            if (released) return;
            released = true; subscriptions.delete(release);
            for (const cleanup of releases) cleanup();
        };
        subscriptions.add(release);
        return release;
    };
    const subscribeFacts = (listener: () => void) => {
        if (lifetime.signal.aborted) return () => {};
        // Facts follow their canonical inventory owner. Memory policy already
        // subscribes to vitals, and idle policy owns its next deadline; treating
        // every sampler tick as a fact change would repeat the full OS census.
        return track([input.inventory.subscribeFacts(listener)]);
    };
    const defaults = MachineGuardPolicyV1Schema.parse({});
    const readPolicy = () => {
        const current = input.policy.read();
        return current.status === 'ready' ? current.policy.guard : defaults;
    };
    const runtime = createGuardRuntime({ vitals: input.sampler,
        readPolicy,
        subscribePolicy: listener => {
            // The metadata revision also covers unrelated Machine fields. Only
            // a changed Guard decision invalidates an in-flight Guard plan.
            let observed = JSON.stringify(readPolicy());
            return input.policy.subscribe(() => {
                const current = JSON.stringify(readPolicy());
                if (current === observed) return;
                observed = current;
                listener();
            });
        }, subscribe: subscribeFacts, policyWork,
        readFacts: async (runtimeSignal, scope) => {
            const signal = runtimeSignal ?? lifetime.signal;
            let facts: Awaited<ReturnType<DaemonGuardInput['readFacts']>> | undefined;
            // Retire only this reader; incumbent ownership/inventory publishers remain live.
            await waitForChangeOrDeadline({ signal, waitForChange: async () => {
                const ownership = await input.ownership.readOwners({ freshness: 'fresh' });
                signal.throwIfAborted();
                const [observed, sessionHost] = await Promise.all([
                    input.readFacts(ownership, signal, scope),
                    ownership.status === 'ok' && readPolicy().memoryGuard.enabled ? input.readIdleSessionHost?.(signal) : undefined,
                ]);
                facts = sessionHost ? { ...observed, sessionHost } : observed;
            } });
            signal.throwIfAborted();
            if (!facts) throw new Error('Guard fact read did not complete');
            return facts;
        },
        stop: input.stopTarget, onSessionStopRecorded: input.onSessionStopRecorded,
        notice: input.notice, notifyEpisode: input.notifyEpisode,
        activity: activityLog, nowMs: input.nowMs, onError: input.onError,
    });
    const state = createGuardStatePublication({ sampler: input.sampler, keepAwake: input.keepAwake,
        episodeOwner: runtime, summary: input.summary, ceilingCapability: input.ceilingCapability });
    const subscribeInvalidation = (listener: () => void) => {
        if (lifetime.signal.aborted) return () => {};
        return track([subscribeFacts(listener), state.subscribe(listener), runtime.subscribe(listener)]);
    };
    const watch = createGuardWatch({ policy: input.policy, sampler: input.sampler, ownership: input.ownership,
        readFacts: input.readFacts, readState: state.read, readTarget: input.readTarget,
        readLeftBehind: input.readLeftBehind, activityLog, sessionState: runtime, terminalState: policyWork?.terminalState,
        subscribe: subscribeInvalidation,
        readManagedRetentionRef: input.readManagedRetentionRef, platform: input.platform, nowMs: input.nowMs });
    const running = runtime.run(lifetime.signal).catch(input.onError);
    let stopping: Promise<void> | undefined;
    const onAbort = () => { void stop().catch(input.onError); };
    const stop = (): Promise<void> => {
        if (stopping) return stopping;
        lifetime.abort(); input.signal?.removeEventListener('abort', onAbort);
        watch.dispose(); state.stop();
        for (const release of [...subscriptions]) release();
        return stopping = (async () => {
            try { await policyWork?.stop?.(); }
            finally { await running; }
        })();
    };
    input.signal?.addEventListener('abort', onAbort, { once: true });
    if (input.signal?.aborted) await stop();
    return { activityLog, runtime, watch, state, subscribeInvalidation, stop,
        async keepRunning(request, requester, signal) {
            if (signal?.aborted) return { status: 'not_pending' };
            if (!request.sessionId) return { status: 'not_pending' };
            if (!requester.isCustodian && !(await watch.readView(requester, signal)).idle
                .some(row => row.sessionRef === request.sessionId)) return { status: 'not_pending' };
            return { status: await runtime.keepRunning(request.sessionId) };
        },
        refreshOnTick() {
            if (lifetime.signal.aborted) return;
            state.refresh();
            // The sampler's completion clock includes failures. Retry auxiliary
            // owners at minute frontiers or reporting transitions, independently
            // of another viewer's cadence and without requiring a valid sample.
            const minute = Math.floor(nowMs() / 60000);
            const currentState = JSON.stringify(input.sampler.state());
            if (minute !== policyMinute || currentState !== samplerState) {
                policyMinute = minute;
                samplerState = currentState;
                policyWork?.refreshOnTick?.();
            }
        },
    };
}
