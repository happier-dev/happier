import type { RpcAdmissionPredicate, RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import type { MachineVitalsSampler } from '@/daemon/vitals/createMachineVitalsSampler';
import { parkWatch } from '@/daemon/lifecycle/parkWatch';
import type { MachineResourceAttentionV1 } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import {
    MachineVitalsGetInputV1Schema, MachineVitalsHistoryGetInputV1Schema, MachineVitalsWatchInputV1Schema,
    MachineVitalsSnapshotV1Schema, MachineVitalsWatchResultV1Schema, type MachineVitalsSnapshotV1,
} from '@happier-dev/protocol/machines/vitals/machineVitalsRpcV1';
import { MachineVitalsHistoryV1Schema } from '@happier-dev/protocol/machines/vitals/machineVitalsHistoryV1';
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
    let previous: MachineVitalsSampleV1 | undefined;
    for (const sample of live) {
        // Opening/closing a watched surface changes cadence; only missed samples at the slower cadence are a gap.
        if (previous && sample.sampledAt - previous.sampledAt > 2 * Math.max(previous.intervalMs, sample.intervalMs)) {
            add(previous.sampledAt + previous.intervalMs, null, null, null, null);
        }
        add(sample.sampledAt, sample.cpu.reported ? sample.cpu.busyPct : null,
            sample.memory.reported ? sample.memory.availableBytes : null,
            sample.network.reported ? sample.network.rxBps : null, sample.network.reported ? sample.network.txBps : null);
        previous = sample;
    }
    return series;
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
        const assertCurrent = async () => {
            const verified = async () => context?.verifyMachineAdmissionCurrent && await context.verifyMachineAdmissionCurrent()
                || deny('machine_currentness');
            if (!matches() || !await verified() || !matches()) {
                throw new RpcError('Machine access denied', RPC_ERROR_CODES.FORBIDDEN);
            }
        };
        // The dispatcher owns initial Home admission. This passive owner keeps
        // local binding checks and one fresh verification at disclosure.
        return assertCurrent;
    };
    rpc.registerHandler(RPC_METHODS.MACHINES_VITALS_GET, async (raw: unknown, context) => {
        const request = MachineVitalsGetInputV1Schema.parse(raw);
        const assertCurrent = bindAdmission(request, context);
        try {
            const latest = options.sampler.latest();
            const state = options.sampler.state();
            const attention = options.readAttention?.();
            return MachineVitalsSnapshotV1Schema.parse({
                ...state, sample: latest ? sampleForView(latest, request.view ?? 'summary') : null,
                series5m: latest || options.sampler.minutes(0).length ? fiveMinuteSeries(options.sampler)
                    : { cpu: [], memory: [], networkRx: [], networkTx: [] },
                ...(attention ? { attention } : {}),
            });
        } finally { await assertCurrent(); }
    });
    rpc.registerHandler(RPC_METHODS.MACHINES_VITALS_HISTORY_GET, async (raw: unknown, context) => {
        const request = MachineVitalsHistoryGetInputV1Schema.parse(raw);
        const assertCurrent = bindAdmission(request, context);
        try { return MachineVitalsHistoryV1Schema.parse(options.sampler.history(request.range)); }
        finally { await assertCurrent(); }
    });
    rpc.registerHandler(RPC_METHODS.DAEMON_VITALS_WATCH, async (raw: unknown, context) => {
        const request = MachineVitalsWatchInputV1Schema.parse(raw);
        const assertCurrent = bindAdmission(request, context);
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
            return MachineVitalsWatchResultV1Schema.parse(parked.changed
                ? { changed: true, samples: parked.snapshot } : { changed: false });
        } finally { await assertCurrent(); }
    });
}
