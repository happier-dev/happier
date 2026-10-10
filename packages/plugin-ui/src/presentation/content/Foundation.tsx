import { isValidElement, useState, type ReactNode } from 'react';
import { Platform, View, type ViewStyle } from 'react-native';

import { useHappierNativeMinimumInteractiveTargetSize } from '../../environment/interactiveTarget.js';
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
import { HAPPIER_PAGE_METRICS } from '../layout/pageMetrics.js';
import { resolveHappierPageTextStyle } from '../layout/pageText.js';
import { HappierDataHatch } from './Hatch.js';
import { useHappierMaterialColorResolver } from '../layout/Surface.js';

export type HappierMetadataEntry = Readonly<{
  label: string;
  value: string;
  /** Decorated glyphs; strings continue to own the metadata's semantic identity. */
  labelContent?: ReactNode;
  valueContent?: ReactNode;
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
  // (1) takes the heading role, a pane or section heading (2) the title role,
  // and a subsection heading (3+) the label role, so a group heading never
  // reads as loudly as the heading of the pane it sits in.
  const role =
    props.level === 1
      ? ('heading' as const)
      : props.level === 2
        ? ('title' as const)
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
        : { variant: role === 'heading' ? ('title' as const) : role })}
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
    <HappierText variant="caption" style={{ color: props.color }}>
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
              ? 999
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

export function HappierMetadata(
  props: Readonly<{
    title?: string;
    titleContent?: ReactNode;
    entries: readonly HappierMetadataEntry[];
    theme: HappierUiTheme;
    testID?: string;
  }>,
) {
  return (
    <View
      role="group"
      accessibilityLabel={props.title}
      testID={props.testID}
      style={{ gap: props.theme.spacing.small }}
    >
      {props.title ? (
        <HappierLabel theme={props.theme}>
          {props.titleContent ?? props.title}
        </HappierLabel>
      ) : null}
      {props.entries.map((entry, index) => (
        <View
          key={`${entry.label}\u0000${index}`}
          testID={entry.testID}
          accessibilityLabel={entry.accessibilityLabel}
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: props.theme.spacing.small,
          }}
        >
          <HappierText style={{ color: props.theme.colors.secondaryText }}>
            {entry.labelContent ?? entry.label}
          </HappierText>
          <HappierText
            selectable
            style={{
              color:
                props.theme.colors[
                  HAPPIER_TONE_COLOR_TOKEN[entry.tone ?? 'neutral']
                ],
            }}
          >
            {entry.valueContent ?? entry.value}
          </HappierText>
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
  const nativeMinimumTouchTarget =
    useHappierNativeMinimumInteractiveTargetSize();
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
        ...(nativeMinimumTouchTarget === undefined
          ? {}
          : {
              minHeight: nativeMinimumTouchTarget,
              minWidth: nativeMinimumTouchTarget,
            }),
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
  const fillStyle: ViewStyle = {
    height: '100%',
    minWidth: props.minimumFillWidth,
    width: `${fillPercentage}%`,
    backgroundColor: props.fillColor ?? props.theme.colors.accent,
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
          {props.fillPattern === 'hatched' ? <HappierDataHatch theme={props.theme} /> : null}
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
    announce?: 'alert' | 'status' | 'none';
    accessibilityLiveRegion?: 'polite' | 'assertive';
  }>,
) {
  const paintColor = useHappierMaterialColorResolver();
  const isUrgent = isHappierBannerUrgent(props.tone);
  const color = props.theme.colors[HAPPIER_TONE_COLOR_TOKEN[props.tone]];
  const typography = useOptionalHappierUiTypography();
  const [narrow, setNarrow] = useState(false);
  const fullWidthAction =
    narrow && props.compactActionPlacement === 'full-width';
  const actionBelow = narrow || props.actionPlacement === 'below';
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
        const width = event.nativeEvent.layout.width;
        if (Number.isFinite(width) && width > 0)
          setNarrow(width < HAPPIER_PAGE_METRICS.rowStackBelowWidthPx);
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
