import { isValidElement, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, View, type ViewStyle } from 'react-native';

import {
  useOptionalHappierUiTheme,
  useOptionalHappierUiTypography,
} from '../../environment/context.js';
import type { HappierUiTheme } from '../../environment/types.js';
import { HAPPIER_RADIUS_V1 } from '../../environment/radius.js';
import { happierFocusRingStyle } from '../interaction/focusVisible.js';
import { HappierPressable } from '../interaction/Pressable.js';
import type {
  HappierFocusable,
  HappierLayoutChangeEvent,
  HappierStyleProp,
} from '../portableTypes.js';
import { HAPPIER_TONE_COLOR_TOKEN, type HappierTone } from '../semantics.js';
import { HappierText } from '../text/Text.js';
import { resolveHappierTypeRoleStyle } from '../text/typeRole.js';
import { HAPPIER_PRESS_FEEDBACK_V1 } from '../interaction/pressFeedback.js';
import { HAPPIER_PAGE_METRICS, readHappierVisibleLayoutWidth } from '../layout/pageMetrics.js';
import {
  HAPPIER_PAGE_TEXT,
  resolveHappierPageTextStyle,
  resolveHappierTextStepStyle,
} from '../layout/pageText.js';
import { HappierDataHatch } from './Hatch.js';
import { HAPPIER_FRESHNESS_LINE_METRICS } from '../state/InfoState.js';
import { useHappierMaterialColorResolver } from '../layout/Surface.js';

export type HappierMetadataEntry = Readonly<{
  label: string;
  value: string;
  /** Decorated glyphs; strings continue to own the metadata's semantic identity. */
  labelContent?: ReactNode;
  valueContent?: ReactNode;
  /**
   * A mark beside the value: a flag, a machine's mark, or a pending bar for a value still being read
   * (leave `value` empty then; the bar holds the value's place).
   */
  leading?: ReactNode;
  tone?: HappierTone;
  accessibilityLabel?: string;
  testID?: string;
}>;

export function HappierHeading(
  props: Readonly<{
    children?: ReactNode;
    /** Private semantic focus binding supplied by the public Heading adapter. */
    controlRef?: (instance: HappierFocusable | null) => void;
    level: 1 | 2 | 3 | 4 | 5 | 6;
    theme?: HappierUiTheme;
    testID?: string;
  }>,
) {
  // Three steps of the ramp, never one size for every level: the page heading
  // (1) takes the title role, a pane or section heading (2) the heading role,
  // and a subsection heading (3+) the label role, so a group heading never
  // reads as loudly as the heading of the pane it sits in.
  const role =
    props.level === 1
      ? ('title' as const)
      : props.level === 2
        ? ('heading' as const)
        : ('label' as const);
  const hostTypography = useOptionalHappierUiTypography();
  const environmentTheme = useOptionalHappierUiTheme();
  const theme = props.theme ?? environmentTheme;
  return (
    <HappierText
      ref={props.controlRef}
      accessibilityRole="header"
      aria-level={props.level}
      tabIndex={props.controlRef ? -1 : undefined}
      {...(theme
        ? {
            style: {
              ...resolveHappierTypeRoleStyle(role, theme, hostTypography),
              color: theme.colors.text,
            },
          }
        : { variant: role })}
      testID={props.testID}
    >
      {props.children}
    </HappierText>
  );
}

/**
 * A compact text label. Unlike {@link HappierHeading}, it deliberately has no
 * document-heading role.
 */
export function HappierLabel(
  props: Readonly<{
    children?: ReactNode;
    theme?: HappierUiTheme;
    testID?: string;
  }>,
) {
  const hostTypography = useOptionalHappierUiTypography();
  return (
    <HappierText
      {...(props.theme
        ? {
            style: {
              ...resolveHappierTypeRoleStyle(
                'label',
                props.theme,
                hostTypography,
              ),
              color: props.theme.colors.text,
            },
          }
        : { variant: 'label' as const })}
      testID={props.testID}
    >
      {props.children}
    </HappierText>
  );
}

export function HappierDivider(
  props: Readonly<{
    color: string;
    accessibilityLabel?: string;
    testID?: string;
    style?: HappierStyleProp;
  }>,
) {
  return (
    <View
      role="separator"
      accessibilityLabel={props.accessibilityLabel}
      testID={props.testID}
      style={[
        { height: 1, alignSelf: 'stretch', backgroundColor: props.color },
        props.style,
      ]}
    />
  );
}

