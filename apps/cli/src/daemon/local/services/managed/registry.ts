type Confidence = 'high' | 'medium' | 'low';

export type ManagedLocalServiceProcess = Readonly<{
    pid: number;
    startedAt: number;
}>;

export type ManagedLocalServiceRuntimeState = Readonly<{
    id: string;
    phase: 'detecting' | 'running' | 'stopped' | 'failed';
    launchMode: 'detectAfterLaunch';
    minimumConfidence: Confidence;
    process: ManagedLocalServiceProcess;
    routeName: string;
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
        minimumConfidence: Confidence;
        process: ManagedLocalServiceProcess;
        routeName: string;
    }>): ManagedLocalServiceRuntimeState;
    applyInventoryEntry(entry: ManagedInventoryCandidate): ManagedLocalServiceRuntimeState | null;
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
            const state: ManagedLocalServiceRuntimeState = {
                id: input.id,
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
