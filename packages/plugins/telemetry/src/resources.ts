import { PluginError } from '@happier-dev/plugin-sdk';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginDynamicResourceRuntime } from '@happier-dev/plugin-sdk/resources';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { PluginServiceListFieldResourceInputV1Schema, type PluginServiceListFieldResourceInputV1,
    type PluginServiceListFieldResourceResultV1 } from '@happier-dev/plugin-sdk/ui';
import * as database from '@happier-dev/database-protocol';
import { localCaptureBackground, type createCaptureBackgroundOwner } from './background.js';
import { captureSourcePartition } from './partition.js';
import { createCaptureSelectedSourceReaders, type AdmittedCaptureSource } from './actions.js';
import { telemetryPartition } from './telemetry/assignments.js';
import { readTelemetryEnvironmentMetrics, readTelemetryMetricsOverview } from './health.js';

type ResourceContext = Parameters<NonNullable<PluginDynamicResourceRuntime['createProducer']>>[0];

export const TELEMETRY_SERVICE_SUMMARY_FIELDS = {
    'http-p95': { property: 'p95Ms', title: 'p95', unit: 'ms' },
    'http-error-rate': { property: 'errorRate', title: 'Errors', unit: '1' },
} as const;

/** The finite Action owns source admission and the existing database lease for every demanded read. */
async function readCaptureAction(context: ResourceContext, actionId: database.DatabaseActionIdV1, input: JsonValue,
    signal: AbortSignal): Promise<unknown> {
    const outcome = await context.readAction({ pluginId: database.DATABASE_CAPTURE_RESOURCE_REF_V1.pluginId,
        localId: database.databaseActionLocalIdV1(actionId) }, input, { signal });
    if (!outcome.ok) throw new PluginError({ code: outcome.errorCode, message: outcome.error });
    return outcome.result;
}

function projectServiceColumnSnapshot(result: database.TelemetryEnvironmentMetricsReadResultV1): PluginServiceListFieldResourceResultV1 {
    return { items: result.items.map(({ environmentId, result, trend }) => {
        const measurement = result.measurements;
        const provenance = measurement && {
            basis: measurement.basis, producers: measurement.producers, window: measurement.window,
            ...(measurement.observedWindow ? { observedWindow: measurement.observedWindow } : {}),
            completeness: measurement.completeness, reasons: measurement.reasons,
        };
        // The mixed request count includes both populations. Its latency and error share cover only the histogram.
        const facts = Object.fromEntries(Object.entries(TELEMETRY_SERVICE_SUMMARY_FIELDS).map(([id, field]) => {
            const value = result.status === 'unknown' || measurement?.basis === 'mixed_telemetry'
                ? null : measurement?.[field.property] ?? null;
            return [id, { value, ...(value !== null && provenance ? { provenance } : {}) }];
        }));
        return {
            environmentId,
            value: result.status === 'unknown' ? null : measurement?.value ?? null,
            ...(provenance ? { provenance } : {}),
            facts,
            trend: trend.map(interval => ({ at: interval.until, value: interval.value ?? null })),
        };
    }) };
}

async function createServiceColumnProducer(context: ResourceContext, input: PluginServiceListFieldResourceInputV1,
    subscribe: ReturnType<typeof createCaptureBackgroundOwner>['subscribe']) {
    const admit = context.deploymentDatabases?.admitTelemetryRead;
    if (!admit) throw new PluginError({ code: 'deployment_target_role_unavailable' });
    const databaseService = context.daemonStorage?.database;
    if (!databaseService) throw new PluginError({ code: 'plugin_service_unavailable' });
    const admitted = await Promise.all([...new Set(input.environmentIds)].map(async environmentId => ({
        ...await admit({ serverId: input.serverId, environmentId }), environmentId,
    })));
    context.signal.throwIfAborted();
    const lease = await localCaptureBackground.acquireRuntime({ signal: context.signal,
        services: { storage: { daemon: { database: databaseService } } } });
    let invalidate: (() => void) | undefined;
    const stop = subscribe(admitted.map(({ environmentId }) => telemetryPartition(environmentId)), () => invalidate?.());
    return {
        async read(invocation: Parameters<NonNullable<PluginDynamicResourceRuntime['read']>>[0]) {
            invocation.signal.throwIfAborted();
            const until = Date.now();
            const selection = { since: Math.max(0, until - database.TELEMETRY_REQUESTS_WINDOW_MS_V1), until,
                measure: { kind: 'http', statistic: 'requests' } as const, includeTrend: input.includeTrend };
            const items = await Promise.all(admitted.map(row => readTelemetryEnvironmentMetrics(lease.runtime, selection, row, until)));
            invocation.signal.throwIfAborted();
            return JSON.stringify(projectServiceColumnSnapshot({ items }));
        },
        observe(callback: () => void) {
            invalidate = callback;
            return { dispose() { if (invalidate === callback) invalidate = undefined; } };
        },
        async dispose() {
            invalidate = undefined;
            stop();
            await lease.release();
        },
    };
}

