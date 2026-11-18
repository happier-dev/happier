/**
 * The request an exception occurrence happened in (P7 J2): its waterfall and the logs it wrote.
 *
 * Both come from the existing capture trace read by the occurrence's `traceId`, admitted once per
 * request for the Environment's telemetry. Trace summaries carry each log's bounded, redacted body
 * prefix (marked when cut), so the lines read at rest; a cut line reads its whole body through the
 * existing capture detail read only when the person opens it.
 */

import * as React from 'react';
import {
  ErrorState,
  LoadingState,
  useExecutePluginAction,
  usePluginTranslation,
  type PluginActionExecution,
} from '@happier-dev/plugin-ui';
import { formatHappierDuration } from '@happier-dev/plugin-ui/components';
import { DATABASE_CAPTURE_QUERY_GET_ACTION_ID_V1, DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1, DatabaseCaptureQueryGetResultV1Schema, DatabaseCaptureTraceGetResultV1Schema, type DatabaseCaptureSourceV1, type DatabaseCaptureTraceGetResultV1 } from '@happier-dev/database-protocol';
import { databaseActionLocalIdV1 } from '@happier-dev/database-protocol';
import { PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1 } from '@happier-dev/plugin-sdk/storage';

import {
  TELEMETRY_PLUGIN_ID,
  type ExceptionOccurrenceV1,
} from './exceptionReads.js';
import { projectWaterfall, requestLabelOf } from './traceWaterfall.js';
import { CapturedRequestLogs, CapturedRequestWaterfall, type CapturedLogBodyReader } from './capture/CapturedRequest.js';

const TRACE_ACTION = Object.freeze({
  pluginId: TELEMETRY_PLUGIN_ID,
  localId: databaseActionLocalIdV1(DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1),
});
const DETAIL_ACTION = Object.freeze({
  pluginId: TELEMETRY_PLUGIN_ID,
  localId: databaseActionLocalIdV1(DATABASE_CAPTURE_QUERY_GET_ACTION_ID_V1),
});

type Trace = Extract<DatabaseCaptureTraceGetResultV1, { ok: true }>;
type TraceState =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'ready'; trace: Trace }>
  | Readonly<{ kind: 'unavailable'; code: string }>;
function failureCode(execution: PluginActionExecution<unknown>): string {
  return execution.status === 'error' || execution.status === 'outcomeUnknown'
    ? execution.code
    : 'telemetry_trace_unreadable';
}


function bodyText(detail: unknown): string | null {
  if (detail === null || typeof detail !== 'object') return null;
  const body = (detail as Record<string, unknown>).body;
  if (body === undefined || body === null) return null;
  return typeof body === 'string' ? body : JSON.stringify(body);
}

function useOccurrenceTrace(
  source: DatabaseCaptureSourceV1,
  traceId: string,
  signal: AbortSignal,
): Readonly<{ state: TraceState; retry: () => void }> {
  const { execute } = useExecutePluginAction(TRACE_ACTION);
  const [state, setState] = React.useState<TraceState>({ kind: 'loading' });
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    let current = true;
    setState({ kind: 'loading' });
    void (async () => {
      const execution = await execute(
        {
          source,
          traceId,
          // The host's own result-row bound for one read; the store pages beneath it.
          page: {
            limit: PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1.maximumResultRows,
          },
        },
        { signal },
      );
      if (
        !current ||
        signal.aborted ||
        execution.status === 'pending' ||
        execution.status === 'idle'
      )
        return;
      if (execution.status !== 'success') {
        setState({ kind: 'unavailable', code: failureCode(execution) });
        return;
      }
      const parsed = DatabaseCaptureTraceGetResultV1Schema.safeParse(
        execution.result,
      );
      if (!parsed.success)
        setState({ kind: 'unavailable', code: 'telemetry_trace_unreadable' });
      else if (!parsed.data.ok)
        setState({ kind: 'unavailable', code: parsed.data.code });
      else setState({ kind: 'ready', trace: parsed.data });
    })();
    return () => {
      current = false;
    };
  }, [attempt, execute, signal, source, traceId]);
  const retry = React.useCallback(() => setAttempt((value) => value + 1), []);
  return { state, retry };
}