/**
 * The one status-chrome geometry (lab `.l12-pill`): a small rounded rect on the small-mark radius step, so a
 * badge nests concentrically and reads as a fact beside a title, not as a separate capsule species. Core's
 * `StatusPill` and the public `Badge` both draw through {@link HappierBadge} with these values; only a
 * badge that is itself a control in a row of capsule chips (the composer status badge) asks for `capsule`.
 */
export const HAPPIER_BADGE_METRICS = Object.freeze({
  radius: HAPPIER_RADIUS_V1.sm,
  horizontalPadding: 7,
  // With the 14pt caption/pill line this is the lab's 20pt fact (`.l12-pill`).
  verticalPadding: 3,
  gap: 5,
});

/** The fully rounded badge shape (`shape="capsule"`); a press target wrapping one follows the same radius. */
export const HAPPIER_BADGE_CAPSULE_RADIUS_PX = 999;

export function HappierBadge(
  props: Readonly<{
    /**
     * The words. Text takes the portable caption role in the badge's ink; a core adapter may pass its own
     * scaled text element (or a fragment of them), which renders as given.
     */
    children?: ReactNode;
    /** A decorative mark before the words (a status dot, a reason's icon), retaining its own marker ink. */
    leading?: ReactNode;
    /** A trailing mark after the words (the caret of a badge that opens a popover). */
    trailing?: ReactNode;
    /** Text ink, independent of supplied marks: adapters project the tinted-status text role here. */
    color: string;
    backgroundColor: string;
    /** A ring in this colour; omitted, the badge is background-only. */
    borderColor?: string;
    /** `rect` (default): the shared status geometry. `capsule`: fully rounded, for a badge that is a control. */
    shape?: 'rect' | 'capsule';
    radius?: number;
    horizontalPadding?: number;
    verticalPadding?: number;
    /** The gap between the marks and the words. */
    gap?: number;
    accessibilityLabel?: string;
    testID?: string;
    style?: HappierStyleProp;
  }>,
) {
  const paintColor = useHappierMaterialColorResolver();
  const words = isValidElement(props.children) ? (
    props.children
  ) : (
    <HappierText variant="micro" style={{ color: props.color }}>
      {props.children}
    </HappierText>
  );
  return (
    <View
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: props.gap ?? HAPPIER_BADGE_METRICS.gap,
          borderWidth: props.borderColor === undefined ? 0 : 1,
          borderColor: props.borderColor,
          backgroundColor: paintColor(props.backgroundColor),
          borderRadius:
            props.shape === 'capsule'
              ? HAPPIER_BADGE_CAPSULE_RADIUS_PX
              : (props.radius ?? HAPPIER_BADGE_METRICS.radius),
          paddingHorizontal:
            props.horizontalPadding ?? HAPPIER_BADGE_METRICS.horizontalPadding,
          paddingVertical:
            props.verticalPadding ?? HAPPIER_BADGE_METRICS.verticalPadding,
        },
        props.style,
      ]}
    >
      {props.leading}
      {words}
      {props.trailing}
    </View>
  );
}

/**
 * Facts read label-then-value: the quiet label at the start of its row, the value at the end carrying
 * the weight, wrapping whole when it is long. Rows keep the control-height measure so a short list of
 * facts reads as one block, in a card, a receipt or a row opened in place.
 */
