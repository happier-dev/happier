import * as React from 'react';
import {
  DATABASE_CAPTURE_CLEAR_ACTION_ID_V1,
  DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1,
  DatabaseCaptureClearResultV1Schema,
  DatabaseCaptureConfigureResultV1Schema,
  DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1,
  DATABASE_CAPTURE_LIST_ACTION_BY_VIEW_V1,
  DATABASE_CAPTURE_LOGS_LIST_ACTION_ID_V1,
  DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1,
  DATABASE_CAPTURE_QUERY_GET_ACTION_ID_V1,
  DATABASE_CAPTURE_STATUS_ACTION_ID_V1,
  DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1,
  DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1,
  DatabaseCaptureEndpointsListResultV1Schema,
  DatabaseCaptureLogsListResultV1Schema,
  DatabaseCaptureQueriesListResultV1Schema,
  DatabaseCaptureResourceSnapshotV1Schema,
  DatabaseCaptureQueryGetResultV1Schema,
  DatabaseCaptureStatusResultV1Schema,
  DatabaseCaptureTraceGetResultV1Schema,
  DatabaseCaptureTracesListResultV1Schema,
  type DatabaseCaptureCoverageV1,
  type DatabaseCaptureEndpointCursorV1,
  type DatabaseCaptureEndpointV1,
  type DatabaseCaptureCursorV1,
  type DatabaseCaptureSummaryV1,
  type DatabaseCaptureSourceV1,
  type DatabaseCaptureTracesListInputV1,
  TELEMETRY_COSTS_READ_ACTION_ID_V1,
  TELEMETRY_METRICS_READ_ACTION_ID_V1,
} from '@happier-dev/database-protocol';
import { PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1 } from '@happier-dev/plugin-sdk/storage';
import { projectCapturedLogBody } from '@happier-dev/plugins-telemetry/capture-views';
import { ActionApprovalRequestCreatedResultSchema, createActionExecuteFailureError, parseActionExecuteFailure, type ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { USAGE_PRICE_ACTION_IDS } from '@happier-dev/protocol/usage/usageActionIdsV1';
import type { PluginUiTelemetryCaptureReadReferenceV1 } from '@happier-dev/protocol/daemon/machineServiceLogsResource';
import type { MachineResourceClientFactory } from '@/components/machines/resources/useMachineServiceResource';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createFrontDoorUiActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { HappyError } from '@/utils/errors/errors';
import { readSafeFailureDetails, type ActionFailureContext } from '@/utils/errors/alertActionFailure';

/**
 * Capture reads (P6 F14d, P5 F7): the same `capture/*` Actions every capture reader uses, with an Environment (relayed
 * to its collector Machine) or a worktree checkout (on the Machine that runs it) as their source. The Action's admission decides once
 * per request that this viewer may read the Environment; there is no timer and no retry loop here.
 */
export type TelemetryCaptureActionId =
  | typeof DATABASE_CAPTURE_CLEAR_ACTION_ID_V1
  | typeof DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1
  | typeof DATABASE_CAPTURE_STATUS_ACTION_ID_V1
  | typeof DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1
  | typeof DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1
  | typeof DATABASE_CAPTURE_LOGS_LIST_ACTION_ID_V1
  | typeof DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1
  | typeof DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1
  | typeof DATABASE_CAPTURE_QUERY_GET_ACTION_ID_V1
  | typeof TELEMETRY_METRICS_READ_ACTION_ID_V1
  | typeof TELEMETRY_COSTS_READ_ACTION_ID_V1;

export type TelemetryCaptureInvoke = (
  request: Readonly<{
    scope: ServerAccountScope;
    collectorMachineId: string;
    actionId: TelemetryCaptureActionId;
    input: unknown;
    signal?: AbortSignal;
  }>,
) => Promise<unknown>;

/** The one network edge: the Action front door, targeted at the collector Machine. */
const invokeThroughFrontDoor: TelemetryCaptureInvoke = (request) =>
  createFrontDoorUiActionExecutor(undefined, {
    serverId: request.scope.serverId,
    expectedAccountId: request.scope.accountId,
  })(
    'action.invoke',
    {
      action: parseQualifiedPluginActionId(request.actionId)!,
      input: request.input,
    },
    {
      externalActionTarget: {
        kind: 'machine',
        machineId: request.collectorMachineId,
      },
      ...(request.signal ? { signal: request.signal } : {}),
    },
  );

/** The viewer's Usage model prices for the App calls a collector reported (Usage's own `usage.prices.get`). */
export type TelemetryUsagePricesRead = (
  request: Readonly<{ scope: ServerAccountScope; modelIds: readonly string[]; signal?: AbortSignal }>,
) => Promise<unknown>;

const readPricesThroughFrontDoor: TelemetryUsagePricesRead = (request) =>
  createFrontDoorUiActionExecutor(undefined, {
    serverId: request.scope.serverId,
    expectedAccountId: request.scope.accountId,
  })(USAGE_PRICE_ACTION_IDS.get, { modelIds: [...request.modelIds] }, request.signal ? { signal: request.signal } : undefined);

/** Dev specimens and tests supply fixture collector answers (and the Home's price catalog) here. */
export const TelemetryCaptureTransportContext = React.createContext<Readonly<{
  invoke: TelemetryCaptureInvoke;
  createResourceClient?: MachineResourceClientFactory;
  readPrices?: TelemetryUsagePricesRead;
}>>({ invoke: invokeThroughFrontDoor, readPrices: readPricesThroughFrontDoor });

export function useTelemetryUsagePricesRead(): TelemetryUsagePricesRead {
  return React.useContext(TelemetryCaptureTransportContext).readPrices ?? readPricesThroughFrontDoor;
}

/** The costs read's bucket: hours for a day or less, so a day's chart has bars; days for longer windows. */
export function telemetryCostsGranularity(windowMs: number): 'hour' | 'day' {
  return windowMs > 2 * 86_400_000 ? 'day' : 'hour';
}

export function telemetryCaptureFailureCode(error: unknown): string {
  return telemetryCaptureFailure(error).code;
}

/** The existing capture error and Action envelopes share one diagnostic projection. */
export function telemetryCaptureFailure(error: unknown): Readonly<{
  code: string; failureCause?: ActionFailureCauseV1; context: ActionFailureContext;
}> {
  const action = parseActionExecuteFailure(error);
  const failure = action ?? (error instanceof HappyError ? error : undefined);
  return {
    code: action?.errorCode ?? (error instanceof HappyError ? error.code : undefined) ?? 'telemetry_unavailable',
    failureCause: failure?.failureCause,
    context: {
      ...readSafeFailureDetails(failure?.details),
      ...(failure?.requestId === undefined ? {} : { requestId: failure.requestId }),
      ...(failure?.effectAttempted === undefined ? {} : { effectAttempted: failure.effectAttempted }),
    },
  };
}

/** Collector reads answer typed failures in-band (`{ ok: false, code }`); a shape this build cannot read says so. */
function settle<T extends { ok: boolean }>(
  parsed: { success: true; data: T } | { success: false },
): Extract<T, { ok: true }> {
  if (!parsed.success) {
    throw unreadableCapture();
  }
  const data = parsed.data as T & { code?: unknown; reason?: unknown; cause?: { message?: unknown } };
  if (!data.ok) {
    const code = typeof data.code === 'string' ? data.code : 'telemetry_unavailable';
    const message = typeof data.cause?.message === 'string'
      ? data.cause.message
      : typeof data.reason === 'string' ? data.reason : code;
    throw new HappyError(message, false, { code, details: data });
  }
  return data as Extract<T, { ok: true }>;
}


/** Turn on/off settles, or the person's approval policy holds it as an approval request. */
export type TelemetryCaptureConfigureOutcome =
  | Readonly<{ kind: 'configured'; enabled: boolean }>
  | Readonly<{ kind: 'approval_pending'; artifactId: string }>;

export type TelemetryCaptureList = Exclude<keyof typeof DATABASE_CAPTURE_LIST_ACTION_BY_VIEW_V1, 'costs' | 'metrics'>;
export type TelemetryAppLlmCallSelection = NonNullable<DatabaseCaptureTracesListInputV1['appLlmCalls']>;
export type TelemetryMetricsSelection = Readonly<{ serviceName?: string; serviceVersion?: string }>;
export type TelemetryCapturePage<Item, Cursor> = Readonly<{
  items: readonly Item[];
  nextCursor: Cursor | null;
}>;
export type TelemetryCaptureListPage =
  | (Readonly<{ list: 'endpoints' }> & TelemetryCapturePage<DatabaseCaptureEndpointV1, DatabaseCaptureEndpointCursorV1>)
  | (Readonly<{ list: Exclude<TelemetryCaptureList, 'endpoints'> }> & TelemetryCapturePage<DatabaseCaptureSummaryV1, DatabaseCaptureCursorV1>);
export type TelemetryCaptureListSnapshot = Readonly<{
  page: TelemetryCaptureListPage;
  window: Readonly<{ since: number; until: number }>;
  coverage: DatabaseCaptureCoverageV1 | undefined;
}>;

function unreadableCapture() {
  const code = 'telemetry_unreadable';
  return new HappyError(code, false, { code });
}

function readTelemetryCaptureSnapshot(bytes: Uint8Array) {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw unreadableCapture();
  }
  const parsed = DatabaseCaptureResourceSnapshotV1Schema.safeParse(raw);
  if (!parsed.success) throw unreadableCapture();
  return parsed.data;
}

