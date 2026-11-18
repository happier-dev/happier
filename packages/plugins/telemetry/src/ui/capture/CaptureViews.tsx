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
  type CollectionRowActions,
} from '@happier-dev/plugin-ui/components';
import {
  Button,
  Stack,
  Text,
  usePluginTranslation,
  type PluginTranslate,
} from '@happier-dev/plugin-ui';

import {
  captureClockOf,
  captureEndpointTitle,
  captureSeverityWord,
  captureSummaryFailed,
  projectCaptureEndpoints,
  type CaptureEndpointView,
} from './model.js';
import { requestLabelOf } from '../traceWaterfall.js';
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
        presentation="list"
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

function endpointFacts(
  view: CaptureEndpointView,
  locale: string,
  text: PluginTranslate,
  withService: boolean,
): string {
  return [
    withService ? view.endpoint.serviceName || null : null,
    text('plugins.telemetry.capture.requestsCount', '{count} requests', {
      count: formatHappierDataValue(view.endpoint.requestCount, locale),
    }),
    // Unthresholded numbers stay ink; only a failing saved check owns a warning colour.
    text('plugins.telemetry.capture.errorsShare', '{share} errors', {
      share: share(view.errorRate, locale),
    }),
    view.endpoint.errorCount > 0
      ? text('plugins.telemetry.capture.failed', '{count} failed', {
          count: formatHappierDataValue(view.endpoint.errorCount, locale),
        })
      : null,
    view.databaseShare === null
      ? null
      : text(
          'plugins.telemetry.capture.inDatabaseShare',
          '{share} in the database',
          {
            share: share(view.databaseShare, locale),
          },
        ),
  ]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(' · ');
}

/**
 * Endpoints (D27 #9): each route with its requests, error share, failed count and time in the database, its mean time
 * at the row's end. Failing routes lead; healthy ones stay quiet.
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
  const views = React.useMemo(
    () => projectCaptureEndpoints(props.items),
    [props.items],
  );
  // The service only says something when the Environment runs more than one.
  const withService = React.useMemo(
    () => new Set(props.items.map((item) => item.serviceName)).size > 1,
    [props.items],
  );
  const keyOf = React.useCallback(
    (view: CaptureEndpointView) =>
      `${view.endpoint.serviceName} ${captureEndpointTitle(view.endpoint)}`,
    [],
  );
  const anatomy = React.useMemo<CollectionAnatomy<CaptureEndpointView>>(
    () => ({
      glyph: () => null,
      loadingGlyph: false,
      title: (view) => captureEndpointTitle(view.endpoint),
      titleIdentifier: true,
      byline: (view) => endpointFacts(view, locale, text, withService),
      titleMeta: (view) => <TimeMeta ms={view.meanMs} locale={locale} />,
      titleMetaAlign: 'row',
      accessibilityLabel: (view) =>
        `${captureEndpointTitle(view.endpoint)}, ${endpointFacts(view, locale, text, true)}`,
      testID: (view) =>
        `telemetry.capture.endpoint.${view.endpoint.method} ${view.endpoint.route}`,
      columnTitles: { title: text('plugins.telemetry.capture.route', 'Route') },
    }),
    [locale, text, withService],
  );
  const useRowActions = React.useCallback(
    (view: CaptureEndpointView): CollectionRowActions =>
      actions && actions.length > 0
        ? {
            secondaryActions: actions.map((action) => ({
              id: action.id,
              label: action.label,
            })),
            secondaryActionAccessibilityLabel: text(
              'plugins.telemetry.capture.routeActions',
              'Actions for {route}',
              {
                route: captureEndpointTitle(view.endpoint),
              },
            ),
            onSecondaryAction: (id) =>
              actions
                .find((action) => action.id === id)
                ?.onSelect(view.endpoint),
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
      empty={text(
        'plugins.telemetry.capture.noRequests',
        'Waiting for the first request',
      )}
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

/** Logs: the lines the app wrote, newest first; each line's start, then its level, its own clock and its service. */
export function CaptureLogs(
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
    const facts = (item: DatabaseCaptureSummaryV1) =>
      [
        captureSeverityWord(item.severityNumber),
        captureClockOf(locale, item.at),
        item.serviceName || null,
      ]
        .filter((part): part is string => part !== null)
        .join(' · ');
    const message = (item: DatabaseCaptureSummaryV1) =>
      item.bodyPrefix
        ? `${item.bodyPrefix}${item.bodyPrefixTruncated ? '…' : ''}`
        : text(
            'plugins.telemetry.exceptions.logEmpty',
            'This line has no message.',
          );
    return {
      glyph: () => null,
      loadingGlyph: false,
      title: message,
      titleIdentifier: true,
      byline: facts,
      accessibilityLabel: (item) => `${facts(item)}, ${message(item)}`,
      testID: (item) => `telemetry.capture.log.${item.id}`,
      columnTitles: { title: text('plugins.telemetry.capture.line', 'Line') },
    };
  }, [locale, text]);
  return (
    <CaptureList
      testID="telemetry.capture.logs"
      label={text('plugins.telemetry.capture.logs', 'Logs')}
      items={props.items}
      loading={props.loading}
      keyOf={summaryKey}
      anatomy={anatomy}
      empty={text(
        'plugins.telemetry.capture.noLogs',
        'No log lines in this window',
      )}
      more={props.more ?? null}
    />
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
