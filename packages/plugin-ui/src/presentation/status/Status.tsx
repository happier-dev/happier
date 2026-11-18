import { cloneElement, createContext, isValidElement, useContext, useState, type ReactNode } from 'react';
import { View, type TextStyle } from 'react-native';

import type { HappierUiAccessibility, HappierUiTheme } from '../../environment/types.js';
import type { HappierAccessibilityLiveRegion, HappierFocusable, HappierPortableStyle } from '../portableTypes.js';
import { useOptionalHappierUiAccessibility } from '../../environment/context.js';
import { HAPPIER_TONE_COLOR_TOKEN, type HappierTone } from '../semantics.js';
import { HappierText } from '../text/Text.js';
import { useHappierTypeRoleStyle } from '../text/typeRole.js';
import { HappierStatusDot } from './StatusDot.js';
import { HAPPIER_PAGE_METRICS, readHappierVisibleLayoutWidth } from '../layout/pageMetrics.js';
import { HAPPIER_SMALL_BUTTON_HEIGHT } from '../interaction/buttonChrome.js';

export type HappierStatusProps = Readonly<{
  /** Visible status name. A core adapter may supply its scaled text primitive. */
  label: ReactNode;
  /** Optional current value below the status name. */
  value?: ReactNode;
  tone: HappierTone;
  /** Resolved semantic theme facts supplied by the current host. */
  theme: HappierUiTheme;
  /**
   * Resolved host contrast fact for consumers that do not mount the executable
   * Plugin UI environment (the declarative renderer). An installed environment
   * remains the source for ordinary Plugin UI surfaces.
   */
  contrast?: HappierUiAccessibility['contrast'];
  /** Whether the status is currently active/in flight. */
  isPulsing?: boolean;
  presentation?: 'notice' | 'inline';
  indicator?: boolean;
  leading?: ReactNode;
  /** Host-owned retained-surface activity; false pauses native pulse work. */
  animationEnabled?: boolean;
  /** Private semantic focus binding supplied by the public Status adapter. */
  controlRef?: (instance: HappierFocusable | null) => void;
  /**
   * The next action for a notice ("… cannot be changed · Retry"). It sits
   * beside the sentence, which wraps rather than truncating, and outside the
   * live region, so pressing it announces nothing new.
   */
  action?: ReactNode;
  testID?: string;
  /** Hosts control whether a dynamically changing status should announce. */
  accessibilityLiveRegion?: HappierAccessibilityLiveRegion;
  /**
   * The complete meaning of this status, in words, for the one status region.
   *
   * Tone is a colour. An adapter whose vocabulary lets the semantic state live
   * in `tone` while `label`/`value` stay neutral supplies the composed wording
   * here, so assistive technology receives what a sighted user sees. The public
   * executable `Status` already requires `label` to say it, and passes nothing.
   */
  accessibilityLabel?: string;
}>;

function textStyle(role: HappierPortableStyle, color: string): HappierPortableStyle {
  return { ...role, color };
}

/**
 * A row's end asks for the compact status (UI refinements 2026-11-16, revised 2026-11-18 10:40Z): a column row's name is
 * what tells rows apart, so a neutral inline status in its trailing slot draws only its tone dot and keeps its words as
 * its accessible name, while a state that needs the person keeps its words beside the dot ("● Deploy failed", as the
 * labs draw). The slot's owner provides it (core `CollectionNavigationRow`); a status standing on its own keeps its words.
 */
export const HappierStatusCompactContext = createContext(false);

/** The tones a state needs the person in: they keep their words in a compact row end. */
const COMPACT_SPEAKING_TONES: ReadonlySet<HappierStatusProps['tone']> = new Set(['danger', 'warning', 'attention']);

/**
 * The shared semantic status row for executable Plugin UI and declarative
 * rendering. It owns the status role, announcement policy, tone-to-dot mapping
 * and row layout. A core adapter may pass its existing scaled `Text` elements
 * as slots, while string slots use the portable text owner directly.
 */
