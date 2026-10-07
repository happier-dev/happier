import { useState, type ReactNode } from 'react';
import {
  Platform,
  View,
  type ViewStyle,
} from 'react-native';

import {
  useHappierNativeMinimumInteractiveTargetSize,
} from '../../environment/interactiveTarget.js';
import { useOptionalHappierUiTheme, useOptionalHappierUiTypography } from '../../environment/context.js';
import type { HappierUiTheme } from '../../environment/types.js';
import { HappierPressable } from '../interaction/Pressable.js';
import type { HappierFocusable, HappierLayoutChangeEvent, HappierStyleProp } from '../portableTypes.js';
import { HAPPIER_TONE_COLOR_TOKEN, type HappierTone } from '../semantics.js';
import { HappierText } from '../text/Text.js';
import { resolveHappierTypeRoleStyle } from '../text/typeRole.js';
import { HAPPIER_PRESS_FEEDBACK_V1 } from '../interaction/pressFeedback.js';
import { HAPPIER_PAGE_METRICS } from '../layout/pageMetrics.js';
import { resolveHappierPageTextStyle } from '../layout/pageText.js';

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

export function HappierHeading(props: Readonly<{
  children?: ReactNode;
  /** Private semantic focus binding supplied by the public Heading adapter. */
  controlRef?: (instance: HappierFocusable | null) => void;
  level: 1 | 2 | 3 | 4 | 5 | 6;
  theme?: HappierUiTheme;
  testID?: string;
}>) {
  // Three steps of the ramp, never one size for every level: the page heading
  // (1) takes the heading role, a pane or section heading (2) the title role,
  // and a subsection heading (3+) the label role, so a group heading never
  // reads as loudly as the heading of the pane it sits in.
  const role = props.level === 1 ? 'heading' as const : props.level === 2 ? 'title' as const : 'label' as const;
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
        ? { style: { ...resolveHappierTypeRoleStyle(role, theme, hostTypography), color: theme.colors.text } }
        : { variant: role === 'heading' ? 'title' as const : role })}
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
export function HappierLabel(props: Readonly<{
  children?: ReactNode;
  theme?: HappierUiTheme;
  testID?: string;
}>) {
  const hostTypography = useOptionalHappierUiTypography();
  return (
    <HappierText
      {...(props.theme
        ? { style: { ...resolveHappierTypeRoleStyle('label', props.theme, hostTypography), color: props.theme.colors.text } }
        : { variant: 'label' as const })}
      testID={props.testID}
    >
      {props.children}
    </HappierText>
  );
}

export function HappierDivider(props: Readonly<{
  color: string;
  accessibilityLabel?: string;
  testID?: string;
  style?: HappierStyleProp;
}>) {
  return (
    <View
      role="separator"
      accessibilityLabel={props.accessibilityLabel}
      testID={props.testID}
      style={[{ height: 1, alignSelf: 'stretch', backgroundColor: props.color }, props.style]}
    />
  );
}

export function HappierBadge(props: Readonly<{
  children?: ReactNode;
  color: string;
  backgroundColor: string;
  borderColor: string;
  radius: number;
  horizontalPadding: number;
  verticalPadding: number;
  testID?: string;
}>) {
  return (
    <View
      testID={props.testID}
      style={{
        alignSelf: 'flex-start',
        borderWidth: 1,
        borderColor: props.borderColor,
        backgroundColor: props.backgroundColor,
        borderRadius: props.radius,
        paddingHorizontal: props.horizontalPadding,
        paddingVertical: props.verticalPadding,
      }}
    >
      <HappierText variant="caption" style={{ color: props.color }}>{props.children}</HappierText>
    </View>
  );
}

