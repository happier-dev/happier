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
  Item,
  ItemGroup,
  LoadingState,
  Stack,
  Text,
  useExecutePluginAction,
  usePluginTheme,
  usePluginTranslation,
  type PluginActionExecution,
} from '@happier-dev/plugin-ui';
import { HAPPIER_PAGE_METRICS, HappierPressable, IntervalTimeline, formatHappierDuration } from '@happier-dev/plugin-ui/components';
import { DATABASE_CAPTURE_QUERY_GET_ACTION_ID_V1, DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1, DatabaseCaptureQueryGetResultV1Schema, DatabaseCaptureTraceGetResultV1Schema, type DatabaseCaptureSourceV1, type DatabaseCaptureSummaryV1, type DatabaseCaptureTraceGetResultV1 } from '@happier-dev/database-protocol';
import { databaseActionLocalIdV1 } from '@happier-dev/database-protocol';
import { PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1 } from '@happier-dev/plugin-sdk/storage';

import {
  TELEMETRY_PLUGIN_ID,
  type ExceptionOccurrenceV1,
} from './exceptionReads.js';
import { projectWaterfall, requestLabelOf } from './traceWaterfall.js';

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
type BodyState =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'ready'; body: string | null }>
  | Readonly<{ kind: 'unavailable' }>;

/** The log card keeps the sheet's row insets; its lines stack at the code line height, as the lab's log block. */
const LOG_LINES_INSET = Object.freeze({
  paddingHorizontal: HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx,
  paddingVertical: HAPPIER_PAGE_METRICS.rowPaddingVerticalPx,
});

function failureCode(execution: PluginActionExecution<unknown>): string {
  return execution.status === 'error' || execution.status === 'outcomeUnknown'
    ? execution.code
    : 'telemetry_trace_unreadable';
}


/** OpenTelemetry severity number ranges, named as the log record states its level. */
function severityWord(severity: number | null | undefined): string {
  if (severity === null || severity === undefined || severity <= 0)
    return 'log';
  if (severity <= 4) return 'trace';
  if (severity <= 8) return 'debug';
  if (severity <= 12) return 'info';
  if (severity <= 16) return 'warn';
  if (severity <= 20) return 'error';
  return 'fatal';
}

function clockOf(locale: string, at: number): string {
  return new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  }).format(at);
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
  const theme = usePluginTheme();
  const waterfall = React.useMemo(
    () => projectWaterfall(trace.summaries, trace.repeatedQueries),
    [trace],
  );
  const threw = text('plugins.telemetry.exceptions.threw', 'threw');
  const root = waterfall.root;
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
    <ItemGroup
      title={text('plugins.telemetry.exceptions.request', 'The request')}
      description={facts.length === 0 ? undefined : facts.join(' · ')}
    >
      {waterfall.domain === null ? (
        <Item
          title={text(
            'plugins.telemetry.exceptions.noSpans',
            'This request sent no timed spans.',
          )}
        />
      ) : (
        <IntervalTimeline
          theme={theme}
          label={text(
            'plugins.telemetry.exceptions.waterfall',
            'Request timeline',
          )}
          intervals={waterfall.rows.map((row) => {
            const raised =
              row.spanId !== null && row.spanId === occurrence.spanId;
            return {
              id: row.id,
              label: row.repeated
                ? `${row.label} × ${row.repeated.count}`
                : row.label,
              depth: row.depth,
              start: row.start,
              end: row.end,
              color: row.failed
                ? theme.colors.danger
                : row.kind === 'query'
                  ? theme.colors.info
                  : theme.colors.mutedText,
              // label | bar | duration, with the span that threw tagged once (lab p7Issues occurrence).
              value: formatHappierDuration(row.end - row.start, locale),
              ...(raised ? { flag: threw } : {}),
            };
          })}
          domain={waterfall.domain}
          size="full"
          formatValue={(value) =>
            formatHappierDuration(value - (waterfall.domain?.start ?? 0), locale)
          }
        />
      )}
    </ItemGroup>
  );
}

