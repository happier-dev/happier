import { createContext, isValidElement, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { View } from 'react-native';

import { useOptionalHappierUiTheme, useOptionalHappierUiTypography } from '../../environment/context.js';
import type { HappierFocusable, HappierLayoutChangeEvent, HappierStyleProp } from '../portableTypes.js';
import { HappierMiddleEllipsisText, HappierPageHeaderMetaId, HappierPageHeaderMetaIdAnchor, type HappierPageHeaderMetaIdCopy } from './PageHeaderMetaId.js';
import { HappierText, useHappierTextPresentation } from '../text/Text.js';
import { useHappierCollectionDetailWidth, useHappierCollectionLayout } from '../collection/collectionLayout.js';
import { HAPPIER_PAGE_METRICS, resolveHappierPageBackMeasuringLine, resolveHappierPageBackPlacement } from './pageMetrics.js';
import { HAPPIER_PAGE_TEXT, resolveHappierPageTextStyle, type HappierPageTextRole } from './pageText.js';
import { useHappierColumnEdgeRemainder } from './columnEdge.js';
import { HappierPressable } from '../interaction/Pressable.js';
import { happierFocusRingStyle } from '../interaction/focusVisible.js';

/** One fact on a page header's meta line: "@handle", "Personal Home", "End-to-end encrypted". */
export type HappierPageHeaderMetaFact = Readonly<{
  key: string;
  text: string;
  /** A small glyph before the text, already themed by the caller (a lock for encryption). */
  icon?: ReactNode;
  /** The fact is an address, path or id: drawn in the mono face. */
  mono?: boolean;
  testID?: string;
  /**
   * The fact leads to the thing it names (the session a Run came from): the fact itself is the
   * link, so the page never repeats it as a separate line. `accessibilityLabel` says where it goes.
   */
  onPress?: () => void;
  accessibilityLabel?: string;
}>;

/**
 * Where the surrounding navigation's back control is drawn. The header decides
 * the placement (gutter or title row) from its measured pane; the adapter
 * renders its own control with the style the header asks for.
 */
export type HappierPageHeaderBackRender = (style: HappierStyleProp) => ReactNode;

export type HappierPageHeaderProps = Readonly<{
  /**
   * The page title. A string is drawn in the page-title step against the
   * environment theme; an element (Happier core's own `Text`) is drawn as-is.
   */
  title: ReactNode;
  /** Whether the title is drawn. `false` when navigation chrome already shows it (the purpose line stays). */
  showTitle?: boolean;
  /**
   * Navigation leaves the page's name to the page (a phone tab's top level): it draws the large title. Every other
   * page, and any entity with a `leading` mark, draws the page title. This is the whole rule (DESIGN.md "One title
   * rule"); hosts state this fact and pages never choose a title size.
   */
  largeTitle?: boolean;
  /** An inline mark after the title, such as a release-channel badge. */
  titleAccessory?: ReactNode;
  /** One sentence saying what the page is for (string or element, as for `title`). */
  description?: ReactNode;
  /** Identity details under the description (an identifier to copy, a version and machine). */
  details?: ReactNode;
  /** Identity details stay with the title by default; page-wide summaries follow the whole title row. */
  detailsPlacement?: 'identity' | 'column';
  /** Entity headers on a compact measured pane: mark, centered identity, then wrapping controls. */
  compactPresentation?: 'centered';
  /**
   * The distinguishing facts of the thing the page is about, on one quiet line
   * (wrapping when narrow), after `details`. An empty list keeps the line's
   * place while the facts load.
   */
  meta?: readonly HappierPageHeaderMetaFact[];
  /** A leading identity mark (entity logo, avatar). */
  leading?: ReactNode;
  /** At most one primary page action plus context controls (e.g. a machine chip). */
  actions?: ReactNode;
  /**
   * `wrap` (default): prefer the title row, but wrap controls beneath rather than squeeze the title.
   * `inline`: controls stay on the title row, pushed to its end, and the description sits under the
   * title beside them (an editor header with a status line under the actions).
   * `hang`: `inline`, with the mark and the controls hanging from the title's line, and the
   * description, details and facts running beneath both at the identity's full width (an entity page
   * whose sentence is long).
   */
  actionsLayout?: 'wrap' | 'inline' | 'hang';
  /** How the default text owner copies a mono meta fact; without it the fact is plain mono text. */
  metaIdCopy?: HappierPageHeaderMetaIdCopy;
  /**
   * A status line under the actions ("Unsaved changes · Save · Ready"). It is the actions' own row:
   * as wide as the actions above it, wrapping within them and ending on their edge, so its changing
   * words never take width from the title. The slot reserves two normal text
   * lines so a one-to-two-line readout does not move the document beneath it.
   */
  status?: ReactNode;
  /** The surrounding navigation's back control, when there is one. */
  renderBack?: HappierPageHeaderBackRender | null;
  /**
   * The page's content column width. The header centres itself in it, and the
   * back control sits in the gutter left of it when the pane leaves room.
   * Absent, the column is the pane.
   */
  columnMaxWidthPx?: number;
  /**
   * How a string slot is drawn. Happier core supplies its own text owner (its
   * font families and text scaling); absent, the shared text owner draws each
   * page text step against the environment theme and host typography.
   */
  renderText?: HappierPageHeaderTextRender;
  /**
   * Wraps a part of the header in place without changing its layout, for an entrance that moves the identity
   * (`mark`, `title`) and fades what supports it (`supporting`: the lines under the title, and the actions).
   */
  wrapPart?: HappierPageHeaderPartWrapper;
  testID?: string;
}>;

export type HappierPageHeaderPartWrapper = (part: 'mark' | 'title' | 'supporting', node: ReactNode) => ReactNode;

export type HappierPageHeaderTextRender = (input: Readonly<{
  role: HappierPageTextRole;
  text: string;
  /** The page title: announced as the page's heading. */
  header: boolean;
  /** A meta fact that is an address, path or id: the host's mono face. */
  mono?: boolean;
}>) => ReactNode;

/** Package-private binding from the public PageHeader adapter; not an author physical-ref prop. */
export const HappierPageHeadingBindingContext = createContext<((target: HappierFocusable | null) => void) | undefined>(undefined);

function useDefaultPageTextRender(metaIdCopy: HappierPageHeaderMetaIdCopy | undefined): HappierPageHeaderTextRender {
  const headingRef = useContext(HappierPageHeadingBindingContext);
  const theme = useOptionalHappierUiTheme();
  const typography = useOptionalHappierUiTypography();
  return useCallback((input) => {
    const color = theme === null
      ? undefined
      : input.header ? theme.colors.text : theme.colors.secondaryText;
    if (input.mono && metaIdCopy) {
      const words = [resolveHappierPageTextStyle('meta', typography), color === undefined ? null : { color }];
      const mono = theme?.typography.code.fontFamily ? { fontFamily: theme.typography.code.fontFamily } : null;
      return <HappierPageHeaderMetaId value={input.text} {...metaIdCopy} host={{
        renderValue: (value) => <HappierMiddleEllipsisText value={value} style={[...words, mono]} />,
        renderCopied: (label) => <HappierText style={words}>{label}</HappierText>,
        renderAnchor: (anchor) => <HappierPageHeaderMetaIdAnchor {...anchor} />,
      }} />;
    }
    return (
      <HappierText
        ref={input.header ? headingRef : undefined}
        tabIndex={input.header && headingRef ? -1 : undefined}
        accessibilityRole={input.header ? 'header' : undefined}
        style={[
          resolveHappierPageTextStyle(input.role, typography),
          input.mono && theme?.typography.code.fontFamily ? { fontFamily: theme.typography.code.fontFamily } : null,
          color === undefined ? null : { color },
        ]}
      >
        {input.text}
      </HappierText>
    );
  }, [headingRef, metaIdCopy, theme, typography]);
}

function renderPageText(
  slot: ReactNode,
  role: HappierPageTextRole,
  renderText: HappierPageHeaderTextRender,
  header = false,
): ReactNode {
  if (slot === null || slot === undefined || slot === false || slot === '') return null;
  if (isValidElement(slot)) return slot;
  return renderText({ role, text: String(slot), header });
}

/**
 * The header of a full configuration or detail page — title, one-line purpose,
 * optional leading mark, identity details, meta line and actions — for Happier
 * core pages and plugin pages alike. It aligns with the section headings of the
 * page sections below it (`HAPPIER_PAGE_METRICS`).
 *
 * Phones recompose rather than shrink: when the title cannot keep a readable
 * width beside the actions, the actions wrap beneath it.
 */
export function HappierPageHeader(props: HappierPageHeaderProps) {
  const defaultRenderText = useDefaultPageTextRender(props.metaIdCopy);
  const { metricScale } = useHappierTextPresentation({});
  const renderText = props.renderText ?? defaultRenderText;
  const showTitle = props.showTitle !== false;
  // Inside a column that already draws part of the edge (a detail's body), the title keeps the text edge.
  const textInsetPx = useHappierColumnEdgeRemainder(HAPPIER_PAGE_METRICS.pageTextInsetPx);
  const renderBack = props.renderBack ?? null;
  const showsBack = showTitle && renderBack !== null;
  const collectionLayout = useHappierCollectionLayout();
  const collectionMode = collectionLayout?.mode ?? null;
  const detailWidthPx = useHappierCollectionDetailWidth();
  // The pane's width decides whether back fits in the gutter left of the
  // column. Every header measures it: a back control often arrives after the
  // pane's one mount layout (it follows the route), and a handler attached
  // late never hears that layout, which left back hidden while "measuring".
  const [paneWidthPx, setPaneWidthPx] = useState<number | null>(null);
  const handleLayout = useCallback((event: HappierLayoutChangeEvent) => {
    const widthPx = event.nativeEvent.layout.width;
    setPaneWidthPx((current) => (current === widthPx ? current : widthPx));
  }, []);

  // An entity header whose actions cannot share the title's line moves them, as one group, after the
  // whole identity (mark, title and meta), never between the title and its facts (DESIGN-15 R1). The
  // split column's width at which they wrapped is remembered; only a wider column tries the line again.
  const [splitWidthPx, setSplitWidthPx] = useState<number | null>(null);
  const [identityHeightPx, setIdentityHeightPx] = useState(0);
  const [leadingHeightPx, setLeadingHeightPx] = useState(0);
  const [actionsHeightPx, setActionsHeightPx] = useState(0);
  const [actionsWrapWidthPx, setActionsWrapWidthPx] = useState<number | null>(null);
  const splitWidthRef = useRef<number | null>(null);
  // Sizes, not positions: a web layout event reports a box that resized, never one that only moved, so
  // the wrap is read from the shared line growing taller than its tallest item.
  const lineHeightsRef = useRef<{ line?: number; title?: number; actions?: number }>({});
  const naturalWidthsRef = useRef<{ key: unknown; title: number; actions: number }>({ key: undefined, title: 0, actions: 0 });
  const checkActionsWrap = useCallback(() => {
    // Once both widths are known the prediction below decides; the line's height is the fallback.
    if (naturalWidthsRef.current.title > 0 && naturalWidthsRef.current.actions > 0) return;
    const { line, title, actions } = lineHeightsRef.current;
    const widthPx = splitWidthRef.current;
    if (line === undefined || title === undefined || actions === undefined || widthPx === null) return;
    if (line <= Math.max(title, actions) + 1) return;
    // Every box is measured afresh when the actions return to the line.
    lineHeightsRef.current = {};
    setActionsWrapWidthPx(widthPx);
  }, []);
  // The title's and the actions' own widths, as wide as either has been seen, decide the line as soon as
  // the column's width is known: a column that narrows (a details pane opening) moves the actions in the
  // same layout pass as everything else on the page, not one settle later (DESIGN-16 D3). Until both are
  // known, the line's measured height decides instead.
  // A renamed title is measured afresh; an element title (a new object every render) keeps its width.
  const titleKey = typeof props.title === 'string' ? props.title : null;
  if (naturalWidthsRef.current.key !== titleKey) naturalWidthsRef.current = { key: titleKey, title: 0, actions: naturalWidthsRef.current.actions };
  const predictActionsWrap = useCallback((widthPx: number) => {
    const { title, actions } = naturalWidthsRef.current;
    if (title <= 0 || actions <= 0) return;
    // The widest column that cannot hold both on one line. A flex-wrap line wraps by each item's own
    // width before shrinking it, so a title is only ever measured narrower than itself when it alone
    // fills the column, which already says the actions cannot share it.
    const wrapWidthPx = Math.ceil(title + HAPPIER_PAGE_METRICS.pageHeaderColumnGapPx + actions) - 1;
    setActionsWrapWidthPx(wrapWidthPx);
    if (widthPx <= wrapWidthPx) lineHeightsRef.current = {};
  }, []);
  const handleTitleNaturalLayout = useCallback((event: HappierLayoutChangeEvent) => {
    naturalWidthsRef.current.title = Math.max(naturalWidthsRef.current.title, event.nativeEvent.layout.width);
    if (splitWidthRef.current !== null) predictActionsWrap(splitWidthRef.current);
  }, [predictActionsWrap]);
  const handleActionsNaturalLayout = useCallback((event: HappierLayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    setActionsHeightPx(current => current === height ? current : height);
    naturalWidthsRef.current.actions = Math.max(naturalWidthsRef.current.actions, event.nativeEvent.layout.width);
    if (splitWidthRef.current !== null) predictActionsWrap(splitWidthRef.current);
  }, [predictActionsWrap]);
  // Layout events arrive in no fixed order: whichever of the column, title and actions lands last decides.
  const handleSplitLayout = useCallback((event: HappierLayoutChangeEvent) => {
    const { width: widthPx, height } = event.nativeEvent.layout;
    splitWidthRef.current = widthPx;
    setSplitWidthPx((current) => (current === widthPx ? current : widthPx));
    setIdentityHeightPx(current => current === height ? current : height);
    predictActionsWrap(widthPx);
    checkActionsWrap();
  }, [checkActionsWrap, predictActionsWrap]);
  const handleTitleLineLayout = useCallback((event: HappierLayoutChangeEvent) => {
    lineHeightsRef.current.line = event.nativeEvent.layout.height;
    checkActionsWrap();
  }, [checkActionsWrap]);
  const handleTitleBoxLayout = useCallback((event: HappierLayoutChangeEvent) => {
    lineHeightsRef.current.title = event.nativeEvent.layout.height;
    checkActionsWrap();
  }, [checkActionsWrap]);
  const handleLineActionsLayout = useCallback((event: HappierLayoutChangeEvent) => {
    lineHeightsRef.current.actions = event.nativeEvent.layout.height;
    checkActionsWrap();
  }, [checkActionsWrap]);
  const handleLeadingLayout = useCallback((event: HappierLayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    setLeadingHeightPx(current => current === height ? current : height);
  }, []);

  if (!showTitle && !props.description && !props.actions && !props.status && !props.details && !props.meta) return null;

  const columnMaxWidthPx = props.columnMaxWidthPx ?? Number.POSITIVE_INFINITY;
  const centered = props.compactPresentation === 'centered' && paneWidthPx !== null && paneWidthPx < HAPPIER_PAGE_METRICS.rowStackBelowWidthPx;
  const hangsFromTitle = !centered && props.actionsLayout === 'hang';
  const inlineActions = hangsFromTitle || (!centered && props.actionsLayout === 'inline');
  // The header's own measurement wins; until it arrives, the split's detail width places back.
  const backPlacement = resolveHappierPageBackPlacement({ paneWidthPx: paneWidthPx ?? detailWidthPx, columnMaxWidthPx, backShown: showsBack });

  // In the gutter the arrow is outside the flow, anchored to what sits on the
  // content's left edge (the mark, else the text), so that keeps its place and
  // the arrow sits level with it. Where the gutter cannot hold it, it takes its
  // own line above the title. Until the pane is measured it is mounted unseen
  // where it will most likely land (the line, beside a collection's list; the
  // gutter elsewhere), so nothing moves on arrival.
  const measuring = showsBack && backPlacement === null;
  const measuringOnLine = measuring && resolveHappierPageBackMeasuringLine({ backShown: showsBack, collectionMode, detailWidthPx });
  const titleRole = props.largeTitle === true && !props.leading ? 'heroTitle' : 'pageTitle';
  const titleLineHeight = HAPPIER_PAGE_TEXT[titleRole].lineHeight;
  const backLine = renderBack && !centered && (backPlacement === 'above-title' || measuringOnLine) ? (
    <View
      testID={props.testID ? `${props.testID}-back-line` : undefined}
      style={[
        { flexDirection: 'row', alignItems: 'center', height: HAPPIER_PAGE_METRICS.backControlSizePx, marginBottom: HAPPIER_PAGE_METRICS.pageHeaderLineGapPx },
        measuring ? { opacity: 0 } : null,
      ]}
    >
      {renderBack({})}
    </View>
  ) : null;
  const gutterBack = renderBack && (backPlacement === 'gutter' || (measuring && !measuringOnLine)) ? (
    <View
      testID={props.testID ? `${props.testID}-back-gutter` : undefined}
      style={[
        {
          position: 'absolute',
          right: '100%',
          marginRight: HAPPIER_PAGE_METRICS.backGutterGapPx,
          justifyContent: 'center',
        },
        props.leading ? { top: 0, bottom: 0 } : { top: 0, height: titleLineHeight },
        measuring ? { opacity: 0 } : null,
      ]}
    >
      {renderBack({ marginLeft: 0 })}
    </View>
  ) : null;

  const wrapPart = props.wrapPart ?? null;
  const renderedTitle = showTitle ? renderPageText(props.title, titleRole, renderText, true) : null;
  const title = renderedTitle && wrapPart ? wrapPart('title', renderedTitle) : renderedTitle;
  const titleLine = title && props.titleAccessory ? (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <View style={{ flexShrink: 1, minWidth: 0 }}>{title}</View>
      {props.titleAccessory}
    </View>
  ) : title;
  const textBelowTitleContent = (
    <>
      {props.description ? (
        <View style={showTitle ? { marginTop: HAPPIER_PAGE_METRICS.pageHeaderLineGapPx } : undefined}>
          {renderPageText(props.description, 'pageDescription', renderText)}
        </View>
      ) : null}
      {props.details && props.detailsPlacement !== 'column' ? (
        <View style={{ marginTop: HAPPIER_PAGE_METRICS.pageHeaderLineGapPx }}>{props.details}</View>
      ) : null}
      {props.meta ? (
        <PageHeaderMetaLine
          testID={props.testID ? `${props.testID}-meta` : undefined}
          facts={props.meta}
          renderText={renderText}
          centered={centered}
          spaced={!props.details && (showTitle || Boolean(props.description))}
        />
      ) : null}
    </>
  );
  const textBelowTitle = wrapPart ? wrapPart('supporting', textBelowTitleContent) : textBelowTitleContent;
  // Every title line is the same line, with controls or without, so a header's actions (however late they arrive)
  // never move the title or what sits under it.
  const splitTitleLine = showTitle && !centered && !inlineActions;
  const actionsBelowIdentity = splitTitleLine
    && actionsWrapWidthPx !== null && splitWidthPx !== null && splitWidthPx <= actionsWrapWidthPx;
  const columnContentWidthPx = paneWidthPx === null ? splitWidthPx
    : Math.max(0, Math.min(paneWidthPx, columnMaxWidthPx) - textInsetPx * 2);
  // A mark sharing the identity's row consumes this part of the column. If it wraps onto its own
  // row, the identity already spans the column and the wrapped actions need no horizontal escape.
  const leadingInsetPx = props.leading && columnContentWidthPx !== null && splitWidthPx !== null
    ? Math.max(0, columnContentWidthPx - splitWidthPx) : 0;
  const sharedLeadingHeightPx = leadingInsetPx > 0 ? leadingHeightPx : 0;
  const identityOffsetTopPx = Math.max(0, sharedLeadingHeightPx - identityHeightPx) / 2;
  const wrappedActionsTopPx = Math.max(sharedLeadingHeightPx, identityHeightPx) - identityOffsetTopPx + 12;
  const wrappedActionsWidthPx = splitWidthPx === null ? undefined : splitWidthPx + leadingInsetPx;
  const actionsContent = props.actions || props.status ? (
            <View
              onLayout={splitTitleLine ? (event: HappierLayoutChangeEvent) => {
                handleActionsNaturalLayout(event);
                if (!actionsBelowIdentity) handleLineActionsLayout(event);
              } : undefined}
              style={{
                flexShrink: inlineActions ? 0 : 1,
                maxWidth: '100%',
                alignItems: centered ? 'center' : inlineActions ? 'flex-end' : 'stretch',
                rowGap: HAPPIER_PAGE_METRICS.pageHeaderLineGapPx,
              }}
            >
              {props.actions ? (
                <View style={{ flexDirection: 'row', flexWrap: inlineActions ? 'nowrap' : 'wrap', alignItems: 'center', justifyContent: centered ? 'center' : 'flex-start', gap: 8, maxWidth: '100%' }}>
                  {props.actions}
                </View>
              ) : null}
              {props.status ? (
                // Zero intrinsic width, then the actions' width: the status wraps under them and never
                // widens the group the title shares its row with.
                <View style={[
                  props.actions ? { width: 0, minWidth: '100%', alignItems: 'flex-end' } : { alignItems: 'flex-end' },
                  // Reserve the normal two-line readout before its words change.
                  // Longer/scaled content can still grow instead of being clipped.
                  { minHeight: HAPPIER_PAGE_TEXT.meta.lineHeight * metricScale * 2 + HAPPIER_PAGE_METRICS.pageHeaderLineGapPx },
                ]}>
                  {props.status}
                </View>
              ) : null}
            </View>
          ) : null;
  const actionsBlock = actionsContent && wrapPart ? wrapPart('supporting', actionsContent) : actionsContent;

  return (
    <View
      testID={props.testID}
      onLayout={handleLayout}
      style={{ alignItems: 'center' }}
    >
      <View
        style={{
          width: '100%',
          maxWidth: props.columnMaxWidthPx,
          paddingHorizontal: textInsetPx,
          // When navigation chrome already shows the title, the purpose line takes the title's place
          // right under that chrome instead of leaving the title's room empty above it. Beside a collection's
          // list the list's header is that chrome's row: the title row centres on it, so the column title,
          // the page title and their actions read as one band (owner 2026-10-30; Lane 12 Main approved). A window
          // wide enough for a split with no detail open has no such band: the page keeps the page's top.
          paddingTop: showTitle && collectionLayout?.detailBeside !== true
            ? HAPPIER_PAGE_METRICS.pageHeaderPaddingTopPx
            : HAPPIER_PAGE_METRICS.pageHeaderUnderChromePaddingTopPx,
          paddingBottom: HAPPIER_PAGE_METRICS.pageHeaderPaddingBottomPx,
        }}
      >
        {backLine}
        <View
          testID={props.testID ? `${props.testID}-title-row` : undefined}
          // Inline actions (and the status line under them) hang from the title's top edge, so a status
          // that wraps to another line never re-centres, and so moves, the identity beside it.
          style={{ position: 'relative', flexDirection: centered ? 'column' : 'row', flexWrap: centered ? 'nowrap' : 'wrap', alignItems: inlineActions ? 'flex-start' : 'center', columnGap: HAPPIER_PAGE_METRICS.pageHeaderColumnGapPx, rowGap: 12 }}
        >
          {renderBack && centered && backPlacement === 'above-title'
            // A compact centred identity keeps back at the pane's top-left corner.
            ? <View style={{ position: 'absolute', left: 0, top: 0 }}>{renderBack({})}</View>
            : null}
          {props.leading ? (
            <View
              onLayout={handleLeadingLayout}
              // Hanging, the mark hangs from the title's line: centred on it, its overflow inside the header's padding.
              style={[{ flexShrink: 0, position: 'relative' }, hangsFromTitle && showTitle ? { height: titleLineHeight, justifyContent: 'center' } : null]}
            >
              {wrapPart ? wrapPart('mark', props.leading) : props.leading}
              {gutterBack}
            </View>
          ) : null}
          <View
            onLayout={splitTitleLine ? handleSplitLayout : undefined}
            style={{ flexGrow: centered ? 0 : 1, flexShrink: 1, flexBasis: centered ? 'auto' : HAPPIER_PAGE_METRICS.sectionTextMinWidthPx, minWidth: 0, ...(centered ? { width: '100%', alignItems: 'center' } : {}) }}
          >
              <View
                onLayout={splitTitleLine && !actionsBelowIdentity ? handleTitleLineLayout : undefined}
                style={{ position: 'relative', flexDirection: centered ? 'column' : 'row', flexWrap: centered ? 'nowrap' : 'wrap', alignItems: inlineActions ? 'flex-start' : 'center', columnGap: HAPPIER_PAGE_METRICS.pageHeaderColumnGapPx, rowGap: 12, ...(centered ? { width: '100%' } : {}) }}
              >
                {/* The title's own measured width decides the line: when it and the actions don't fit
                    side by side, the actions wrap beneath it instead of squeezing a short name onto two
                    lines (DESIGN-14 D5). A title wider than the row still wraps within it. */}
                <View
                  onLayout={splitTitleLine && !actionsBelowIdentity ? handleTitleBoxLayout : undefined}
                  style={{ position: 'relative', flexGrow: centered ? 0 : 1, flexShrink: 1, flexBasis: splitTitleLine || centered ? 'auto' : HAPPIER_PAGE_METRICS.sectionTextMinWidthPx, minWidth: 0, ...(centered ? { width: '100%', alignItems: 'center' } : {}), ...(splitTitleLine ? { minHeight: HAPPIER_PAGE_METRICS.controlHeightPx, justifyContent: 'center' } : {}) }}
                >
                  {props.leading ? null : gutterBack}
                  {splitTitleLine ? <View onLayout={handleTitleNaturalLayout} style={{ alignSelf: 'flex-start', maxWidth: '100%' }}>{titleLine}</View> : titleLine}
                  {splitTitleLine || hangsFromTitle ? null : textBelowTitle}
                </View>
                {actionsBlock ? (
                  <View
                    key="actions"
                    testID={actionsBelowIdentity && props.testID ? `${props.testID}-actions-below` : undefined}
                    style={[
                      { flexShrink: inlineActions ? 0 : 1, maxWidth: '100%' },
                      actionsBelowIdentity ? {
                        position: 'absolute',
                        left: -leadingInsetPx,
                        top: wrappedActionsTopPx,
                        width: wrappedActionsWidthPx,
                        maxWidth: wrappedActionsWidthPx ?? '100%',
                        flexDirection: 'row',
                      } : inlineActions ? { marginLeft: 'auto' } : null,
                    ]}
                  >
                    {actionsBlock}
                  </View>
                ) : null}
              </View>
              {splitTitleLine || hangsFromTitle ? textBelowTitle : null}
          </View>
        </View>
        {/* The controls keep their title-line parent even while drawn below the whole identity row.
            This empty row reserves exactly their measured height without mounting a second control. */}
        {actionsBelowIdentity ? <View pointerEvents="none" style={{ height: actionsHeightPx, marginTop: 12 }} /> : null}
        {props.details && props.detailsPlacement === 'column' ? <View style={{ marginTop: HAPPIER_PAGE_METRICS.pageHeaderLineGapPx }}>{props.details}</View> : null}
      </View>
    </View>
  );
}

/**
 * The meta line. Each separator closes the fact before it, so a wrapped line never starts with "·";
 * a separator that ends up closing a line keeps its width (the wrap does not move) but is not drawn,
 * so no line ends with a dangling "·" either.
 */
function PageHeaderMetaLine(props: Readonly<{
  testID?: string;
  facts: readonly HappierPageHeaderMetaFact[];
  renderText: HappierPageHeaderTextRender;
  centered: boolean;
  /** Directly under the description or title; an identifier row above is already padded by its button. */
  spaced: boolean;
}>) {
  const focusColor = useOptionalHappierUiTheme()?.colors.focus;
  // Each fact's vertical centre in the line; facts on one wrapped row share it.
  const [centres, setCentres] = useState<Readonly<Record<string, number>>>({});
  // A fact reports its layout when its own size changes, not when a narrower line only moves it to
  // the next row (web measures size). The line's width keys the facts, so a new width measures them
  // again and a separator that now ends a line is hidden.
  const [lineWidth, setLineWidth] = useState(0);
  const measureFact = (key: string) => (event: HappierLayoutChangeEvent) => {
    const { y, height } = event.nativeEvent.layout;
    const centre = y + height / 2;
    setCentres((current) => (current[key] === centre ? current : { ...current, [key]: centre }));
  };
  const endsLine = (index: number) => {
    const here = centres[props.facts[index]!.key];
    const next = centres[props.facts[index + 1]!.key];
    return here !== undefined && next !== undefined && next - here > HAPPIER_PAGE_TEXT.meta.lineHeight / 2;
  };
  return (
    <View
      testID={props.testID}
      onLayout={(event: HappierLayoutChangeEvent) => {
        const width = Math.round(event.nativeEvent.layout.width);
        setLineWidth((current) => (current === width ? current : width));
      }}
      style={[
        { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: props.centered ? 'center' : 'flex-start', columnGap: 6, minHeight: 18 },
        props.spaced ? { marginTop: HAPPIER_PAGE_METRICS.pageHeaderLineGapPx } : null,
      ]}
    >
      {props.facts.map((fact, index) => (
        // A fact and the separator that closes it wrap as one group: the fact's words never break
        // across lines, so a line never ends on a lone "·" after half a fact.
        <View key={`${fact.key}@${lineWidth}`} testID={fact.testID} onLayout={measureFact(fact.key)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0, maxWidth: '100%' }}>
          {fact.onPress === undefined ? <>
            {fact.icon ?? null}
            {props.renderText({ role: 'meta', text: fact.text, header: false, ...(fact.mono ? { mono: true } : {}) })}
          </> : (
            <HappierPressable
              accessibilityRole="link"
              {...(fact.accessibilityLabel === undefined ? {} : { accessibilityLabel: fact.accessibilityLabel })}
              onPress={fact.onPress}
              style={(state) => [
                { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
                happierFocusRingStyle({ visible: state.focused && focusColor !== undefined, color: focusColor ?? '' }),
                state.pressed || state.hovered ? { opacity: 0.7 } : null,
              ]}
            >
              {fact.icon ?? null}
              {props.renderText({ role: 'meta', text: fact.text, header: false, ...(fact.mono ? { mono: true } : {}) })}
            </HappierPressable>
          )}
          {index < props.facts.length - 1 ? (
            <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden style={endsLine(index) ? { opacity: 0 } : undefined}>
              {props.renderText({ role: 'meta', text: '·', header: false })}
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}
