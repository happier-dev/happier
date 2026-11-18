/**
 * One captured request, drawn from the existing capture trace read (`capture/trace/get`): where its time went,
 * its waterfall on the shared IntervalTimeline, and the log lines it wrote. The exception detail (P7 J2) and the
 * Environment's Traces detail (P6 F14d) draw these same parts; each consumer reads the trace and the whole
 * body of a cut log line through its own Action path and hands the answers in.
 */

import * as React from 'react';
import {
  Icon,
  Item,
  ItemGroup,
  Row,
  Stack,
  Text,
  usePluginTheme,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';
import {
  CapacityBar,
  HAPPIER_DATA_METRICS,
  HAPPIER_PAGE_METRICS,
  HappierPressable,
  IntervalTimeline,
  formatHappierDuration,
} from '@happier-dev/plugin-ui/components';
import type {
  DatabaseCaptureSummaryV1,
  DatabaseCaptureTraceGetResultV1,
} from '@happier-dev/database-protocol';

import { failedStep, projectWaterfall, slowestSteps } from '../traceWaterfall.js';
import { captureClockOf, captureSeverityTone, captureSeverityWord, captureStepKind } from './model.js';
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

/** The share bar's length beside the step's figures (lab p7AddNow-trace). */
const SHARE_BAR_STYLE = Object.freeze({ width: HAPPIER_DATA_METRICS.shareBarWidthPx, marginTop: HAPPIER_DATA_METRICS.axisGapPx });

function rowLabel(
  row: Readonly<{ label: string; repeated?: Readonly<{ count: number }> }>,
): string {
  return row.repeated ? `${row.label} × ${row.repeated.count}` : row.label;
}

function stepKindWord(
  row: Parameters<typeof captureStepKind>[0] & Readonly<{ failed: boolean }>,
  text: ReturnType<typeof usePluginTranslation>,
): string {
  const kind = captureStepKind(row);
  const word = kind === 'query'
    ? text('plugins.telemetry.request.kind.query', 'database query')
    : kind === 'external'
      ? text('plugins.telemetry.request.kind.external', 'external call')
      : text('plugins.telemetry.request.kind.app', 'in the app');
  return row.failed ? `${word} · ${text('plugins.telemetry.request.kind.failed', 'failed')}` : word;
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
  const theme = usePluginTheme();
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
          identifier
          titleNumberOfLines={1}
          // What the step was, so the slowest one reads at a glance (lab p7AddNow-trace).
          subtitle={stepKindWord(row, text)}
          // The step's time and its share of the request, at the row's end in the interface face (lab p7AddNow-trace).
          accessory={
            <Stack gap="none" align="flex-end">
              <Text variant="body" value={formatHappierDuration(row.end - row.start, locale)} />
              <Text
                variant="meta"
                tone="secondary"
                value={text('plugins.telemetry.request.shareOfRequest', '{share} of the request', {
                  share: formatTelemetryMetric('errorRate', share, locale),
                })}
              />
              {/* The share as a bar, so the slowest step reads at a glance (the shared capacity bar, its whole = the request). */}
              <CapacityBar
                theme={theme}
                label={rowLabel(row)}
                value={share}
                capacity={1}
                size="inline"
                showCaption={false}
                color={failedStep(row) ? theme.colors.danger : theme.colors.mutedText}
                style={SHARE_BAR_STYLE}
                testID={`telemetry.request.slowest.share.${row.id}`}
              />
            </Stack>
          }
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
              // The step that failed carries the mark; the request it ended stays ink (lab p7AddNow-trace).
              color: failedStep(row)
                ? theme.colors.danger
                : row.repeated?.kind === 'suspected_n_plus_one'
                  ? theme.colors.warning
                  : row.kind === 'query'
                    ? theme.colors.info
                    : theme.colors.mutedText,
              // label | bar | duration, with the flagged span tagged once (lab p7Issues occurrence).
              value: formatHappierDuration(row.end - row.start, locale),
              ...(raised ? { flag: flag.label } : {}),
              // A query reads as code, led by the database mark (lab p7AddNow-trace).
              ...(row.kind === 'query'
                ? { identifier: true, glyph: <Icon name="database" size="small" tone="secondary" /> }
                : {}),
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
 * Log lines as one card: one mono line each, time · level (error rose, warn amber) · service · the start of its
 * message, with no rules between lines. A cut line ends in "…" and opens its whole message through `readBody`; a
 * whole line has nothing more to open. The request's logs and the Environment's Logs tab draw these same lines.
 */
export function CapturedLogLines({
  logs,
  locale,
  readBody,
  showService = false,
  testIDPrefix,
}: Readonly<{
  logs: readonly DatabaseCaptureSummaryV1[];
  locale: string;
  readBody: CapturedLogBodyReader;
  /** The Logs tab names each line's service; a request's own lines share one. */
  showService?: boolean;
  testIDPrefix: string;
}>): React.ReactElement {
  const [bodies, setBodies] = React.useState<Readonly<Record<string, BodyState>>>({});
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
  return (
    <Stack gap="xsmall" testID={`${testIDPrefix}.logs`} style={CAPTURE_LOG_LINES_INSET}>
      {logs.map((log) => (
        <CapturedLogLine
          key={log.id}
          log={log}
          locale={locale}
          showService={showService}
          body={log.bodyPrefixTruncated === true && openIds.has(log.id) ? bodies[log.id] : undefined}
          onOpen={log.bodyPrefixTruncated === true ? () => open(log.id) : undefined}
          testID={`${testIDPrefix}.log.${log.id}`}
        />
      ))}
    </Stack>
  );
}

/** "Logs from this request": the request's own lines, oldest first. */
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
  const logs = React.useMemo(
    () =>
      trace.summaries
        .filter((summary): summary is DatabaseCaptureSummaryV1 => summary.kind === 'log')
        .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)),
    [trace],
  );
  if (logs.length === 0) return null;
  return (
    <ItemGroup
      title={text('plugins.telemetry.exceptions.requestLogs', 'Logs from this request')}
      description={text(
        logs.length === 1 ? 'plugins.telemetry.exceptions.requestLogs.one' : 'plugins.telemetry.exceptions.requestLogs.many',
        logs.length === 1 ? '1 line' : '{count} lines',
      ).replace('{count}', String(logs.length))}
    >
      <CapturedLogLines logs={logs} locale={locale} readBody={readBody} testIDPrefix={testIDPrefix} />
    </ItemGroup>
  );
}

