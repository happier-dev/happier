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
  DatabaseCaptureEndpointV1,
  DatabaseCaptureSummaryV1,
} from '@happier-dev/database-protocol';
import {
  Collection,
  formatHappierDataValue,
  formatHappierDuration,
  useHappierCollection,
  type CollectionAnatomy,
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
import { requestLabelOf } from '../traceWaterfall.js';
import { CapturedLogLines, type CapturedLogBodyReader } from './CapturedRequest.js';
import { formatTelemetryMetric } from '../widgets/telemetryWidgetModel.js';

/** A share as every Telemetry surface states it ("2.4%", "38%"); unknown reads "—". */
const share = (value: number | null, locale: string) =>
  formatTelemetryMetric('errorRate', value, locale);

const EMPTY_SET: ReadonlySet<string> = new Set();

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

/** The time at a row's end: tabular, never truncated. */
function TimeMeta(
  props: Readonly<{
    ms: number | null | undefined;
    locale: string;
    failed?: boolean;
  }>,
) {
  return (
    <Text
      variant="meta"
      tone={props.failed ? 'danger' : 'secondary'}
      value={
        props.ms === null || props.ms === undefined
          ? '—'
          : formatHappierDuration(props.ms, props.locale)
      }
    />
  );
}

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
  }>,
) {
  const { items, keyOf, onOpen } = props;
  const byKey = React.useMemo(
    () => new Map(items.map((item) => [keyOf(item), item])),
    [items, keyOf],
  );
  const model = useHappierCollection({
    items,
    keyOf,
    openKey: null,
    onOpenChange: (key) => {
      const item = key === null ? undefined : byKey.get(String(key));
      if (item && onOpen) onOpen(item);
    },
  });
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
        // The list is the whole answer here: no detail pane beside it, rows on the page's own scroller.
        detail="none"
        scroll="page"
        minListWidth={0}
        minDetailWidth={0}
        preferredListRatio={1}
      />
      <MoreButton more={props.more} testID={`${props.testID}.older`} />
    </Stack>
  );
}

/** The phone's second line (lab p7Setup-tabp): "4,812 requests · 2.4% errors". */
function endpointPhoneFacts(view: CaptureEndpointView, locale: string, text: PluginTranslate): string {
  return [
    text('plugins.telemetry.capture.requestsCount', '{count} requests', {
      count: formatHappierDataValue(view.endpoint.requestCount, locale),
    }),
    text('plugins.telemetry.capture.errorsShare', '{share} errors', { share: share(view.errorRate, locale) }),
  ].join(' · ');
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
        minWidth: 84,
        priority: 4,
        align: 'end',
        render: (view) => <Text variant="body" value={formatHappierDataValue(view.endpoint.requestCount, locale)} />,
      },
      {
        key: 'errors',
        title: text('plugins.telemetry.capture.errorRate', 'Error rate'),
        minWidth: 88,
        priority: 3,
        align: 'end',
        render: (view) => (
          <Stack gap="none" align="flex-end">
            <Text variant="body" value={share(view.errorRate, locale)} />
            {view.endpoint.errorCount > 0 ? (
              <Text
                variant="meta"
                tone="secondary"
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
        minWidth: 76,
        priority: 2,
        align: 'end',
        render: (view) => (
          <Text variant="body" value={view.meanMs === null ? '—' : formatHappierDuration(view.meanMs, locale)} />
        ),
      },
      {
        key: 'database',
        title: text('plugins.telemetry.capture.inDatabase', 'In database'),
        minWidth: 92,
        priority: 1,
        align: 'end',
        render: (view) => <Text variant="body" value={share(view.databaseShare, locale)} />,
      },
    ];
    return {
      glyph: () => null,
      loadingGlyph: false,
      title: (view) => captureEndpointTitle(view.endpoint),
      titleIdentifier: true,
      // The table names the service under the route; the phone's row says the figures its columns would.
      byline: (view, layout) =>
        layout?.fieldColumns === false ? endpointPhoneFacts(view, locale, text) : view.endpoint.serviceName || null,
      listFact: (view) => <TimeMeta ms={view.meanMs} locale={locale} />,
      fields,
      // A route is a short code ("POST /checkout"): its columns keep their room on a page column, and a phone, where
      // no column fits beside it, recomposes the rows to the list.
      titleMinWidth: 220,
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
      empty={text('plugins.telemetry.capture.noRequests', 'Waiting for the first request')}
      {...(actions && actions.length > 0 ? { useRowActions } : {})}
      more={props.more ?? null}
    />
  );
}

const summaryKey = (item: DatabaseCaptureSummaryV1) => item.id;

/** Traces: each captured request, newest first, its time at the row's end; a row opens that request. */
export function CaptureTraces(
  props: Readonly<{
    items: readonly DatabaseCaptureSummaryV1[];
    loading: boolean;
    locale: string;
    onOpen: (request: DatabaseCaptureSummaryV1) => void;
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
      [
        item.serviceName || null,
        item.httpStatusCode === null || item.httpStatusCode === undefined
          ? null
          : String(item.httpStatusCode),
        time.format(item.at),
      ]
        .filter((part): part is string => part !== null)
        .join(' · ');
    return {
      glyph: () => null,
      loadingGlyph: false,
      title: requestLabelOf,
      titleIdentifier: true,
      byline: facts,
      // A failed request says so once, in the failure tone, beside its time.
      titleMeta: (item) => (
        <TimeMeta
          ms={item.durationMs}
          locale={locale}
          failed={captureSummaryFailed(item)}
        />
      ),
      titleMetaAlign: 'row',
      accessibilityLabel: (item) => `${requestLabelOf(item)}, ${facts(item)}`,
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
      <ItemGroup testID="telemetry.capture.logs.card">
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
