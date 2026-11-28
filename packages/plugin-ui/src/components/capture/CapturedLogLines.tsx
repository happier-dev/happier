import * as React from 'react';
import type { DatabaseCaptureSummaryV1 } from '@happier-dev/plugin-sdk/database';

import { projectPluginActionRejectionV1 } from '../../hostApi/executeAction.js';
import { HappierDisclosureChevron } from '../../presentation/collection/DisclosureChevron.js';
import { HappierPressable } from '../../presentation/interaction/Pressable.js';
import { HAPPIER_PAGE_METRICS } from '../../presentation/layout/pageMetrics.js';
import { HappierStateDetails } from '../../presentation/state/InfoState.js';
import { Stack } from '../Layout.js';
import { LogLine } from '../LogLine.js';
import { usePluginTheme, usePluginTranslation } from '../PluginUiProvider.js';
import { Text } from '../Text.js';
import { captureClockOf, captureSeverityTone, captureSeverityWord } from './capturePresentation.js';

export type CapturedLogBody = Readonly<{ text: string; secretMaskingIncomplete: boolean }>;

/** Reads the whole body of one cut log line; resolves null for a line with no message, rejects when unavailable. */
export type CapturedLogBodyReader = (logId: string) => Promise<CapturedLogBody | null>;

type BodyState =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'ready'; body: CapturedLogBody | null }>
  | Readonly<{ kind: 'unavailable'; error: unknown }>;

/** The log card keeps the sheet's row insets; its lines stack at the code line height, as the lab's log block. */
const CAPTURE_LOG_LINES_INSET = Object.freeze({
  paddingHorizontal: HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx,
  paddingVertical: HAPPIER_PAGE_METRICS.rowPaddingVerticalPx,
});

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
      (error: unknown) => settle(id, { kind: 'unavailable', error }),
    );
  };
  return (
    <Stack gap="none" testID={`${testIDPrefix}.logs`} style={CAPTURE_LOG_LINES_INSET}>
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
  const theme = usePluginTheme();
  const severity = captureSeverityWord(log.severityNumber);
  const tone = captureSeverityTone(log.severityNumber);
  const failing = tone === 'danger';
  const prefix = log.bodyPrefix ?? null;
  const truncated = log.bodyPrefixTruncated === true;
  const clock = captureClockOf(locale, log.at);
  const service = showService && log.serviceName ? log.serviceName : null;
  const failure = React.useMemo(() => body?.kind === 'unavailable'
    && typeof (body.error as { code?: unknown } | null)?.code === 'string'
    ? projectPluginActionRejectionV1(body.error, text) : null, [body, text]);
  const diagnostic = failure?.status === 'error' || failure?.status === 'outcomeUnknown' ? failure : null;
  // Keep the captured prefix while the full body is reading or refused.
  const message =
    body?.kind !== 'ready'
      ? prefix === null
        ? null
        : `${prefix}${truncated ? '…' : ''}`
      : (body.body?.text ?? text('plugins.telemetry.exceptions.logEmpty', 'This line has no message.'));
  // Lines wrap rather than cut: on a phone the clock leaves the message room, so no line is a dead end.
  // The clock, level and service are the line's fixed lead; the message is its own column, so a long one wraps
  // under its own first word rather than back under the clock.
  const line = (
    <LogLine
      gutter={{ value: clock }}
      prefix={
        <>
          <Text variant="code" tone={tone} value={severity} selectable={!truncated} />
          {service === null ? null : <Text variant="code" tone="secondary" value={service} selectable={!truncated} />}
        </>
      }
      prefixTestID={testID ? `${testID}.prefix` : undefined}
      message={message === null ? undefined : {
        selectable: !truncated,
        tone: body?.kind === 'unavailable' ? 'secondary' : failing ? 'danger' : 'neutral',
        plainText: message,
      }}
      messageTestID={testID ? `${testID}.message` : undefined}
    />
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
      {body?.kind === 'unavailable' ? (
        <>
          <Text variant="meta" tone="secondary" value={
            diagnostic?.message ?? text('plugins.telemetry.exceptions.logUnavailable', 'The collector didn’t return this line.')
          } />
          {diagnostic ? (
            <HappierStateDetails
              label={text('plugins.telemetry.request.failureDetails', 'Details')}
              details={diagnostic.code}
              align="start"
              renderCaret={(expanded) => <HappierDisclosureChevron expanded={expanded} color={theme.colors.secondaryText} />}
            />
          ) : null}
        </>
      ) : null}
      {body?.kind === 'ready' && body.body?.secretMaskingIncomplete ? (
        <Text variant="meta" tone="secondary" value={text('plugins.telemetry.capture.logMaskingIncomplete', 'Log text may contain secrets.')} />
      ) : null}
    </Stack>
  );
}
