import { PluginError } from '@happier-dev/plugin-sdk';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginDynamicResourceRuntime } from '@happier-dev/plugin-sdk/resources';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { PluginServiceListFieldResourceInputV1Schema, type PluginServiceListFieldResourceInputV1,
    type PluginServiceListFieldResourceResultV1 } from '@happier-dev/plugin-sdk/ui';
import * as database from '@happier-dev/database-protocol';
import type { createCaptureBackgroundOwner } from './background.js';
import { captureSourcePartition } from './partition.js';
import { telemetryPartition } from './telemetry/assignments.js';

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

async function readServiceColumnSnapshot(context: ResourceContext, input: PluginServiceListFieldResourceInputV1,
    signal: AbortSignal): Promise<PluginServiceListFieldResourceResultV1> {
    const until = Date.now();
    const result = database.TelemetryEnvironmentMetricsReadResultV1Schema.parse(await readCaptureAction(
        context, database.TELEMETRY_METRICS_READ_ACTION_ID_V1, {
            serverId: input.serverId, environmentIds: input.environmentIds,
            since: Math.max(0, until - database.TELEMETRY_REQUESTS_WINDOW_MS_V1), until,
            measure: { kind: 'http', statistic: 'requests' },
            ...(input.includeTrend === false ? { includeTrend: false } : {}),
        }, signal));
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

async function readCaptureResourceSnapshot(context: ResourceContext, demand: database.DatabaseCaptureResourceInputV1,
    signal: AbortSignal): Promise<database.DatabaseCaptureResourceSnapshotV1> {
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

function unavailable(): never { throw new PluginError({ code: 'plugin_resource_producer_placement_unavailable' }); }

/** The Resource host owns bytes, refresh and disposal. No database service or second source admission is needed. */
export function createCaptureResourceRuntime(options: Readonly<{
    subscribe: ReturnType<typeof createCaptureBackgroundOwner>['subscribe'];
}>): PluginDynamicResourceRuntime {
    return {
        read: unavailable,
        observe: unavailable,
        async createProducer(context) {
            if (context.context.kind !== 'surface') throw new PluginError({ code: 'plugin_resource_demand_unavailable' });
            const serviceInput = PluginServiceListFieldResourceInputV1Schema.safeParse(context.context.launchInput);
            const demand = serviceInput.success ? { kind: 'service' as const, input: serviceInput.data }
                : { kind: 'capture' as const, input: database.DatabaseCaptureResourceInputV1Schema.parse(context.context.launchInput) };
            let invalidate: (() => void) | undefined;
            let stop: (() => void) | undefined;
            const unsubscribe = () => { stop?.(); stop = undefined; };
            return {
                async read(invocation) {
                    try {
                        const snapshot = demand.kind === 'service'
                            ? await readServiceColumnSnapshot(context, demand.input, invocation.signal)
                            : await readCaptureResourceSnapshot(context, demand.input, invocation.signal);
                        const partitions = 'items' in snapshot
                            ? snapshot.items.map(item => telemetryPartition(item.environmentId))
                            : snapshot.result.ok ? [captureSourcePartition(snapshot.result.source, context.requesterAccount?.accountId)] : [];
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
