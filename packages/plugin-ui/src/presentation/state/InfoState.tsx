import { isValidElement, type ReactNode } from 'react';
import { View } from 'react-native';

import { HappierText } from '../text/Text.js';
import type { HappierTone } from '../semantics.js';

/**
 * The single implementation owner for Happier's centered informational state
 * (UI-T27) — the shape behind "nothing here yet", "still loading" and "that
 * failed".
 *
 * Extracted from `apps/ui/sources/components/ui/lists/CenteredInfoTile.tsx` and
 * `apps/ui/sources/components/ui/empty/EmptyState.tsx`, whose measured layout it
 * preserves exactly: the full-width centered column, the 32/16 padding pair, the
 * 520pt readable measure, and the action slot's 16pt offset.
 *
 * **Typography stays with its owner.** A slot given a rendered element is
 * rendered as-is, so Happier core keeps supplying Unistyles typography through
 * its own `Text` adapter — which is what keeps the `uiFontScale` local setting
 * applying (§3.10.8). A slot given a plain string is rendered through the shared
 * {@link HappierText} against the environment theme, which is what a plugin
 * surface — with no Unistyles — needs.
 */
const INFO_STATE_MEASURE = 520;
const INFO_STATE_VERTICAL_PADDING = 32;
const INFO_STATE_HORIZONTAL_PADDING = 16;
const INFO_STATE_TITLE_GAP = 6;
const INFO_STATE_ACTION_GAP = 16;

export type HappierInfoTileProps = Readonly<{
  /** Leading glyph, already themed by the caller. */
  icon?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  /** Semantic colour for string slots. Ignored for slots the caller renders itself. */
  tone?: HappierTone;
  paddingHorizontal?: number;
}>;

export type HappierInfoStateProps = Readonly<{
  /** The informational body — normally a {@link HappierInfoTile}. */
  children?: ReactNode;
  /** Call-to-action rendered below the body. */
  action?: ReactNode;
  testID?: string;
  actionTestID?: string;
  accessibilityRole?: 'alert';
  accessibilityLiveRegion?: 'none' | 'polite' | 'assertive';
  busy?: boolean;
}>;

function renderSlot(
  slot: ReactNode,
  semantic: Readonly<{ variant: 'title' | 'body'; tone: HappierTone; gap: number }>,
): ReactNode {
  if (slot === null || slot === undefined || slot === false || slot === '') return null;
  if (isValidElement(slot)) return slot;

  return (
    <HappierText
      variant={semantic.variant}
      tone={semantic.tone}
      style={{ textAlign: 'center', marginBottom: semantic.gap }}
    >
      {slot}
    </HappierText>
  );
}

/**
 * The centered icon / title / description column.
 *
 * Happier core's `CenteredInfoTile` is this component; so is the body of every
 * plugin loading, empty and error state.
 */
export function HappierInfoTile({
  icon,
  title,
  description,
  tone,
  paddingHorizontal,
}: HappierInfoTileProps) {
  return (
    <View
      style={{
        width: '100%',
        alignItems: 'center',
        paddingVertical: INFO_STATE_VERTICAL_PADDING,
        paddingHorizontal: paddingHorizontal ?? INFO_STATE_HORIZONTAL_PADDING,
      }}
    >
      {icon}
      <View style={{ width: '100%', maxWidth: INFO_STATE_MEASURE }}>
        {renderSlot(title, { variant: 'title', tone: tone ?? 'neutral', gap: INFO_STATE_TITLE_GAP })}
        {renderSlot(description, { variant: 'body', tone: 'secondary', gap: 0 })}
      </View>
    </View>
  );
}

/**
 * A {@link HappierInfoTile} plus the call-to-action slot beneath it.
 *
 * Happier core's `EmptyState` is this component wrapped around
 * `CenteredInfoTile`; the plugin adapters wrap it around a `HappierInfoTile`.
 * Keeping the tile a child rather than a prop is what lets core keep its own
 * tile adapter — which six other core surfaces already render — instead of
 * acquiring a second one.
 */
export function HappierInfoState({
  children,
  action,
  testID,
  actionTestID,
  accessibilityRole,
  accessibilityLiveRegion,
  busy,
}: HappierInfoStateProps) {
  return (
    <View
      testID={testID}
      role={accessibilityRole}
      accessibilityRole={accessibilityRole}
      accessibilityLiveRegion={accessibilityLiveRegion}
      accessibilityState={busy === true ? { busy: true } : undefined}
      aria-live={accessibilityLiveRegion === 'none' ? 'off' : accessibilityLiveRegion}
      aria-busy={busy || undefined}
      style={{ width: '100%', alignItems: 'center' }}
    >
      {children}
      {action !== null && action !== undefined ? (
        <View
          testID={actionTestID}
          style={{
            width: '100%',
            maxWidth: INFO_STATE_MEASURE,
            alignItems: 'center',
            marginTop: INFO_STATE_ACTION_GAP,
          }}
        >
          {action}
        </View>
      ) : null}
    </View>
  );
}
