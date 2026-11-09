import type { RpcAdmissionPredicate, RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import type { MachineVitalsSampler } from '@/daemon/vitals/createMachineVitalsSampler';
import { parkWatch } from '@/daemon/lifecycle/parkWatch';
import { appendMachineVitalsSeriesV1, type MachineResourceAttentionV1 } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import {
    MachineVitalsGetInputV1Schema, MachineVitalsHistoryGetInputV1Schema, MachineVitalsWatchInputV1Schema,
    type MachineVitalsSnapshotV1, type MachineVitalsWatchResultV1,
} from '@happier-dev/protocol/machines/vitals/machineVitalsRpcV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';
import { doesMachineRpcTargetMatchAdmission } from '@/api/machine/machineRpcAuthorization';

export type DaemonMachineVitalsRoutes = Readonly<{
    sampler: MachineVitalsSampler;
    target: () => Readonly<{ serverId: string; machineId: string; installationId: string; custodianAccountId: string }> | null;
    readAttention?: () => MachineResourceAttentionV1 | undefined;
}>;

/** Independent Overview extras are filtered; a memory observation stays whole. */
function sampleForView(sample: MachineVitalsSampleV1, view: 'summary' | 'overview'): MachineVitalsSampleV1 {
    if (view === 'overview') return sample;
    const { gpu: _gpu, battery: _battery, thermal: _thermal, sharedMemory: _sharedMemory, ...base } = sample;
    const limits = base.limits ? (() => {
        const { inotify: _inotify, ...limits } = base.limits;
        return limits;
    })() : undefined;
    return { ...base, ...(limits ? { limits } : {}) };
}

function fiveMinuteSeries(sampler: MachineVitalsSampler): MachineVitalsSnapshotV1['series5m'] {
    const latest = sampler.latest();
    const end = latest?.sampledAt ?? Date.now();
    const start = end - 5 * 60_000;
    const live = sampler.samplesSince(start);
    const firstLive = live[0]?.sampledAt ?? end + 1;
    const memoryTotal = latest?.memory.reported ? latest.memory.totalBytes : sampler.host()?.memoryTotalBytes;
    const series: MachineVitalsSnapshotV1['series5m'] = { cpu: [], memory: [], networkRx: [], networkTx: [] };
    const add = (t: number, cpu: number | null, memory: number | null, rx: number | null, tx: number | null) => {
        series.cpu.push({ t, y: cpu });
        series.memory.push({ t, y: memory });
        series.networkRx.push({ t, y: rx });
        series.networkTx.push({ t, y: tx });
    };
    const minutes = new Map(sampler.minutes(start).map(record => [record.t, record]));
    for (let at = (Math.floor(start / 60_000) + 1) * 60_000; at < firstLive && at <= end; at += 60_000) {
        const minute = minutes.get(at);
        add(at, minute?.cpu ?? null,
            minute?.mem != null && memoryTotal !== undefined ? Math.max(0, memoryTotal - minute.mem) : null,
            minute?.rx != null ? minute.rx / 60 : null, minute?.tx != null ? minute.tx / 60 : null);
    }
    return appendMachineVitalsSeriesV1(series, null, live);
}

export function registerDaemonMachineVitalsRpcHandlers(rpc: RpcHandlerRegistrar, options: DaemonMachineVitalsRoutes): void {
    const bindAdmission = (request: Readonly<{ serverId?: string; machineId: string }>, context?: RpcHandlerContext) => {
        const target = options.target();
        const deny = (predicate: RpcAdmissionPredicate) => { context?.reportAdmissionDenial?.(predicate); return false; };
        const matches = () => {
            const current = options.target();
            const admission = context?.machineAdmission;
            if (!target || !current || current.serverId !== target.serverId) return deny('machine_home');
            if (!admission || admission.actorAccountId.length === 0) return deny('machine_actor');
            if (context?.signal.aborted) return deny('request_cancelled');
            if (admission.role !== 'use' && admission.role !== 'manage') return deny('machine_role');
            return doesMachineRpcTargetMatchAdmission(request, admission, current, context?.reportAdmissionDenial);
        };
        if (!matches()) throw new RpcError('Machine access denied', RPC_ERROR_CODES.FORBIDDEN);
        const assertLocal = async () => {
            if (!matches()) {
                throw new RpcError('Machine access denied', RPC_ERROR_CODES.FORBIDDEN);
            }
        };
        // The dispatcher admits each request once; returns retain only local binding and cancellation.
        return assertLocal;
    };
    rpc.registerHandler(RPC_METHODS.MACHINES_VITALS_GET, async (raw: unknown, context) => {
        const request = MachineVitalsGetInputV1Schema.parse(raw);
        const assertLocal = bindAdmission(request, context);
        try {
            const latest = options.sampler.latest();
            const state = options.sampler.state();
            const attention = options.readAttention?.();
            return {
                ...state, sample: latest ? sampleForView(latest, request.view ?? 'summary') : null,
                series5m: latest || options.sampler.minutes(0).length ? fiveMinuteSeries(options.sampler)
                    : { cpu: [], memory: [], networkRx: [], networkTx: [] },
                ...(attention ? { attention } : {}),
            } satisfies MachineVitalsSnapshotV1;
        } finally { await assertLocal(); }
    });
    rpc.registerHandler(RPC_METHODS.MACHINES_VITALS_HISTORY_GET, async (raw: unknown, context) => {
        const request = MachineVitalsHistoryGetInputV1Schema.parse(raw);
        const assertLocal = bindAdmission(request, context);
        try { return options.sampler.history(request.range); }
        finally { await assertLocal(); }
    });
    rpc.registerHandler(RPC_METHODS.DAEMON_VITALS_WATCH, async (raw: unknown, context) => {
        const request = MachineVitalsWatchInputV1Schema.parse(raw);
        const assertLocal = bindAdmission(request, context);
        const cursor = request.sinceSampledAt ?? options.sampler.latest()?.sampledAt ?? 0;
        const newer = () => options.sampler.samplesSince(cursor, request.view);
        try {
            const parked = await parkWatch({
                isNewer: () => newer().length > 0,
                read: () => newer().map(sample => sampleForView(sample, request.view)),
                subscribe(listener) {
                    const unsubscribe = options.sampler.subscribe(() => { if (newer().length) listener(); });
                    const release = request.view === 'overview' ? options.sampler.demandOverview() : options.sampler.demand('summary');
                    return () => { unsubscribe(); release(); };
                },
                signal: context?.signal,
            });
            return (parked.changed
                ? { changed: true, samples: parked.snapshot } : { changed: false }) satisfies MachineVitalsWatchResultV1;
        } finally { await assertLocal(); }
    });
}
