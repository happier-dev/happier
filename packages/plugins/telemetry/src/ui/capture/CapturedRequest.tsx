/**
 * One captured request, drawn from the existing capture trace read (`capture/trace/get`): where its time went,
 * its waterfall on the shared IntervalTimeline, and the log lines it wrote. The exception detail (P7 J2) and the
 * Environment's Traces detail (P6 F14d) draw these same parts; each consumer reads the trace and the whole
 * body of a cut log line through its own Action path and hands the answers in.
 */

import * as React from 'react';
import {
  Item,
  ItemGroup,
  Stack,
  Text,
  usePluginTheme,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';
import {
  HAPPIER_PAGE_METRICS,
  HappierPressable,
  IntervalTimeline,
  formatHappierDuration,
} from '@happier-dev/plugin-ui/components';
import type {
  DatabaseCaptureSummaryV1,
  DatabaseCaptureTraceGetResultV1,
} from '@happier-dev/database-protocol';

import { projectWaterfall, slowestSteps } from '../traceWaterfall.js';
import { captureClockOf, captureSeverityWord } from './model.js';
import { formatTelemetryMetric } from '../widgets/telemetryWidgetModel.js';

export type CapturedTraceV1 = Extract<
  DatabaseCaptureTraceGetResultV1,
  { ok: true }
>;

/** Reads the whole body of one cut log line; resolves null for a line with no message, rejects when unavailable. */
export type CapturedLogBodyReader = (logId: string) => Promise<string | null>;

type BodyState =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'ready'; body: string | null }>
  | Readonly<{ kind: 'unavailable' }>;

/** The log card keeps the sheet's row insets; its lines stack at the code line height, as the lab's log block. */
const CAPTURE_LOG_LINES_INSET = Object.freeze({
  paddingHorizontal: HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx,
  paddingVertical: HAPPIER_PAGE_METRICS.rowPaddingVerticalPx,
});

function rowLabel(
  row: Readonly<{ label: string; repeated?: Readonly<{ count: number }> }>,
): string {
  return row.repeated ? `${row.label} × ${row.repeated.count}` : row.label;
}

/** "Where the time went": the request's slowest direct steps, each with its time and share of the request. */
export function CapturedRequestSlowest({
  trace,
  locale,
}: Readonly<{
  trace: CapturedTraceV1;
  locale: string;
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  const steps = React.useMemo(
    () =>
      slowestSteps(projectWaterfall(trace.summaries, trace.repeatedQueries)),
    [trace],
  );
  if (steps.length === 0) return null;
  return (
    <ItemGroup
      testID="telemetry.request.slowest"
      title={text('plugins.telemetry.request.slowest', 'Slowest steps')}
      description={text(
        'plugins.telemetry.request.slowestLine',
        'Where this request spent its time. Steps can overlap, so they don’t add up to the total.',
      )}
    >
      {steps.map(({ row, share }) => (
        <Item
          key={row.id}
          title={rowLabel(row)}
          titleNumberOfLines={1}
          detail={`${formatHappierDuration(row.end - row.start, locale)} · ${text(
            'plugins.telemetry.request.shareOfRequest',
            '{share} of the request',
            { share: formatTelemetryMetric('errorRate', share, locale) },
          )}`}
        />
      ))}
    </ItemGroup>
  );
}

/** The request's waterfall; a span an exception was recorded in carries the consumer's flag once. */
export function CapturedRequestWaterfall({
  trace,
  locale,
  title,
  description,
  flag,
}: Readonly<{
  trace: CapturedTraceV1;
  locale: string;
  title: string;
  description?: string;
  flag?: Readonly<{ spanId: string; label: string }>;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const theme = usePluginTheme();
  const waterfall = React.useMemo(
    () => projectWaterfall(trace.summaries, trace.repeatedQueries),
    [trace],
  );
  return (
    <ItemGroup title={title} description={description}>
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
              flag !== undefined &&
              row.spanId !== null &&
              row.spanId === flag.spanId;
            return {
              id: row.id,
              label: rowLabel(row),
              depth: row.depth,
              start: row.start,
              end: row.end,
              color: row.failed
                ? theme.colors.danger
                : row.repeated?.kind === 'suspected_n_plus_one'
                  ? theme.colors.warning
                  : row.kind === 'query'
                    ? theme.colors.info
                    : theme.colors.mutedText,
              // label | bar | duration, with the flagged span tagged once (lab p7Issues occurrence).
              value: formatHappierDuration(row.end - row.start, locale),
              ...(raised ? { flag: flag.label } : {}),
            };
          })}
          domain={waterfall.domain}
          size="full"
          formatValue={(value) =>
            formatHappierDuration(
              value - (waterfall.domain?.start ?? 0),
              locale,
            )
          }
        />
      )}
    </ItemGroup>
  );
}

