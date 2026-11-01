import type { ReactElement } from 'react';
import { View } from 'react-native';

import { happierFocusRingStyle } from '../presentation/interaction/focusVisible.js';
import { HappierPressable } from '../presentation/interaction/Pressable.js';
import {
  HappierSpinner,
  iconMatchedSpinnerSize,
} from '../presentation/feedback/Spinner.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { PluginUiIconGlyph } from './Icon.js';
import { usePluginTheme } from './PluginUiProvider.js';
import { Text } from './Text.js';

export type CheckboxMarkState = 'checked' | 'unchecked' | 'mixed';
export type CheckboxSize = 'regular' | 'compact';

/** The mark's box per row rhythm, the same two sizes the host's own checkbox mark draws at. */
export const HAPPIER_CHECKBOX_MARK_SIZE_PX: Readonly<
  Record<CheckboxSize, number>
> = Object.freeze({ regular: 18, compact: 16 });

export type CheckboxProps = Readonly<{
  /**
   * `mixed` is a group that is partly checked; pressing it checks the whole group. `null` is not known
   * yet: the box keeps its place, draws nothing and is hidden from assistive technology.
   */
  checked: boolean | 'mixed' | null;
  onChange: (checked: boolean) => void;
  /** Words beside the box ("Viewed"). Without them, `accessibilityLabel` is required to name the box. */
  label?: string;
  /** The accessible name when it should say more than the visible label ("Viewed: confirm.ts"). */
  accessibilityLabel?: string;
  disabled?: boolean;
  /**
   * The change is being saved elsewhere: the box shows a spinner and announces itself busy until its
   * owner settles. In a pressable row, place the checkbox outside the row's press (`Item`'s
   * `accessoryOutsidePressable`) so a press on a busy box never reaches the row.
   */
  pending?: boolean;
  size?: CheckboxSize;
  testID?: string;
}>;

/**
 * The checkbox mark of plugin-ui and plugin code: the host's own mark when it supplies one (the same
 * mark as its list and tree rows), otherwise a drawn box. Decorative: the control around it owns the
 * press, name and checked state.
 */
export function HappierCheckboxMark(
  props: Readonly<{ state: CheckboxMarkState; size?: CheckboxSize }>,
): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  const theme = usePluginTheme();
  const size = props.size ?? 'regular';
  if (host?.renderCheckboxMark)
    return <>{host.renderCheckboxMark({ state: props.state, size })}</>;
  const box = HAPPIER_CHECKBOX_MARK_SIZE_PX[size];
  // A glyph's box is inset in its em square; the drawn box takes the same share of it.
  const inner = Math.round(box * 0.72);
  const filled = props.state !== 'unchecked';
  return (
    <View
      aria-hidden
      pointerEvents="none"
      style={{
        width: box,
        height: box,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <View
        style={{
          width: inner,
          height: inner,
          borderRadius: theme.radii.small,
          borderWidth: filled ? 0 : 1.5,
          borderColor: theme.colors.mutedText,
          backgroundColor: filled ? theme.colors.text : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {props.state === 'checked' ? (
          <PluginUiIconGlyph
            name="check"
            size={inner - 2}
            color={theme.colors.surface}
          />
        ) : props.state === 'mixed' ? (
          <View
            style={{
              width: inner / 2,
              height: 1.5,
              backgroundColor: theme.colors.surface,
            }}
          />
        ) : null}
      </View>
    </View>
  );
}

/**
 * A checkbox for plugin surfaces: one labelled control with the host's checkbox look. It is a fact
 * the person sets directly (Viewed, Include), so it changes at once with no motion of its own; a
 * change saved elsewhere shows `pending` in the box until its owner settles.
 */
export function Checkbox(props: CheckboxProps): ReactElement {
  const theme = usePluginTheme();
  const size = props.size ?? 'regular';
  const box = HAPPIER_CHECKBOX_MARK_SIZE_PX[size];
  const body = (focused: boolean, mark: ReactElement | null) => (
    <View style={{
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.small / 2,
      paddingHorizontal: theme.spacing.small / 4,
      borderRadius: theme.radii.small,
      ...happierFocusRingStyle({ visible: focused, color: theme.colors.focus }),
    }}>
      <View style={{ width: box, height: box, alignItems: 'center', justifyContent: 'center' }}>{mark}</View>
      {props.label === undefined ? null : <Text variant="meta" tone="secondary" numberOfLines={1} value={props.label} />}
    </View>
  );
  if (props.checked === null) {
    // Not known yet: the control keeps its place so nothing moves when the answer arrives, and says nothing.
    return (
      <View testID={props.testID ? `${props.testID}-unknown` : undefined} aria-hidden
        importantForAccessibility="no-hide-descendants" style={{ opacity: 0, pointerEvents: 'none' }}>
        {body(false, null)}
      </View>
    );
  }
  const checked = props.checked;
  const state: CheckboxMarkState = checked === 'mixed' ? 'mixed' : checked ? 'checked' : 'unchecked';
  return (
    <HappierPressable
      testID={props.testID}
      accessibilityRole="checkbox"
      checked={checked}
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      disabled={props.disabled}
      busy={props.pending === true}
      onPress={(event) => {
        // A checkbox inside a pressable row is its own control: the row never receives its press.
        (event as { stopPropagation?: () => void } | undefined)?.stopPropagation?.();
        props.onChange(checked !== true);
      }}
      style={{ opacity: props.disabled ? 0.4 : 1 }}
    >
      {(pressState) => body(pressState.focused, props.pending
        ? (
          <View testID={props.testID ? `${props.testID}-pending` : undefined}>
            <HappierSpinner size={iconMatchedSpinnerSize(box)} color={theme.colors.secondaryText} />
          </View>
        )
        : <HappierCheckboxMark state={state} size={size} />)}
    </HappierPressable>
  );
}
