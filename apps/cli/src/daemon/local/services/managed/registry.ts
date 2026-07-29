import type { LocalServiceManagedOwnerV1 } from '@happier-dev/protocol';

type Confidence = 'high' | 'medium' | 'low';

export type ManagedLocalServiceProcess = Readonly<{
    pid: number;
    startedAt: number;
}>;

export type ManagedLocalServiceLaunchMode = 'detectAfterLaunch' | 'assignAndInject';

export type ManagedLocalServiceRuntimeState = Readonly<{
    id: string;
    owner: LocalServiceManagedOwnerV1;
    phase: 'detecting' | 'running' | 'unhealthy' | 'stopped' | 'failed';
    launchMode: ManagedLocalServiceLaunchMode;
    minimumConfidence: Confidence;
    process: ManagedLocalServiceProcess;
    routeName: string;
    host?: string;
    inventoryId?: string;
    port?: number;
    diagnostics: readonly Readonly<{ code: string; severity: 'info' | 'warning' | 'error' }>[];
}>;

export type ManagedInventoryCandidate = Readonly<{
    id: string;
    port: number;
    confidence: Confidence;
    processOwnershipConfidence: Confidence;
    provenance?: Readonly<{
        process?: Readonly<{
            pid: number;
            ppid?: number;
            lineagePids?: readonly number[];
            redacted: true;
            command: string;
        }>;
    }>;
}>;

function confidenceRank(confidence: Confidence): number {
    if (confidence === 'high') return 3;
    if (confidence === 'medium') return 2;
    return 1;
}

function isCorrelatedProcess(entry: ManagedInventoryCandidate, managedPid: number): boolean {
    const process = entry.provenance?.process;
    if (!process) return false;
    return process.pid === managedPid
        || process.ppid === managedPid
        || process.lineagePids?.includes(managedPid) === true;
}

export type ManagedLocalServiceRegistry = Readonly<{
    getService(serviceId: string): ManagedLocalServiceRuntimeState | null;
    listServices(): readonly ManagedLocalServiceRuntimeState[];
    startDetectAfterLaunch(input: Readonly<{
        id: string;
        owner: LocalServiceManagedOwnerV1;
        minimumConfidence: Confidence;
        process: ManagedLocalServiceProcess;
        routeName: string;
    }>): ManagedLocalServiceRuntimeState;
    /**
     * Assign-and-inject services know their port before the child spawns (the daemon
     * allocated it and injected PORT/HOST). They start in `running` immediately — there
     * is no inventory-correlation wait like detect-after-launch.
     */
    startAssignAndInject(input: Readonly<{
        id: string;
        owner: LocalServiceManagedOwnerV1;
        process: ManagedLocalServiceProcess;
        routeName: string;
        host: string;
        port: number;
    }>): ManagedLocalServiceRuntimeState;
    applyInventoryEntry(entry: ManagedInventoryCandidate): ManagedLocalServiceRuntimeState | null;
    /**
     * Transition a live assign-and-inject service between `running` and `unhealthy`
     * (driven by the daemon-internal health monitor). Ignored for services that are not
     * live or already in a terminal phase. Pid-guarded so a stale monitor tick cannot
     * touch a newer run.
     */
    markHealthPhase(input: Readonly<{
        serviceId: string;
        pid: number;
        phase: 'running' | 'unhealthy';
    }>): ManagedLocalServiceRuntimeState | null;
    /**
     * Fence a live service after a guarded operation can no longer prove that
     * the listener and process still belong to the previously verified run.
     * The row remains for recovery/diagnostics, but it is no longer projected
     * as an active owned run.
     */
    markProcessOwnershipUnverified(input: Readonly<{
        serviceId: string;
        pid: number;
    }>): ManagedLocalServiceRuntimeState | null;
    stopIntentional(serviceId: string): Readonly<{ ok: boolean }>;
    handleProcessExit(input: Readonly<{ serviceId: string; pid: number; exitCode: number | null }>): Readonly<{
        ignored: boolean;
        reason?: 'service_not_live' | 'pid_mismatch';
    }>;
}>;

export function createManagedLocalServiceRegistry(): ManagedLocalServiceRegistry {
    const live = new Map<string, ManagedLocalServiceRuntimeState>();
    return {
        getService(serviceId) {
            return live.get(serviceId) ?? null;
        },
        listServices() {
            return [...live.values()];
        },
        startDetectAfterLaunch(input) {
            if (!input.owner) {
                throw new Error('managed_local_service_owner_required');
            }
            const state: ManagedLocalServiceRuntimeState = {
                id: input.id,
                owner: input.owner,
                phase: 'detecting',
                launchMode: 'detectAfterLaunch',
                minimumConfidence: input.minimumConfidence,
                process: input.process,
                routeName: input.routeName,
                diagnostics: [{ code: 'correlation_pending', severity: 'info' }],
            };
            live.set(input.id, state);
            return state;
        },
        startAssignAndInject(input) {
            if (!input.owner) {
                throw new Error('managed_local_service_owner_required');
            }
            const state: ManagedLocalServiceRuntimeState = {
                id: input.id,
                owner: input.owner,
                phase: 'running',
                launchMode: 'assignAndInject',
                minimumConfidence: 'high',
                process: input.process,
                routeName: input.routeName,
                host: input.host,
                port: input.port,
                diagnostics: [],
            };
            live.set(input.id, state);
            return state;
        },
        applyInventoryEntry(entry) {
            for (const [serviceId, state] of live) {
                if (state.phase !== 'detecting') continue;
                if (!isCorrelatedProcess(entry, state.process.pid)) continue;
                if (confidenceRank(entry.processOwnershipConfidence) < confidenceRank(state.minimumConfidence)) continue;
                const next: ManagedLocalServiceRuntimeState = {
                    ...state,
                    phase: 'running',
                    inventoryId: entry.id,
                    port: entry.port,
                    diagnostics: [],
                };
                live.set(serviceId, next);
                return next;
            }
            return null;
        },
        markHealthPhase(input) {
            const state = live.get(input.serviceId);
            if (!state) return null;
            if (state.process.pid !== input.pid) return null;
            if (state.phase !== 'running' && state.phase !== 'unhealthy') return null;
            if (state.phase === input.phase) return state;
            const next: ManagedLocalServiceRuntimeState = {
                ...state,
                phase: input.phase,
                diagnostics: input.phase === 'unhealthy'
                    ? [{ code: 'health_check_failed', severity: 'warning' }]
                    : [],
            };
            live.set(input.serviceId, next);
            return next;
        },
        markProcessOwnershipUnverified(input) {
            const state = live.get(input.serviceId);
            if (!state) return null;
            if (state.process.pid !== input.pid) return null;
            if (
                state.phase !== 'detecting'
                && state.phase !== 'running'
                && state.phase !== 'unhealthy'
            ) {
                return null;
            }
            const next: ManagedLocalServiceRuntimeState = {
                ...state,
                phase: 'failed',
                diagnostics: [{
                    code: 'process_ownership_unverified',
                    severity: 'error',
                }],
            };
            live.set(input.serviceId, next);
            return next;
        },
        stopIntentional(serviceId) {
            const existed = live.delete(serviceId);
            return { ok: existed };
        },
        handleProcessExit(input) {
            const state = live.get(input.serviceId);
            if (!state) return { ignored: true, reason: 'service_not_live' };
            if (state.process.pid !== input.pid) return { ignored: true, reason: 'pid_mismatch' };
            live.set(input.serviceId, { ...state, phase: 'failed', diagnostics: [{ code: 'process_exited', severity: 'error' }] });
            return { ignored: false };
        },
    };
}