/** One captured log line. */
function CapturedLogLine({
  log,
  locale,
  showService,
  body,
  onOpen,
  testID,
}: Readonly<{
  log: DatabaseCaptureSummaryV1;
  locale: string;
  showService: boolean;
  body?: BodyState;
  onOpen?: () => void;
  testID?: string;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const severity = captureSeverityWord(log.severityNumber);
  const tone = captureSeverityTone(log.severityNumber);
  const failing = tone === 'danger';
  const prefix = log.bodyPrefix ?? null;
  const truncated = log.bodyPrefixTruncated === true;
  const clock = captureClockOf(locale, log.at);
  const service = showService && log.serviceName ? log.serviceName : null;
  // An open line reads its whole message in place of the cut start; a reading or failed open says so instead.
  const message =
    body === undefined
      ? prefix === null
        ? null
        : `${prefix}${truncated ? '…' : ''}`
      : body.kind === 'loading'
        ? `${prefix ?? ''}…`
        : body.kind === 'unavailable'
          ? text('plugins.telemetry.exceptions.logUnavailable', 'The collector didn’t return this line.')
          : (body.body ?? text('plugins.telemetry.exceptions.logEmpty', 'This line has no message.'));
  // Lines wrap rather than cut: on a phone the clock leaves the message room, so no line is a dead end.
  // The clock, level and service are the line's fixed lead; the message is its own column, so a long one wraps
  // under its own first word rather than back under the clock.
  const line = (
    <Row gap="none" align="flex-start">
      <Stack gap="none" testID={testID ? `${testID}.prefix` : undefined}>
        <Text variant="code" selectable={!truncated}>
          <Text variant="code" tone="secondary" value={`${clock}  `} />
          <Text variant="code" tone={tone} value={severity} />
          {service === null ? null : <Text variant="code" tone="secondary" value={`  ${service}`} />}
          <Text variant="code" value="  " />
        </Text>
      </Stack>
      {message === null ? null : (
        <Stack gap="none" grow testID={testID ? `${testID}.message` : undefined}>
          <Text
            variant="code"
            selectable={!truncated}
            tone={body?.kind === 'unavailable' ? 'secondary' : failing ? 'danger' : 'neutral'}
            value={message}
          />
        </Stack>
      )}
    </Row>
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