async function readCaptureResourceSnapshot(context: ResourceContext, demand: Exclude<database.DatabaseCaptureResourceInputV1, { view: 'metrics' }>,
    signal: AbortSignal): Promise<Exclude<database.DatabaseCaptureResourceSnapshotV1, { view: 'metrics' }>> {
    const input = projectNativeJsonValueForTransport(demand.input);
    const read = (actionId: database.DatabaseActionIdV1, input: JsonValue) => readCaptureAction(context, actionId, input, signal);
    switch (demand.view) {
        case 'costs': return { view: demand.view, result: database.DatabaseCaptureCostsReadResultV1Schema.parse(await read(database.TELEMETRY_COSTS_READ_ACTION_ID_V1, input)) };
        case 'status': return { view: demand.view, result: database.DatabaseCaptureStatusResultV1Schema.parse(await read(database.DATABASE_CAPTURE_STATUS_ACTION_ID_V1, input)) };
        case 'queries': return { view: demand.view, result: database.DatabaseCaptureQueriesListResultV1Schema.parse(await read(database.DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1, input)) };
        case 'query': return { view: demand.view, result: database.DatabaseCaptureQueryGetResultV1Schema.parse(await read(database.DATABASE_CAPTURE_QUERY_GET_ACTION_ID_V1, input)) };
        case 'traces': return { view: demand.view, result: database.DatabaseCaptureTracesListResultV1Schema.parse(await read(database.DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1, input)) };
        case 'trace': return { view: demand.view, result: database.DatabaseCaptureTraceGetResultV1Schema.parse(await read(database.DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1, input)) };
        case 'logs': return { view: demand.view, result: database.DatabaseCaptureLogsListResultV1Schema.parse(await read(database.DATABASE_CAPTURE_LOGS_LIST_ACTION_ID_V1, input)) };
        case 'endpoints': return { view: demand.view, result: database.DatabaseCaptureEndpointsListResultV1Schema.parse(await read(database.DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1, input)) };
    }
}

type RollingCaptureDemand = Extract<database.DatabaseCaptureResourceInputV1,
    { view: keyof typeof database.DATABASE_CAPTURE_LIST_ACTION_BY_VIEW_V1 }>;

function isRollingCaptureDemand(demand: database.DatabaseCaptureResourceInputV1): demand is RollingCaptureDemand {
    return Object.hasOwn(database.DATABASE_CAPTURE_LIST_ACTION_BY_VIEW_V1, demand.view);
}

async function readRollingCapturePage(demand: RollingCaptureDemand,
    readers: ReturnType<typeof createCaptureSelectedSourceReaders>, admission: AdmittedCaptureSource, windowMs: number):
    Promise<Extract<database.DatabaseCaptureResourceSnapshotV1, { view: RollingCaptureDemand['view'] }>> {
    const until = Date.now();
    const window = { since: Math.max(0, until - windowMs), until };
    switch (demand.view) {
        case 'metrics': return { view: demand.view,
            result: await readTelemetryMetricsOverview(admission.runtime, { ...demand.input, ...window }, admission, until) };
        case 'costs': return { view: demand.view, result: await readers.readCapturedCosts({ ...demand.input, ...window }) };
        case 'endpoints': return { view: demand.view, window, result: await readers.listCapturedEndpoints({ ...demand.input, ...window }) };
        case 'logs': return { view: demand.view, window, result: await readers.listCapturedLogs({ ...demand.input, ...window }) };
        case 'traces': return { view: demand.view, window, result: await readers.listCapturedTraces({ ...demand.input, ...window }) };
        case 'queries': return { view: demand.view, window, result: await readers.listCapturedQueries({ ...demand.input, ...window }) };
    }
}

function unavailable(): never { throw new PluginError({ code: 'plugin_resource_producer_placement_unavailable' }); }

