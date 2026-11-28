import * as React from 'react';
import { captureSummaryFailed, type DatabaseCaptureEndpointV1, type DatabaseCaptureSummaryV1 } from '@happier-dev/plugin-sdk/database';

import { formatHappierDataValue, formatHappierDuration } from '../../presentation/data/dataModel.js';
import type { CollectionAnatomy, CollectionField, CollectionRowActions } from '../Collection.js';
import { ItemGroup } from '../List.js';
import { Stack } from '../Layout.js';
import { usePluginTranslation, type PluginTranslate } from '../PluginUiProvider.js';
import { Text } from '../Text.js';
import {
  CaptureList, CaptureMoreButton, CaptureTimeMeta, type CaptureListDetail, type CapturePageMore,
} from './CaptureQueries.js';
import { CapturedLogLines, type CapturedLogBodyReader } from './CapturedLogLines.js';
import {
  captureEndpointTitle, formatCaptureShare, projectCaptureEndpoints, requestLabelOf, requestRouteOf,
  type CaptureEndpointView,
} from './capturePresentation.js';

/**
 * The one route cell every capture list draws (lab dbCapture): the method quiet, then the route in identifier type,
 * whether the row is an endpoint or one request to it. A record with no route names itself by its shape.
 */
function routeTitleSlots<Item>(
  parts: (item: Item) => Readonly<{ method: string | null; route: string }>,
): Pick<CollectionAnatomy<Item>, 'title' | 'titleLead' | 'titleIdentifier'> {
  return { title: (item) => parts(item).route, titleLead: (item) => parts(item).method, titleIdentifier: true };
}


/** A route row's own actions ("Add a check…"), offered from the row's "…" menu. */
export type CaptureEndpointAction = Readonly<{
  id: string;
  label: string;
  onSelect: (endpoint: DatabaseCaptureEndpointV1) => void;
}>;

/** The route column and every figure column of the Endpoints table, at their readable widths. */
const ENDPOINT_TITLE_MIN_WIDTH = 220;
const ENDPOINT_FIELD_MIN_WIDTHS = Object.freeze({ requests: 84, errors: 88, mean: 76, database: 92 });
const ENDPOINT_TABLE_MIN_WIDTH = Object.values(ENDPOINT_FIELD_MIN_WIDTHS)
  .reduce((sum, width) => sum + width, ENDPOINT_TITLE_MIN_WIDTH);

/** A route failed in this window: the one decision its Error rate cell and its phone line both speak from. */
const endpointFailing = (view: CaptureEndpointView) => view.endpoint.errorCount > 0;

/** "1 request" / "38 requests". */
function requestCount(count: number, locale: string, text: PluginTranslate): string {
  return count === 1
    ? text('plugins.telemetry.capture.requestsCount.one', '1 request')
    : text('plugins.telemetry.capture.requestsCount', '{count} requests', { count: formatHappierDataValue(count, locale) });
}

/** "9 failed": the one part of a route's phone line that speaks, and only when the route failed. */
function endpointFailedCount(view: CaptureEndpointView, locale: string, text: PluginTranslate): string | null {
  return endpointFailing(view)
    ? text('plugins.telemetry.capture.failed', '{count} failed', {
        count: formatHappierDataValue(view.endpoint.errorCount, locale),
      })
    : null;
}

/**
 * The phone's second line, the figures the table's columns hold (lab dbCapture-endpointsp): "38 requests · 22 ms · 24% in
 * database", quiet. A failed count leads it in the failure tone (`bylineLead`), so only that part speaks.
 */
