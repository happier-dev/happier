import * as React from 'react';
import {
  DATABASE_CAPTURE_CLEAR_ACTION_ID_V1,
  DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1,
  DatabaseCaptureClearResultV1Schema,
  DatabaseCaptureConfigureResultV1Schema,
  DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1,
  DATABASE_CAPTURE_LOGS_LIST_ACTION_ID_V1,
  DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1,
  DATABASE_CAPTURE_QUERY_GET_ACTION_ID_V1,
  DATABASE_CAPTURE_STATUS_ACTION_ID_V1,
  DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1,
  DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1,
  DatabaseCaptureEndpointsListResultV1Schema,
  DatabaseCaptureLogsListResultV1Schema,
  DatabaseCaptureQueriesListResultV1Schema,
  DatabaseCaptureQueryGetResultV1Schema,
  DatabaseCaptureStatusResultV1Schema,
  DatabaseCaptureTraceGetResultV1Schema,
  DatabaseCaptureTracesListResultV1Schema,
  type DatabaseCaptureEndpointCursorV1,
  type DatabaseCaptureEndpointV1,
  type DatabaseCaptureCursorV1,
  type DatabaseCaptureSummaryV1,
} from '@happier-dev/database-protocol';
import { PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1 } from '@happier-dev/plugin-sdk/storage';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createFrontDoorUiActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { HappyError } from '@/utils/errors/errors';

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
  | typeof DATABASE_CAPTURE_QUERY_GET_ACTION_ID_V1;

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

/** Dev specimens and tests supply fixture collector answers here, as other collector reads do. */
export const TelemetryCaptureInvokeContext =
  React.createContext<TelemetryCaptureInvoke>(invokeThroughFrontDoor);

export function telemetryCaptureFailureCode(error: unknown): string {
  return (error instanceof HappyError ? error.code : undefined) ?? 'telemetry_unavailable';
}

/** Collector reads answer typed failures in-band (`{ ok: false, code }`); a shape this build cannot read says so. */
function settle<T extends { ok: boolean }>(
  parsed: { success: true; data: T } | { success: false },
): Extract<T, { ok: true }> {
  if (!parsed.success) {
    const code = 'telemetry_unreadable';
    throw new HappyError(code, false, { code });
  }
  const data = parsed.data as T & { code?: unknown };
  if (!data.ok) {
    const code = typeof data.code === 'string' ? data.code : 'telemetry_unavailable';
    throw new HappyError(code, false, { code });
  }
  return data as Extract<T, { ok: true }>;
}

export type TelemetryCaptureList = 'endpoints' | 'traces' | 'logs' | 'queries';
export type TelemetryCapturePage<Item, Cursor> = Readonly<{
  items: readonly Item[];
  nextCursor: Cursor | null;
}>;

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

function source(environment: TelemetryCaptureEnvironment) {
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
  const call = (
    actionId: TelemetryCaptureActionId,
    input: unknown,
    signal?: AbortSignal,
  ) =>
    invoke({
      scope: environment.scope,
      collectorMachineId: environment.collectorMachineId,
      actionId,
      input,
      ...(signal ? { signal } : {}),
    });
  const window = (since: number, until: number) => ({ since, until });
  return {
    async clear() {
      return settle(DatabaseCaptureClearResultV1Schema.safeParse(
        await call(DATABASE_CAPTURE_CLEAR_ACTION_ID_V1, { source: source(environment) }),
      ));
    },
    /** A worktree's Project Capture switch on its Machine (P5 Q3); the person's press is the confirmation. */
    async configure(enabled: boolean) {
      if (!environment.worktree) throw new HappyError('telemetry_unavailable', false, { code: 'telemetry_unavailable' });
      const project = { serverId: environment.scope.serverId, machineId: environment.collectorMachineId,
        projectId: environment.worktree.projectId };
      return settle(DatabaseCaptureConfigureResultV1Schema.safeParse(
        await call(DATABASE_CAPTURE_CONFIGURE_ACTION_ID_V1, { project, enabled }),
      ));
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
    ) {
      const traceRead = { source: source(environment), traceId, page: { limit: PAGE_LIMIT } };
      return settle(DatabaseCaptureTraceGetResultV1Schema.safeParse(
        await call(DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1, traceRead, signal),
      ));
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
  };
}

export type TelemetryCaptureReads = ReturnType<
  typeof createTelemetryCaptureReads
>;