/** The Resource host owns bytes, refresh and disposal. No database service or second source admission is needed. */
export function createCaptureResourceRuntime(options: Readonly<{
    subscribe: ReturnType<typeof createCaptureBackgroundOwner>['subscribe'];
    acquireSelection?(source: database.DatabaseCaptureSourceV1, context: ResourceContext, actionId: database.DatabaseActionIdV1):
        Promise<AdmittedCaptureSource & Readonly<{ release(): Promise<void> }>>;
}>): PluginDynamicResourceRuntime {
    return {
        read: unavailable,
        observe: unavailable,
        async createProducer(context) {
            if (context.context.kind !== 'surface') throw new PluginError({ code: 'plugin_resource_demand_unavailable' });
            const serviceInput = PluginServiceListFieldResourceInputV1Schema.safeParse(context.context.launchInput);
            if (serviceInput.success) return await createServiceColumnProducer(context, serviceInput.data, options.subscribe);
            const capture = database.DatabaseCaptureResourceInputV1Schema.parse(context.context.launchInput);
            const follow = capture?.view === 'status' && capture.input.source.kind === 'environment'
                ? { kind: 'status' as const, input: capture }
                : capture && isRollingCaptureDemand(capture) && capture.windowMs !== undefined
                    ? { kind: 'rolling' as const, input: capture, windowMs: capture.windowMs }
                    : null;
            if (follow) {
                const selected = follow.input;
                if (selected.view === 'queries' && selected.input.databaseTarget !== undefined) return unavailable();
                const acquire = options.acquireSelection;
                if (!acquire) return unavailable();
                let invalidate: (() => void) | undefined;
                let stop: (() => void) | undefined;
                let disposed = false;
                // Authority and the database lease are captured once for this demand. The subscription is
                // installed after admission and before the first snapshot so a concurrent commit is visible.
                const source = selected.view === 'metrics'
                    ? { kind: 'environment' as const, serverId: selected.input.serverId, environmentId: selected.input.environmentId }
                    : selected.input.source;
                const actionId = selected.view === 'status' ? database.DATABASE_CAPTURE_STATUS_ACTION_ID_V1
                    : database.DATABASE_CAPTURE_LIST_ACTION_BY_VIEW_V1[selected.view];
                const binding = acquire(source, context, actionId)
                    .then(async admission => {
                        if (disposed || context.signal.aborted) {
                            await admission.release();
                            throw new PluginError({ code: 'plugin_resource_aborted' });
                        }
                        stop = options.subscribe([admission.partition], () => invalidate?.());
                        return { readers: createCaptureSelectedSourceReaders(admission), admission };
                    });
                // The host calls observe before its baseline read. Keep the first typed failure for that read.
                void binding.catch(() => {});
                return {
                    async read(invocation) {
                        invocation.signal.throwIfAborted();
                        const { readers, admission } = await binding;
                        invocation.signal.throwIfAborted();
                        if (follow.kind === 'status') {
                            return JSON.stringify({ view: follow.input.view, result: await readers.captureStatus(follow.input.input) });
                        }
                        const page = await readRollingCapturePage(follow.input, readers, admission, follow.windowMs);
                        return JSON.stringify('window' in page ? { ...page, coverage: admission.runtime.ingest.coverage(admission.partition) } : page);
                    },
                    observe(callback) {
                        invalidate = callback;
                        return { dispose() { if (invalidate === callback) invalidate = undefined; } };
                    },
                    async dispose() {
                        if (disposed) return;
                        disposed = true;
                        invalidate = undefined;
                        stop?.();
                        const held = await binding.catch(() => null);
                        await held?.admission.release();
                    },
                };
            }
            const finite = capture.view === 'metrics' ? unavailable() : capture;
            let invalidate: (() => void) | undefined;
            let stop: (() => void) | undefined;
            const unsubscribe = () => { stop?.(); stop = undefined; };
            return {
                async read(invocation) {
                    try {
                        const snapshot = await readCaptureResourceSnapshot(context, finite, invocation.signal);
                        const partitions = snapshot.result.ok ? [captureSourcePartition(snapshot.result.source, context.requesterAccount?.accountId)] : [];
                        if (!partitions.length) unsubscribe();
                        else if (!stop && !context.signal.aborted) stop = options.subscribe(partitions, () => invalidate?.());
                        return JSON.stringify(snapshot);
                    } catch (error: unknown) { unsubscribe(); throw error; }
                },
                observe(callback) {
                    invalidate = callback;
                    return { dispose() { if (invalidate === callback) invalidate = undefined; } };
                },
                dispose() { invalidate = undefined; unsubscribe(); },
            };
        },
    };
}
