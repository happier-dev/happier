import { z } from 'zod/mini';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';

import { inspectProcessBirthWitness, ProcessBirthWitnessSchema, type ProcessBirthInspection,
    type ProcessBirthWitness } from '@/daemon/processIdentity';
import { createProcessTreeStopper, terminateProcessTree } from '@/processes/terminate/terminateProcessTree';
import type { ManagedServiceProcessHandle, ManagedServiceProcessHealthSnapshot,
    ManagedServiceProcessSnapshot } from './managedProcessSupervisor';

/** Host-private recovery facts, deliberately excluding commands, environment and diagnostics. */
export const ManagedServiceProcessRecoveryRecordSchema = z.strictObject({
    snapshot: z.strictObject({
        id: z.string().check(z.minLength(1)),
        instanceId: z.string().check(z.minLength(1)),
        baseUrl: z.nullable(z.string().check(z.minLength(1))),
        port: z.nullable(z.number().check(z.int(), z.positive(), z.maximum(65_535))),
        startedAtMs: z.nullable(z.number().check(z.int(), z.nonnegative())),
    }),
    process: ProcessBirthWitnessSchema,
    /** Windows containment is retained separately from the target's process birthday. */
    windowsJobName: z.optional(z.string().check(z.minLength(1))),
});
export type ManagedServiceProcessRecoveryRecord = Readonly<z.infer<typeof ManagedServiceProcessRecoveryRecordSchema>>;

export function captureManagedServiceProcessRecoveryRecord(
    snapshot: ManagedServiceProcessSnapshot,
    process: ProcessBirthWitness,
    windowsJobName?: string,
): ManagedServiceProcessRecoveryRecord {
    return Object.freeze({
        snapshot: Object.freeze({ id: snapshot.id, instanceId: snapshot.instanceId,
            baseUrl: snapshot.baseUrl, port: snapshot.port, startedAtMs: snapshot.startedAtMs }),
        process,
        ...(windowsJobName ? { windowsJobName } : {}),
    });
}

function assertObservationAvailable(observation: ProcessBirthInspection): asserts observation is Exclude<ProcessBirthInspection, { status: 'unknown' }> {
    if (observation.status === 'unknown') {
        throw new PluginError({ code: 'plugin_managed_server_process_identity_unavailable',
            message: 'Managed service process identity could not be observed',
            retryable: true, details: { reason: observation.reason } });
    }
}

function assertNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new PluginError({ code: 'plugin_managed_server_aborted',
        message: 'Managed server operation was aborted' });
}

/** Re-adoption observes once; subsequent reads consume that observation without a watchdog. */
export async function restoreManagedServiceProcess(
    record: ManagedServiceProcessRecoveryRecord,
): Promise<ManagedServiceProcessHandle> {
    const initial = await inspectProcessBirthWitness(record.process);
    assertObservationAvailable(initial);
    const stopped = initial.status === 'absent' || initial.status === 'reused';
    let snapshot: ManagedServiceProcessSnapshot = Object.freeze({
        ...record.snapshot, mode: 'managedSpawn', state: stopped ? 'stopped' : 'running',
        pid: stopped ? null : record.process.pid, baseUrl: stopped ? null : record.snapshot.baseUrl,
        port: stopped ? null : record.snapshot.port, lastHealthyAtMs: null,
        diagnostics: Object.freeze([]), diagnosticsTruncated: false,
    });
    let healthSnapshot: ManagedServiceProcessHealthSnapshot = Object.freeze({ state: snapshot.state });
    const listeners = new Set<(snapshot: ManagedServiceProcessSnapshot) => void>();
    const healthListeners = new Set<(snapshot: ManagedServiceProcessHealthSnapshot) => void>();
    const publishStopped = (): void => {
        if (snapshot.state === 'stopped') return;
        snapshot = Object.freeze({ ...snapshot, state: 'stopped', pid: null, baseUrl: null, port: null });
        healthSnapshot = Object.freeze({ state: 'stopped' });
        for (const listener of listeners) {
            try { listener(snapshot); } catch { listeners.delete(listener); }
        }
        for (const listener of healthListeners) {
            try { listener(healthSnapshot); } catch { healthListeners.delete(listener); }
        }
    };
    const stopper = createProcessTreeStopper(async () => {
        if (snapshot.state === 'stopped') return;
        // The terminator owns exact generation/principal checks and its existing stop budget.
        const result = await terminateProcessTree({ targets: [record.process], tree: true,
            rootKind: 'service', policy: record.windowsJobName ? 'kill' : 'stop',
            ...(record.windowsJobName ? { containment: { kind: 'windows_job' as const, name: record.windowsJobName } } : {}),
        });
        // A recycled root proves the retained generation ended. Other refused or surviving
        // tree members still make Stop incomplete; the replacement PID is never signalled.
        const retainedRootEnded = result.status === 'incomplete' && result.outcomes.length > 0
            && result.outcomes.every(outcome => outcome.outcome === 'ended' || outcome.outcome === 'gone_before'
                || outcome.pid === record.process.pid && outcome.outcome === 'refused' && outcome.reason === 'identity_changed');
        if (result.status !== 'complete' && !retainedRootEnded) throw new PluginError({
            code: 'plugin_managed_server_termination_incomplete',
            message: 'Managed service process termination could not be confirmed',
            details: { status: result.status,
                reasons: [...new Set(result.outcomes.flatMap(outcome => outcome.reason ? [outcome.reason] : []))] },
        });
        publishStopped();
    });
    return Object.freeze({
        snapshot: () => snapshot,
        async inspectCurrentOccurrence() {
            if (snapshot.state === 'stopped') return snapshot;
            const observation = await inspectProcessBirthWitness(record.process);
            assertObservationAvailable(observation);
            if (observation.status === 'absent' || observation.status === 'reused') publishStopped();
            return snapshot;
        },
        observe(listener: (snapshot: ManagedServiceProcessSnapshot) => void) {
            listeners.add(listener);
            try { listener(snapshot); } catch { listeners.delete(listener); }
            return Object.freeze({ dispose() { listeners.delete(listener); } });
        },
        observeHealth(listener: (snapshot: ManagedServiceProcessHealthSnapshot) => void) {
            healthListeners.add(listener);
            try { listener(healthSnapshot); } catch { healthListeners.delete(listener); }
            return Object.freeze({ dispose() { healthListeners.delete(listener); } });
        },
        async waitUntilHealthy(options?: Readonly<{ timeoutMs?: number; signal?: AbortSignal }>) {
            assertNotAborted(options?.signal);
            if (snapshot.state === 'stopped') throw new PluginError({ code: 'plugin_managed_server_stopped',
                message: 'Managed server handle is stopped' });
            // Health declarations and credential leases do not cross daemon lifetimes.
            throw new PluginError({ code: 'plugin_managed_service_unavailable',
                message: 'Recovered service has no reported readiness capability' });
        },
        async stop(options?: Readonly<{ signal?: AbortSignal }>) {
            assertNotAborted(options?.signal);
            try { await stopper.stop(); }
            catch (error) {
                if (isPluginError(error) && error.code === 'plugin_managed_server_termination_incomplete') {
                    return Object.freeze({ status: 'termination_incomplete' as const });
                }
                throw error;
            }
            return Object.freeze({ status: 'stopped' as const });
        },
        async dispose() { await stopper.stop(); },
    });
}
