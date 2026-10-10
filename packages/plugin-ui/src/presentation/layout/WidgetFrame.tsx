import { isValidElement, useCallback, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Path, Svg } from 'react-native-svg';

import {
  useOptionalHappierUiTheme,
  useOptionalHappierUiTypography,
} from '../../environment/context.js';
import type {
  HappierLayoutChangeEvent,
  HappierStyleProp,
} from '../portableTypes.js';
import { HappierText } from '../text/Text.js';
import {
  HappierDisclosure,
  type HappierControlledDisclosure,
  type HappierDisclosureMotionDriver,
} from '../collection/Disclosure.js';
import { HAPPIER_INSTANT_DISCLOSURE_MOTION } from '../collection/collectionMotion.js';
import { HappierPressable } from '../interaction/Pressable.js';
import { happierFocusRingStyle } from '../interaction/focusVisible.js';
import { HAPPIER_RADIUS_V1 } from '../../environment/radius.js';
import {
  HAPPIER_DISCLOSURE_CHEVRON_METRICS,
  HappierDisclosureChevron,
} from '../collection/DisclosureChevron.js';
import { HAPPIER_PAGE_METRICS } from './pageMetrics.js';
import { resolveHappierPageTextStyle } from './pageText.js';
import { HappierMaterialSurface, type HappierMaterialSurfaceRender } from './Surface.js';
import type { HappierSurfaceGradient } from './material.js';

/**
 * How a widget is framed. `card` gives it its own surface; `plain` puts it on the page with a
 * hairline above. Header, body, footer, size, order and states are identical in both.
 */
export type HappierWidgetFrameStyle = 'card' | 'plain';

/** Where the widget is placed. Each placement has a per-surface default style (Home and Board card, Companion plain). */
export type HappierWidgetFramePlacement = 'home' | 'board' | 'companion';

export const HAPPIER_WIDGET_FRAME_STYLES: readonly HappierWidgetFrameStyle[] =
  Object.freeze(['card', 'plain']);

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

/** The caret's box (lab `.wf-cv`): 24pt, extended by the slop to a comfortable target without crowding the mark. */
const DISCLOSURE_BOX_STYLE = Object.freeze({
  width: HAPPIER_DISCLOSURE_CHEVRON_METRICS.boxPx,
  height: HAPPIER_DISCLOSURE_CHEVRON_METRICS.boxPx,
  borderRadius: HAPPIER_RADIUS_V1.sm,
  alignItems: 'center',
  justifyContent: 'center',
  // Optically, the caret hangs into the inset so the mark and title keep their column.
  marginLeft: -4,
  marginRight: -3,
} as const);
const DISCLOSURE_HIT_SLOP = 8;
/** Only an unthemed, unhosted frame (a bare test mount) falls back to a neutral mid-grey caret. */
const DISCLOSURE_FALLBACK_INK = 'rgb(128, 128, 128)';

/** The frame's one narrowing rule: the source line leaves before the title truncates. */
export function isHappierWidgetFrameSourceShown(
  widthPx: number | null,
): boolean {
  return (
    widthPx === null ||
    widthPx >= HAPPIER_WIDGET_FRAME_METRICS.sourceHiddenBelowPx
  );
}

/**
 * What the source slot draws at a width: the source, or — below the narrowing width — its compact
 * form when the widget gives one (a glyph and a value, its phrase kept as the accessible label), else
 * nothing, so the title keeps its room.
 */
export function resolveHappierWidgetFrameSource<T>(input: Readonly<{ widthPx: number | null; source: T; compactSource?: T }>): T | null {
  if (isHappierWidgetFrameSourceShown(input.widthPx)) return input.source;
  return input.compactSource ?? null;
}

/**
 * How a source is bound, drawn as a small glyph before its text: `pin` is a value chosen for this
 * widget (or group) itself; `follow` is a value it takes from where it sits (its group).
 */
export type HappierWidgetFrameSourceBinding = 'pin' | 'follow';

/**
 * A bound source for the frame's source slot ("📌 website · main", "🔗 Following group · happier"):
 * the frame draws the binding glyph and the text, and names the line for assistive tech. A widget
 * whose source is only a name passes a string instead.
 */
export type HappierWidgetFrameSourceDescriptor = Readonly<{
  binding: HappierWidgetFrameSourceBinding;
  /** The line as written ("Following group · happier"). */
  text: string;
  /**
   * The short form a narrow frame keeps (the value alone: "happier"), beside the same glyph. Without
   * one, the source leaves a narrow frame before the title truncates.
   */
  compactText?: string;
  /** The accessible name when it says more than the visible text; defaults to `text`. */
  accessibilityLabel?: string;
}>;

