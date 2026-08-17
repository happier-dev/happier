import type { ReactNode } from 'react';
import {
  Platform,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import {
  useHappierNativeMinimumInteractiveTargetSize,
} from '../../environment/interactiveTarget.js';
import type { HappierUiTheme } from '../../environment/types.js';
import { HappierPressable } from '../interaction/Pressable.js';
import type { HappierLayoutChangeEvent, HappierStyleProp } from '../portableTypes.js';
import { HAPPIER_TONE_COLOR_TOKEN, type HappierTone } from '../semantics.js';
import { HappierText } from '../text/Text.js';

export type HappierMetadataEntry = Readonly<{
  label: string;
  value: string;
  tone?: HappierTone;
  accessibilityLabel?: string;
  testID?: string;
}>;

export function HappierHeading(props: Readonly<{
  children?: ReactNode;
  /** Private semantic focus binding supplied by the public Heading adapter. */
  controlRef?: (instance: unknown | null) => void;
  level: 1 | 2 | 3 | 4 | 5 | 6;
  theme?: HappierUiTheme;
  testID?: string;
}>) {
  return (
    <HappierText
      ref={props.controlRef}
      accessibilityRole="header"
      aria-level={props.level}
      tabIndex={props.controlRef ? -1 : undefined}
      {...(props.theme
        ? { style: {
            fontSize: props.theme.typography.title.fontSize,
            lineHeight: props.theme.typography.title.lineHeight,
            fontWeight: props.theme.typography.title.fontWeight as TextStyle['fontWeight'],
            color: props.theme.colors.text,
          } }
        : { variant: 'title' as const })}
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
  return (
    <HappierText
      {...(props.theme
        ? { style: {
            fontSize: props.theme.typography.label.fontSize,
            lineHeight: props.theme.typography.label.lineHeight,
            fontWeight: props.theme.typography.label.fontWeight as TextStyle['fontWeight'],
            color: props.theme.colors.text,
          } }
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
  entries: readonly HappierMetadataEntry[];
  theme: HappierUiTheme;
  testID?: string;
}>) {
  return (
    <View role="group" accessibilityLabel={props.title} testID={props.testID} style={{ gap: props.theme.spacing.small }}>
      {props.title ? <HappierLabel theme={props.theme}>{props.title}</HappierLabel> : null}
      {props.entries.map((entry, index) => (
        <View
          key={`${entry.label}\u0000${index}`}
          testID={entry.testID}
          accessibilityLabel={entry.accessibilityLabel}
          style={{ flexDirection: 'row', flexWrap: 'wrap', gap: props.theme.spacing.small }}
        >
          <HappierText style={{ color: props.theme.colors.secondaryText }}>{entry.label}</HappierText>
          <HappierText selectable style={{ color: props.theme.colors[HAPPIER_TONE_COLOR_TOKEN[entry.tone ?? 'neutral']] }}>{entry.value}</HappierText>
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
        opacity: state.disabled ? 0.4 : state.pressed ? 0.7 : 1,
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
}>) {
  const percentage = resolveHappierProgressPercentage(props.value);
  const determinate = props.value !== undefined && Number.isFinite(props.value);
  const nativePointerEvents = Platform.OS === 'web' ? undefined : props.pointerEvents;
  const webPointerEventsStyle = Platform.OS === 'web' && props.pointerEvents
    ? { pointerEvents: props.pointerEvents }
    : undefined;
  const fillStyle: ViewStyle = {
    height: '100%',
    width: `${percentage ?? 35}%`,
    backgroundColor: props.theme.colors.accent,
    borderRadius: props.theme.radii.pill,
  };
  return (
    <View
      role="progressbar"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={determinate ? percentage : undefined}
      accessibilityLabel={props.label}
      accessibilityValue={determinate ? { min: 0, max: 100, now: percentage } : undefined}
      testID={props.testID}
      pointerEvents={nativePointerEvents}
      style={[{
          height: 8,
          overflow: 'hidden',
          borderRadius: props.theme.radii.pill,
          backgroundColor: props.theme.colors.controlDisabled,
        }, props.style, webPointerEventsStyle]}
    >
      {props.renderFill ? props.renderFill(percentage) : <View style={fillStyle} />}
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
  theme: HappierUiTheme;
  testID?: string;
  style?: HappierStyleProp;
  onLayout?: (event: HappierLayoutChangeEvent) => void;
  renderContent?: (input: Readonly<{ color: string; urgent: boolean }>) => ReactNode;
  /** Host adapter supplies product placement/chrome while this owner retains semantics. */
  unstyled?: boolean;
}>) {
  const isUrgent = isHappierBannerUrgent(props.tone);
  const color = props.theme.colors[HAPPIER_TONE_COLOR_TOKEN[props.tone]];
  return (
    <View
      role={isUrgent ? 'alert' : 'status'}
      accessibilityLiveRegion={isUrgent ? 'assertive' : 'polite'}
      testID={props.testID}
      onLayout={props.onLayout}
      style={[props.unstyled ? undefined : {
        borderWidth: 1,
        borderColor: color,
        borderRadius: props.theme.radii.panel,
        padding: props.theme.spacing.medium,
        gap: props.theme.spacing.small,
        backgroundColor: props.theme.colors.elevatedSurface,
      }, props.style]}
    >
      {props.renderContent ? props.renderContent({ color, urgent: isUrgent }) : (
        <>
          <HappierText variant="label" style={{ color }}>{props.title}</HappierText>
          {props.description ? <HappierText tone="secondary">{props.description}</HappierText> : null}
          {props.action}
        </>
      )}
    </View>
  );
}
