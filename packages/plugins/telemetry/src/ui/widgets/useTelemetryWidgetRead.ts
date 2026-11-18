/**
 * The one read path every Telemetry widget shares.
 *
 * A widget reads only while the host presents it (the surface's activity is the host's presented
 * demand): mounting on a hidden Board, a scrolled-away card or a closed pane reads nothing, and coming
 * back reads again while the last answer stays on screen. Every collector read goes through the
 * telemetry Actions, whose R16 admission decides once per request that this viewer may read the
 * Environment. There is no timer and no retry loop; Retry is the person's.
 */

import * as React from 'react';
import {
  useExecutePluginAction,
  usePluginSurfaceActivity,
  type PluginActionExecution,
} from '@happier-dev/plugin-ui';
import {
  DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1,
  TELEMETRY_METRICS_READ_ACTION_ID_V1,
  TELEMETRY_REGRESSIONS_COMPARE_ACTION_ID_V1,
  type TelemetryMetricsReadInputV1,
  type DatabaseCaptureEndpointCursorV1,
  type DatabaseCaptureEndpointV1,
  type TelemetryMetricsReadResultV1,
} from '@happier-dev/database-protocol';
import { databaseActionLocalIdV1 } from '@happier-dev/plugin-sdk/actions';

import {
  TELEMETRY_PLUGIN_ID,
  describeTelemetryEnvironment,
  type TelemetryWidgetEnvironmentV1,
} from './telemetryWidgetModel.js';

const ENDPOINTS_ACTION = Object.freeze({
  pluginId: TELEMETRY_PLUGIN_ID,
  localId: databaseActionLocalIdV1(
    DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1,
  ),
});
const METRICS_ACTION = Object.freeze({
  pluginId: TELEMETRY_PLUGIN_ID,
  localId: databaseActionLocalIdV1(TELEMETRY_METRICS_READ_ACTION_ID_V1),
});
const COMPARE_ACTION = Object.freeze({
  pluginId: TELEMETRY_PLUGIN_ID,
  localId: databaseActionLocalIdV1(TELEMETRY_REGRESSIONS_COMPARE_ACTION_ID_V1),
});

export type TelemetryWidgetFailureV1 = Readonly<{
  code: string;
  message: string;
}>;

/** What a widget's own read asks of the collector, once per presented read. */
export type TelemetryWidgetReader = Readonly<{
  /** The window this read covers, authored once at demand. */
  window: Readonly<{ since: number; until: number }>;
  /** One page of the Environment's routes for the window, in the collector's order; `before` continues it. */
  endpoints: (limit: number, before?: DatabaseCaptureEndpointCursorV1) => Promise<Readonly<{
    items: readonly DatabaseCaptureEndpointV1[];
    nextCursor: DatabaseCaptureEndpointCursorV1 | null;
  }>>;
  /** One measure for the window: the whole service's, a route's, or a runtime metric. */
  metrics: (
    serviceName: string,
    measure: TelemetryMetricsReadInputV1['measure'],
  ) => Promise<TelemetryMetricsReadResultV1>;
  /**
   * The live version against the one before it, over the same window on each side of the deploy (the regression
   * comparison). It answers in its own words: comparable, or inconclusive with reasons.
   */
  compare: (
    serviceName: string,
    measure: Exclude<TelemetryMetricsReadInputV1['measure'], { kind: 'http' }>,
  ) => Promise<unknown>;
}>;

export type TelemetryWidgetReadState<T> =
  | Readonly<{ kind: 'unbound' }>
  | Readonly<{ kind: 'loading' }>
  /** No request reached the collector in the window: nothing to draw yet. */
  | Readonly<{ kind: 'quiet' }>
  | Readonly<{ kind: 'unavailable'; failure: TelemetryWidgetFailureV1 }>
  /** `failure` is a later read that failed; the numbers above stay at full strength. */
  | Readonly<{
      kind: 'ready';
      data: T;
      readAtMs: number;
      failure: TelemetryWidgetFailureV1 | null;
    }>;

class TelemetryWidgetReadError extends Error {
  constructor(readonly failure: TelemetryWidgetFailureV1) {
    super(failure.message);
  }
}

/** Thrown by a widget's read when the Environment has no traffic in the window. */
export class TelemetryWidgetQuiet extends Error {}