export function HappierMetadata(props: Readonly<{
  title?: string;
  titleContent?: ReactNode;
  entries: readonly HappierMetadataEntry[];
  theme: HappierUiTheme;
  testID?: string;
}>) {
  return (
    <View role="group" accessibilityLabel={props.title} testID={props.testID} style={{ gap: props.theme.spacing.small }}>
      {props.title ? <HappierLabel theme={props.theme}>{props.titleContent ?? props.title}</HappierLabel> : null}
      {props.entries.map((entry, index) => (
        <View
          key={`${entry.label}\u0000${index}`}
          testID={entry.testID}
          accessibilityLabel={entry.accessibilityLabel}
          style={{ flexDirection: 'row', flexWrap: 'wrap', gap: props.theme.spacing.small }}
        >
          <HappierText style={{ color: props.theme.colors.secondaryText }}>{entry.labelContent ?? entry.label}</HappierText>
          <HappierText selectable style={{ color: props.theme.colors[HAPPIER_TONE_COLOR_TOKEN[entry.tone ?? 'neutral']] }}>{entry.valueContent ?? entry.value}</HappierText>
        </View>
      ))}
    </View>
  );
}

export function HappierLink(props: Readonly<{
  children?: ReactNode;
  label: string;
  disabled?: boolean;
  onPress: () => unknown;
  theme: HappierUiTheme;
  testID?: string;
}>) {
  const nativeMinimumTouchTarget = useHappierNativeMinimumInteractiveTargetSize();
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
        ...(nativeMinimumTouchTarget === undefined ? {} : {
          minHeight: nativeMinimumTouchTarget,
          minWidth: nativeMinimumTouchTarget,
        }),
        borderBottomWidth: state.focused ? 2 : 1,
        borderBottomColor: state.focused ? props.theme.colors.focus : props.theme.colors.accent,
        opacity: state.disabled ? 0.4 : state.pressed ? HAPPIER_PRESS_FEEDBACK_V1.opacity : 1,
      })}
    >
      <HappierText style={{ color: props.theme.colors.accent }}>{props.children}</HappierText>
    </HappierPressable>
  );
}