/**
 * "Logs from this request": one mono line each, time · level · the start of its message, on one card with no
 * rules between lines. A cut line ends in "…" and opens its whole message through `readBody`; a whole line has
 * nothing more to open.
 */
export function CapturedRequestLogs({
  trace,
  locale,
  readBody,
  testIDPrefix = 'telemetry.request',
}: Readonly<{
  trace: CapturedTraceV1;
  locale: string;
  readBody: CapturedLogBodyReader;
  testIDPrefix?: string;
}>): React.ReactElement | null {
  const text = usePluginTranslation();
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
  const [openIds, setOpenIds] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const open = (id: string) => {
    const wasOpen = openIds.has(id);
    setOpenIds((current) => {
      const next = new Set(current);
      if (wasOpen) next.delete(id);
      else next.add(id);
      return next;
    });
    if (wasOpen) return;
    const known = bodiesRef.current[id];
    if (known !== undefined && known.kind !== 'unavailable') return;
    settle(id, { kind: 'loading' });
    readBody(id).then(
      (body) => settle(id, { kind: 'ready', body }),
      () => settle(id, { kind: 'unavailable' }),
    );
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
      <Stack
        gap="xsmall"
        testID={`${testIDPrefix}.logs`}
        style={CAPTURE_LOG_LINES_INSET}
      >
        {logs.map((log) => (
          <CapturedLogLine
            key={log.id}
            log={log}
            locale={locale}
            body={
              log.bodyPrefixTruncated === true && openIds.has(log.id)
                ? bodies[log.id]
                : undefined
            }
            onOpen={
              log.bodyPrefixTruncated === true ? () => open(log.id) : undefined
            }
            testID={`${testIDPrefix}.log.${log.id}`}
          />
        ))}
      </Stack>
    </ItemGroup>
  );
}

/** One captured log line, as the request's log card and the Logs tab both draw it. */
export function CapturedLogLine({
  log,
  locale,
  body,
  onOpen,
  testID,
}: Readonly<{
  log: DatabaseCaptureSummaryV1;
  locale: string;
  body?: BodyState;
  onOpen?: () => void;
  testID?: string;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const severity = captureSeverityWord(log.severityNumber);
  const failing = severity === 'error' || severity === 'fatal';
  const prefix = log.bodyPrefix ?? null;
  const truncated = log.bodyPrefixTruncated === true;
  const clock = captureClockOf(locale, log.at);
  // An open line reads its whole message in place of the cut start; a reading or failed open says so instead.
  const message =
    body === undefined
      ? prefix === null
        ? null
        : `${prefix}${truncated ? '…' : ''}`
      : body.kind === 'loading'
        ? `${prefix ?? ''}…`
        : body.kind === 'unavailable'
          ? text(
              'plugins.telemetry.exceptions.logUnavailable',
              'The collector didn’t return this line.',
            )
          : (body.body ??
            text(
              'plugins.telemetry.exceptions.logEmpty',
              'This line has no message.',
            ));
  // Lines wrap rather than cut: on a phone the clock leaves the message room, so no line is a dead end.
  const line = (
    <Text
      variant="code"
      selectable={!truncated}
      tone={failing ? 'danger' : 'neutral'}
    >
      <Text variant="code" tone="secondary" value={`${clock}  `} />
      <Text
        variant="code"
        tone={failing ? 'danger' : 'secondary'}
        value={severity}
      />
      {message === null ? null : (
        <Text
          variant="code"
          tone={
            body?.kind === 'unavailable'
              ? 'secondary'
              : failing
                ? 'danger'
                : 'neutral'
          }
          value={`  ${message}`}
        />
      )}
    </Text>
  );
  return (
    <Stack gap="none" testID={testID}>
      {onOpen ? (
        <HappierPressable
          testID={testID ? `${testID}.open` : undefined}
          accessibilityRole="button"
          accessibilityLabel={`${clock} ${severity} ${prefix ?? ''}…`}
          expanded={body !== undefined}
          busy={body?.kind === 'loading'}
          onPress={onOpen}
        >
          {line}
        </HappierPressable>
      ) : (
        line
      )}
    </Stack>
  );
}