export function readTelemetryCaptureCostsSnapshot(bytes: Uint8Array) {
  const snapshot = readTelemetryCaptureSnapshot(bytes);
  if (snapshot.view !== 'costs') throw unreadableCapture();
  return settle({ success: true, data: snapshot.result });
}

export function readTelemetryCaptureMetricsSnapshot(bytes: Uint8Array) {
  const snapshot = readTelemetryCaptureSnapshot(bytes);
  if (snapshot.view !== 'metrics') throw unreadableCapture();
  return snapshot.result;
}

export function readTelemetryCaptureStatusSnapshot(bytes: Uint8Array) {
  const snapshot = readTelemetryCaptureSnapshot(bytes);
  if (snapshot.view !== 'status') throw unreadableCapture();
  return settle({ success: true, data: snapshot.result });
}

export function readTelemetryCaptureListSnapshot(list: TelemetryCaptureList, bytes: Uint8Array): TelemetryCaptureListSnapshot {
  const snapshot = readTelemetryCaptureSnapshot(bytes);
  if (snapshot.view !== list) throw unreadableCapture();
  if (!snapshot.window) throw unreadableCapture();
  const { window, coverage } = snapshot;
  if (snapshot.view === 'endpoints') {
    const { items, nextCursor } = settle({ success: true, data: snapshot.result });
    return { page: { list: snapshot.view, items, nextCursor: nextCursor ?? null }, window, coverage };
  }
  const { items, nextCursor } = settle({ success: true, data: snapshot.result });
  return { page: { list: snapshot.view, items, nextCursor: nextCursor ?? null }, window, coverage };
}

