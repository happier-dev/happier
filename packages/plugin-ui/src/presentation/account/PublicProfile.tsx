import { useMemo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import type { PublicProfileDisplayView } from '../../components/publicProfileTypes.js';

import { useHappierUiTheme } from '../../environment/context.js';
import { HAPPIER_SPACE_STEPS } from '../../environment/spacing.js';
import type { InertDeclarativeLabels } from '../../declarative/inertDeclarativeView.js';
import type { HappierUiTheme } from '../../environment/types.js';
import { HappierText } from '../text/Text.js';
import { HAPPIER_STATE_SIZE_METRICS } from '../state/InfoState.js';
import { resolveHappierButtonChrome, useHappierButtonMaterial } from '../interaction/buttonChrome.js';
import { HAPPIER_PAGE_METRICS, HAPPIER_PUBLIC_PROFILE_HERO_METRICS, HAPPIER_PUBLIC_PROFILE_OWNER_METRICS } from '../layout/pageMetrics.js';
export { HAPPIER_PUBLIC_PROFILE_HERO_METRICS, resolveHappierPublicProfilePlanetBand } from '../layout/pageMetrics.js';
import { HAPPIER_WIDGET_FRAME_METRICS, HappierWidgetFrame, resolveHappierWidgetFrameInsetPx } from '../layout/WidgetFrame.js';
import { PublicProfileUsageBody, type HappierPublicProfileUsageHost } from './PublicProfileUsage.js';
import type { PublicUsageMetricId } from './PublicProfileUsageOriginal.js';
import type { UsagePlanetSlot } from '../usage/charts/usagePlanetSlot.js';
import type { PublicUsageChartModels } from '../usage/charts/publicUsageChartModels.js';
import type { UsageRecordsModel } from '../usage/charts/UsageWorkCharts.js';
export type { HappierPublicProfileUsageHost, HappierPublicProfileUsageLabels } from './PublicProfileUsage.js';
import {
  packWidgetGroupBands,
  type WidgetGroupBand,
  type WidgetGroupCell,
  type WidgetGroupCellInput,
} from '../layout/widgetGroupLayout.js';

type ViewWidget = Extract<
  PublicProfileDisplayView['layout']['items'][number],
  { kind: 'widget' }
>;
type ViewItem = PublicProfileDisplayView['layout']['items'][number];

/**
 * Every string the page shows besides the person's own data. The host localizes and formats them
 * (dates, the period, "synced 2 h ago"), so the server and the app render the same tree.
 */
export type HappierPublicProfileLabels = Readonly<{
  /** "@leeroy · Happier Cloud · since March 2026", composed from the view by the host. */
  identityLine: string;
  /** "Last 90 days". */
  periodTitle: string;
  /** "8 Jul – 5 Oct 2026 · synced 2 h ago". */
  periodDetail: string;
  /** Why visitors see nothing below the header: the owner placed no blocks. */
  emptyLayout: string;
  footerNote: string;
  report: string;
  madeWith: string;
  inert: InertDeclarativeLabels;
  /** The applied picture's credit or "Your picture · Halftone"; shown on the band. */
  heroCredit?: string;
}>;

export type HappierPublicProfileHeroGeometry = Readonly<{ bandHeightPx: number; singleColumn: boolean }>;

/**
 * The visitor page's brand bar (lab `.pp-top`): "Happier · <service>" and "What is Happier?". Only an
 * anonymous visitor's host passes it; the owner reads the page inside the app, under its own header.
 */
export type HappierPublicProfileBrand = Readonly<{
  /** "Happier". */
  name: string;
  /** The service the page is published on ("Happier Cloud"); a phone bar leaves it out. */
  service?: string;
  /** "What is Happier?" and where it leads; a phone bar leaves it out. */
  about?: Readonly<{ label: string; href: string }>;
}>;

export type PublicProfileProjection = Readonly<{
  models: PublicUsageChartModels | null;
  records: UsageRecordsModel | null;
  cells: ReadonlyMap<string, WidgetGroupCellInput>;
  renderDeclarative: (root: unknown, theme: HappierUiTheme, labels: InertDeclarativeLabels) => ReactNode;
}>;

export type PublishedPublicProfileProps = Readonly<{
  view: PublicProfileDisplayView;
  projection: PublicProfileProjection;
  labels: HappierPublicProfileLabels;
  /**
   * The applied atmosphere band (picture or planet), painted by the host's own adapter at the given
   * geometry. Omitted for an atmosphere of None: the page keeps its name-only header.
   */
  renderHero?: (geometry: HappierPublicProfileHeroGeometry) => ReactNode;
  /** The admitted avatar or the planet mark; omitted when the owner shares neither. */
  renderAvatar?: () => ReactNode;
  /** Paint, localization and identity marks for the shared Usage bodies. */
  usage?: HappierPublicProfileUsageHost;
  /** A visitor's brand bar, laid over the band. */
  brand?: HappierPublicProfileBrand;
  /** One column: a phone host or a narrow window. Wider pages still wrap a pair that cannot fit. */
  singleColumn?: boolean;
  /**
   * The owner's own view: blocks that visitors don't see stay in place, quieted and labelled, so the
   * layout never jumps while consent changes. Visitors and the server never pass this.
   */
  owner?: HappierPublicProfileOwner;
  testID?: string;
}>;

export type HappierPublicProfileOwner = Readonly<{
  hiddenBlockIds: ReadonlySet<string>;
  onlyYou: string;
  /**
   * The owner's editable widget area in place of the projected blocks (Edit), so the page keeps its
   * header, period and footer while blocks are added, sized and arranged. Never passed to visitors.
   */
  renderBlocks?: () => ReactNode;
  /** The owner's customizing bar, on the page between its header and the period (lab `ppcomp-E`). */
  renderToolbar?: () => ReactNode;
  /**
   * Under a block visitors don't see: why, with the one way to share what it needs (lab `ppcomp-E`
   * "Share hours of the week"). Consent stays with the host's one policy owner.
   */
  renderHiddenNote?: (blockId: string) => ReactNode;
  /**
   * Each Totals figure's own eye (lab `ppcomp-E`), at the figure's top end; figures visitors don't see stay in
   * place, quieted. One control per figure, never one for the block. Consent stays with the host's policy owner.
   */
  renderFigureControl?: (figure: PublicUsageMetricId) => ReactNode;
  hiddenFigures?: ReadonlySet<PublicUsageMetricId>;
}>;

export type WithdrawnPublicProfileProps = Readonly<{
  /** Withdrawal states have no fabricated snapshot, period, coverage or applied blocks. */
  result: Readonly<{ kind: 'paused'; handle: string; identity: Readonly<{ name?: string; avatar?: Readonly<{ kind: 'planet' }> }> }>
    | Readonly<{ kind: 'unavailable' }>;
  labels: Readonly<{
    /** "Leeroy paused this profile" / "No public profile here". */
    title: string;
    /** The one line under it: when the numbers come back, or what profiles are. */
    body: string;
    /** Paused only: "@leeroy · Happier Cloud" under the name the owner shares. */
    identityLine?: string;
  }>;
  brand?: HappierPublicProfileBrand;
  /** The quiet horizon, painted by the host at the given geometry (lab `ppstate-X`: a small rise, or an eclipse). */
  renderHero?: (geometry: HappierPublicProfileHeroGeometry) => ReactNode;
  /** The host's Brand planet, for a paused identity's shared planet fallback. */
  renderPlanet?: UsagePlanetSlot;
  singleColumn?: boolean;
  testID?: string;
}>;

export type HappierPublicProfileProps = PublishedPublicProfileProps | WithdrawnPublicProfileProps;

/**
 * The public profile page: header, one period line and the owner's placed blocks below it. One
 * tree serves the visitor page, the owner's preview and the server's cold render, so a block looks
 * the same wherever it is read. It only draws the already-projected view: hidden facts are absent
 * from `view`, never filtered here.
 */
export function HappierPublicProfile(props: HappierPublicProfileProps) {
  return 'result' in props ? <WithdrawnPublicProfile {...props} /> : <PublishedPublicProfile {...props} />;
}

/**
 * Paused and unavailable read as one quiet page (lab `ppstate-X`): the brand bar, a small horizon over a
 * hairline, then one title and one line. Paused keeps the identity the owner shares; unavailable says
 * what Happier is, so a visitor who followed a dead link still has somewhere to go.
 */
function WithdrawnPublicProfile(props: WithdrawnPublicProfileProps) {
  const theme = useHappierUiTheme();
  const testID = props.testID ?? 'public-profile';
  const singleColumn = props.singleColumn ?? false;
  const bandHeightPx = HAPPIER_PUBLIC_PROFILE_HERO_METRICS.quietBandHeightPx[singleColumn ? 'phone' : 'wide'];
  const paused = props.result.kind === 'paused' ? props.result : null;
  const pausedAvatar = paused?.identity.avatar?.kind === 'planet' && props.renderPlanet !== undefined;
  const about = props.brand?.about;
  return (
    <View testID={testID} style={styles.page}>
      {props.brand ? <PublicProfileBrandBar brand={props.brand} singleColumn={singleColumn} testID={testID} /> : null}
      <View testID={`${testID}-hero-band`} style={[styles.heroBand, styles.quietBand,
        { height: bandHeightPx, borderBottomColor: theme.colors.border }]}>
        {props.renderHero?.({ bandHeightPx, singleColumn })}
      </View>
      <View style={[styles.withdrawn, { maxWidth: HAPPIER_STATE_SIZE_METRICS[singleColumn ? 'phone' : 'page'].measurePx }]}>
        <HappierText variant="title" tone="neutral" style={styles.centered} testID={`${testID}-withdrawn-title`}>
          {props.labels.title}
        </HappierText>
        <HappierText variant="reading" tone="secondary" style={styles.centered}>
          {props.labels.body}
        </HappierText>
        {paused ? (
          <View testID={`${testID}-identity`} style={[styles.identityChip, pausedAvatar ? styles.identityChipWithAvatar : null,
            { borderColor: theme.colors.border }]}>
            {pausedAvatar && props.renderPlanet ? (
              <PublicProfilePlanetAvatar handle={paused.handle} sizePx={HAPPIER_PUBLIC_PROFILE_HERO_METRICS.avatarPx.paused}
                renderPlanet={props.renderPlanet} testID={`${testID}-avatar`} />
            ) : null}
            <View>
              <HappierText variant="heading" tone="neutral">{paused.identity.name ?? `@${paused.handle}`}</HappierText>
              {props.labels.identityLine ? <HappierText variant="meta" tone="secondary">{props.labels.identityLine}</HappierText> : null}
            </View>
          </View>
        ) : about ? (
          <PublicLinkButton href={about.href} label={about.label} testID={`${testID}-about`} />
        ) : null}
      </View>
    </View>
  );
}

/** The person's side of the one planet (lab `ppMark`): the same handle always turns it to the same longitude. */
function planetLongitude(handle: string): number {
  let hash = 2166136261;
  for (let index = 0; index < handle.length; index++) hash = Math.imul(hash ^ handle.charCodeAt(index), 16777619);
  return ((hash >>> 0) / 4294967296) * Math.PI * 2 - Math.PI;
}

/**
 * The explained photo fallback (U3): no Account image has an admitted public address, so a shared photo is the
 * person's planet, drawn by the host's own Brand planet owner (the app's canvas, the server's static adapter).
 */
function PublicProfilePlanetAvatar(props: Readonly<{ handle: string; sizePx: number; renderPlanet: UsagePlanetSlot; testID: string }>) {
  const { sizePx } = props;
  const theme = useHappierUiTheme();
  // A paper coin, like a photo's paper ring: over the band's artwork the planet would otherwise dissolve into it.
  return (
    <View testID={props.testID} style={[styles.planetAvatar,
      { width: sizePx, height: sizePx, borderRadius: sizePx / 2, backgroundColor: theme.colors.surface }]}>
      {props.renderPlanet({ size: sizePx, radius: sizePx * 0.4, halo: 0.6, tail: 0, rise: 1, light: 1, rotate: planetLongitude(props.handle),
        // Only the paused pill is mark-sized; a hero avatar keeps the whole planet so the person's side still shows.
        style: 'rich', mark: sizePx <= HAPPIER_PUBLIC_PROFILE_HERO_METRICS.avatarPx.paused })}
    </View>
  );
}

/** The visitor's brand bar: in flow on a quiet page, over the top of the band on a published one. */
function PublicProfileBrandBar(props: Readonly<{ brand: HappierPublicProfileBrand; singleColumn: boolean; over?: boolean; testID: string }>) {
  const { brand, singleColumn } = props;
  return (
    <View testID={`${props.testID}-brand`} style={[styles.brandBar, singleColumn ? styles.brandBarPhone : null,
      props.over ? styles.brandBarOver : null]}>
      <View style={styles.brandName}>
        <HappierText variant="heading" tone="neutral">{brand.name}</HappierText>
        {!singleColumn && brand.service ? <HappierText variant="body" tone="secondary" numberOfLines={1}>{brand.service}</HappierText> : null}
      </View>
      {!singleColumn && brand.about ? <PublicLink href={brand.about.href} label={brand.about.label} rel="noopener" variant="body" /> : null}
    </View>
  );
}

function PublishedPublicProfile(props: PublishedPublicProfileProps) {
  const theme = useHappierUiTheme();
  const { view, labels } = props;
  const { models: usageModels, records: usageRecords } = props.projection;
  const testID = props.testID ?? 'public-profile';
  const columns = props.singleColumn ? 1 : 2;
  const bands = packWidgetGroupBands(
    view.layout.items.map(item => props.projection.cells.get(item.id)!),
    columns,
  );
  const byId = new Map(
    view.layout.items.map((item) => [item.id, item] as const),
  );
  const renderCell = (cell: WidgetGroupCell, span: 'full' | 'half') => {
    const item = byId.get(cell.id);
    return item && usageModels ? (
      <PublicProfileItem
        key={item.id}
        item={item}
        labels={labels}
        projection={props.projection}
        usageModels={usageModels}
        usageRecords={usageRecords}
        usage={props.usage}
        owner={props.owner}
        singleColumn={columns === 1}
        coldWidthPx={props.usage?.cold ? publicProfileColdCellWidth(publicProfileColdContentWidth(columns === 1), span) : undefined}
        testID={testID}
      />
    ) : null;
  };
  const renderAvatar = props.renderAvatar ?? (view.identity.avatar?.kind === 'planet' && props.usage?.renderPlanet
    ? () => <PublicProfilePlanetAvatar handle={view.handle} sizePx={HAPPIER_PUBLIC_PROFILE_HERO_METRICS.avatarPx[columns === 1 ? 'phone' : 'wide']}
      renderPlanet={props.usage!.renderPlanet!} testID={`${testID}-avatar`} /> : undefined);
  // Beside an avatar on the band's edge, the words start where the artwork ends, never on it.
  const wordsBelowBand = props.renderHero !== undefined && renderAvatar !== undefined && columns !== 1;
  const identity = (
        <View style={[styles.identity, columns === 1 && props.renderHero ? styles.identityStacked : null,
          wordsBelowBand ? styles.identityBesideBandEdge : null]}>
          {renderAvatar?.()}
          <View style={[styles.identityText,
            wordsBelowBand ? { paddingTop: HAPPIER_PUBLIC_PROFILE_HERO_METRICS.avatarPx.wide / 2 } : null]}>
            <HappierText
              variant="display"
              tone="neutral"
              testID={`${testID}-name`}
            >
              {view.identity.name ?? `@${view.handle}`}
            </HappierText>
            <HappierText variant="meta" tone="secondary">
              {labels.identityLine}
            </HappierText>
            {view.metadata.bio ? (
              <HappierText variant="body" tone="neutral">
                {view.metadata.bio}
              </HappierText>
            ) : null}
            {view.metadata.links?.length ? (
              <View style={styles.links}>
                {view.metadata.links.map((link) => (
                  <PublicLink
                    key={link.url}
                    href={link.url}
                    label={link.label}
                    rel="me ugc nofollow noopener"
                  />
                ))}
              </View>
            ) : null}
          </View>
        </View>
  );
  return (
    <View testID={testID} style={styles.page}>
      {props.brand && !props.renderHero ? <PublicProfileBrandBar brand={props.brand} singleColumn={columns === 1} testID={testID} /> : null}
      {props.renderHero ? (
        <PublicProfileHero
          testID={testID}
          singleColumn={columns === 1}
          brand={props.brand}
          credit={labels.heroCredit}
          overlapsBand={renderAvatar !== undefined}
          renderBand={props.renderHero}
        >
          {identity}
        </PublicProfileHero>
      ) : null}
      <View style={styles.column}>
        {props.renderHero ? null : identity}
        {props.owner?.renderToolbar?.()}
        <View style={styles.period}>
          <HappierText variant="heading" tone="neutral">
            {labels.periodTitle}
          </HappierText>
          {/* The line keeps its place while the period is still being read, so nothing moves when it arrives. */}
          <HappierText variant="meta" tone="secondary" tabularNumbers>
            {labels.periodDetail || '\u00a0'}
          </HappierText>
        </View>
        {props.owner?.renderBlocks ? (
          props.owner.renderBlocks()
        ) : !usageModels ? null : bands.length === 0 ? (
          <HappierText
            variant="body"
            tone="secondary"
            testID={`${testID}-empty`}
          >
            {labels.emptyLayout}
          </HappierText>
        ) : (
          <View style={styles.blocks}>
            {bands.map((band) => (
              <Band
                key={band.key}
                band={band}
                renderCell={renderCell}
              />
            ))}
          </View>
        )}
        <View style={[styles.footer, { borderTopColor: theme.colors.divider }]}>
          <HappierText
            variant="meta"
            tone="secondary"
            style={styles.footerNote}
          >
            {labels.footerNote}
          </HappierText>
          <View style={styles.footerLinks}>
            {view.urls ? <PublicLink
              href={view.urls.report}
              label={labels.report}
              testID={`${testID}-report`}
            /> : null}
            <HappierText variant="meta" tone="secondary">
              {labels.madeWith}
            </HappierText>
          </View>
        </View>
      </View>
    </View>
  );
}

/**
 * The band is reserved at its full height before any artwork paints, and the identity sits over its
 * lower edge (lab `pphero`): beside the avatar on a wide page, under it on a phone.
 */
function PublicProfileHero(
  props: Readonly<{
    testID: string;
    singleColumn: boolean;
    brand?: HappierPublicProfileBrand;
    credit?: string;
    /** Only an avatar sits over the band's edge; a name alone starts below the artwork, never on it. */
    overlapsBand: boolean;
    renderBand: (geometry: HappierPublicProfileHeroGeometry) => ReactNode;
    children: ReactNode;
  }>,
) {
  const theme = useHappierUiTheme();
  const kind = props.singleColumn ? 'phone' : 'wide';
  const bandHeightPx = HAPPIER_PUBLIC_PROFILE_HERO_METRICS.bandHeightPx[kind];
  const avatarPx = HAPPIER_PUBLIC_PROFILE_HERO_METRICS.avatarPx[kind];
  return (
    <View testID={`${props.testID}-hero`} style={styles.hero}>
      <View testID={`${props.testID}-hero-band`} style={[styles.band, styles.heroBand, { height: bandHeightPx }]}>
        {props.renderBand({ bandHeightPx, singleColumn: props.singleColumn })}
        {props.brand ? <PublicProfileBrandBar brand={props.brand} singleColumn={props.singleColumn} over testID={props.testID} /> : null}
        {props.credit ? (
          <View style={[styles.credit, props.singleColumn ? styles.creditPhone
            : props.brand ? styles.creditUnderBrand : styles.creditWide,
            { backgroundColor: theme.colors.surface }]}>
            <HappierText variant="micro" tone="secondary" numberOfLines={1}>{props.credit}</HappierText>
          </View>
        ) : null}
      </View>
      <View style={[styles.heroColumn, { marginTop: props.overlapsBand ? -avatarPx / 2 : HAPPIER_PAGE_METRICS.cardPaddingPx }]}>
        {props.children}
      </View>
    </View>
  );
}

/**
 * The page column's content width for an edition on a host that cannot measure (the server): the wide column at its
 * maximum, the phone edition at the phone width it is painted for. A narrower window scales the drawings down.
 */
function publicProfileColdContentWidth(singleColumn: boolean): number {
  const column = singleColumn ? HAPPIER_PUBLIC_PROFILE_HERO_METRICS.rasterWidthPx.phone : HAPPIER_PAGE_METRICS.columnMaxWidthPx.wide;
  return column - 2 * HAPPIER_PAGE_METRICS.sheetInsetPx;
}

/** A cell's share of a band: the whole width, or one of a pair beside the band's gap. */
function publicProfileColdCellWidth(bandWidthPx: number, span: 'full' | 'half'): number {
  return span === 'full' ? bandWidthPx : Math.floor((bandWidthPx - HAPPIER_PAGE_METRICS.cardGapPx) / 2);
}

function Band(
  props: Readonly<{
    band: WidgetGroupBand;
    renderCell: (cell: WidgetGroupCell, span: 'full' | 'half') => ReactNode;
  }>,
) {
  const { band } = props;
  if (band.kind === 'row')
    return <View style={styles.band}>{props.renderCell(band.cell, 'full')}</View>;
  if (band.kind === 'slot') return null;
  return (
    <View style={[styles.band, styles.pair]}>
      {band.columns.map((column, index) =>
        column.length ? (
          <View key={index} style={styles.pairColumn}>
            {column.map((cell) => props.renderCell(cell, 'half'))}
          </View>
        ) : null,
      )}
    </View>
  );
}

function PublicProfileItem(
  props: Readonly<{
    item: ViewItem;
    labels: HappierPublicProfileLabels;
    projection: PublicProfileProjection;
    usageModels: PublicUsageChartModels;
    usageRecords: UsageRecordsModel | null;
    usage?: HappierPublicProfileUsageHost;
    owner?: HappierPublicProfileOwner;
    singleColumn: boolean;
    /** The cell's width in the page column on a host that cannot measure. */
    coldWidthPx?: number;
    testID: string;
  }>,
) {
  const { item } = props;
  if (item.kind === 'widget')
    return (
      <PublicProfileBlock
        widget={item}
        labels={props.labels}
        projection={props.projection}
        usageModels={props.usageModels}
        usageRecords={props.usageRecords}
        usage={props.usage}
        owner={props.owner}
        coldWidthPx={props.coldWidthPx === undefined ? undefined : props.coldWidthPx - 2 * resolveHappierWidgetFrameInsetPx(item.frameStyle)}
        testID={props.testID}
      />
    );
  const groupInnerPx = props.coldWidthPx === undefined ? undefined : props.coldWidthPx - 2 * resolveHappierWidgetFrameInsetPx(item.frameStyle);
  const bands = packWidgetGroupBands(
    item.children.map(child => props.projection.cells.get(child.id)!),
    props.singleColumn || item.width === 'half' ? 1 : 2,
  );
  const children = new Map(
    item.children.map((child) => [child.id, child] as const),
  );
  return (
    <HappierWidgetFrame
      frameStyle={item.frameStyle}
      placement="home"
      title={item.title ?? null}
      testID={`${props.testID}-group-${item.id}`}
    >
      {bands.map((band) => (
        <Band
          key={band.key}
          band={band}
          renderCell={(cell, span) => {
            const child = children.get(cell.id);
            return child ? (
              <PublicProfileBlock
                key={child.id}
                widget={child}
                labels={props.labels}
                projection={props.projection}
                usageModels={props.usageModels}
                usageRecords={props.usageRecords}
                usage={props.usage}
                owner={props.owner}
                coldWidthPx={groupInnerPx === undefined ? undefined : publicProfileColdCellWidth(groupInnerPx, span)}
                testID={props.testID}
                bare
              />
            ) : null;
          }}
        />
      ))}
    </HappierWidgetFrame>
  );
}

/** The same placed block in an authenticated setup/frame; the host supplies an already masked view. */
export function HappierPublicProfileWidget(props: Readonly<{
  view: PublishedPublicProfileProps['view'];
  projection: PublicProfileProjection;
  widgetId: string;
  labels: HappierPublicProfileLabels;
  usage?: HappierPublicProfileUsageHost;
  /** The owner's in-place view of this block, exactly as the page draws it for its owner. */
  owner?: HappierPublicProfileOwner;
  testID: string;
}>) {
  const { models, records } = props.projection;
  const widget = props.view.layout.items.flatMap(item => item.kind === 'widget' ? [item] : item.children)
    .find(item => item.id === props.widgetId);
  return widget && models ? <PublicProfileBlock widget={widget} projection={props.projection} labels={props.labels} usageModels={models} usageRecords={records}
    usage={props.usage} owner={props.owner} testID={props.testID} bare /> : null;
}

function PublicProfileBlock(
  props: Readonly<{
    widget: ViewWidget;
    labels: HappierPublicProfileLabels;
    projection: PublicProfileProjection;
    usageModels: PublicUsageChartModels;
    usageRecords: UsageRecordsModel | null;
    usage?: HappierPublicProfileUsageHost;
    owner?: HappierPublicProfileOwner;
    /** The body's drawing width on a host that cannot measure. */
    coldWidthPx?: number;
    testID: string;
    bare?: boolean;
  }>,
) {
  const theme = useHappierUiTheme();
  const onlyYou = props.owner?.hiddenBlockIds.has(props.widget.id) ? props.owner.onlyYou : null;
  // A block visitors don't see has its one Share below it; figure eyes belong to blocks they do see.
  const renderFigure = onlyYou ? undefined : props.owner?.renderFigureControl;
  const hiddenFigures = props.owner?.hiddenFigures;
  const figures = useMemo(() => renderFigure ? { render: renderFigure, hidden: hiddenFigures ?? new Set<PublicUsageMetricId>() }
    : undefined, [renderFigure, hiddenFigures]);
  const marker = onlyYou ? (
    <View style={[styles.onlyYou, { borderColor: theme.colors.border }]}>
      <HappierText variant="micro" tone="secondary">{onlyYou}</HappierText>
    </View>
  ) : null;
  const body = props.widget.presentation.kind === 'usage'
    ? props.usage ? <PublicProfileUsageBody presentation={props.widget.presentation} models={props.usageModels} records={props.usageRecords}
      host={props.usage} width={props.coldWidthPx} figures={figures} testID={`${props.testID}-usage-${props.widget.id}`} /> : null
    : props.projection.renderDeclarative(props.widget.presentation.document.root, theme, props.labels.inert);
  const shownBody = onlyYou ? <>
    <View style={styles.quieted}>{body}</View>
    {props.owner?.renderHiddenNote?.(props.widget.id)}
  </> : body;
  if (props.bare)
    return (
      <View
        testID={`${props.testID}-block-${props.widget.id}`}
        style={styles.bareBlock}
      >
        {props.widget.title ? <HappierText variant="heading" tone="neutral">{props.widget.title}</HappierText> : null}
        {marker}
        {shownBody}
      </View>
    );
  return (
    <HappierWidgetFrame
      frameStyle={props.widget.frameStyle}
      placement="home"
      title={props.widget.title ?? null}
      accessory={marker}
      testID={`${props.testID}-block-${props.widget.id}`}
    >
      {shownBody}
    </HappierWidgetFrame>
  );
}

/**
 * React Native Web draws `href` as a real anchor, on the server too. The portable text props do not
 * name it, so it rides through the host Text's pass-through untyped.
 */
function anchorProps(href: string, rel: string | undefined): Record<string, unknown> {
  return { href, hrefAttrs: { rel: rel ?? 'noopener', target: '_blank' } };
}

/** A real anchor on web and in the server render; safe user links never carry an opener. */
function PublicLink(
  props: Readonly<{
    href: string;
    label: string;
    rel?: string;
    variant?: 'meta' | 'body';
    testID?: string;
  }>,
) {
  return (
    <HappierText
      variant={props.variant ?? 'meta'}
      tone="secondary"
      testID={props.testID}
      accessibilityRole="link"
      {...anchorProps(props.href, props.rel)}
    >
      {props.label}
    </HappierText>
  );
}

/** A link that reads as the page's one secondary action: the shared button face on a real anchor. */
function PublicLinkButton(props: Readonly<{ href: string; label: string; testID?: string }>) {
  const theme = useHappierUiTheme();
  const material = useHappierButtonMaterial(theme);
  const chrome = resolveHappierButtonChrome({ theme, variant: 'secondary', disabled: false, focused: false, ...material });
  return (
    <HappierText
      variant="label"
      testID={props.testID}
      accessibilityRole="link"
      style={[chrome.style, styles.linkButton, { color: chrome.foreground }]}
      {...anchorProps(props.href, 'noopener')}
    >
      {props.label}
    </HappierText>
  );
}

const styles = StyleSheet.create({
  page: { width: '100%' },
  hero: { width: '100%', marginBottom: HAPPIER_PAGE_METRICS.cardGapPx * 2 },
  heroBand: { position: 'relative', overflow: 'hidden' },
  credit: {
    position: 'absolute',
    right: HAPPIER_PAGE_METRICS.sheetInsetPx,
    maxWidth: '70%',
    paddingHorizontal: HAPPIER_PAGE_METRICS.pageHeaderLineGapPx * 2,
    paddingVertical: HAPPIER_PAGE_METRICS.pageHeaderLineGapPx / 2,
    borderRadius: HAPPIER_PAGE_METRICS.controlHeightPx,
  },
  creditWide: { top: HAPPIER_PAGE_METRICS.cardPaddingPx },
  // The brand bar holds the band's top; the credit sits just under its "What is Happier?" (lab `ppalign-H`).
  creditUnderBrand: { top: HAPPIER_PAGE_METRICS.paneHeaderHeightPx },
  // Lab `.pp-top`: one 56 px bar (48 on a phone) at the page's own side room.
  brandBar: {
    minHeight: HAPPIER_PAGE_METRICS.paneHeaderHeightPx,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: HAPPIER_PAGE_METRICS.cardGapPx,
    paddingHorizontal: HAPPIER_PAGE_METRICS.cardPaddingPx * 2,
  },
  brandBarPhone: {
    minHeight: HAPPIER_PAGE_METRICS.paneHeaderUnderNativeChromeHeightPx,
    paddingHorizontal: HAPPIER_PAGE_METRICS.pageTextInsetPx,
  },
  brandBarOver: { position: 'absolute', top: 0, left: 0, right: 0 },
  brandName: { flexDirection: 'row', alignItems: 'baseline', gap: HAPPIER_PAGE_METRICS.cardGapPx, flexShrink: 1, minWidth: 0 },
  quietBand: { width: '100%', borderBottomWidth: StyleSheet.hairlineWidth },
  withdrawn: {
    width: '100%',
    alignSelf: 'center',
    alignItems: 'center',
    paddingTop: HAPPIER_PAGE_METRICS.sectionGapPx,
    paddingHorizontal: HAPPIER_PAGE_METRICS.pageTextInsetPx,
    paddingBottom: HAPPIER_PAGE_METRICS.pagePaddingBottomPx,
    gap: HAPPIER_PAGE_METRICS.pageHeaderLineGapPx * 2,
  },
  centered: { textAlign: 'center' },
  // Lab `.ppS-who`: name and handle in a quiet pill under the line.
  identityChip: {
    marginTop: HAPPIER_PAGE_METRICS.pageHeaderLineGapPx * 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: HAPPIER_SPACE_STEPS.s10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: HAPPIER_PAGE_METRICS.paneHeaderHeightPx,
    paddingVertical: HAPPIER_PAGE_METRICS.pageHeaderLineGapPx * 2,
    paddingHorizontal: HAPPIER_PAGE_METRICS.cardPaddingPx * 1.5,
  },
  // The avatar sits close to the pill's rounded end (lab `ppS-who`).
  identityChipWithAvatar: { paddingLeft: HAPPIER_SPACE_STEPS.s10 },
  linkButton: { marginTop: HAPPIER_PAGE_METRICS.pageHeaderLineGapPx * 2, textDecorationLine: 'none' },
  // On a phone the credit stays on the picture, just above where the identity begins.
  creditPhone: { bottom: HAPPIER_PAGE_METRICS.cardPaddingPx * 3 },
  column: {
    width: '100%',
    maxWidth: HAPPIER_PAGE_METRICS.columnMaxWidthPx.wide,
    alignSelf: 'center',
    paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx,
    paddingBottom: HAPPIER_PAGE_METRICS.pagePaddingBottomPx,
    gap: HAPPIER_PAGE_METRICS.cardGapPx * 2,
  },
  // The identity under the band shares the page column's edge; the page's bottom room is the column's.
  heroColumn: {
    width: '100%',
    maxWidth: HAPPIER_PAGE_METRICS.columnMaxWidthPx.wide,
    alignSelf: 'center',
    paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx,
  },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: HAPPIER_PAGE_METRICS.cardPaddingPx,
  },
  // On a phone the avatar sits on the band's edge and the words drop below it.
  identityStacked: { flexDirection: 'column', alignItems: 'flex-start' },
  identityBesideBandEdge: { alignItems: 'flex-start' },
  planetAvatar: { overflow: 'hidden' },
  identityText: {
    flexShrink: 1,
    minWidth: 0,
    gap: HAPPIER_PAGE_METRICS.pageHeaderLineGapPx,
  },
  links: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: HAPPIER_PAGE_METRICS.cardPaddingPx,
    rowGap: HAPPIER_PAGE_METRICS.pageHeaderLineGapPx,
  },
  period: { gap: HAPPIER_PAGE_METRICS.pageHeaderLineGapPx },
  blocks: { gap: HAPPIER_PAGE_METRICS.cardGapPx },
  band: { width: '100%' },
  // A pair wraps to one column on a narrow page without measuring, so a cold server render is responsive.
  pair: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: HAPPIER_PAGE_METRICS.cardGapPx,
  },
  pairColumn: {
    flexGrow: 1,
    // A half that would be narrower than a frame keeps its full header stacks under its pair instead.
    flexBasis: HAPPIER_WIDGET_FRAME_METRICS.sourceHiddenBelowPx,
    minWidth: 0,
    gap: HAPPIER_PAGE_METRICS.cardGapPx,
  },
  bareBlock: { minWidth: 0 },
  onlyYou: {
    alignSelf: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: HAPPIER_PAGE_METRICS.controlHeightPx,
    paddingHorizontal: HAPPIER_PAGE_METRICS.pageHeaderLineGapPx * 2,
  },
  // A private block stays in place for its owner, quieted, so consent changes never move the layout.
  quieted: { opacity: HAPPIER_PUBLIC_PROFILE_OWNER_METRICS.quietedOpacity },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: HAPPIER_PAGE_METRICS.cardPaddingPx,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: HAPPIER_PAGE_METRICS.cardGapPx,
  },
  footerNote: { flexShrink: 1 },
  footerLinks: {
    flexDirection: 'row',
    gap: HAPPIER_PAGE_METRICS.cardPaddingPx,
  },
});
