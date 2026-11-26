import type { RpcAdmissionPredicate, RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import type { MachineVitalsSampler } from '@/daemon/vitals/createMachineVitalsSampler';
import { parkWatch } from '@/daemon/lifecycle/parkWatch';
import type { MachineResourceAttentionV1 } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import { projectMachineVitalsSample, projectMachineVitalsSnapshot } from '@/daemon/vitals/projectMachineVitalsRead';
import {
    MachineVitalsGetInputV1Schema, MachineVitalsHistoryGetInputV1Schema, MachineVitalsWatchInputV1Schema,
    type MachineVitalsWatchResultV1,
} from '@happier-dev/protocol/machines/vitals/machineVitalsRpcV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';
import { doesMachineRpcTargetMatchAdmission } from '@/api/machine/machineRpcAuthorization';
import { registerActionSpecRpcHandlers } from './registerActionSpecRpcHandlers';

export type DaemonMachineVitalsRoutes = Readonly<{
    sampler: MachineVitalsSampler;
    target: () => Readonly<{ serverId: string; machineId: string; installationId: string; custodianAccountId: string }> | null;
    canReadServiceHistory?: (serviceId: string, context: RpcHandlerContext) => Promise<boolean>;
    readAttention?: () => MachineResourceAttentionV1 | undefined;
}>;

export function registerDaemonMachineVitalsRpcHandlers(
    rpc: RpcHandlerRegistrar,
    options: DaemonMachineVitalsRoutes & Readonly<{ machineId: string }>,
): void {
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
    const readVitals = async (raw: unknown, context?: RpcHandlerContext) => {
        const request = MachineVitalsGetInputV1Schema.parse(raw);
        const assertLocal = bindAdmission(request, context);
        try {
            return projectMachineVitalsSnapshot(options.sampler, request.view ?? 'summary', options.readAttention?.());
        } finally { await assertLocal(); }
    };
    registerActionSpecRpcHandlers({
        rpcHandlerManager: rpc,
        methods: [RPC_METHODS.MACHINES_VITALS_GET],
        targetMachineId: options.machineId,
        defaultMachineTarget: true,
        resolveActionExecutor: ({ ingress }) => ({
            execute: async (_actionId, input) => ({ ok: true, result: await readVitals(input, ingress) }),
        }),
    });
    rpc.registerHandler(RPC_METHODS.MACHINES_VITALS_HISTORY_GET, async (raw: unknown, context) => {
        const request = MachineVitalsHistoryGetInputV1Schema.parse(raw);
        const assertLocal = bindAdmission(request, context);
        try {
            if (request.serviceId !== undefined && (!context || !await options.canReadServiceHistory?.(request.serviceId, context))) {
                throw new RpcError('Service access denied', RPC_ERROR_CODES.FORBIDDEN);
            }
            return options.sampler.history(request.range, request.serviceId);
        }
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
                read: () => newer().map(sample => projectMachineVitalsSample(sample, request.view)),
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