/** The place whose capture is read: an Environment on its collector, or one worktree checkout on its own Machine. */
export type TelemetryCaptureEnvironment = Readonly<{
  scope: ServerAccountScope;
  collectorMachineId: string;
}> & (
  | Readonly<{ environmentId: string; worktree?: undefined }>
  | Readonly<{ environmentId?: undefined; worktree: Readonly<{ projectId: string; workspaceId: string }> }>
);

/** The host's own result-row bound for one read; the collector pages beneath it. */
const PAGE_LIMIT = PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1.maximumResultRows;

function source(environment: TelemetryCaptureEnvironment): DatabaseCaptureSourceV1 {
  if (environment.worktree) {
    return {
      kind: 'worktree' as const,
      serverId: environment.scope.serverId,
      machineId: environment.collectorMachineId,
      projectId: environment.worktree.projectId,
      workspaceId: environment.worktree.workspaceId,
    };
  }
  return {
    kind: 'environment' as const,
    serverId: environment.scope.serverId,
    environmentId: environment.environmentId,
  };
}

/** The Environment-bound capture reads one Telemetry tab makes, each one Action request on the collector. */
export function createTelemetryCaptureReads(
  invoke: TelemetryCaptureInvoke,
  environment: TelemetryCaptureEnvironment,
) {
  const call = async (
    actionId: TelemetryCaptureActionId,
    input: unknown,
    signal?: AbortSignal,
  ) => {
    const result = await invoke({
      scope: environment.scope,
      collectorMachineId: environment.collectorMachineId,
      actionId,
      input,
      ...(signal ? { signal } : {}),
    });
    const failure = parseActionExecuteFailure(result);
    if (failure) throw createActionExecuteFailureError(failure);
    return result;
  };
  const window = (since: number, until: number) => ({ since, until });
  return {
    targetMachineId: environment.collectorMachineId,
    listReference(list: TelemetryCaptureList, windowMs: number, appLlmCalls?: TelemetryAppLlmCallSelection): PluginUiTelemetryCaptureReadReferenceV1 {
      return {
        hostRead: 'telemetry.capture',
        input: {
          action: parseQualifiedPluginActionId(DATABASE_CAPTURE_LIST_ACTION_BY_VIEW_V1[list])!,
          input: { source: source(environment), page: { limit: PAGE_LIMIT }, ...(appLlmCalls ? { appLlmCalls } : {}) },
        },
        windowMs,
      };
    },
    costsReference(selection: TelemetryAppLlmCallSelection, windowMs: number): PluginUiTelemetryCaptureReadReferenceV1 {
      return {
        hostRead: 'telemetry.capture',
        input: {
          action: parseQualifiedPluginActionId(TELEMETRY_COSTS_READ_ACTION_ID_V1)!,
          input: { source: source(environment), ...selection, granularity: telemetryCostsGranularity(windowMs), groupByRoute: true },
        },
        windowMs,
      };
    },
    metricsReference(selection: TelemetryMetricsSelection, windowMs: number): PluginUiTelemetryCaptureReadReferenceV1 {
      return {
        hostRead: 'telemetry.capture',
        input: {
          action: parseQualifiedPluginActionId(TELEMETRY_METRICS_READ_ACTION_ID_V1)!,
          input: { view: 'overview', serverId: environment.scope.serverId, environmentId: environment.environmentId, ...selection },
        },
        windowMs,
      };
    },
    statusReference(): PluginUiTelemetryCaptureReadReferenceV1 {
      return {
        hostRead: 'telemetry.capture',
        input: { action: parseQualifiedPluginActionId(DATABASE_CAPTURE_STATUS_ACTION_ID_V1)!, input: { source: source(environment) } },
      };
    },
    async clear() {
      return settle(DatabaseCaptureClearResultV1Schema.safeParse(
        await call(DATABASE_CAPTURE_CLEAR_ACTION_ID_V1, { source: source(environment) }),
      ));
    },
    /**
     * A worktree's Project Capture switch on its Machine (P5 Q3); the person's press is the confirmation. `retry`
     * asks a switch that is already on to bind again after a gap.
     */
    async configure(enabled: boolean, options?: Readonly<{ retry: true }>): Promise<TelemetryCaptureConfigureOutcome> {
      if (!environment.worktree) throw new HappyError('telemetry_unavailable', false, { code: 'telemetry_unavailable' });
      const project = { serverId: environment.scope.serverId, machineId: environment.collectorMachineId,
        projectId: environment.worktree.projectId };
      const result = await call(DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1, { project, enabled, ...(options?.retry ? { retry: true } : {}) });
      const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result);
      if (approval.success) return { kind: 'approval_pending', artifactId: approval.data.artifactId };
      return { kind: 'configured', enabled: settle(DatabaseCaptureConfigureResultV1Schema.safeParse(result)).enabled };
    },
    async status(signal?: AbortSignal) {
      return settle(
        DatabaseCaptureStatusResultV1Schema.safeParse(
          await call(DATABASE_CAPTURE_STATUS_ACTION_ID_V1, { source: source(environment) }, signal),
        ),
      );
    },
    async endpoints(
      since: number,
      until: number,
      before: DatabaseCaptureEndpointCursorV1 | null,
      signal?: AbortSignal,
    ): Promise<
      TelemetryCapturePage<
        DatabaseCaptureEndpointV1,
        DatabaseCaptureEndpointCursorV1
      >
    > {
      const page = settle(
        DatabaseCaptureEndpointsListResultV1Schema.safeParse(
          await call(
            DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1,
            {
              source: source(environment),
              page: { limit: PAGE_LIMIT, ...(before ? { before } : {}) },
              ...window(since, until),
            },
            signal,
          ),
        ),
      );
      return { items: page.items, nextCursor: page.nextCursor ?? null };
    },
    async endpointFinding(endpoint: DatabaseCaptureEndpointCursorV1, since: number, until: number, signal: AbortSignal) {
      const result = settle(DatabaseCaptureEndpointsListResultV1Schema.safeParse(await call(
        DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1,
        { source: source(environment), page: { limit: 1 }, endpoint, ...window(since, until) }, signal,
      )));
      return result.finding;
    },
    async summaries(
      list: Exclude<TelemetryCaptureList, 'endpoints'>,
      since: number,
      until: number,
      before: DatabaseCaptureCursorV1 | null,
      signal?: AbortSignal,
    ): Promise<
      TelemetryCapturePage<DatabaseCaptureSummaryV1, DatabaseCaptureCursorV1>
    > {
      const input = {
        source: source(environment),
        page: { limit: PAGE_LIMIT, ...(before ? { before } : {}) },
        ...window(since, until),
      };
      const raw = await call(
        DATABASE_CAPTURE_LIST_ACTION_BY_VIEW_V1[list],
        input,
        signal,
      );
      const schema =
        list === 'traces'
          ? DatabaseCaptureTracesListResultV1Schema
          : list === 'logs'
            ? DatabaseCaptureLogsListResultV1Schema
            : DatabaseCaptureQueriesListResultV1Schema;
      const page = settle(schema.safeParse(raw));
      return { items: page.items, nextCursor: page.nextCursor ?? null };
    },
    /** Retained individual calls for the LLM calls view; each row keeps its own Trace detail operand. */
    async appLlmCalls(
      selection: TelemetryAppLlmCallSelection,
      since: number,
      until: number,
      before: DatabaseCaptureCursorV1 | null,
      signal?: AbortSignal,
    ) {
      const input = { source: source(environment), page: { limit: PAGE_LIMIT, ...(before ? { before } : {}) },
        ...window(since, until), appLlmCalls: selection };
      const result = settle(DatabaseCaptureTracesListResultV1Schema.safeParse(
        await call(DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1, input, signal),
      ));
      return { items: result.items, nextCursor: result.nextCursor ?? null };
    },
    async trace(
      traceId: string,
      signal?: AbortSignal,
    ) {
      const traceRead = { source: source(environment), traceId, page: { limit: PAGE_LIMIT } };
      return settle(DatabaseCaptureTraceGetResultV1Schema.safeParse(
        await call(DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1, traceRead, signal),
      ));
    },
    /** A cut log line's whole body, only when the person opens it. */
    async logBody(id: string, signal?: AbortSignal) {
      const read = settle(
        DatabaseCaptureQueryGetResultV1Schema.safeParse(
          await call(
            DATABASE_CAPTURE_QUERY_GET_ACTION_ID_V1,
            {
              source: source(environment),
              id,
            },
            signal,
          ),
        ),
      );
      return projectCapturedLogBody(read.detail);
    },
  };
}

export type TelemetryCaptureReads = ReturnType<
  typeof createTelemetryCaptureReads
>;