function endpointPhoneFacts(view: CaptureEndpointView, locale: string, text: PluginTranslate): string {
  return [
    requestCount(view.endpoint.requestCount, locale, text),
    view.meanMs === null ? null : formatHappierDuration(view.meanMs, locale),
    view.databaseShare === null
      ? null
      : text('plugins.telemetry.capture.inDatabaseShare', '{share} in database', {
          share: formatCaptureShare(view.databaseShare, locale),
        }),
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
}

/**
 * Endpoints (D27 #9): each route with its requests, error rate (and failed count), mean time and time in the database,
 * compared down their columns (lab p7Flows-mark). Failing routes lead; unthresholded numbers stay ink. A phone
 * recomposes each row to its route, "4,812 requests · 2.4% errors" and its mean time.
 */
export function CaptureEndpoints(
  props: Readonly<{
    items: readonly DatabaseCaptureEndpointV1[];
    loading: boolean;
    locale: string;
    actions?: readonly CaptureEndpointAction[];
    more?: CapturePageMore | null;
  }>,
) {
  const text = usePluginTranslation();
  const { locale, actions } = props;
  const views = React.useMemo(() => projectCaptureEndpoints(props.items), [props.items]);
  const keyOf = React.useCallback(
    (view: CaptureEndpointView) => `${view.endpoint.serviceName} ${captureEndpointTitle(view.endpoint)}`,
    [],
  );
  const anatomy = React.useMemo<CollectionAnatomy<CaptureEndpointView>>(() => {
    const fields: CollectionField<CaptureEndpointView>[] = [
      {
        key: 'requests',
        title: text('plugins.telemetry.capture.requests', 'Requests'),
        minWidth: ENDPOINT_FIELD_MIN_WIDTHS.requests,
        priority: 4,
        align: 'end',
        render: (view) => <Text variant="body" value={formatHappierDataValue(view.endpoint.requestCount, locale)} />,
      },
      {
        key: 'errors',
        title: text('plugins.telemetry.capture.errorRate', 'Error rate'),
        minWidth: ENDPOINT_FIELD_MIN_WIDTHS.errors,
        priority: 3,
        align: 'end',
        render: (view) => (
          <Stack gap="none" align="flex-end">
            <Text variant="body" {...(endpointFailing(view) ? { tone: 'danger' as const } : {})} value={formatCaptureShare(view.errorRate, locale)} />
            {endpointFailing(view) ? (
              <Text
                variant="meta"
                tone="danger"
                value={text('plugins.telemetry.capture.failed', '{count} failed', {
                  count: formatHappierDataValue(view.endpoint.errorCount, locale),
                })}
              />
            ) : null}
          </Stack>
        ),
      },
      {
        key: 'mean',
        // The endpoints contract counts total time per route, so the column is the mean (no per-route p95).
        title: text('plugins.telemetry.capture.mean', 'Mean'),
        minWidth: ENDPOINT_FIELD_MIN_WIDTHS.mean,
        priority: 2,
        align: 'end',
        render: (view) => (
          <Text variant="body" value={view.meanMs === null ? '—' : formatHappierDuration(view.meanMs, locale)} />
        ),
      },
      {
        key: 'database',
        title: text('plugins.telemetry.capture.inDatabase', 'In database'),
        minWidth: ENDPOINT_FIELD_MIN_WIDTHS.database,
        priority: 1,
        align: 'end',
        render: (view) => <Text variant="body" value={formatCaptureShare(view.databaseShare, locale)} />,
      },
    ];
    return {
      glyph: () => null,
      loadingGlyph: false,
      ...routeTitleSlots((view: CaptureEndpointView) => ({ method: view.endpoint.method, route: view.endpoint.route })),
      // The table names the service under the route; the phone's row says the figures its columns would, in the
      // failure tone when the route failed.
      byline: (view, layout) =>
        layout?.fieldColumns === false ? endpointPhoneFacts(view, locale, text) : view.endpoint.serviceName || null,
      // A phone row has no Error rate column: its failed count leads the line, the only part in the failure tone.
      bylineLead: (view, layout) => {
        const failedCount = layout?.fieldColumns === false ? endpointFailedCount(view, locale, text) : null;
        return failedCount === null ? null : <Text variant="meta" tone="danger" value={failedCount} />;
      },
      fields,
      // A route is a short code ("POST /checkout"): its columns keep their room on a page column, and a phone, where
      // no column fits beside it, recomposes the rows to the list.
      titleMinWidth: ENDPOINT_TITLE_MIN_WIDTH,
      accessibilityLabel: (view) => [captureEndpointTitle(view.endpoint), endpointFailedCount(view, locale, text),
        endpointPhoneFacts(view, locale, text)].filter((part): part is string => part !== null).join(', '),
      testID: (view) => `telemetry.capture.endpoint.${view.endpoint.method} ${view.endpoint.route}`,
      columnTitles: { title: text('plugins.telemetry.capture.route', 'Route') },
    };
  }, [locale, text]);
  const useRowActions = React.useCallback(
    (view: CaptureEndpointView): CollectionRowActions =>
      actions && actions.length > 0
        ? {
            secondaryActions: actions.map((action) => ({ id: action.id, label: action.label })),
            secondaryActionAccessibilityLabel: text('plugins.telemetry.capture.routeActions', 'Actions for {route}', {
              route: captureEndpointTitle(view.endpoint),
            }),
            onSecondaryAction: (id) => actions.find((action) => action.id === id)?.onSelect(view.endpoint),
          }
        : {},
    [actions, text],
  );
  return (
    <CaptureList
      testID="telemetry.capture.endpoints"
      label={text('plugins.telemetry.capture.endpoints', 'Endpoints')}
      items={views}
      loading={props.loading}
      keyOf={keyOf}
      anatomy={anatomy}
      presentation="table"
      // A route's figures are compared together: the table stands only where every column fits beside the route, and a
      // phone recomposes each row to its route and its figures line rather than dropping them (lab dbCapture-endpointsp).
      tableMinWidth={ENDPOINT_TABLE_MIN_WIDTH}
      empty={text('plugins.telemetry.capture.noRequests', 'Waiting for the first request')}
      {...(actions && actions.length > 0 ? { useRowActions } : {})}
      more={props.more ?? null}
    />
  );
}

const summaryKey = (item: DatabaseCaptureSummaryV1) => item.id;

/**
 * Traces: each captured request, newest first, its time at the row's end. A row opens that request: beside the list
 * through `detail` (the first one shown until the person picks), or through `onOpen` where the caller owns the page.
 */
export function CaptureTraces(
  props: Readonly<{
    items: readonly DatabaseCaptureSummaryV1[];
    loading: boolean;
    locale: string;
    more?: CapturePageMore | null;
  }> &
    (
      | Readonly<{ onOpen: (request: DatabaseCaptureSummaryV1) => void; detail?: undefined }>
      | Readonly<{ detail: CaptureListDetail<DatabaseCaptureSummaryV1>; onOpen?: undefined }>
    ),
) {
  const text = usePluginTranslation();
  const { locale } = props;
  const anatomy = React.useMemo<
    CollectionAnatomy<DatabaseCaptureSummaryV1>
  >(() => {
    const time = new Intl.DateTimeFormat(locale, {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    });
    // A healthy status stays quiet (lab dbCapture-traces): a failed request names its status in the row's rose end.
    const facts = (item: DatabaseCaptureSummaryV1) =>
      [
        item.serviceName || null,
        time.format(item.at),
      ]
        .filter((part): part is string => part !== null)
        .join(' · ');
    return {
      glyph: () => null,
      loadingGlyph: false,
      ...routeTitleSlots(requestRouteOf),
      byline: facts,
      // A failed request says so once, in the failure tone, its status before its time ("500 · 18 ms").
      titleMeta: (item) => (
        <CaptureTimeMeta
          ms={item.durationMs}
          locale={locale}
          failed={captureSummaryFailed(item)}
          status={item.httpStatusCode ?? null}
        />
      ),
      titleMetaAlign: 'row',
      accessibilityLabel: (item) => [requestLabelOf(item), facts(item),
        captureSummaryFailed(item) && item.httpStatusCode != null ? String(item.httpStatusCode) : null]
        .filter((part): part is string => part !== null).join(', '),
      testID: (item) => `telemetry.capture.trace.${item.id}`,
      columnTitles: {
        title: text('plugins.telemetry.capture.request', 'Request'),
      },
    };
  }, [locale, text]);
  return (
    <CaptureList
      testID="telemetry.capture.traces"
      label={text('plugins.telemetry.capture.traces', 'Traces')}
      items={props.items}
      loading={props.loading}
      keyOf={summaryKey}
      anatomy={anatomy}
      empty={text(
        'plugins.telemetry.capture.noTraces',
        'No requests in this window',
      )}
      {...(props.detail ? { detail: props.detail } : { onOpen: props.onOpen })}
      more={props.more ?? null}
    />
  );
}

/**
 * Logs: the lines the app wrote, newest first, read as log lines (time · level · service · message, mono) on one
 * card, the same lines a request's logs draw. A cut line opens its whole message through `readBody`.
 */
export function CaptureLogs(
  props: Readonly<{
    items: readonly DatabaseCaptureSummaryV1[];
    loading: boolean;
    locale: string;
    readBody: CapturedLogBodyReader;
    more?: CapturePageMore | null;
  }>,
) {
  const text = usePluginTranslation();
  if (props.items.length === 0) {
    return (
      <Text
        testID="telemetry.capture.logs.empty"
        tone="secondary"
        value={
          props.loading
            ? text('plugins.telemetry.capture.reading', 'Reading…')
            : text('plugins.telemetry.capture.noLogs', 'No log lines in this window')
        }
      />
    );
  }
  return (
    <Stack gap="medium">
      {/* One sheet of lines (lab dbCapture-logs): an untitled group draws no chrome unless it asks for its sheet. */}
      <ItemGroup testID="telemetry.capture.logs.card" surface="sheet">
        <CapturedLogLines logs={props.items} locale={props.locale} readBody={props.readBody} showService
          testIDPrefix="telemetry.capture" />
      </ItemGroup>
      <CaptureMoreButton more={props.more} testID="telemetry.capture.logs.older" />
    </Stack>
  );
}