export function HappierStatus(props: HappierStatusProps) {
  const environmentAccessibility = useOptionalHappierUiAccessibility();
  const inline = props.presentation === 'inline';
  const compact = useContext(HappierStatusCompactContext) && inline && !COMPACT_SPEAKING_TONES.has(props.tone);
  const accessibilityLiveRegion = props.accessibilityLiveRegion ?? 'polite';
  const ariaLive = accessibilityLiveRegion === 'none' ? 'off' : accessibilityLiveRegion;
  const highContrast = (props.contrast ?? environmentAccessibility?.contrast) === 'high';
  // A notice whose action does not fit beside its words on a narrow measure (a phone) takes the action beneath
  // them, as a banner does; beside a wrapped block it would crowd the sentence it belongs to.
  const [actionBelow, setActionBelow] = useState(false);
  const toneColor = props.theme.colors[HAPPIER_TONE_COLOR_TOKEN[props.tone]];
  // A status line is quiet metadata beside the content it describes: body for
  // its name, caption for its value — never the row-title weight of a label.
  // The dot carries the tone; the value (the reason or the time) stays quiet
  // secondary ink, so a warning reads as one amber mark, not an amber paragraph.
  const bodyStyle = useHappierTypeRoleStyle('meta', props.theme);
  const captionStyle = useHappierTypeRoleStyle('micro', props.theme);
  const label = renderStatusText(
    props.label,
    textStyle(bodyStyle, inline ? props.theme.colors.secondaryText : props.theme.colors.text),
    false,
    undefined,
    inline ? 1 : undefined,
  );
  // With an action, the dot and the action both ride the label's first line, never the middle of a two-line
  // notice. Beside the words, that line is centred on the action's small control (the action is a small Button),
  // so the sentence and its press share one baseline and the control never hangs below the text.
  const labelLineHeightPx = typeof bodyStyle.lineHeight === 'number' ? bodyStyle.lineHeight : undefined;
  const firstLineSlot = labelLineHeightPx === undefined || props.action === undefined || props.action === null
    ? { alignSelf: 'center' as const }
    : { height: labelLineHeightPx, justifyContent: 'center' as const };
  const besideActionInsetPx = labelLineHeightPx === undefined
    ? 0
    : Math.max(0, (HAPPIER_SMALL_BUTTON_HEIGHT - labelLineHeightPx) / 2);
  const value = props.value === undefined
    ? null
    : renderStatusText(
      props.value,
      textStyle(captionStyle, highContrast ? props.theme.colors.text : props.theme.colors.secondaryText),
      true,
      highContrast ? { color: props.theme.colors.text } : undefined,
    );

  if (compact) {
    const name = props.accessibilityLabel ?? (typeof props.label === 'string' ? props.label : undefined);
    return (
      <View
        testID={props.testID}
        {...(name === undefined ? {} : { accessibilityLabel: name, 'aria-label': name })}
        style={{ flexShrink: 0, flexDirection: 'row', alignItems: 'center' }}
      >
        <HappierStatusDot color={toneColor} isPulsing={props.isPulsing} animationEnabled={props.animationEnabled}
          {...(highContrast ? { size: 8, style: { borderWidth: 1, borderColor: props.theme.colors.text } } : {})} />
      </View>
    );
  }

  const region = (
    <View
      ref={props.controlRef}
      role={inline ? undefined : 'status'}
      tabIndex={props.controlRef ? -1 : undefined}
      testID={props.testID}
      {...(props.accessibilityLabel === undefined
        ? {}
        : { accessibilityLabel: props.accessibilityLabel, 'aria-label': props.accessibilityLabel })}
      accessibilityLiveRegion={inline ? undefined : accessibilityLiveRegion}
      aria-live={inline ? undefined : ariaLive}
      style={inline
        // Inline, it is a row's quiet end: it gives way in the row (its word truncates) before what follows it.
        ? { flexShrink: 1, minWidth: 0, maxWidth: '100%', flexDirection: 'row', alignItems: 'center', gap: props.theme.spacing.xsmall }
        : props.action === undefined || props.action === null
        ? { flexDirection: 'row', alignItems: 'center', gap: props.theme.spacing.small }
        : actionBelow
        ? { alignSelf: 'stretch', flexDirection: 'row', alignItems: 'flex-start', gap: props.theme.spacing.small }
        : { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'flex-start', gap: props.theme.spacing.small,
          paddingTop: besideActionInsetPx }}
    >
      {props.leading}
      {props.indicator === false ? null : <View style={firstLineSlot}><HappierStatusDot
        color={toneColor}
        isPulsing={props.isPulsing}
        animationEnabled={props.animationEnabled}
        {...(highContrast ? {
          size: 8,
          style: { borderWidth: 1, borderColor: props.theme.colors.text },
        } : {})}
      /></View>}
      <View style={inline
        ? { flexShrink: 1, minWidth: 0 }
        : { flex: 1, minWidth: 0, gap: props.theme.spacing.xsmall }}>
        {label}
        {value}
      </View>
    </View>
  );
  if (props.action === undefined || props.action === null) return region;
  return (
    <View
      onLayout={(event) => {
        const width = readHappierVisibleLayoutWidth(event.nativeEvent.layout.width);
        if (width !== null) setActionBelow(width < HAPPIER_PAGE_METRICS.rowStackBelowWidthPx);
      }}
      style={actionBelow
        ? { alignItems: 'flex-start', gap: props.theme.spacing.xsmall }
        : { flexDirection: 'row', alignItems: 'flex-start', gap: props.theme.spacing.small }}
    >
      {region}
      {/* Beside the words, the action rides the sentence's first line ("acme/ledger could not be read · Manage
          sources"), never the middle of a two-line notice, where it reads as a line of its own. */}
      {props.action}
    </View>
  );
}

function renderStatusText(
  value: ReactNode,
  style: HappierPortableStyle,
  selectable = false,
  elementStyleOverride?: HappierPortableStyle,
  numberOfLines?: number,
): ReactNode {
  if (isValidElement<{ style?: unknown }>(value)) {
    return elementStyleOverride === undefined
      ? value
      : cloneElement(value, { style: [value.props.style, elementStyleOverride] });
  }
  return <HappierText selectable={selectable} numberOfLines={numberOfLines} style={style}>{value}</HappierText>;
}