export function HappierProgress(props: Readonly<{
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
  height?: number;
  fillColor?: string;
  trackColor?: string;
  fillTestID?: string;
  minimumVisibleFraction?: number;
  minimumFillWidth?: number;
}>) {
  const percentage = resolveHappierProgressPercentage(props.value);
  const determinate = props.value !== undefined && Number.isFinite(props.value);
  const nativePointerEvents = Platform.OS === 'web' ? undefined : props.pointerEvents;
  const webPointerEventsStyle = Platform.OS === 'web' && props.pointerEvents
    ? { pointerEvents: props.pointerEvents }
    : undefined;
  const fillPercentage = resolveHappierProgressPercentage(props.value, { minimumVisible: props.minimumVisibleFraction });
  const fillStyle: ViewStyle = {
    height: '100%',
    minWidth: props.minimumFillWidth,
    width: `${fillPercentage}%`,
    backgroundColor: props.fillColor ?? props.theme.colors.accent,
    borderRadius: props.theme.radii.pill,
  };
  return (
    <View
      {...(props.semantics === 'none' ? {} : props.semantics === 'image' ? {
        role: 'img' as const,
        'aria-label': props.label,
        accessibilityLabel: props.label,
      } : {
        role: 'progressbar' as const,
        accessibilityRole: 'progressbar' as const,
        'aria-label': props.label,
        'aria-valuemin': 0,
        'aria-valuemax': 100,
        'aria-valuenow': determinate ? percentage : undefined,
        accessibilityLabel: props.label,
        accessibilityValue: determinate ? { min: 0, max: 100, now: percentage } : undefined,
      })}
      testID={props.testID}
      pointerEvents={nativePointerEvents}
      style={[{
          height: props.height ?? 8,
          overflow: 'hidden',
          borderRadius: props.theme.radii.pill,
          backgroundColor: props.trackColor ?? props.theme.colors.controlDisabled,
        }, props.style, webPointerEventsStyle]}
    >
      {props.segments !== undefined
        ? <View style={{ flexDirection: 'row', height: '100%' }}>
          {props.segments.map((segment, index) => (
            <View key={index} testID={props.testID === undefined ? undefined : `${props.testID}-segment-${index}`}
              style={{ height: '100%', width: `${resolveHappierProgressPercentage(segment.value, { indeterminate: 0 })}%`, backgroundColor: segment.color }} />
          ))}
        </View>
        : props.renderFill ? props.renderFill(percentage) : <View testID={props.fillTestID} style={fillStyle} />}
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
  const fraction = value === undefined || !Number.isFinite(value)
    ? indeterminate
    : Math.max(minimumVisible, Math.min(1, value));
  return Math.round(fraction * 100);
}

export function isHappierBannerUrgent(tone: HappierTone): boolean {
  return tone === 'danger' || tone === 'warning';
}

export function HappierBanner(props: Readonly<{
  title: string;
  description?: string;
  tone: HappierTone;
  action?: ReactNode;
  /** Compact call-to-action below the whole banner identity, not only its text column. */
  compactActionPlacement?: 'full-width';
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
}>) {
  const isUrgent = isHappierBannerUrgent(props.tone);
  const color = props.theme.colors[HAPPIER_TONE_COLOR_TOKEN[props.tone]];
  const typography = useOptionalHappierUiTypography();
  const [narrow, setNarrow] = useState(false);
  const fullWidthAction = narrow && props.compactActionPlacement === 'full-width';
  const role = props.announce === 'none' ? undefined : props.announce ?? (isUrgent ? 'alert' : 'status');
  const decorationPointerEvents = Platform.OS === 'web' ? undefined : 'none';
  const decorationStyle: ViewStyle = {
    position: 'absolute', top: 0, right: 0, bottom: 0, left: 0,
    borderRadius: HAPPIER_PAGE_METRICS.sheetRadiusPx,
    ...(Platform.OS === 'web' ? { pointerEvents: 'none' } : {}),
  };
  const banner = (
    <View
      role={role}
      accessibilityRole={role === 'alert' ? 'alert' : undefined}
      accessibilityLiveRegion={props.accessibilityLiveRegion ?? (role === undefined ? undefined : role === 'alert' ? 'assertive' : 'polite')}
      testID={props.testID}
      onLayout={(event) => {
        const width = event.nativeEvent.layout.width;
        if (Number.isFinite(width) && width > 0) setNarrow(width < HAPPIER_PAGE_METRICS.rowStackBelowWidthPx);
        props.onLayout?.(event);
      }}
      style={[{
        flexDirection: 'row',
        alignItems: narrow ? 'flex-start' : 'center',
        borderRadius: HAPPIER_PAGE_METRICS.sheetRadiusPx,
        paddingVertical: 12,
        paddingLeft: HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx,
        paddingRight: 12,
        gap: HAPPIER_PAGE_METRICS.rowLeadingGapPx,
        backgroundColor: props.backgroundColor ?? props.theme.colors.surface,
      }, props.style]}
    >
      {props.backgroundColor ? null : <View pointerEvents={decorationPointerEvents}
        style={[decorationStyle, { backgroundColor: color, opacity: 0.08 }]} />}
      <View pointerEvents={decorationPointerEvents}
        style={[decorationStyle, { borderWidth: 1, borderColor: props.borderColor ?? color, opacity: 0.32 }]} />
      {props.icon ? <View style={{ width: HAPPIER_PAGE_METRICS.rowLeadingColumnPx, alignItems: 'center', justifyContent: 'center' }}>{props.icon}</View> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        {props.titleContent ?? <HappierText style={{ ...resolveHappierPageTextStyle('rowTitle', typography), color: props.theme.colors.text }}>{props.title}</HappierText>}
        {props.descriptionContent ?? (props.description ? <HappierText style={{ ...resolveHappierPageTextStyle('rowDescription', typography), color: props.theme.colors.secondaryText, marginTop: 2 }}>{props.description}</HappierText> : null)}
        {props.details}
        {props.action && narrow && !fullWidthAction ? <View style={{ alignItems: 'flex-start', marginTop: 10 }}>{props.action}</View> : null}
      </View>
      {props.action && !narrow ? <View style={{ flexShrink: 0 }}>{props.action}</View> : null}
      {props.dismiss ? <View style={{ alignSelf: 'flex-start', marginTop: -4, marginRight: -4 }}>{props.dismiss}</View> : null}
    </View>
  );
  return fullWidthAction ? <View>{banner}<View style={{ width: '100%', marginTop: HAPPIER_PAGE_METRICS.rowLeadingGapPx }}>{props.action}</View></View> : banner;
}