function settle<T>(execution: PluginActionExecution<unknown>): T {
  if (execution.status === 'success') {
    const result = execution.result as Readonly<{
      ok?: unknown;
      code?: unknown;
      message?: unknown;
    }> | null;
    // Collector reads answer typed failures in-band ({ ok: false, code }).
    if (result && typeof result === 'object' && result.ok === false) {
      throw new TelemetryWidgetReadError({
        code:
          typeof result.code === 'string'
            ? result.code
            : 'telemetry_unavailable',
        message:
          typeof result.message === 'string'
            ? result.message
            : 'Telemetry is unavailable.',
      });
    }
    return execution.result as T;
  }
  if (execution.status === 'error' || execution.status === 'outcomeUnknown') {
    throw new TelemetryWidgetReadError({
      code: execution.code,
      message: execution.message,
    });
  }
  throw new TelemetryWidgetReadError({
    code: 'telemetry_read_cancelled',
    message: 'The read did not finish.',
  });
}

export function useTelemetryWidgetRead<T>(
  input: Readonly<{
    environment: TelemetryWidgetEnvironmentV1 | null;
    /** The window length; the read authors since/until at demand. */
    windowMs: number;
    /** Everything else that changes what is read (the metric); a new value reads again. */
    readKey: string;
    read: (reader: TelemetryWidgetReader) => Promise<T>;
  }>,
): Readonly<{
  state: TelemetryWidgetReadState<T>;
  caption: string | null;
  retry: () => void;
}> {
  const active = usePluginSurfaceActivity().active;
  const { execute: listEnvironments } = useExecutePluginAction(
    'deployments.environments.list',
  );
  const { execute: executeEndpoints } =
    useExecutePluginAction(ENDPOINTS_ACTION);
  const { execute: executeMetrics } = useExecutePluginAction(METRICS_ACTION);
  const { execute: executeCompare } = useExecutePluginAction(COMPARE_ACTION);
  const [state, setState] = React.useState<TelemetryWidgetReadState<T>>({
    kind: 'loading',
  });
  const [caption, setCaption] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  const readRef = React.useRef(input.read);
  readRef.current = input.read;
  const serverId = input.environment?.serverId ?? null;
  const environmentId = input.environment?.environmentId ?? null;

  // What is on screen belongs to one Environment and measure: a different one starts from loading,
  // while a re-read of the same one keeps the last answer until the new one lands.
  const subject = `${serverId}\u0000${environmentId}\u0000${input.windowMs}\u0000${input.readKey}`;
  const shownSubject = React.useRef(subject);

  React.useEffect(() => {
    if (!active || serverId === null || environmentId === null) return;
    if (shownSubject.current !== subject) {
      shownSubject.current = subject;
      setState({ kind: 'loading' });
      setCaption(null);
    }
    const controller = new AbortController();
    const { signal } = controller;
    const source = { kind: 'environment' as const, serverId, environmentId };
    const until = Date.now();
    const window = { since: Math.max(0, until - input.windowMs), until };
    const reader: TelemetryWidgetReader = {
      window,
      endpoints: async (limit, before) => {
        const page = settle<Readonly<{ items: readonly DatabaseCaptureEndpointV1[]; nextCursor?: DatabaseCaptureEndpointCursorV1 }>>(
          await executeEndpoints({ source, page: { limit, ...(before ? { before } : {}) }, ...window }, { signal }));
        return { items: page.items, nextCursor: page.nextCursor ?? null };
      },
      metrics: async (serviceName, measure) =>
        settle<TelemetryMetricsReadResultV1>(
          await executeMetrics(
            { serverId, environmentId, serviceName, ...window, measure },
            { signal },
          ),
        ),
      compare: async (serviceName, measure) =>
        settle<unknown>(
          await executeCompare(
            { serverId, environmentId, serviceName, measure, windowMs: input.windowMs },
            { signal },
          ),
        ),
    };
    void listEnvironments(
      { serverId, environmentIds: [environmentId] },
      { signal },
    ).then((execution) => {
      if (signal.aborted || execution.status !== 'success') return;
      setCaption(describeTelemetryEnvironment(execution.result, environmentId));
    });
    readRef.current(reader).then(
      (data) => {
        if (!signal.aborted)
          setState({ kind: 'ready', data, readAtMs: until, failure: null });
      },
      (error: unknown) => {
        if (signal.aborted) return;
        if (error instanceof TelemetryWidgetQuiet) {
          setState({ kind: 'quiet' });
          return;
        }
        const failure =
          error instanceof TelemetryWidgetReadError
            ? error.failure
            : {
                code: 'telemetry_unreadable',
                message:
                  'The collector answered in a shape this build cannot read.',
              };
        setState((current) =>
          current.kind === 'ready'
            ? { ...current, failure }
            : { kind: 'unavailable', failure },
        );
      },
    );
    return () => controller.abort();
    // `read` is held in a ref: a new closure per render is not a new read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, serverId, environmentId, input.windowMs, input.readKey, attempt]);

  const retry = React.useCallback(() => setAttempt((value) => value + 1), []);
  return {
    state: serverId === null ? { kind: 'unbound' } : state,
    caption,
    retry,
  };
}