export function HappierMetadata(
  props: Readonly<{
    title?: string;
    titleContent?: ReactNode;
    entries: readonly HappierMetadataEntry[];
    theme: HappierUiTheme;
    testID?: string;
  }>,
) {
  const typography = useOptionalHappierUiTypography();
  const labelStyle = {
    ...resolveHappierPageTextStyle('rowDescription', typography),
    color: props.theme.colors.secondaryText,
  };
  const valueStyle = {
    ...resolveHappierTextStepStyle({ ...HAPPIER_PAGE_TEXT.rowDescription, weight: 'medium' }, typography),
    textAlign: 'right' as const,
    flexShrink: 1,
    minWidth: 0,
    // An unbroken value (an image URL, a path) wraps inside its column instead of running over the label.
    ...(Platform.OS === 'web' ? { wordBreak: 'break-word' as const } : {}),
  };
  const valueCellStyle = {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'flex-end' as const,
    gap: props.theme.spacing.xsmall,
    flexShrink: 1,
    minWidth: 0,
    // A long label wraps before it squeezes the value into a sliver.
    maxWidth: '65%' as const,
  };
  return (
    <View
      role="group"
      accessibilityLabel={props.title}
      testID={props.testID}
    >
      {props.title ? (
        <View style={{ paddingBottom: props.theme.spacing.xsmall }}>
          <HappierLabel theme={props.theme}>
            {props.titleContent ?? props.title}
          </HappierLabel>
        </View>
      ) : null}
      {props.entries.map((entry, index) => (
        <View
          key={`${entry.label}\u0000${index}`}
          testID={entry.testID}
          accessibilityLabel={entry.accessibilityLabel}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: props.theme.spacing.medium,
            minHeight: HAPPIER_PAGE_METRICS.controlHeightPx,
            // Ink hairlines between facts, never above the first.
            ...(index === 0 ? {} : { borderTopWidth: 1, borderTopColor: props.theme.colors.divider }),
          }}
        >
          <HappierText style={{ ...labelStyle, flexShrink: 1 }}>
            {entry.labelContent ?? entry.label}
          </HappierText>
          <View style={valueCellStyle}>
            {entry.leading}
            {entry.value === '' && entry.valueContent === undefined ? null : (
              <HappierText
                selectable
                style={{
                  ...valueStyle,
                  color:
                    props.theme.colors[
                      HAPPIER_TONE_COLOR_TOKEN[entry.tone ?? 'neutral']
                    ],
                }}
              >
                {entry.valueContent ?? entry.value}
              </HappierText>
            )}
          </View>
        </View>
      ))}
    </View>
  );
}

export function HappierLink(
  props: Readonly<{
    children?: ReactNode;
    label: string;
    disabled?: boolean;
    onPress: () => unknown;
    theme: HappierUiTheme;
    testID?: string;
  }>,
) {
  return (
    <HappierPressable
      accessibilityRole="link"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      testID={props.testID}
      style={(state) => ({
        alignSelf: 'flex-start',
        alignItems: 'center',
        justifyContent: 'center',
        borderBottomWidth: 1,
        borderBottomColor: props.theme.colors.accent,
        ...happierFocusRingStyle({
          visible: state.focused,
          color: props.theme.colors.focus,
        }),
        opacity: state.disabled
          ? 0.4
          : state.pressed
            ? HAPPIER_PRESS_FEEDBACK_V1.opacity
            : 1,
      })}
    >
      <HappierText style={{ color: props.theme.colors.accent }}>
        {props.children}
      </HappierText>
    </HappierPressable>
  );
}