export function isHappierWidgetFrameSourceDescriptor(source: unknown): source is HappierWidgetFrameSourceDescriptor {
  return typeof source === 'object' && source !== null && !isValidElement(source)
    && 'binding' in source && 'text' in source;
}

/** The text a bound source shows at a width: its line, its short form below the narrowing width, or nothing. */
export function resolveHappierWidgetFrameSourceText(input: Readonly<{
  widthPx: number | null;
  source: Pick<HappierWidgetFrameSourceDescriptor, 'text' | 'compactText'>;
}>): string | null {
  return resolveHappierWidgetFrameSource({
    widthPx: input.widthPx,
    source: input.source.text,
    ...(input.source.compactText === undefined ? {} : { compactSource: input.source.compactText }),
  });
}

/** The glyph's box beside the source's `meta` text step. */
const SOURCE_GLYPH_PX = 12;
/** Lab `dashboards` kit: the pin and the follow link, drawn on a 24 grid at the lab's 1.6 stroke. */
const SOURCE_GLYPH_PATHS: Readonly<Record<HappierWidgetFrameSourceBinding, string>> = Object.freeze({
  pin: 'M9 4h6l-1 5 3 3v1.5H7V12l3-3-1-5Z M12 13.5V20',
  follow: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
});

/** The frame's own binding glyph, for a host that passes no icon pack (a plugin's frame). */
function DefaultSourceGlyph(props: Readonly<{ binding: HappierWidgetFrameSourceBinding; color: string; testID: string }>) {
  return (
    <Svg testID={props.testID} width={SOURCE_GLYPH_PX} height={SOURCE_GLYPH_PX} viewBox="0 0 24 24" aria-hidden>
      <Path d={SOURCE_GLYPH_PATHS[props.binding]} fill="none" stroke={props.color} strokeWidth={1.6}
        strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

/**
 * What the meta slot draws at a width: the meta, or — below the narrowing width — its compact form
 * when the widget gives one ("Refreshing…" becomes its spinner), so the title keeps its room.
 */
export function resolveHappierWidgetFrameMeta<T>(input: Readonly<{ widthPx: number | null; meta: T; compactMeta?: T }>): T {
  return isHappierWidgetFrameSourceShown(input.widthPx) || input.compactMeta === undefined ? input.meta : input.compactMeta;
}

/** From the frame's edge to its header and body content, for this style (the same in every placement). */
export function resolveHappierWidgetFrameInsetPx(
  frameStyle: HappierWidgetFrameStyle,
): number {
  return frameStyle === 'plain'
    ? HAPPIER_WIDGET_FRAME_METRICS.plainInsetPx
    : HAPPIER_WIDGET_FRAME_METRICS.cardInsetPx;
}

export type HappierWidgetFrameTextRole = 'title' | 'source';

export type HappierWidgetFrameTextRender = (
  input: Readonly<{
    role: HappierWidgetFrameTextRole;
    text: string;
    testID: string;
  }>,
) => ReactNode;

export type HappierWidgetFrameProps = Readonly<{
  frameStyle: HappierWidgetFrameStyle;
  placement: HappierWidgetFramePlacement;
  /** The adapter's resolved card surface (background, radius, hairline edge, elevation). */
  cardStyle?: HappierStyleProp;
  gradient?: HappierSurfaceGradient | null;
  renderMaterialSurface?: HappierMaterialSurfaceRender;
  /** The hairline above a plain widget and under a card's body, before its footer. */
  dividerColor?: string;
  /** A control before the mark while the widget's surface is being arranged (its move handle). */
  leading?: ReactNode;
  /** The source's mark: a glyph or a brand mark. It stands alone, never on a tile. */
  mark?: ReactNode;
  /** A string is drawn in the frame's title step; an element (a rename field) is drawn as-is. */
  title: ReactNode;
  /**
   * The source, quiet beside the title (or under it on a phone): its name, or — when it is a bound
   * value — a descriptor the frame draws with the pin or follow glyph.
   */
  source?: ReactNode | HappierWidgetFrameSourceDescriptor;
  /** The host's icon pack for a bound source's glyph; without it the frame draws its own. */
  renderSourceGlyph?: (binding: HappierWidgetFrameSourceBinding) => ReactNode;
  /** `below` on phones: the source sits under the title instead of competing with it. */
  sourcePlacement?: 'inline' | 'below';
  /** Freshness ("as of 10:42") or a count, only when the source knows it. */
  meta?: ReactNode;
  /** The meta's short form for a narrow frame (an activity word becomes its spinner), drawn instead of crowding the title. */
  compactMeta?: ReactNode;
  /** The widget's own controls at the end of the header: its ⋯ menu, a move handle. */
  accessory?: ReactNode;
  /** Viewer-local controlled collapse, independent from header/body actions. */
  disclosure?: HappierControlledDisclosure;
  /** The host's existing disclosure driver; unhosted frames reveal immediately. */
  disclosureMotion?: HappierDisclosureMotionDriver;
  reducedMotion?: boolean;
  /**
   * The disclosure caret's inks: at rest, under hover/focus, and its focus ring. A host without the plugin
   * environment theme (Happier core) passes its own roles; a plugin surface reads them from its environment.
   */
  disclosureColors?: Readonly<{
    glyph: string;
    glyphActive: string;
    focus: string;
  }>;
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

function DefaultFrameText(
  props: Readonly<{
    role: HappierWidgetFrameTextRole;
    text: string;
    testID: string;
  }>,
) {
  const theme = useOptionalHappierUiTheme();
  const typography = useOptionalHappierUiTypography();
  const title = props.role === 'title';
  const color = theme
    ? title
      ? theme.colors.text
      : theme.colors.secondaryText
    : undefined;
  return (
    <HappierText
      testID={props.testID}
      numberOfLines={1}
      accessibilityRole={title ? 'header' : undefined}
      style={[
        resolveHappierPageTextStyle(
          title ? 'sectionTitle' : 'meta',
          typography,
        ),
        color === undefined ? null : { color },
      ]}
    >
      {props.text}
    </HappierText>
  );
}

const renderDefaultFrameText: HappierWidgetFrameTextRender = (input) => (
  <DefaultFrameText role={input.role} text={input.text} testID={input.testID} />
);

function isEmptySlot(slot: ReactNode): boolean {
  return slot === null || slot === undefined || slot === false || slot === '';
}

function renderSlot(
  slot: ReactNode,
  role: HappierWidgetFrameTextRole,
  testID: string,
  renderText: HappierWidgetFrameTextRender,
): ReactNode {
  if (isEmptySlot(slot)) return null;
  if (typeof slot === 'string' || typeof slot === 'number')
    return renderText({ role, text: String(slot), testID });
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
  const environmentTheme = useOptionalHappierUiTheme();
  const disclosureExpanded = props.disclosure?.collapsed !== true;
  // The caret is the quietest control in the header; it comes to the text ink under hover or focus.
  const disclosureColors = props.disclosureColors ?? {
    glyph: environmentTheme?.colors.secondaryText ?? DISCLOSURE_FALLBACK_INK,
    glyphActive: environmentTheme?.colors.text ?? DISCLOSURE_FALLBACK_INK,
    focus: environmentTheme?.colors.focus ?? DISCLOSURE_FALLBACK_INK,
  };
  const plain = props.frameStyle === 'plain';
  const inset = resolveHappierWidgetFrameInsetPx(props.frameStyle);
  const renderText = props.renderText ?? renderDefaultFrameText;
  const below = props.sourcePlacement === 'below';
  // Stacked under the title, the source never competes for the title's width.
  let source: ReactNode;
  if (isHappierWidgetFrameSourceDescriptor(props.source)) {
    const bound = props.source;
    const text = below ? bound.text : resolveHappierWidgetFrameSourceText({ widthPx, source: bound });
    source = text === null ? null : (
      <View
        testID={`${testID}.source`}
        accessible
        accessibilityLabel={bound.accessibilityLabel ?? bound.text}
        aria-label={bound.accessibilityLabel ?? bound.text}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 4, minWidth: 0 }}
      >
        {props.renderSourceGlyph
          ? props.renderSourceGlyph(bound.binding)
          : <DefaultSourceGlyph binding={bound.binding} color={environmentTheme?.colors.secondaryText ?? DISCLOSURE_FALLBACK_INK} testID={`${testID}.source.glyph`} />}
        <View style={{ flexShrink: 1, minWidth: 0 }}>
          {renderText({ role: 'source', text, testID: `${testID}.source.text` })}
        </View>
      </View>
    );
  } else {
    // A plain source leaves a narrow frame before the title truncates.
    const plain: ReactNode = below ? props.source : resolveHappierWidgetFrameSource({ widthPx, source: props.source });
    source = renderSlot(plain, 'source', `${testID}.source`, renderText);
  }
  const meta = below ? props.meta
    : resolveHappierWidgetFrameMeta({ widthPx, meta: props.meta, ...(props.compactMeta === undefined ? {} : { compactMeta: props.compactMeta }) });
  const hairline =
    props.dividerColor === undefined
      ? null
      : {
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: props.dividerColor,
        };
  // A frame with nothing to say in its header (an untitled widget group) has no header row: its
  // body starts at the frame's edge, so it is exactly as tall as what it holds.
  const headerless =
    isEmptySlot(props.title) &&
    !props.mark &&
    !props.leading &&
    !props.meta &&
    !props.accessory &&
    !props.disclosure;

  return (
    <HappierMaterialSurface materialRole={plain ? undefined : 'content'} gradient={plain ? null : props.gradient} renderMaterialSurface={props.renderMaterialSurface}
      testID={testID}
      onLayout={onLayout}
      accessibilityLabel={props.accessibilityLabel}
      style={[
        { minWidth: 0, position: 'relative' },
        plain ? hairline : props.cardStyle,
        plain
          ? null
          : {
              borderRadius: HAPPIER_WIDGET_FRAME_METRICS.cardRadiusPx,
              overflow: 'hidden',
            },
        props.fill ? { flexGrow: 1 } : null,
      ]}
    >
      <HappierDisclosure
        expanded={props.disclosure?.collapsed !== true}
        onExpandedChange={(expanded) =>
          props.disclosure?.onCollapsedChange(!expanded)
        }
        keepMounted
        style={{ flexGrow: 1, minWidth: 0 }}
        bodyStyle={{ flexGrow: 1, minWidth: 0 }}
        showDivider={false}
        reducedMotion={props.reducedMotion ?? true}
        motion={props.disclosureMotion ?? HAPPIER_INSTANT_DISCLOSURE_MOTION}
        header={
          headerless ? null : <View
            testID={`${testID}.header`}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: HAPPIER_WIDGET_FRAME_METRICS.headerGapPx,
              minHeight: HAPPIER_WIDGET_FRAME_METRICS.headerMinHeightPx,
              paddingLeft: inset,
              paddingRight: plain
                ? 0
                : HAPPIER_WIDGET_FRAME_METRICS.headerTrailingInsetPx,
              paddingVertical: below ? 8 : 0,
            }}
          >
            {props.disclosure ? (
              <HappierPressable
                testID={`${testID}.disclosure`}
                onPress={() =>
                  props.disclosure?.onCollapsedChange(
                    !props.disclosure.collapsed,
                  )
                }
                expanded={!props.disclosure.collapsed}
                accessibilityLabel={
                  props.disclosure.collapsed
                    ? props.disclosure.expandLabel
                    : props.disclosure.collapseLabel
                }
                hitSlop={DISCLOSURE_HIT_SLOP}
                style={(state) => [
                  DISCLOSURE_BOX_STYLE,
                  happierFocusRingStyle({
                    visible: state.focused,
                    color: disclosureColors.focus,
                  }),
                ]}
              >
                {(state) => (
                  <HappierDisclosureChevron
                    expanded={disclosureExpanded}
                    color={
                      state.hovered || state.focused
                        ? disclosureColors.glyphActive
                        : disclosureColors.glyph
                    }
                    reducedMotion={props.reducedMotion}
                  />
                )}
              </HappierPressable>
            ) : null}
            {props.leading ?? null}
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
              style={
                below
                  ? { flexDirection: 'column', flex: 1, minWidth: 0, gap: 1 }
                  : {
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: HAPPIER_WIDGET_FRAME_METRICS.headerGapPx,
                      flex: 1,
                      minWidth: 0,
                    }
              }
            >
              <View
                style={{
                  flexShrink: below ? 1 : 0,
                  minWidth: 0,
                  maxWidth: '100%',
                }}
              >
                {renderSlot(
                  props.title,
                  'title',
                  `${testID}.title`,
                  renderText,
                )}
              </View>
              {source ? (
                <View style={{ flexShrink: 1, minWidth: 0 }}>{source}</View>
              ) : null}
            </View>
            {meta ? (
              <View style={{ flexShrink: 0 }}>{meta}</View>
            ) : null}
            {props.accessory ?? null}
          </View>
        }
      >
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
      </HappierDisclosure>
      {props.overlay ?? null}
    </HappierMaterialSurface>
  );
}