/** "The request": its route, time and version over the waterfall, the span this occurrence threw in tagged once. */
function RequestWaterfall({
  trace,
  occurrence,
  locale,
}: Readonly<{
  trace: Trace;
  occurrence: ExceptionOccurrenceV1;
  locale: string;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const root = React.useMemo(
    () => projectWaterfall(trace.summaries, trace.repeatedQueries).root,
    [trace],
  );
  const facts = [
    root === null ? null : requestLabelOf(root),
    root?.durationMs === null || root?.durationMs === undefined
      ? null
      : formatHappierDuration(root.durationMs, locale),
    occurrence.serviceVersion ?? null,
  ].filter(
    (part): part is string => typeof part === 'string' && part.length > 0,
  );
  return (
    <CapturedRequestWaterfall
      trace={trace}
      locale={locale}
      title={text('plugins.telemetry.exceptions.request', 'The request')}
      {...(facts.length === 0 ? {} : { description: facts.join(' · ') })}
      {...(occurrence.spanId
        ? { flag: { spanId: occurrence.spanId, label: text('plugins.telemetry.exceptions.threw', 'threw') } }
        : {})}
    />
  );
}

/** A cut line's whole body, through the existing capture detail read, only when the person opens it. */
function RequestLogs({
  trace,
  locale,
  signal,
}: Readonly<{
  trace: Trace;
  locale: string;
  signal: AbortSignal;
}>): React.ReactElement | null {
  const { execute } = useExecutePluginAction(DETAIL_ACTION);
  const readBody = React.useCallback<CapturedLogBodyReader>(async (id) => {
    const execution = await execute({ source: trace.source, id }, { signal });
    const parsed =
      execution.status === 'success'
        ? DatabaseCaptureQueryGetResultV1Schema.safeParse(execution.result)
        : null;
    if (!parsed?.success || !parsed.data.ok) throw new Error('telemetry_log_unavailable');
    return bodyText(parsed.data.detail);
  }, [execute, signal, trace.source]);
  return (
    <CapturedRequestLogs
      trace={trace}
      locale={locale}
      readBody={readBody}
      testIDPrefix="telemetry.exception"
    />
  );
}

/** The selected occurrence's request, read from the collector while its panel is open. */
export function OccurrenceRequest({
  source,
  occurrence,
  locale,
  signal,
}: Readonly<{
  source: DatabaseCaptureSourceV1;
  occurrence: ExceptionOccurrenceV1;
  locale: string;
  signal: AbortSignal;
}>): React.ReactElement | null {
  const traceId = occurrence.traceId;
  if (traceId === null || traceId === undefined) return null;
  return (
    <OccurrenceTrace
      source={source}
      traceId={traceId}
      occurrence={occurrence}
      locale={locale}
      signal={signal}
    />
  );
}

function OccurrenceTrace({
  source,
  traceId,
  occurrence,
  locale,
  signal,
}: Readonly<{
  source: DatabaseCaptureSourceV1;
  traceId: string;
  occurrence: ExceptionOccurrenceV1;
  locale: string;
  signal: AbortSignal;
}>): React.ReactElement {
  const { state, retry } = useOccurrenceTrace(source, traceId, signal);
  if (state.kind === 'loading')
    return (
      <LoadingState
        title="Reading the request"
        titleKey="plugins.telemetry.exceptions.readingRequest"
      />
    );
  if (state.kind === 'unavailable')
    return (
      <ErrorState
        kind="unavailable"
        title="The request isn’t available"
        titleKey="plugins.telemetry.exceptions.requestUnavailable"
        description="The collector didn’t return this occurrence’s request. Its stack is above."
        descriptionKey="plugins.telemetry.exceptions.requestUnavailable.description"
        details={state.code}
        onRetry={retry}
      />
    );
  return (
    <>
      <RequestWaterfall
        trace={state.trace}
        occurrence={occurrence}
        locale={locale}
      />
      <RequestLogs trace={state.trace} locale={locale} signal={signal} />
    </>
  );
}
