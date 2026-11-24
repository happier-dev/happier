/**
 * The capture lists (P5 F7 / P6 F14d): Endpoints, Traces, Logs and Queries, each drawn from one page of its
 * `capture/*` read. Any surface that reads a capture source (an Environment's collector, a worktree's local
 * capture) draws these same views; it reads the page through its own Action path and hands the answer in.
 *
 * Each list is the page's flat list (lab p7Setup-tabp): the record in identifier type, its facts on the second line,
 * and its time at the row's end, so a column of times reads down the page on every width.
 */

import * as React from 'react';
import type {
  DatabaseCaptureCostMetadataV1,
  DatabaseCaptureEndpointV1,
  DatabaseCaptureSummaryV1,
} from '@happier-dev/database-protocol';
import {
  Collection,
  formatHappierDataValue,
  formatHappierDuration,
  useHappierCollection,
  type CollectionAnatomy,
  type CollectionDetailRenderContext,
  type CollectionField,
  type CollectionRowActions,
} from '@happier-dev/plugin-ui/components';
import {
  Button,
  ItemGroup,
  Stack,
  Text,
  usePluginTranslation,
  type PluginTranslate,
} from '@happier-dev/plugin-ui';

import {
  captureEndpointTitle,
  captureSummaryFailed,
  projectCaptureEndpoints,
  type CaptureEndpointView,
} from './model.js';
import { requestLabelOf, requestRouteOf } from '../traceWaterfall.js';
import { CapturedLogLines, type CapturedLogBodyReader } from './CapturedRequest.js';
import { formatTelemetryMetric } from '../widgets/telemetryWidgetModel.js';

/** A share as every Telemetry surface states it ("2.4%", "38%"); unknown reads "—". */
const share = (value: number | null, locale: string) =>
  formatTelemetryMetric('errorRate', value, locale);

const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * The one route cell every capture list draws (lab dbCapture): the method quiet, then the route in identifier type,
 * whether the row is an endpoint or one request to it. A record with no route names itself by its shape.
 */
function routeTitleSlots<Item>(
  parts: (item: Item) => Readonly<{ method: string | null; route: string }>,
): Pick<CollectionAnatomy<Item>, 'title' | 'titleLead' | 'titleIdentifier'> {
  return { title: (item) => parts(item).route, titleLead: (item) => parts(item).method, titleIdentifier: true };
}


/**
 * A list whose rows open beside it (lab dbCapture-traces): the chosen row's detail stands beside the list where both
 * fit and is pushed in their place where they don't. Until the person picks a row the first one is shown beside the
 * list (never pushed), so a wide list always has a selection.
 */
export type CaptureListDetail<Item> = Readonly<{
  /** The row the person opened, or null to show the first beside the list. */
  openId: string | null;
  onOpenChange: (id: string | null) => void;
  render: (item: Item, context: CollectionDetailRenderContext) => React.ReactNode;
}>;

/** The next page of a list, when the read said there is one. */
export type CapturePageMore = Readonly<{ onPress: () => void; busy: boolean }>;

/** A route row's own actions ("Add a check…"), offered from the row's "…" menu. */
export type CaptureEndpointAction = Readonly<{
  id: string;
  label: string;
  onSelect: (endpoint: DatabaseCaptureEndpointV1) => void;
}>;

function MoreButton(
  props: Readonly<{ more: CapturePageMore | null | undefined; testID: string }>,
) {
  const text = usePluginTranslation();
  if (!props.more) return null;
  return (
    <Button
      testID={props.testID}
      variant="secondary"
      size="small"
      busy={props.more.busy}
      disabled={props.more.busy}
      title={text('plugins.telemetry.capture.older', 'Show older')}
      onPress={props.more.onPress}
    />
  );
}

/** The time at a row's end: tabular, never truncated. A failed row leads it with its status ("500 · 18 ms", lab). */
function TimeMeta(
  props: Readonly<{
    ms: number | null | undefined;
    locale: string;
    failed?: boolean;
    status?: number | null;
  }>,
) {
  const time = props.ms === null || props.ms === undefined ? '—' : formatHappierDuration(props.ms, props.locale);
  return (
    <Text
      variant="meta"
      tone={props.failed ? 'danger' : 'secondary'}
      value={props.failed && props.status != null ? `${props.status} · ${time}` : time}
    />
  );
}

