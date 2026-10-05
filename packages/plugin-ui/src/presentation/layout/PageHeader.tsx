import { createContext, isValidElement, useCallback, useContext, useState, type ReactNode } from 'react';
import { View } from 'react-native';

import { useOptionalHappierUiTheme, useOptionalHappierUiTypography } from '../../environment/context.js';
import type { HappierFocusable, HappierLayoutChangeEvent, HappierStyleProp } from '../portableTypes.js';
import { HappierText } from '../text/Text.js';
import { HAPPIER_PAGE_METRICS, resolveHappierPageBackPlacement } from './pageMetrics.js';
import { HAPPIER_PAGE_TEXT, resolveHappierPageTextStyle, type HappierPageTextRole } from './pageText.js';

/** One fact on a page header's meta line: "@handle", "Personal Home", "End-to-end encrypted". */
export type HappierPageHeaderMetaFact = Readonly<{
  key: string;
  text: string;
  /** A small glyph before the text, already themed by the caller (a lock for encryption). */
  icon?: ReactNode;
  testID?: string;
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
  /** A surface's one greeting or display heading, above the regular page-title step. */
  titleProminence?: 'page' | 'hero';
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
  testID?: string;
}>;

export type HappierPageHeaderTextRender = (input: Readonly<{
  role: HappierPageTextRole;
  text: string;
  /** The page title: announced as the page's heading. */
  header: boolean;
}>) => ReactNode;

/** Package-private binding from the public PageHeader adapter; not an author physical-ref prop. */
export const HappierPageHeadingBindingContext = createContext<((target: HappierFocusable | null) => void) | undefined>(undefined);

