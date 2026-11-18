import * as React from 'react';
import {
  DATABASE_CAPTURE_CLEAR_ACTION_ID_V1,
  DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1,
  DATABASE_CAPTURE_LOGS_LIST_ACTION_ID_V1,
  DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1,
  DATABASE_CAPTURE_QUERY_GET_ACTION_ID_V1,
  DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1,
  DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1,
  DatabaseCaptureClearResultV1Schema,
  DatabaseCaptureEndpointsListResultV1Schema,
  DatabaseCaptureLogsListResultV1Schema,
  DatabaseCaptureQueriesListResultV1Schema,
  DatabaseCaptureQueryGetResultV1Schema,
  DatabaseCaptureTraceGetResultV1Schema,
  DatabaseCaptureTracesListResultV1Schema,
  type DatabaseCaptureEndpointCursorV1,
  type DatabaseCaptureEndpointV1,
  type DatabaseCaptureCursorV1,
  type DatabaseCaptureSummaryV1,
  type DatabaseCaptureTraceGetResultV1,
} from '@happier-dev/database-protocol';
import { PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1 } from '@happier-dev/plugin-sdk/storage';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createFrontDoorUiActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

/**
 * An Environment's collector reads (P6 F14d): the same `capture/*` Actions every capture reader uses, with the
 * Environment as their source, relayed to the Environment's collector Machine. The Action's admission decides once
 * per request that this viewer may read the Environment; there is no timer and no retry loop here.
 */
export type TelemetryCaptureActionId =
  | typeof DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1
  | typeof DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1
  | typeof DATABASE_CAPTURE_LOGS_LIST_ACTION_ID_V1
  | typeof DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1
  | typeof DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1
  | typeof DATABASE_CAPTURE_QUERY_GET_ACTION_ID_V1
  | typeof DATABASE_CAPTURE_CLEAR_ACTION_ID_V1;

export type TelemetryCaptureInvoke = (
  request: Readonly<{
    scope: ServerAccountScope;
    collectorMachineId: string;
    actionId: TelemetryCaptureActionId;
    input: unknown;
    signal?: AbortSignal;
    /** The person already confirmed this exact operation in place (Clear). */
    confirmed?: true;
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
      ...(request.confirmed ? { confirmed: true as const } : {}),
    },
  );

/** Dev specimens and tests supply fixture collector answers here, as other collector reads do. */
export const TelemetryCaptureInvokeContext =
  React.createContext<TelemetryCaptureInvoke>(invokeThroughFrontDoor);

export class TelemetryCaptureFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Collector reads answer typed failures in-band (`{ ok: false, code }`); a shape this build cannot read says so. */
function settle<T extends { ok: boolean }>(
  parsed: { success: true; data: T } | { success: false },
): Extract<T, { ok: true }> {
  if (!parsed.success)
    throw new TelemetryCaptureFailure('telemetry_unreadable');
  const data = parsed.data as T & { code?: unknown };
  if (!data.ok)
    throw new TelemetryCaptureFailure(
      typeof data.code === 'string' ? data.code : 'telemetry_unavailable',
    );
  return data as Extract<T, { ok: true }>;
}

export type TelemetryCaptureList = 'endpoints' | 'traces' | 'logs' | 'queries';
export type TelemetryCapturePage<Item, Cursor> = Readonly<{
  items: readonly Item[];
  nextCursor: Cursor | null;
}>;

export type TelemetryCaptureEnvironment = Readonly<{
  scope: ServerAccountScope;
  environmentId: string;
  collectorMachineId: string;
}>;

/** The host's own result-row bound for one read; the collector pages beneath it. */
const PAGE_LIMIT = PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1.maximumResultRows;

function source(environment: TelemetryCaptureEnvironment) {
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
  const call = (
    actionId: TelemetryCaptureActionId,
    input: unknown,
    signal?: AbortSignal,
    confirmed?: true,
  ) =>
    invoke({
      scope: environment.scope,
      collectorMachineId: environment.collectorMachineId,
      actionId,
      input,
      ...(signal ? { signal } : {}),
      ...(confirmed ? { confirmed } : {}),
    });
  const window = (since: number, until: number) => ({ since, until });
  return {
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
        list === 'traces'
          ? DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1
          : list === 'logs'
            ? DATABASE_CAPTURE_LOGS_LIST_ACTION_ID_V1
            : DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1,
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
    async trace(
      traceId: string,
      signal?: AbortSignal,
    ): Promise<Extract<DatabaseCaptureTraceGetResultV1, { ok: true }>> {
      return settle(
        DatabaseCaptureTraceGetResultV1Schema.safeParse(
          await call(
            DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1,
            {
              source: source(environment),
              traceId,
              page: { limit: PAGE_LIMIT },
            },
            signal,
          ),
        ),
      );
    },
    /** A cut log line's whole body, only when the person opens it. */
    async logBody(id: string, signal?: AbortSignal): Promise<string | null> {
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
      const body = read.detail?.body;
      if (body === undefined || body === null) return null;
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
    /** Deletes everything the collector kept for this Environment; the person confirmed it in place. */
    async clear(): Promise<void> {
      settle(
        DatabaseCaptureClearResultV1Schema.safeParse(
          await call(
            DATABASE_CAPTURE_CLEAR_ACTION_ID_V1,
            {
              source: source(environment),
            },
            undefined,
            true,
          ),
        ),
      );
    },
  };
}

export type TelemetryCaptureReads = ReturnType<
  typeof createTelemetryCaptureReads
>;