function RequestLogs({
  trace,
  locale,
  signal,
}: Readonly<{
  trace: Trace;
  locale: string;
  signal: AbortSignal;
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  const { execute } = useExecutePluginAction(DETAIL_ACTION);
  const [bodies, setBodies] = React.useState<
    Readonly<Record<string, BodyState>>
  >({});
  const logs = React.useMemo(
    () =>
      trace.summaries
        .filter(
          (summary): summary is DatabaseCaptureSummaryV1 =>
            summary.kind === 'log',
        )
        .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)),
    [trace],
  );
  const bodiesRef = React.useRef(bodies);
  const settle = (id: string, next: BodyState) => {
    bodiesRef.current = { ...bodiesRef.current, [id]: next };
    setBodies(bodiesRef.current);
  };
  // Which cut lines are open now. A second press closes a line; its body stays read for the next open.
  const [openIds, setOpenIds] = React.useState<ReadonlySet<string>>(() => new Set());
  const open = (id: string) => {
    const wasOpen = openIds.has(id);
    setOpenIds((current) => {
      const next = new Set(current);
      if (wasOpen) next.delete(id); else next.add(id);
      return next;
    });
    if (wasOpen) return;
    const known = bodiesRef.current[id];
    if (known !== undefined && known.kind !== 'unavailable') return;
    settle(id, { kind: 'loading' });
    void (async () => {
      const execution = await execute({ source: trace.source, id }, { signal });
      if (signal.aborted || execution.status === 'pending' || execution.status === 'idle') return;
      const parsed =
        execution.status === 'success'
          ? DatabaseCaptureQueryGetResultV1Schema.safeParse(execution.result)
          : null;
      settle(
        id,
        parsed?.success && parsed.data.ok
          ? { kind: 'ready', body: bodyText(parsed.data.detail) }
          : { kind: 'unavailable' },
      );
    })();
  };
  if (logs.length === 0) return null;
  return (
    <ItemGroup
      title={text(
        'plugins.telemetry.exceptions.requestLogs',
        'Logs from this request',
      )}
      description={text(
        logs.length === 1
          ? 'plugins.telemetry.exceptions.requestLogs.one'
          : 'plugins.telemetry.exceptions.requestLogs.many',
        logs.length === 1 ? '1 line' : '{count} lines',
      ).replace('{count}', String(logs.length))}
    >
      {/* The request's log as it was written: one mono line each, time · level · the start of its message,
          on one card with no rules between lines (lab p7Issues occurrence). A cut line ends in "…" and opens
          its whole message through the detail read; a whole line has nothing more to open. */}
      <Stack gap="xsmall" testID="telemetry.exception.logs" style={LOG_LINES_INSET}>
        {logs.map((log) => {
          const severity = severityWord(log.severityNumber);
          const failing = severity === 'error' || severity === 'fatal';
          const prefix = log.bodyPrefix ?? null;
          const truncated = log.bodyPrefixTruncated === true;
          const clock = clockOf(locale, log.at);
          const body = truncated && openIds.has(log.id) ? bodies[log.id] : undefined;
          // An open line reads its whole message in place of the cut start; a reading or failed open says so instead.
          const message =
            body === undefined
              ? (prefix === null ? null : `${prefix}${truncated ? '…' : ''}`)
              : body.kind === 'loading'
                ? `${prefix ?? ''}…`
                : body.kind === 'unavailable'
                  ? text('plugins.telemetry.exceptions.logUnavailable', 'The collector didn’t return this line.')
                  : (body.body ?? text('plugins.telemetry.exceptions.logEmpty', 'This line has no message.'));
          // Lines wrap rather than cut: on a phone the clock leaves the message room, so no line is a dead end.
          const line = (
            <Text variant="code" selectable={!truncated} tone={failing ? 'danger' : 'neutral'}>
              <Text variant="code" tone="secondary" value={`${clock}  `} />
              <Text variant="code" tone={failing ? 'danger' : 'secondary'} value={severity} />
              {message === null ? null : (
                <Text variant="code" tone={body?.kind === 'unavailable' ? 'secondary' : failing ? 'danger' : 'neutral'} value={`  ${message}`} />
              )}
            </Text>
          );
          return (
            <Stack key={log.id} gap="none" testID={`telemetry.exception.log.${log.id}`}>
              {truncated ? (
                <HappierPressable
                  testID={`telemetry.exception.log.${log.id}.open`}
                  accessibilityRole="button"
                  accessibilityLabel={`${clock} ${severity} ${prefix ?? ''}…`}
                  expanded={body !== undefined}
                  busy={body?.kind === 'loading'}
                  onPress={() => open(log.id)}
                >
                  {line}
                </HappierPressable>
              ) : (
                line
              )}
            </Stack>
          );
        })}
      </Stack>
    </ItemGroup>
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
