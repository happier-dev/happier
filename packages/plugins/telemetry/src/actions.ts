import { databaseActionLocalIdV1, databaseActionMetadata } from '@happier-dev/plugin-sdk/actions';
import type { JsonValue, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginActionDefinition } from '@happier-dev/plugin-sdk/actions';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import * as database from '@happier-dev/database-protocol';
import type { PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';
import { configureCapturePreference, type CaptureProjectScope } from './configuration.js';
import { createCaptureReader } from './read.js';
import type { CaptureRuntime } from './runtime.js';
import type { CaptureListInput } from './store/capture.js';
import type { createCaptureBackgroundOwner } from './background.js';
import { readCaptureCostWindow } from './costs.js';

/** Internal producer bindings. Public Action schemas and target admission remain
 * with the Database catalogue/access owners; operands here have already been admitted. */
export function createCaptureActionProducers(options: Readonly<{
    runtime: CaptureRuntime;
    accountStorage?: PluginAccountStorageScope;
    stopProjectCapture: (project: CaptureProjectScope) => Promise<void>;
}>) {
    const { runtime } = options;
    const reader = createCaptureReader(runtime.store);
    return {
        status(input: Pick<CaptureListInput, 'worktree'>) {
            return { coverage: runtime.ingest.coverage(input.worktree) };
        },
        queriesList(input: Omit<CaptureListInput, 'kind' | 'spanKind'>) {
            return runtime.store.list({ ...input, kind: 'query' });
        },
        queryGet(input: Readonly<{ worktree: string; id: string }>) {
            return reader.detail(input.worktree, input.id);
        },
        tracesList: reader.requests,
        traceGet: reader.trace,
        logsList(input: Omit<CaptureListInput, 'kind' | 'spanKind'>) {
            return runtime.store.list({ ...input, kind: 'log' });
        },
        endpointsList: reader.endpoints,
        async clear(input: Pick<CaptureListInput, 'worktree'>) {
            await runtime.clear(input.worktree);
        },
        async configure(input: Readonly<{ project: CaptureProjectScope; enabled: boolean; retry?: true }>) {
            await configureCapturePreference(options.accountStorage, input.project, input.enabled);
            if (!input.enabled) await options.stopProjectCapture(input.project);
            if (input.retry === true) runtime.ingest.retry();
            return { enabled: input.enabled };
        },
    };
}

/** Public handlers consume already-admitted source/project producers; C6 metadata has one owner. */
export type CapturePublicActionProducers = Readonly<{
    readCapturedCosts?: (input: database.DatabaseCaptureCostsReadInputV1, context: PluginInvocationContext)
        => database.DatabaseCaptureCostsReadResultV1 | Promise<database.DatabaseCaptureCostsReadResultV1>;
    captureStatus?: (input: database.DatabaseCaptureStatusInputV1, context: PluginInvocationContext)
        => database.DatabaseCaptureStatusResultV1 | Promise<database.DatabaseCaptureStatusResultV1>;
    listCapturedQueries?: (input: database.DatabaseCaptureQueriesListInputV1, context: PluginInvocationContext)
        => database.DatabaseCaptureQueriesListResultV1 | Promise<database.DatabaseCaptureQueriesListResultV1>;
    getCapturedQuery?: (input: database.DatabaseCaptureQueryGetInputV1, context: PluginInvocationContext)
        => database.DatabaseCaptureQueryGetResultV1 | Promise<database.DatabaseCaptureQueryGetResultV1>;
    listCapturedTraces?: (input: database.DatabaseCaptureTracesListInputV1, context: PluginInvocationContext)
        => database.DatabaseCaptureTracesListResultV1 | Promise<database.DatabaseCaptureTracesListResultV1>;
    getCapturedTrace?: (input: database.DatabaseCaptureTraceGetInputV1, context: PluginInvocationContext)
        => database.DatabaseCaptureTraceGetResultV1 | Promise<database.DatabaseCaptureTraceGetResultV1>;
    listCapturedLogs?: (input: database.DatabaseCaptureLogsListInputV1, context: PluginInvocationContext)
        => database.DatabaseCaptureLogsListResultV1 | Promise<database.DatabaseCaptureLogsListResultV1>;
    listCapturedEndpoints?: (input: database.DatabaseCaptureEndpointsListInputV1, context: PluginInvocationContext)
        => database.DatabaseCaptureEndpointsListResultV1 | Promise<database.DatabaseCaptureEndpointsListResultV1>;
    clearCapture?: (input: database.DatabaseCaptureClearInputV1, context: PluginInvocationContext)
        => database.DatabaseCaptureClearResultV1 | Promise<database.DatabaseCaptureClearResultV1>;
    configureCapture?: (input: database.DatabaseCaptureConfigureInputV1, context: PluginInvocationContext)
        => database.DatabaseCaptureConfigureResultV1 | Promise<database.DatabaseCaptureConfigureResultV1>;
}>;

/** The SDK validates each canonical operand/result; missing producers register no callable Action. */
export function createCaptureActions(producers: CapturePublicActionProducers): Record<string, PluginActionDefinition> {
    const actions: Record<string, PluginActionDefinition> = {};
    const common = { execution: { target: 'daemon' }, scopes: ['global'], surfaces: ['ui', 'cli', 'agent', 'mcp', 'plugin'] } as const;
    const readCapturedCosts = producers.readCapturedCosts;
    if (readCapturedCosts) {
        const metadata = databaseActionMetadata[database.TELEMETRY_COSTS_READ_ACTION_ID_V1];
        actions[database.databaseActionLocalIdV1(database.TELEMETRY_COSTS_READ_ACTION_ID_V1)] = {
            ...common, ...metadata,
            inputSchema: database.DatabaseCaptureCostsReadInputV1ProtocolSchema,
            resultSchema: database.DatabaseCaptureCostsReadResultV1ProtocolSchema,
            run: async (input: JsonValue, context: PluginInvocationContext) => projectNativeJsonValueForTransport(
                await readCapturedCosts(input as database.DatabaseCaptureCostsReadInputV1, context)),
        };
    }
    const captureStatus = producers.captureStatus;
    if (captureStatus) {
        const metadata = databaseActionMetadata[database.DATABASE_CAPTURE_STATUS_ACTION_ID_V1];
        actions[database.databaseActionLocalIdV1(database.DATABASE_CAPTURE_STATUS_ACTION_ID_V1)] = {
            ...common, ...metadata,
            inputSchema: database.DatabaseCaptureStatusInputV1ProtocolSchema,
            resultSchema: database.DatabaseCaptureStatusResultV1ProtocolSchema,
            // definePlugin admits this exact canonical input before invoking the producer.
            run: async (input: JsonValue, context: PluginInvocationContext) => projectNativeJsonValueForTransport(
                await captureStatus(input as database.DatabaseCaptureStatusInputV1, context)),
        };
    }
    const listCapturedQueries = producers.listCapturedQueries;
    if (listCapturedQueries) {
        const metadata = databaseActionMetadata[database.DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1];
        actions[database.databaseActionLocalIdV1(database.DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1)] = {
            ...common, ...metadata,
            inputSchema: database.DatabaseCaptureQueriesListInputV1ProtocolSchema,
            resultSchema: database.DatabaseCaptureQueriesListResultV1ProtocolSchema,
            // definePlugin admits this exact canonical input before invoking the producer.
            run: async (input: JsonValue, context: PluginInvocationContext) => projectNativeJsonValueForTransport(
                await listCapturedQueries(input as database.DatabaseCaptureQueriesListInputV1, context)),
        };
    }
    const getCapturedQuery = producers.getCapturedQuery;
    if (getCapturedQuery) {
        const metadata = databaseActionMetadata[database.DATABASE_CAPTURE_QUERY_GET_ACTION_ID_V1];
        actions[database.databaseActionLocalIdV1(database.DATABASE_CAPTURE_QUERY_GET_ACTION_ID_V1)] = {
            ...common, ...metadata,
            inputSchema: database.DatabaseCaptureQueryGetInputV1ProtocolSchema,
            resultSchema: database.DatabaseCaptureQueryGetResultV1ProtocolSchema,
            // definePlugin admits this exact canonical input before invoking the producer.
            run: async (input: JsonValue, context: PluginInvocationContext) => projectNativeJsonValueForTransport(
                await getCapturedQuery(input as database.DatabaseCaptureQueryGetInputV1, context)),
        };
    }
    const listCapturedTraces = producers.listCapturedTraces;
    if (listCapturedTraces) {
        const metadata = databaseActionMetadata[database.DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1];
        actions[database.databaseActionLocalIdV1(database.DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1)] = {
            ...common, ...metadata,
            inputSchema: database.DatabaseCaptureTracesListInputV1ProtocolSchema,
            resultSchema: database.DatabaseCaptureTracesListResultV1ProtocolSchema,
            // definePlugin admits this exact canonical input before invoking the producer.
            run: async (input: JsonValue, context: PluginInvocationContext) => projectNativeJsonValueForTransport(
                await listCapturedTraces(input as database.DatabaseCaptureTracesListInputV1, context)),
        };
    }
    const getCapturedTrace = producers.getCapturedTrace;
    if (getCapturedTrace) {
        const metadata = databaseActionMetadata[database.DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1];
        actions[database.databaseActionLocalIdV1(database.DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1)] = {
            ...common, ...metadata,
            inputSchema: database.DatabaseCaptureTraceGetInputV1ProtocolSchema,
            resultSchema: database.DatabaseCaptureTraceGetResultV1ProtocolSchema,
            // definePlugin admits this exact canonical input before invoking the producer.
            run: async (input: JsonValue, context: PluginInvocationContext) => projectNativeJsonValueForTransport(
                await getCapturedTrace(input as database.DatabaseCaptureTraceGetInputV1, context)),
        };
    }
    const listCapturedLogs = producers.listCapturedLogs;
    if (listCapturedLogs) {
        const metadata = databaseActionMetadata[database.DATABASE_CAPTURE_LOGS_LIST_ACTION_ID_V1];
        actions[database.databaseActionLocalIdV1(database.DATABASE_CAPTURE_LOGS_LIST_ACTION_ID_V1)] = {
            ...common, ...metadata,
            inputSchema: database.DatabaseCaptureLogsListInputV1ProtocolSchema,
            resultSchema: database.DatabaseCaptureLogsListResultV1ProtocolSchema,
            // definePlugin admits this exact canonical input before invoking the producer.
            run: async (input: JsonValue, context: PluginInvocationContext) => projectNativeJsonValueForTransport(
                await listCapturedLogs(input as database.DatabaseCaptureLogsListInputV1, context)),
        };
    }
    const listCapturedEndpoints = producers.listCapturedEndpoints;
    if (listCapturedEndpoints) {
        const metadata = databaseActionMetadata[database.DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1];
        actions[database.databaseActionLocalIdV1(database.DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1)] = {
            ...common, ...metadata,
            inputSchema: database.DatabaseCaptureEndpointsListInputV1ProtocolSchema,
            resultSchema: database.DatabaseCaptureEndpointsListResultV1ProtocolSchema,
            // definePlugin admits this exact canonical input before invoking the producer.
            run: async (input: JsonValue, context: PluginInvocationContext) => projectNativeJsonValueForTransport(
                await listCapturedEndpoints(input as database.DatabaseCaptureEndpointsListInputV1, context)),
        };
    }
    const clearCapture = producers.clearCapture;
    if (clearCapture) {
        const metadata = databaseActionMetadata[database.DATABASE_CAPTURE_CLEAR_ACTION_ID_V1];
        actions[database.databaseActionLocalIdV1(database.DATABASE_CAPTURE_CLEAR_ACTION_ID_V1)] = {
            ...common, ...metadata,
            inputSchema: database.DatabaseCaptureClearInputV1ProtocolSchema,
            resultSchema: database.DatabaseCaptureClearResultV1ProtocolSchema,
            // definePlugin admits this exact canonical input before invoking the producer.
            run: async (input: JsonValue, context: PluginInvocationContext) => projectNativeJsonValueForTransport(
                await clearCapture(input as database.DatabaseCaptureClearInputV1, context)),
        };
    }
    const configureCapture = producers.configureCapture;
    if (configureCapture) {
        const metadata = databaseActionMetadata[database.DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1];
        actions[database.databaseActionLocalIdV1(database.DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1)] = {
            ...common, ...metadata,
            inputSchema: database.DatabaseCaptureConfigureInputV1ProtocolSchema,
            resultSchema: database.DatabaseCaptureConfigureResultV1ProtocolSchema,
            // definePlugin admits this exact canonical input before invoking the producer.
            run: async (input: JsonValue, context: PluginInvocationContext) => projectNativeJsonValueForTransport(
                await configureCapture(input as database.DatabaseCaptureConfigureInputV1, context)),
        };
    }
    return actions;
}

/** The ACCESS/source owner supplies this admitted result. P5 does not derive a partition from operands. */
export type AdmittedCaptureSource = Readonly<{ source: database.DatabaseCaptureSourceV1; partition: string; runtime: CaptureRuntime }>;
export type AdmittedCaptureScope = Pick<AdmittedCaptureSource, 'source' | 'partition'>;
export type CaptureSourceAdmission = (input: database.DatabaseCaptureStatusInputV1, context: PluginInvocationContext,
    actionId: database.DatabaseActionIdV1) => Promise<AdmittedCaptureScope>;

/** Actions and a demanded Resource share the exact same selected-source DTO projection. */
export function createCaptureSelectedSourceReaders(selected: AdmittedCaptureSource) {
    const page = (items: readonly database.DatabaseCaptureSummaryV1[], limit: number) => {
        const last = items.at(-1);
        return { ok: true as const, source: selected.source, items: [...items], ...(last && items.length === limit ? { nextCursor: { at: last.at, id: last.id } } : {}) };
    };
    return {
        async readCapturedCosts(input: database.DatabaseCaptureCostsReadInputV1) {
            return { ok: true as const, source: selected.source, ...await readCaptureCostWindow(selected.runtime, {
                worktree: selected.partition, since: input.since, until: input.until, serviceName: input.serviceName,
                serviceVersion: input.serviceVersion, granularity: input.granularity,
            }) };
        },
        async captureStatus(input: database.DatabaseCaptureStatusInputV1) {
            return { ok: true as const, source: selected.source, coverage: selected.runtime.ingest.coverage(selected.partition) };
        },
        async listCapturedQueries(input: database.DatabaseCaptureQueriesListInputV1) {
            return page(await selected.runtime.store.list({ ...input.page, since: input.since, until: input.until,
                traceId: input.traceId, worktree: selected.partition, kind: 'query' }), input.page.limit);
        },
        async getCapturedQuery(input: database.DatabaseCaptureQueryGetInputV1) {
            return { ok: true as const, source: selected.source, detail: await selected.runtime.store.detail(selected.partition, input.id) };
        },
        async listCapturedTraces(input: database.DatabaseCaptureTracesListInputV1) {
            return page(await createCaptureReader(selected.runtime.store).requests({ ...input.page, since: input.since,
                until: input.until, worktree: selected.partition }), input.page.limit);
        },
        async getCapturedTrace(input: database.DatabaseCaptureTraceGetInputV1) {
            const trace = await createCaptureReader(selected.runtime.store).trace({ worktree: selected.partition,
                traceId: input.traceId, pageSize: input.page.limit });
            return { ok: true as const, source: selected.source, traceId: input.traceId, summaries: [...trace.summaries],
                repeatedQueries: trace.repeatedQueries.map(query => ({ ...query, observationIds: [...query.observationIds], callsites: [...query.callsites] })),
                slowChildSpans: trace.slowChildSpans, logCorrelations: trace.logCorrelations };
        },
        async listCapturedLogs(input: database.DatabaseCaptureLogsListInputV1) {
            return page(await selected.runtime.store.list({ ...input.page, since: input.since, until: input.until,
                serviceName: input.serviceName, severityNumber: input.severityNumber,
                worktree: selected.partition, kind: 'log' }), input.page.limit);
        },
        async listCapturedEndpoints(input: database.DatabaseCaptureEndpointsListInputV1) {
            const items = await createCaptureReader(selected.runtime.store).endpoints({ ...input.page, since: input.since,
                until: input.until, worktree: selected.partition, pageSize: input.page.limit });
            const last = items.at(-1);
            return { ok: true as const, source: selected.source, items: [...items], ...(last && items.length === input.page.limit
                ? { nextCursor: { serviceName: last.serviceName, method: last.method, route: last.route } } : {}) };
        },
        async clearCapture(input: database.DatabaseCaptureClearInputV1) {
            await selected.runtime.clear(selected.partition);
            return { ok: true as const };
        },
    };
}

/** One source-owner admission precedes each finite Action. A Resource retains the same admitted readers. */
export function createCapturePublicActionProducers(options: Readonly<{
    admitSource: CaptureSourceAdmission;
    acquireRuntime: ReturnType<typeof createCaptureBackgroundOwner>['acquireRuntime'];
    configureCapture?: CapturePublicActionProducers['configureCapture'];
}>): CapturePublicActionProducers {
    async function withSource<T>(input: database.DatabaseCaptureStatusInputV1, context: PluginInvocationContext,
        actionId: database.DatabaseActionIdV1, read: (readers: ReturnType<typeof createCaptureSelectedSourceReaders>) => Promise<T>): Promise<T> {
        const scope = await options.admitSource(input, context, actionId);
        const lease = await options.acquireRuntime(context);
        try { return await read(createCaptureSelectedSourceReaders({ ...scope, runtime: lease.runtime })); }
        finally { await lease.release(); }
    }
    return {
        async readCapturedCosts(input, context) {
            return withSource(input, context, database.TELEMETRY_COSTS_READ_ACTION_ID_V1, readers => readers.readCapturedCosts(input));
        },
        async captureStatus(input, context) {
            return withSource(input, context, database.DATABASE_CAPTURE_STATUS_ACTION_ID_V1, readers => readers.captureStatus(input));
        },
        async listCapturedQueries(input, context) {
            return withSource(input, context, database.DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1, readers => readers.listCapturedQueries(input));
        },
        async getCapturedQuery(input, context) {
            return withSource(input, context, database.DATABASE_CAPTURE_QUERY_GET_ACTION_ID_V1, readers => readers.getCapturedQuery(input));
        },
        async listCapturedTraces(input, context) {
            return withSource(input, context, database.DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1, readers => readers.listCapturedTraces(input));
        },
        async getCapturedTrace(input, context) {
            return withSource(input, context, database.DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1, readers => readers.getCapturedTrace(input));
        },
        async listCapturedLogs(input, context) {
            return withSource(input, context, database.DATABASE_CAPTURE_LOGS_LIST_ACTION_ID_V1, readers => readers.listCapturedLogs(input));
        },
        async listCapturedEndpoints(input, context) {
            return withSource(input, context, database.DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1, readers => readers.listCapturedEndpoints(input));
        },
        async clearCapture(input, context) {
            return withSource(input, context, database.DATABASE_CAPTURE_CLEAR_ACTION_ID_V1, readers => readers.clearCapture(input));
        },
        ...(options.configureCapture ? { configureCapture: options.configureCapture } : {}),
    };
}