export function HappierProgress(
  props: Readonly<{
    value?: number;
    label: string;
    theme: HappierUiTheme;
    testID?: string;
    style?: HappierStyleProp;
    pointerEvents?: 'auto' | 'box-none' | 'box-only' | 'none';
    renderFill?: (percentage: number) => ReactNode;
    /**
     * Capacity visuals have no progress announcement; their enclosing row supplies meaning. A stack of
     * shares (`segments`) is one picture named by `label`, never a progress value.
     */
    semantics?: 'progress' | 'none' | 'image';
    /** Shares of one whole (0–1 each), drawn left to right on the one track; `value` is not drawn. */
    segments?: readonly Readonly<{ value: number; color: string }>[];
    segmentGap?: number;
    renderSegment?: (segment: Readonly<{ value: number; color: string }>, visual: ReactNode, index: number) => ReactNode;
    height?: number;
    fillColor?: string;
    fillOpacity?: number;
    fillPattern?: 'solid' | 'hatched';
    trackColor?: string;
    trackOpacity?: number;
    fillTestID?: string;
    minimumVisibleFraction?: number;
    minimumFillWidth?: number;
  }>,
) {
  const percentage = resolveHappierProgressPercentage(props.value);
  const determinate = props.value !== undefined && Number.isFinite(props.value);
  const nativePointerEvents =
    Platform.OS === 'web' ? undefined : props.pointerEvents;
  const webPointerEventsStyle =
    Platform.OS === 'web' && props.pointerEvents
      ? { pointerEvents: props.pointerEvents }
      : undefined;
  const fillPercentage = resolveHappierProgressPercentage(props.value, {
    minimumVisible: props.minimumVisibleFraction,
  });
  const fillColor = props.fillColor ?? props.theme.colors.accent;
  // A hatched fill is the hatch itself in the fill's ink, inside a hairline of it (the same mark as a
  // composition strip's hatched part): the track shows between the lines, so it reads as "not yet".
  const hatched = props.fillPattern === 'hatched';
  const fillStyle: ViewStyle = {
    height: '100%',
    minWidth: props.minimumFillWidth,
    width: `${fillPercentage}%`,
    backgroundColor: hatched ? 'transparent' : fillColor,
    ...(hatched ? { borderWidth: 1, borderColor: fillColor, overflow: 'hidden' as const } : {}),
    opacity: props.fillOpacity,
    borderRadius: props.theme.radii.pill,
  };
  return (
    <View
      {...(props.semantics === 'none'
        ? {}
        : props.semantics === 'image'
          ? {
              role: 'img' as const,
              'aria-label': props.label,
              accessibilityLabel: props.label,
            }
          : {
              role: 'progressbar' as const,
              accessibilityRole: 'progressbar' as const,
              'aria-label': props.label,
              'aria-valuemin': 0,
              'aria-valuemax': 100,
              'aria-valuenow': determinate ? percentage : undefined,
              accessibilityLabel: props.label,
              accessibilityValue: determinate
                ? { min: 0, max: 100, now: percentage }
                : undefined,
            })}
      testID={props.testID}
      pointerEvents={nativePointerEvents}
      style={[
        {
          height: props.height ?? 8,
          overflow: 'hidden',
          borderRadius: props.theme.radii.pill,
          backgroundColor:
            props.trackOpacity === undefined ? props.trackColor ?? props.theme.colors.controlDisabled : 'transparent',
        },
        props.style,
        webPointerEventsStyle,
      ]}
    >
      {props.trackOpacity === undefined ? null : <View pointerEvents={Platform.OS === 'web' ? undefined : 'none'} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
        ...(Platform.OS === 'web' ? { pointerEvents: 'none' as const } : {}),
        backgroundColor: props.trackColor ?? props.theme.colors.controlDisabled, opacity: props.trackOpacity }} />}
      {props.segments !== undefined ? (
        <View style={{ flexDirection: 'row', height: '100%', gap: props.segmentGap }}>
          {props.segments.map((segment, index) => {
            const visual = (
            <View
              key={index}
              testID={
                props.testID === undefined
                  ? undefined
                  : `${props.testID}-segment-${index}`
              }
              style={{
                height: '100%',
                backgroundColor: segment.color,
              }}
            />
            );
            return <View key={index} style={{ width: `${resolveHappierProgressPercentage(segment.value, {
              indeterminate: 0, minimumVisible: segment.value > 0 ? props.minimumVisibleFraction : undefined,
            })}%`, minWidth: segment.value > 0 ? props.minimumFillWidth : undefined, flexShrink: 1, height: '100%' }}>
              {props.renderSegment?.(segment, visual, index) ?? visual}
            </View>;
          })}
        </View>
      ) : props.renderFill ? (
        props.renderFill(percentage)
      ) : (
        <View testID={props.fillTestID} style={fillStyle}>
          {hatched ? <HappierDataHatch theme={props.theme} color={fillColor} density={(props.height ?? 8) <= props.theme.spacing.small ? 'fine' : 'regular'} /> : null}
        </View>
      )}
    </View>
  );
}

/** Shared clamping/rounding for every determinate or placeholder progress owner. */
export function resolveHappierProgressPercentage(
  value: number | undefined,
  options: Readonly<{ indeterminate?: number; minimumVisible?: number }> = {},
): number {
  const indeterminate = options.indeterminate ?? 0.35;
  const minimumVisible = options.minimumVisible ?? 0;
  const fraction =
    value === undefined || !Number.isFinite(value)
      ? indeterminate
      : Math.max(minimumVisible, Math.min(1, value));
  return Math.round(fraction * 100);
}

