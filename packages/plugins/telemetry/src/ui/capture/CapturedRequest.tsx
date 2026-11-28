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
  Stack,
  Text,
  usePluginTheme,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';
import {
  CapacityBar,
  CapturedLogLines,
  type CapturedLogBody,
  type CapturedLogBodyReader,
  HAPPIER_DATA_METRICS,
  IntervalTimeline,
  formatHappierDuration,
} from '@happier-dev/plugin-ui/components';
import type {
  DatabaseCaptureSummaryV1,
  DatabaseCaptureQueryGetResultV1,
  DatabaseCaptureTraceGetResultV1,
} from '@happier-dev/database-protocol';

import { failedStep, projectWaterfall, slowestSteps } from '../traceWaterfall.js';
import { captureStepKind } from './model.js';
import { formatTelemetryMetric } from '../widgets/telemetryWidgetModel.js';

export type CapturedTraceV1 = Extract<
  DatabaseCaptureTraceGetResultV1,
  { ok: true }
>;

export function projectCapturedLogBody(
  detail: Extract<DatabaseCaptureQueryGetResultV1, { ok: true }>['detail'],
): CapturedLogBody | null {
  const log = detail?.log;
  if (log === null || typeof log !== 'object' || Array.isArray(log) || !('body' in log)) return null;
  const body = log.body;
  if (body === undefined || body === null) return null;
  return {
    text: typeof body === 'string' ? body : JSON.stringify(body),
    secretMaskingIncomplete: detail?.secretMasking === 'incomplete',
  };
}

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
              // A request reads as the shared route cell: its method quiet, its route in identifier type.
              ...(row.route
                ? { label: row.route.route, labelLead: row.route.method, identifier: true }
                : { label: rowLabel(row) }),
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
          // The toggle opens each step's exact start and end; the rows already show how long each took.
          valuesLabel={text('plugins.telemetry.request.exactTimes', 'Start and end times')}
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