function useDefaultPageTextRender(): HappierPageHeaderTextRender {
  const headingRef = useContext(HappierPageHeadingBindingContext);
  const theme = useOptionalHappierUiTheme();
  const typography = useOptionalHappierUiTypography();
  return useCallback((input) => {
    const color = theme === null
      ? undefined
      : input.header ? theme.colors.text : theme.colors.secondaryText;
    return (
      <HappierText
        ref={input.header ? headingRef : undefined}
        tabIndex={input.header && headingRef ? -1 : undefined}
        accessibilityRole={input.header ? 'header' : undefined}
        style={[resolveHappierPageTextStyle(input.role, typography), color === undefined ? null : { color }]}
      >
        {input.text}
      </HappierText>
    );
  }, [headingRef, theme, typography]);
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
  const defaultRenderText = useDefaultPageTextRender();
  const renderText = props.renderText ?? defaultRenderText;
  const showTitle = props.showTitle !== false;
  const renderBack = props.renderBack ?? null;
  const showsBack = showTitle && renderBack !== null;
  // The pane's width decides whether back fits in the gutter left of the
  // column; only a header that carries back measures it.
  const [paneWidthPx, setPaneWidthPx] = useState<number | null>(null);
  const handleLayout = useCallback((event: HappierLayoutChangeEvent) => {
    const widthPx = event.nativeEvent.layout.width;
    setPaneWidthPx((current) => (current === widthPx ? current : widthPx));
  }, []);

  if (!showTitle && !props.description && !props.actions && !props.details && !props.meta) return null;

  const columnMaxWidthPx = props.columnMaxWidthPx ?? Number.POSITIVE_INFINITY;
  const centered = props.compactPresentation === 'centered' && paneWidthPx !== null && paneWidthPx < HAPPIER_PAGE_METRICS.rowStackBelowWidthPx;
  const backPlacement = showsBack ? resolveHappierPageBackPlacement({ paneWidthPx, columnMaxWidthPx }) : null;

  // In the gutter the arrow is outside the flow, anchored to what sits on the
  // content's left edge (the mark, else the text), so that keeps its place and
  // the arrow sits level with it. Until the pane is measured it is mounted
  // there unseen, so nothing moves on arrival.
  const measuring = showsBack && backPlacement === null;
  const titleRole = props.titleProminence === 'hero' ? 'heroTitle' : 'pageTitle';
  const titleLineHeight = HAPPIER_PAGE_TEXT[titleRole].lineHeight;
  const gutterBack = renderBack && (backPlacement === 'gutter' || measuring) ? (
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

  const title = showTitle ? renderPageText(props.title, titleRole, renderText, true) : null;

  return (
    <View
      testID={props.testID}
      onLayout={showsBack || props.compactPresentation ? handleLayout : undefined}
      style={{ alignItems: 'center' }}
    >
      <View
        style={{
          width: '100%',
          maxWidth: props.columnMaxWidthPx,
          paddingHorizontal: HAPPIER_PAGE_METRICS.pageTextInsetPx,
          // When navigation chrome already shows the title, the purpose line takes the title's place
          // right under that chrome instead of leaving the title's room empty above it.
          paddingTop: showTitle ? HAPPIER_PAGE_METRICS.pageHeaderPaddingTopPx : HAPPIER_PAGE_METRICS.pageHeaderUnderChromePaddingTopPx,
          paddingBottom: HAPPIER_PAGE_METRICS.pageHeaderPaddingBottomPx,
        }}
      >
        <View
          testID={props.testID ? `${props.testID}-title-row` : undefined}
          style={{ position: 'relative', flexDirection: centered ? 'column' : 'row', flexWrap: centered ? 'nowrap' : 'wrap', alignItems: 'center', columnGap: 14, rowGap: 12 }}
        >
          {renderBack && backPlacement === 'title-row'
            // On the title-row fallback the back control is centred on the
            // title's first line at the page's text edge; its trailing margin
            // pulls the title closer than the row gap, so the pair reads as one.
            ? centered ? <View style={{ position: 'absolute', left: 0, top: 0 }}>{renderBack({})}</View> : renderBack(props.leading
              ? { alignSelf: 'center', marginRight: -6 }
              : { alignSelf: 'flex-start', height: titleLineHeight, marginRight: -6 })
            : null}
          {props.leading ? (
            <View style={{ flexShrink: 0, position: 'relative' }}>
              {props.leading}
              {gutterBack}
            </View>
          ) : null}
          <View style={{ position: 'relative', flexGrow: centered ? 0 : 1, flexShrink: 1, flexBasis: centered ? 'auto' : 200, minWidth: 0, ...(centered ? { width: '100%', alignItems: 'center' } : {}) }}>
            {props.leading ? null : gutterBack}
            {title && props.titleAccessory ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View style={{ flexShrink: 1, minWidth: 0 }}>{title}</View>
                {props.titleAccessory}
              </View>
            ) : title}
            {props.description ? (
              <View style={showTitle ? { marginTop: HAPPIER_PAGE_METRICS.pageHeaderLineGapPx } : undefined}>
                {renderPageText(props.description, 'pageDescription', renderText)}
              </View>
            ) : null}
            {props.details && props.detailsPlacement !== 'column' ? (
              <View style={{ marginTop: HAPPIER_PAGE_METRICS.pageHeaderLineGapPx }}>{props.details}</View>
            ) : null}
            {props.meta ? (
              <View
                testID={props.testID ? `${props.testID}-meta` : undefined}
                style={[
                  { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: centered ? 'center' : 'flex-start', columnGap: 6, minHeight: 18 },
                  // Directly under the details line (an identifier row is already padded by its button).
                  !props.details && (showTitle || props.description)
                    ? { marginTop: HAPPIER_PAGE_METRICS.pageHeaderLineGapPx }
                    : null,
                ]}
              >
                {props.meta.map((fact, index) => (
                  <View key={fact.key} testID={fact.testID} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    {index > 0 ? (
                      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden>
                        {renderText({ role: 'meta', text: '·', header: false })}
                      </View>
                    ) : null}
                    {fact.icon ?? null}
                    {renderText({ role: 'meta', text: fact.text, header: false })}
                  </View>
                ))}
              </View>
            ) : null}
          </View>
          {props.actions ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: centered ? 'center' : 'flex-start', gap: 8, flexShrink: 1, maxWidth: '100%' }}>
              {props.actions}
            </View>
          ) : null}
        </View>
        {props.details && props.detailsPlacement === 'column' ? <View style={{ marginTop: HAPPIER_PAGE_METRICS.pageHeaderLineGapPx }}>{props.details}</View> : null}
      </View>
    </View>
  );
}
