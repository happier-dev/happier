import { useRef, type ReactElement, type ReactNode } from 'react';
import { View } from 'react-native';

import type { HappierPortableStyle } from '../portableTypes.js';
import type { HappierCapsuleColors, HappierCapsuleHost } from './capsuleHost.js';

type HappierStatusCapsuleContent = Readonly<{
  /** The one sentence ("This page is taking a while", "Showing the last frame · reconnecting"). */
  text: string;
  /** Work is under way (a reconnect, a slow load): a spinner leads the sentence. */
  busy?: boolean;
  /** The one way out, beside the sentence ("Open in your browser"). */
  action?: Readonly<{ label: string; onPress: () => void }>;
}>;

export type HappierStatusCapsuleProps = HappierStatusCapsuleContent & Readonly<{
  /**
   * Whether something is not normal right now. A caller that keeps the capsule mounted and flips this
   * gets the leave as well as the arrival (the stream coming back lifts the capsule away instead of
   * blinking it off); while it leaves it keeps its last words and takes no presses.
   */
  visible?: boolean;
  /**
   * `dock` (default) drops it over the top edge of a page or a stream. `inline` stands in flow among
   * other floating capsules: the identity a floating viewer names (its Machine, with a status dot).
   */
  placement?: 'dock' | 'inline';
  /** A mark before the sentence (a status dot); never a second sentence. */
  leading?: ReactNode;
  colors: HappierCapsuleColors;
  host: HappierCapsuleHost;
  testID: string;
}>;

const DOCK_STYLE: HappierPortableStyle = {
  position: 'absolute',
  top: 12,
  left: 12,
  right: 12,
  alignItems: 'center',
  zIndex: 3,
  pointerEvents: 'box-none',
};

const CAPSULE_STYLE = {
  flexDirection: 'row',
  alignItems: 'center',
  gap: 8,
  minHeight: 32,
  paddingLeft: 12,
  paddingRight: 4,
  paddingVertical: 3,
} as const;

const CAPSULE_TEXT_ONLY_STYLE = { paddingRight: 12 } as const;

const TEXT_STYLE: HappierPortableStyle = { flexShrink: 1 };

/**
 * One small status capsule docked under the top edge of a page or a stream, shown only while something
 * is not normal. Healthy is quiet: when the page loads or the stream is live the caller stops showing
 * it. It never covers the content with a card, so what is already on screen stays readable; the one
 * optional action is the way out. Extracted from Happier's browser frame status capsule with its
 * geometry intact; it drops in from the frame's top edge and lifts back into it through the host dock.
 */
export function HappierStatusCapsule(props: HappierStatusCapsuleProps): ReactElement | null {
  const { host } = props;
  const visible = props.visible ?? true;
  const lastShownRef = useRef<HappierStatusCapsuleContent>(props);
  if (visible) lastShownRef.current = props;

  const renderCapsule = (leaving: boolean): ReactNode => {
    const shown = lastShownRef.current;
    const testID = leaving ? `${props.testID}-leaving` : props.testID;
    return (
      <host.Surface elevation="low" testID={testID}>
        <View
          style={[CAPSULE_STYLE, shown.action ? null : CAPSULE_TEXT_ONLY_STYLE]}
          accessibilityRole="summary"
          accessibilityLiveRegion="polite"
          aria-live="polite"
        >
          {shown.busy ? <host.Spinner color={props.colors.secondaryText} /> : null}
          {props.leading ?? null}
          <host.Text role="meta" color={props.colors.text} numberOfLines={1} style={TEXT_STYLE}>{shown.text}</host.Text>
          {shown.action ? (
            <host.Button
              emphasis="secondary"
              title={shown.action.label}
              onPress={shown.action.onPress}
              testID={`${testID}-action`}
            />
          ) : null}
        </View>
      </host.Surface>
    );
  };

  if (props.placement === 'inline') return visible ? <>{renderCapsule(false)}</> : null;
  if (host.Dock) {
    return <host.Dock visible={visible} edge="top" style={DOCK_STYLE}>{renderCapsule}</host.Dock>;
  }
  if (!visible) return null;
  return <View style={DOCK_STYLE}>{renderCapsule(false)}</View>;
}