/**
 * The list beside a request's detail: room for a route and its time, the rest for the waterfall (lab dbCapture-traces,
 * about 300 of 1010). Below both minima the detail is pushed in the list's place.
 */
const CAPTURE_SPLIT = Object.freeze({ minListWidthPx: 280, minDetailWidthPx: 480, preferredListRatio: 0.3 });

/** The route column and every figure column of the Endpoints table, at their readable widths. */
const ENDPOINT_TITLE_MIN_WIDTH = 220;
const ENDPOINT_FIELD_MIN_WIDTHS = Object.freeze({ requests: 84, errors: 88, mean: 76, database: 92 });
const ENDPOINT_TABLE_MIN_WIDTH = Object.values(ENDPOINT_FIELD_MIN_WIDTHS)
  .reduce((sum, width) => sum + width, ENDPOINT_TITLE_MIN_WIDTH);

/** The one list shape every capture view shares: the page's flat list, rows on the page's own scroller. */
function CaptureList<Item>(
  props: Readonly<{
    testID: string;
    label: string;
    items: readonly Item[];
    loading: boolean;
    keyOf: (item: Item) => string;
    anatomy: CollectionAnatomy<Item>;
    empty: string;
    onOpen?: (item: Item) => void;
    useRowActions?: (item: Item) => CollectionRowActions;
    more?: CapturePageMore | null;
    /** `table` for figures compared down a column (Endpoints); a phone recomposes it to the list. */
    presentation?: 'table' | 'list';
    /**
     * The narrowest width the table reads at; narrower, the rows recompose to the list and their `byline` carries
     * the figures. Omitted, the table stands at any width and drops columns as it narrows.
     */
    tableMinWidth?: number;
    detail?: CaptureListDetail<Item>;
    /** Controls over the rows (a time window): beside the list, and gone while one row's detail is the page. */
    header?: React.ReactNode;
  }>,
) {
  const { items, keyOf, onOpen, detail } = props;
  const byKey = React.useMemo(
    () => new Map(items.map((item) => [keyOf(item), item])),
    [items, keyOf],
  );
  // The person's pick while its row is listed; otherwise the row first shown, beside the list only. That row stays
  // while newer rows arrive above it, so the request being read is never swapped under the reader; it moves to the
  // first row only once it leaves the list.
  const picked = detail?.openId != null && byKey.has(detail.openId) ? detail.openId : null;
  const first = items[0];
  const [landing, setLanding] = React.useState<string | null>(null);
  const landingKey = landing !== null && byKey.has(landing) ? landing : first === undefined ? null : keyOf(first);
  if (detail !== undefined && landingKey !== landing) setLanding(landingKey);
  const openKey = detail === undefined ? null : picked ?? landingKey;
  const model = useHappierCollection({
    items,
    keyOf,
    openKey,
    onOpenChange: (key) => {
      if (detail) {
        detail.onOpenChange(key);
        return;
      }
      const item = key === null ? undefined : byKey.get(String(key));
      if (item && onOpen) onOpen(item);
    },
  });
  const renderDetail = React.useCallback(
    (key: string, context: CollectionDetailRenderContext) => {
      const item = byKey.get(String(key));
      return item && detail ? detail.render(item, context) : null;
    },
    [byKey, detail],
  );
  return (
    <Stack gap="medium">
      <Collection
        testID={props.testID}
        accessibilityLabel={props.label}
        model={model}
        anatomy={props.anatomy}
        presentation={props.presentation ?? 'list'}
        collapsedGroups={EMPTY_SET}
        loading={props.loading && items.length === 0}
        {...(props.useRowActions ? { useRowActions: props.useRowActions } : {})}
        empty={<Text tone="secondary" value={props.empty} />}
        scroll="page"
        {...(props.header === undefined ? {} : { header: props.header })}
        {...(detail
          ? {
              // The rows and the chosen one's detail share the page (lab dbCapture-traces: a short list, a wide detail).
              detail: 'auto' as const,
              // A pushed detail returns to this list by name ("‹ Traces"), not a bare Back beside the page's own.
              detailBackLabel: props.label,
              detailOpenIntent: picked === null ? ('landing' as const) : ('explicit' as const),
              renderDetail,
              minListWidth: CAPTURE_SPLIT.minListWidthPx,
              minDetailWidth: CAPTURE_SPLIT.minDetailWidthPx,
              preferredListRatio: CAPTURE_SPLIT.preferredListRatio,
            }
          : {
              // The list is the whole answer here: no detail beside it, rows on the page's own scroller.
              detail: 'none' as const,
              minListWidth: props.tableMinWidth ?? 0,
              minDetailWidth: 0,
              preferredListRatio: 1,
            })}
      />
      <MoreButton more={props.more} testID={`${props.testID}.older`} />
    </Stack>
  );
}

