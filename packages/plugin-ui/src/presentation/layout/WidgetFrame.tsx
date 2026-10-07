import { useCallback, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { useOptionalHappierUiTheme, useOptionalHappierUiTypography } from '../../environment/context.js';
import type { HappierLayoutChangeEvent, HappierStyleProp } from '../portableTypes.js';
import { HappierText } from '../text/Text.js';
import { HAPPIER_PAGE_METRICS } from './pageMetrics.js';
import { resolveHappierPageTextStyle } from './pageText.js';

/**
 * How a widget is framed. `card` gives it its own surface; `plain` puts it on the page with a
 * hairline above. Header, body, footer, size, order and states are identical in both.
 */
export type HappierWidgetFrameStyle = 'card' | 'plain';

/** Where the widget is placed. Each placement has a per-surface default style (Home and Board card, Companion plain). */
export type HappierWidgetFramePlacement = 'home' | 'board' | 'companion';

export const HAPPIER_WIDGET_FRAME_STYLES: readonly HappierWidgetFrameStyle[] = Object.freeze(['card', 'plain']);

/**
 * Geometry of the one widget frame, shared by Happier core's widget frame and any plugin page that
 * shows a glance in the same frame.
 */
export const HAPPIER_WIDGET_FRAME_METRICS = Object.freeze({
  /** A card's corner: the page sheet's radius, so a Board card and a page sheet read as one family. */
  cardRadiusPx: HAPPIER_PAGE_METRICS.sheetRadiusPx,
  /**
   * From a card's edge to its mark, title, body and footer text, in every placement: a step of the
   * spacing rhythm (DESIGN.md → "Spacing runs on one rhythm"; lab `ui-refine` R2).
   */
  cardInsetPx: 12,
  /** A plain widget sits on the page: its text keeps only an optical inset from the column's edge. */
  plainInsetPx: 2,
  /** One header height in every placement; the menu inside it keeps its own touch target. */
  headerMinHeightPx: 40,
  /** Between the header's mark, title block, meta and controls. */
  headerGapPx: 8,
  /** The menu's own hit area supplies the card's right inset. */
  headerTrailingInsetPx: 6,
  /** Below the body, above the footer or the frame's edge. */
  bodyBottomInsetPx: 12,
  plainBodyBottomInsetPx: 14,
  /** The one footer row ("Open Channels ›"). */
  footerMinHeightPx: 38,
  plainFooterMinHeightPx: 30,
  /** Below this measured width the source leaves the header, before the title starts to truncate. */
  sourceHiddenBelowPx: 300,
} as const);

/** The frame's one narrowing rule: the source line leaves before the title truncates. */
export function isHappierWidgetFrameSourceShown(widthPx: number | null): boolean {
  return widthPx === null || widthPx >= HAPPIER_WIDGET_FRAME_METRICS.sourceHiddenBelowPx;
}

/** From the frame's edge to its header and body content, for this style (the same in every placement). */
export function resolveHappierWidgetFrameInsetPx(frameStyle: HappierWidgetFrameStyle): number {
  return frameStyle === 'plain' ? HAPPIER_WIDGET_FRAME_METRICS.plainInsetPx : HAPPIER_WIDGET_FRAME_METRICS.cardInsetPx;
}

export type HappierWidgetFrameTextRole = 'title' | 'source';

export type HappierWidgetFrameTextRender = (input: Readonly<{
  role: HappierWidgetFrameTextRole;
  text: string;
  testID: string;
}>) => ReactNode;

export type HappierWidgetFrameProps = Readonly<{
  frameStyle: HappierWidgetFrameStyle;
  placement: HappierWidgetFramePlacement;
  /** The adapter's resolved card surface (background, radius, hairline edge, elevation). */
  cardStyle?: HappierStyleProp;
  /** The hairline above a plain widget and under a card's body, before its footer. */
  dividerColor?: string;
  /** The source's mark: a glyph or a brand mark. It stands alone, never on a tile. */
  mark?: ReactNode;
  /** A string is drawn in the frame's title step; an element (a rename field) is drawn as-is. */
  title: ReactNode;
  /** The source's name, quiet beside the title (or under it on a phone). */
  source?: ReactNode;
  /** `below` on phones: the source sits under the title instead of competing with it. */
  sourcePlacement?: 'inline' | 'below';
  /** Freshness ("as of 10:42") or a count, only when the source knows it. */
  meta?: ReactNode;
  /** The widget's own controls at the end of the header: its ⋯ menu, a move handle. */
  accessory?: ReactNode;
  children?: ReactNode;
  /** Style for the body (a fixed or reserved height, full-bleed insets). */
  bodyStyle?: HappierStyleProp;
  /** The one footer row, where the widget leads somewhere. */
  footer?: ReactNode;
  /** Drawn over the frame's edge (the one-shot "just arrived" ring). */
  overlay?: ReactNode;
  /** Fill the parent's height (a card in a grid row shares its height with its neighbours). */
  fill?: boolean;
  /** How a string title or source is drawn (Happier core passes its own text owner). */
  renderText?: HappierWidgetFrameTextRender;
  accessibilityLabel?: string;
  testID?: string;
}>;

function DefaultFrameText(props: Readonly<{ role: HappierWidgetFrameTextRole; text: string; testID: string }>) {
  const theme = useOptionalHappierUiTheme();
  const typography = useOptionalHappierUiTypography();
  const title = props.role === 'title';
  const color = theme ? (title ? theme.colors.text : theme.colors.secondaryText) : undefined;
  return (
    <HappierText
      testID={props.testID}
      numberOfLines={1}
      accessibilityRole={title ? 'header' : undefined}
      style={[resolveHappierPageTextStyle(title ? 'sectionTitle' : 'meta', typography), color === undefined ? null : { color }]}
    >
      {props.text}
    </HappierText>
  );
}

const renderDefaultFrameText: HappierWidgetFrameTextRender = (input) => (
  <DefaultFrameText role={input.role} text={input.text} testID={input.testID} />
);

function renderSlot(
  slot: ReactNode,
  role: HappierWidgetFrameTextRole,
  testID: string,
  renderText: HappierWidgetFrameTextRender,
): ReactNode {
  if (slot === null || slot === undefined || slot === false || slot === '') return null;
  if (typeof slot === 'string' || typeof slot === 'number') return renderText({ role, text: String(slot), testID });
  return slot;
}

/**
 * The one widget frame (F1): the same header grammar — mark · title · source · meta · controls —
 * the same body and one footer on Home, the Board and the Companion, drawn as a card or plain.
 *
 * The frame owns structure and geometry; colours, elevation and text faces are the adapter's
 * (Happier core's theme, or a plugin's palette). A plugin widget's body is drawn inside it by the
 * host; a plugin page that shows a glance of its own uses the same frame through the public
 * `WidgetFrame`.
 */
export function HappierWidgetFrame(props: HappierWidgetFrameProps) {
  const [widthPx, setWidthPx] = useState<number | null>(null);
  const onLayout = useCallback((event: HappierLayoutChangeEvent) => {
    const next = event.nativeEvent.layout.width;
    setWidthPx((current) => (current === next ? current : next));
  }, []);
  const testID = props.testID ?? 'widget-frame';
  const plain = props.frameStyle === 'plain';
  const inset = resolveHappierWidgetFrameInsetPx(props.frameStyle);
  const renderText = props.renderText ?? renderDefaultFrameText;
  const below = props.sourcePlacement === 'below';
  // Stacked under the title, the source never competes for the title's width.
  const sourceShown = below || isHappierWidgetFrameSourceShown(widthPx);
  const source = sourceShown ? renderSlot(props.source, 'source', `${testID}.source`, renderText) : null;
  const hairline = props.dividerColor === undefined
    ? null
    : { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: props.dividerColor };

  return (
    <View
      testID={testID}
      onLayout={onLayout}
      accessibilityLabel={props.accessibilityLabel}
      style={[
        { minWidth: 0, position: 'relative' },
        plain ? hairline : props.cardStyle,
        plain ? null : { borderRadius: HAPPIER_WIDGET_FRAME_METRICS.cardRadiusPx, overflow: 'hidden' },
        props.fill ? { flexGrow: 1 } : null,
      ]}
    >
      <View
        testID={`${testID}.header`}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: HAPPIER_WIDGET_FRAME_METRICS.headerGapPx,
          minHeight: HAPPIER_WIDGET_FRAME_METRICS.headerMinHeightPx,
          paddingLeft: inset,
          paddingRight: plain ? 0 : HAPPIER_WIDGET_FRAME_METRICS.headerTrailingInsetPx,
          paddingVertical: below ? 8 : 0,
        }}
      >
        {props.mark ? (
          <View
            style={{ alignItems: 'center', justifyContent: 'center' }}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {props.mark}
          </View>
        ) : null}
        <View
          testID={`${testID}.titleBlock`}
          style={below
            ? { flexDirection: 'column', flex: 1, minWidth: 0, gap: 1 }
            : { flexDirection: 'row', alignItems: 'center', gap: HAPPIER_WIDGET_FRAME_METRICS.headerGapPx, flex: 1, minWidth: 0 }}
        >
          <View style={{ flexShrink: below ? 1 : 0, minWidth: 0, maxWidth: '100%' }}>
            {renderSlot(props.title, 'title', `${testID}.title`, renderText)}
          </View>
          {source ? <View style={{ flexShrink: 1, minWidth: 0 }}>{source}</View> : null}
        </View>
        {props.meta ? <View style={{ flexShrink: 0 }}>{props.meta}</View> : null}
        {props.accessory ?? null}
      </View>
      <View
        testID={`${testID}.body`}
        style={[
          {
            flexGrow: 1,
            minWidth: 0,
            paddingLeft: inset,
            paddingRight: inset,
            paddingBottom: plain
              ? HAPPIER_WIDGET_FRAME_METRICS.plainBodyBottomInsetPx
              : HAPPIER_WIDGET_FRAME_METRICS.bodyBottomInsetPx,
          },
          props.bodyStyle,
        ]}
      >
        {props.children}
      </View>
      {props.footer ? (
        <View
          testID={`${testID}.footer`}
          style={[
            {
              flexDirection: 'row',
              alignItems: 'center',
              minHeight: plain
                ? HAPPIER_WIDGET_FRAME_METRICS.plainFooterMinHeightPx
                : HAPPIER_WIDGET_FRAME_METRICS.footerMinHeightPx,
            },
            plain ? { marginTop: -6, paddingBottom: 6 } : hairline,
          ]}
        >
          {props.footer}
        </View>
      ) : null}
      {props.overlay ?? null}
    </View>
  );
}
