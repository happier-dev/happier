import { PluginError } from '@happier-dev/plugin-sdk';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginDynamicResourceRuntime } from '@happier-dev/plugin-sdk/resources';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import * as database from '@happier-dev/database-protocol';
import type { createCaptureBackgroundOwner } from './background.js';
import { captureSourcePartition } from './partition.js';
import { telemetryPartition } from './telemetry/assignments.js';

type ResourceContext = Parameters<NonNullable<PluginDynamicResourceRuntime['createProducer']>>[0];

/** The finite Action owns source admission and the existing database lease for every demanded read. */
async function readCaptureResourceSnapshot(context: ResourceContext, demand: database.DatabaseCaptureResourceInputV1,
    signal: AbortSignal): Promise<database.DatabaseCaptureResourceSnapshotV1> {
    async function read(actionId: database.DatabaseActionIdV1, input: JsonValue): Promise<unknown> {
        const outcome = await context.readAction({ pluginId: database.DATABASE_CAPTURE_RESOURCE_REF_V1.pluginId,
            localId: database.databaseActionLocalIdV1(actionId) }, input, { signal });
        if (!outcome.ok) throw new PluginError({ code: outcome.errorCode, message: outcome.error });
        return outcome.result;
    }
    const until = demand.view === 'metrics' ? Date.now() : 0;
    const input = projectNativeJsonValueForTransport(demand.view === 'metrics'
        ? { serverId: demand.input.serverId, environmentIds: demand.input.environmentIds,
            since: Math.max(0, until - demand.input.windowMs), until, measure: { kind: 'http', statistic: 'requests' } }
        : demand.input);
    switch (demand.view) {
        case 'metrics': return { view: demand.view, result: database.TelemetryEnvironmentMetricsReadResultV1Schema.parse(await read(database.TELEMETRY_METRICS_READ_ACTION_ID_V1, input)) };
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
            const demand = database.DatabaseCaptureResourceInputV1Schema.parse(context.context.launchInput);
            let invalidate: (() => void) | undefined;
            let stop: (() => void) | undefined;
            const unsubscribe = () => { stop?.(); stop = undefined; };
            return {
                async read(invocation) {
                    try {
                        const snapshot = await readCaptureResourceSnapshot(context, demand, invocation.signal);
                        const partitions = snapshot.view === 'metrics'
                            ? snapshot.result.items.map(item => telemetryPartition(item.environmentId))
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