/** A route failed in this window: the one decision its Error rate cell and its phone line both speak from. */
const endpointFailing = (view: CaptureEndpointView) => view.endpoint.errorCount > 0;

/** "1 request" / "38 requests". */
function requestCount(count: number, locale: string, text: PluginTranslate): string {
  return count === 1
    ? text('plugins.telemetry.capture.requestsCount.one', '1 request')
    : text('plugins.telemetry.capture.requestsCount', '{count} requests', { count: formatHappierDataValue(count, locale) });
}

/**
 * The phone's second line, the figures the table's columns hold (lab dbCapture-endpointsp): "38 requests · 9 failed ·
 * 22 ms · 24% in database". A failed count is the only part that speaks, and only when there is one.
 */
function endpointPhoneFacts(view: CaptureEndpointView, locale: string, text: PluginTranslate): string {
  return [
    requestCount(view.endpoint.requestCount, locale, text),
    endpointFailing(view)
      ? text('plugins.telemetry.capture.failed', '{count} failed', {
          count: formatHappierDataValue(view.endpoint.errorCount, locale),
        })
      : null,
    view.meanMs === null ? null : formatHappierDuration(view.meanMs, locale),
    view.databaseShare === null
      ? null
      : text('plugins.telemetry.capture.inDatabaseShare', '{share} in database', {
          share: share(view.databaseShare, locale),
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
            <Text variant="body" {...(endpointFailing(view) ? { tone: 'danger' as const } : {})} value={share(view.errorRate, locale)} />
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
        render: (view) => <Text variant="body" value={share(view.databaseShare, locale)} />,
      },
    ];
    return {
      glyph: () => null,
      loadingGlyph: false,
      ...routeTitleSlots((view: CaptureEndpointView) => ({ method: view.endpoint.method, route: view.endpoint.route })),
      // The table names the service under the route; the phone's row says the figures its columns would, in the
      // failure tone when the route failed.
      byline: (view, layout) =>
        layout?.fieldColumns === false ? (
          <Text
            variant="meta"
            tone={endpointFailing(view) ? 'danger' : 'secondary'}
            numberOfLines={1}
            value={endpointPhoneFacts(view, locale, text)}
          />
        ) : (
          view.endpoint.serviceName || null
        ),
      fields,
      // A route is a short code ("POST /checkout"): its columns keep their room on a page column, and a phone, where
      // no column fits beside it, recomposes the rows to the list.
      titleMinWidth: ENDPOINT_TITLE_MIN_WIDTH,
      accessibilityLabel: (view) => `${captureEndpointTitle(view.endpoint)}, ${endpointPhoneFacts(view, locale, text)}`,
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
    /** Controls over the rows (the time window), which give way while a request's detail is the page. */
    header?: React.ReactNode;
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
        <TimeMeta
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
      {...(props.header === undefined ? {} : { header: props.header })}
      more={props.more ?? null}
    />
  );
}

/** A retained App LLM call (J4): the span its app reported, with the model and token fields the collector kept. */
export type CaptureAppLlmCallV1 = DatabaseCaptureSummaryV1 & Readonly<{
  serviceVersion?: string;
  genAi?: DatabaseCaptureCostMetadataV1;
}>;

/**
 * LLM calls: each model call the app made, newest first — the model in identifier type, its service, provider and
 * tokens on the second line, its time at the row's end. A row opens the call's own trace, as a trace row does.
 */
export function CaptureAppLlmCalls(
  props: Readonly<{
    items: readonly CaptureAppLlmCallV1[];
    loading: boolean;
    locale: string;
    onOpen: (call: CaptureAppLlmCallV1) => void;
    more?: CapturePageMore | null;
  }>,
) {
  const text = usePluginTranslation();
  const { locale } = props;
  const anatomy = React.useMemo<CollectionAnatomy<CaptureAppLlmCallV1>>(() => {
    const model = (item: CaptureAppLlmCallV1) =>
      item.genAi?.modelId ?? item.genAi?.requestedModel ?? requestLabelOf(item);
    const facts = (item: CaptureAppLlmCallV1) => {
      const tokens = item.genAi?.tokens.total ?? null;
      return [
        item.serviceName || null,
        item.serviceVersion ?? null,
        item.genAi?.provider ?? null,
        tokens === null
          ? null
          : text('plugins.telemetry.capture.tokens', '{count} tokens', {
              count: formatHappierDataValue(tokens, locale),
            }),
      ]
        .filter((part): part is string => part !== null && part.length > 0)
        .join(' · ');
    };
    return {
      glyph: () => null,
      loadingGlyph: false,
      title: model,
      titleIdentifier: true,
      byline: facts,
      titleMeta: (item) => (
        <TimeMeta ms={item.durationMs} locale={locale} failed={captureSummaryFailed(item)} />
      ),
      titleMetaAlign: 'row',
      accessibilityLabel: (item) => `${model(item)}, ${facts(item)}`,
      testID: (item) => `telemetry.capture.llmCall.${item.id}`,
      columnTitles: {
        title: text('plugins.telemetry.capture.model', 'Model'),
      },
    };
  }, [locale, text]);
  return (
    <CaptureList
      testID="telemetry.capture.llmCalls"
      label={text('plugins.telemetry.capture.llmCalls', 'LLM calls')}
      items={props.items}
      loading={props.loading}
      keyOf={summaryKey}
      anatomy={anatomy}
      empty={text('plugins.telemetry.capture.noLlmCalls', 'No model calls in this window')}
      onOpen={props.onOpen}
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
      <MoreButton more={props.more} testID="telemetry.capture.logs.older" />
    </Stack>
  );
}

/** Queries: each statement the app ran, its shape, where and when, its time at the row's end. */
export function CaptureQueries(
  props: Readonly<{
    items: readonly DatabaseCaptureSummaryV1[];
    loading: boolean;
    locale: string;
    more?: CapturePageMore | null;
  }>,
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
    const facts = (item: DatabaseCaptureSummaryV1) =>
      [item.serviceName || null, time.format(item.at)]
        .filter((part): part is string => part !== null)
        .join(' · ');
    const shape = (item: DatabaseCaptureSummaryV1) =>
      item.shape ?? text('plugins.telemetry.capture.unnamedQuery', 'Statement');
    return {
      glyph: () => null,
      loadingGlyph: false,
      title: shape,
      titleIdentifier: true,
      byline: facts,
      titleMeta: (item) => (
        <TimeMeta
          ms={item.durationMs}
          locale={locale}
          failed={captureSummaryFailed(item)}
        />
      ),
      titleMetaAlign: 'row',
      accessibilityLabel: (item) => `${shape(item)}, ${facts(item)}`,
      testID: (item) => `telemetry.capture.query.${item.id}`,
      columnTitles: {
        title: text('plugins.telemetry.capture.statement', 'Statement'),
      },
    };
  }, [locale, text]);
  return (
    <CaptureList
      testID="telemetry.capture.queries"
      label={text('plugins.telemetry.capture.queries', 'Queries')}
      items={props.items}
      loading={props.loading}
      keyOf={summaryKey}
      anatomy={anatomy}
      empty={text(
        'plugins.telemetry.capture.noQueries',
        'No queries in this window',
      )}
      more={props.more ?? null}
    />
  );
}