/**
 * One check or step beneath a banner's description, with the literal commands it names kept apart
 * (`{ code }`) so they are drawn as code and never wrap inside themselves.
 */
export type HappierBannerPoint = readonly (string | Readonly<{ code: string }>)[];

/** Splits a translated line around the literal commands it names (they are never translated). */
export function splitHappierBannerPoint(text: string, commands: readonly string[]): HappierBannerPoint {
  const segments: (string | Readonly<{ code: string }>)[] = [];
  let rest = text;
  while (rest) {
    const next = commands
      .map((command) => ({ command, at: command ? rest.indexOf(command) : -1 }))
      .filter((match) => match.at >= 0)
      .sort((left, right) => left.at - right.at || right.command.length - left.command.length)[0];
    if (!next) { segments.push(rest); break; }
    if (next.at > 0) segments.push(rest.slice(0, next.at));
    segments.push({ code: next.command });
    rest = rest.slice(next.at + next.command.length);
  }
  return segments;
}

/** A banner that needs the reader — a failure, a caution or "needs you" — is announced and wears the warning mark. */
export function isHappierBannerUrgent(tone: HappierTone): boolean {
  return tone === 'danger' || tone === 'warning' || tone === 'attention';
}

export function HappierBanner(
  props: Readonly<{
    title: string;
    description?: string;
    tone: HappierTone;
    action?: ReactNode;
    /** Compact call-to-action below the whole banner identity, not only its text column. */
    compactActionPlacement?: 'full-width';
    /**
     * `below` keeps the action under the text at every width: several buttons, or a notice whose
     * text is a list of steps, would otherwise squeeze the words into a narrow column beside them.
     */
    actionPlacement?: 'trailing' | 'below';
    theme: HappierUiTheme;
    testID?: string;
    style?: HappierStyleProp;
    onLayout?: (event: HappierLayoutChangeEvent) => void;
    icon?: ReactNode;
    details?: ReactNode;
    dismiss?: ReactNode;
    backgroundColor?: string;
    borderColor?: string;
    /** Core binds its text host; both adapters retain this owner's layout. */
    titleContent?: ReactNode;
    descriptionContent?: ReactNode;
    /**
     * Checks or steps the reader can take, beneath the description: one hanging line each, so a long
     * point wraps under its own text rather than under the bullet. Points put the action below.
     */
    points?: readonly HappierBannerPoint[];
    /** Core binds its text host for a point's line; the hanging layout stays this owner's. */
    renderPoint?: (point: HappierBannerPoint, index: number) => ReactNode;
    announce?: 'alert' | 'status' | 'none';
    accessibilityLiveRegion?: 'polite' | 'assertive';
    /**
     * `card` (default): a notice that takes a section's place in a page. `strip`: the compact band across
     * the top of a pane or reading surface, on the freshness line's measures (inset fill, ink hairlines
     * above and below, one line of meta text). Its title leads in the ink of the words when a description
     * follows it, else it is the one quiet sentence; the actions keep the line's end and move beneath the
     * words when both do not fit, ending at the band's trailing edge on a narrow pane. Points and the
     * full-width compact action belong to the card.
     */
    presentation?: 'card' | 'strip';
  }>,
) {
  const paintColor = useHappierMaterialColorResolver();
  const isUrgent = isHappierBannerUrgent(props.tone);
  const color = props.theme.colors[HAPPIER_TONE_COLOR_TOKEN[props.tone]];
  const typography = useOptionalHappierUiTypography();
  const [narrow, setNarrow] = useState(false);
  if (props.presentation === 'strip') return <HappierBannerStrip {...props} />;
  const fullWidthAction =
    narrow && props.compactActionPlacement === 'full-width';
  const actionBelow = narrow || props.actionPlacement === 'below' || (props.points?.length ?? 0) > 0;
  const descriptionStyle = {
    ...resolveHappierPageTextStyle('rowDescription', typography),
    color: props.theme.colors.secondaryText,
  };
  const role =
    props.announce === 'none'
      ? undefined
      : (props.announce ?? (isUrgent ? 'alert' : 'status'));
  const decorationPointerEvents = Platform.OS === 'web' ? undefined : 'none';
  const decorationStyle: ViewStyle = {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: HAPPIER_PAGE_METRICS.sheetRadiusPx,
    ...(Platform.OS === 'web' ? { pointerEvents: 'none' } : {}),
  };
  const banner = (
    <View
      role={role}
      accessibilityRole={role === 'alert' ? 'alert' : undefined}
      accessibilityLiveRegion={
        props.accessibilityLiveRegion ??
        (role === undefined
          ? undefined
          : role === 'alert'
            ? 'assertive'
            : 'polite')
      }
      testID={props.testID}
      onLayout={(event) => {
        const width = readHappierVisibleLayoutWidth(event.nativeEvent.layout.width);
        if (width !== null) setNarrow(width < HAPPIER_PAGE_METRICS.rowStackBelowWidthPx);
        props.onLayout?.(event);
      }}
      style={[
        {
          flexDirection: 'row',
          // Stacked, the mark belongs to the title's line, not to the middle of a tall block.
          alignItems: actionBelow ? 'flex-start' : 'center',
          borderRadius: HAPPIER_PAGE_METRICS.sheetRadiusPx,
          paddingVertical: 12,
          paddingLeft: HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx,
          paddingRight: 12,
          gap: HAPPIER_PAGE_METRICS.rowLeadingGapPx,
          backgroundColor: paintColor(props.backgroundColor ?? props.theme.colors.surface, 'transparent'),
        },
        props.style,
      ]}
    >
      {props.backgroundColor ? null : (
        <View
          pointerEvents={decorationPointerEvents}
          style={[decorationStyle, { backgroundColor: color, opacity: 0.08 }]}
        />
      )}
      <View
        pointerEvents={decorationPointerEvents}
        style={[
          decorationStyle,
          {
            borderWidth: 1,
            borderColor: props.borderColor ?? color,
            opacity: 0.32,
          },
        ]}
      />
      {props.icon ? (
        <View
          style={{
            width: HAPPIER_PAGE_METRICS.rowLeadingColumnPx,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {props.icon}
        </View>
      ) : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        {props.titleContent ?? (
          <HappierText
            style={{
              ...resolveHappierPageTextStyle('rowTitle', typography),
              color: props.theme.colors.text,
            }}
          >
            {props.title}
          </HappierText>
        )}
        {props.descriptionContent ??
          (props.description ? (
            <HappierText
              style={{
                ...resolveHappierPageTextStyle('rowDescription', typography),
                color: props.theme.colors.secondaryText,
                marginTop: 2,
              }}
            >
              {props.description}
            </HappierText>
          ) : null)}
        {props.points?.length ? (
          <View style={{ marginTop: 2 }}>
            {props.points.map((point, index) => (
              <View key={index} testID={props.testID ? `${props.testID}.point.${index}` : undefined}
                style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                <HappierText aria-hidden style={{ ...descriptionStyle, width: 14 }}>{'\u2022'}</HappierText>
                <View style={{ flex: 1, minWidth: 0 }}>
                  {props.renderPoint?.(point, index) ?? (
                    <HappierText style={descriptionStyle}>
                      {point.map((segment, segmentIndex) => typeof segment === 'string' ? segment : (
                        // A command never breaks inside itself; the line wraps around it.
                        <HappierText key={segmentIndex} style={{ fontFamily: props.theme.typography.code.fontFamily,
                          color: props.theme.colors.text }}>{segment.code.replace(/ /g, '\u00a0')}</HappierText>
                      ))}
                    </HappierText>
                  )}
                </View>
              </View>
            ))}
          </View>
        ) : null}
        {props.details}
        {props.action && actionBelow && !fullWidthAction ? (
          <View style={{ alignItems: 'flex-start', marginTop: 10 }}>
            {props.action}
          </View>
        ) : null}
      </View>
      {props.action && !actionBelow ? (
        <View style={{ flexShrink: 0 }}>{props.action}</View>
      ) : null}
      {props.dismiss ? (
        <View
          style={{ alignSelf: 'flex-start', marginTop: -4, marginRight: -4 }}
        >
          {props.dismiss}
        </View>
      ) : null}
    </View>
  );
  return fullWidthAction ? (
    <View>
      {banner}
      <View
        style={{
          width: '100%',
          marginTop: HAPPIER_PAGE_METRICS.rowLeadingGapPx,
        }}
      >
        {props.action}
      </View>
    </View>
  ) : (
    banner
  );
}

/** The banner's `strip` presentation; see {@link HappierBanner}. */
function HappierBannerStrip(props: Parameters<typeof HappierBanner>[0]) {
  const metrics = HAPPIER_FRESHNESS_LINE_METRICS;
  const typography = useOptionalHappierUiTypography();
  const paintColor = useHappierMaterialColorResolver();
  const [narrow, setNarrow] = useState(false);
  const color = props.theme.colors[HAPPIER_TONE_COLOR_TOKEN[props.tone]];
  const role =
    props.announce === 'none'
      ? undefined
      : (props.announce ?? (isHappierBannerUrgent(props.tone) ? 'alert' : 'status'));
  const meta = resolveHappierTypeRoleStyle('meta', props.theme, typography);
  const lead = props.description
    ? { ...resolveHappierTypeRoleStyle('meta', props.theme, typography, 'semiBold'), color: props.theme.colors.text }
    : null;
  return (
    <View
      role={role}
      accessibilityRole={role === 'alert' ? 'alert' : undefined}
      accessibilityLiveRegion={
        props.accessibilityLiveRegion ??
        (role === undefined ? undefined : role === 'alert' ? 'assertive' : 'polite')
      }
      testID={props.testID}
      onLayout={(event) => {
        const width = readHappierVisibleLayoutWidth(event.nativeEvent.layout.width);
        if (width !== null) setNarrow(width < HAPPIER_PAGE_METRICS.rowStackBelowWidthPx);
        props.onLayout?.(event);
      }}
      style={[
        {
          flexDirection: narrow ? 'column' : 'row',
          flexWrap: narrow ? 'nowrap' : 'wrap',
          alignItems: narrow ? 'stretch' : 'center',
          columnGap: metrics.gapPx,
          rowGap: 6,
          minHeight: metrics.minHeightPx,
          paddingLeft: metrics.paddingStartPx,
          paddingRight: metrics.paddingEndPx,
          paddingVertical: narrow ? 8 : 6,
          backgroundColor: paintColor(props.backgroundColor ?? props.theme.colors.surface, 'transparent'),
          // The edges stay ink hairlines in every tone: a tinted rule reads heavier than the words.
          borderTopWidth: StyleSheet.hairlineWidth,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderColor: props.borderColor ?? props.theme.colors.divider,
        },
        props.style,
      ]}
    >
      {props.backgroundColor ? null : (
        <View
          pointerEvents={Platform.OS === 'web' ? undefined : 'none'}
          style={{
            position: 'absolute', top: 0, right: 0, bottom: 0, left: 0,
            ...(Platform.OS === 'web' ? { pointerEvents: 'none' } : {}),
            backgroundColor: props.tone === 'neutral' || props.tone === 'secondary' || props.tone === 'muted' ? props.theme.colors.text : color,
            opacity: props.tone === 'neutral' || props.tone === 'secondary' || props.tone === 'muted' ? 0.025 : 0.08,
          }}
        />
      )}
      {/* The words keep their natural width as the line's basis, so actions that do not fit wrap under
          them instead of squeezing the sentence into a one-word column. */}
      <View style={{ flexDirection: 'row', alignItems: props.details ? 'flex-start' : 'center', gap: metrics.gapPx,
        flexGrow: 1, flexShrink: 1, flexBasis: 'auto', minWidth: 0 }}>
        {props.icon ? (
          <View style={props.details ? { marginTop: (metrics.text.lineHeight - metrics.glyphPx) / 2 } : null}>{props.icon}</View>
        ) : null}
        <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 'auto', minWidth: 0 }}>
          {props.titleContent ?? (
            <HappierText style={{ ...meta, color: props.theme.colors.secondaryText }}>
              {lead ? <HappierText style={lead}>{props.title}</HappierText> : props.title}
              {props.description ? ` ${props.description}` : null}
            </HappierText>
          )}
          {props.details}
        </View>
      </View>
      {props.action ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 0,
          ...(narrow ? { alignSelf: 'flex-end' } : { marginLeft: 'auto' }) }}>
          {props.action}
        </View>
      ) : null}
      {props.dismiss ? <View style={{ flexShrink: 0 }}>{props.dismiss}</View> : null}
    </View>
  );
}
