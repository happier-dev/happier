import * as React from 'react';
import { captureSummaryFailed, type DatabaseCaptureSummaryV1 } from '@happier-dev/plugin-sdk/database';

import { useHappierCollection } from '../../presentation/collection/useCollection.js';
import { formatHappierDuration } from '../../presentation/data/dataModel.js';
import { Button } from '../Button.js';
import { Collection, type CollectionAnatomy, type CollectionDetailHeader, type CollectionDetailRenderContext, type CollectionRowActions } from '../Collection.js';
import { Stack } from '../Layout.js';
import { usePluginTranslation } from '../PluginUiProvider.js';
import { Text } from '../Text.js';

const EMPTY_SET: ReadonlySet<string> = new Set();
const summaryKey = (item: DatabaseCaptureSummaryV1) => item.id;

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

export function CaptureMoreButton(
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
export function CaptureTimeMeta(
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

/** The one list shape every capture view shares: the page's flat list, rows on the page's own scroller. */
export function CaptureList<Item>(
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
    /**
     * The open row's title band. Given it, the detail stands on the platform's body edge beside the list and pushed,
     * and a pushed detail is named by it; without it the detail draws its own edge (Traces).
     */
    detailHeader?: (item: Item) => CollectionDetailHeader;
  }>,
) {
  const { items, keyOf, onOpen, detail, detailHeader } = props;
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
  const headerOf = React.useCallback(
    (key: string) => {
      const item = byKey.get(key);
      return item && detailHeader ? detailHeader(item) : { title: props.label };
    },
    [byKey, detailHeader, props.label],
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
        {...(detail
          ? {
              // The rows and the chosen one's detail share the page (lab dbCapture-traces: a short list, a wide detail).
              detail: 'auto' as const,
              // A pushed detail returns to this list by name ("‹ Traces"), not a bare Back beside the page's own.
              detailBackLabel: props.label,
              detailOpenIntent: picked === null ? ('landing' as const) : ('explicit' as const),
              renderDetail,
              ...(detailHeader ? { detailHeader: headerOf } : {}),
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
      <CaptureMoreButton more={props.more} testID={`${props.testID}.older`} />
    </Stack>
  );
}

/**
 * Queries: each statement the app ran, its shape, where and when, its time at the row's end. A host that shows one
 * statement's detail (Workbench Insights) opens it beside the list through `detail`, as Traces does.
 */
export function CaptureQueries(
  props: Readonly<{
    items: readonly DatabaseCaptureSummaryV1[];
    loading: boolean;
    locale: string;
    more?: CapturePageMore | null;
    detail?: CaptureListDetail<DatabaseCaptureSummaryV1>;
  }>,
) {
  const text = usePluginTranslation();
  const { locale } = props;
  const { facts, shape } = React.useMemo(() => {
    const time = new Intl.DateTimeFormat(locale, {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    });
    return {
      facts: (item: DatabaseCaptureSummaryV1) =>
        [item.serviceName || null, time.format(item.at)]
          .filter((part): part is string => part !== null)
          .join(' · '),
      shape: (item: DatabaseCaptureSummaryV1) =>
        item.shape ?? text('plugins.telemetry.capture.unnamedQuery', 'Statement'),
    };
  }, [locale, text]);
  const anatomy = React.useMemo<
    CollectionAnatomy<DatabaseCaptureSummaryV1>
  >(() => {
    return {
      glyph: () => null,
      loadingGlyph: false,
      title: shape,
      titleIdentifier: true,
      byline: facts,
      titleMeta: (item) => (
        <CaptureTimeMeta
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
  }, [facts, locale, shape, text]);
  // The open statement is named by its shape, with where and when under it; its full SQL is the body.
  const detailHeader = React.useCallback(
    (item: DatabaseCaptureSummaryV1) => ({ title: shape(item), subtitle: facts(item) }),
    [facts, shape],
  );
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
      {...(props.detail ? { detail: props.detail } : {})}
      detailHeader={detailHeader}
      more={props.more ?? null}
    />
  );
}
