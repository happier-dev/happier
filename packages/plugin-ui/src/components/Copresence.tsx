import { useMemo, type ReactElement, type ReactNode } from 'react';
import { View } from 'react-native';

import type { PluginUiThemeV1 } from '@happier-dev/plugin-sdk/ui';

import { useOptionalHappierUiAccessibility, useOptionalHappierUiPalette } from '../environment/context.js';
import {
  HAPPIER_INSTANT_AGENT_CURSOR_MOTION,
  HappierAgentCursor,
  type HappierAgentPageRect,
  type HappierAgentPoint,
  type HappierAgentTarget,
} from '../presentation/copresence/AgentCursor.js';
import {
  HappierPresenceCapsule,
  type HappierPresence,
  type HappierPresenceCapsulePlacement,
  type HappierPresenceCapsuleProps,
} from '../presentation/copresence/PresenceCapsule.js';
import { HappierSpinner } from '../presentation/feedback/Spinner.js';
import type { HappierCapsuleColors, HappierCapsuleHost, HappierSurfaceGlyph } from '../presentation/status/capsuleHost.js';
import { HappierStatusCapsule } from '../presentation/status/StatusCapsule.js';
import { HappierText } from '../presentation/text/Text.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { Button } from './Button.js';
import { usePluginTheme, usePluginTranslation, type PluginTranslate } from './PluginUiProvider.js';

const GLYPH_ICON: Record<HappierSurfaceGlyph, string> = {
  hand: 'hand',
  warning: 'warning',
  sparkle: 'sparkle',
  pointer: 'navigation-arrow',
};

/** The capsule's colour roles from the projected theme (the mark plate takes the host's segment track). */
function useCapsuleColors(theme: PluginUiThemeV1): HappierCapsuleColors {
  const palette = useOptionalHappierUiPalette();
  return useMemo(() => ({
    text: theme.colors.text,
    secondaryText: theme.colors.secondaryText,
    warning: theme.colors.warning,
    stripBackground: theme.colors.surface,
    stripBorder: theme.colors.divider,
  }), [palette?.segmentTrack, theme]);
}

function PlainCapsuleSurface(props: Readonly<{ testID: string; children: ReactNode }>): ReactElement {
  const theme = usePluginTheme();
  return (
    <View
      testID={props.testID}
      style={{
        borderRadius: theme.radii.pill,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.elevatedSurface,
      }}
    >
      {props.children}
    </View>
  );
}

function PlainCapsuleGlyph(props: Readonly<{ glyph: HappierSurfaceGlyph; color: string; size: number }>): ReactElement | null {
  const presentationHost = useOptionalPluginUiPresentationHost();
  return <>{presentationHost?.renderIcon({ name: GLYPH_ICON[props.glyph], size: props.size, color: props.color }) ?? null}</>;
}

/**
 * Where the host supplies no leaves (a hosted-web realm), a plain solid capsule: the projected theme's
 * surface and type metrics, Happier's plugin button and spinner, and the host's icons when it renders
 * them. Changes land at once.
 */
const PLAIN_CAPSULE_HOST: HappierCapsuleHost = {
  Surface: PlainCapsuleSurface,
  Text: (props) => (
    <HappierText
      variant={props.role === 'title' ? 'label' : props.role === 'meta' ? 'micro' : undefined}
      numberOfLines={props.numberOfLines}
      style={[props.style, props.color ? { color: props.color } : null]}
    >
      {props.children}
    </HappierText>
  ),
  Button: (props) => (
    <Button
      title={props.title}
      variant={props.emphasis}
      busy={props.loading}
      icon={props.leading}
      onPress={props.onPress}
      testID={props.testID}
    />
  ),
  Spinner: (props) => <HappierSpinner size="small" color={props.color} />,
  renderGlyph: (glyph, color, size) => <PlainCapsuleGlyph glyph={glyph} color={color} size={size} />,
};

function useCapsuleHost(): HappierCapsuleHost {
  return useOptionalPluginUiPresentationHost()?.capsuleHost ?? PLAIN_CAPSULE_HOST;
}

export type StatusCapsuleProps = Readonly<{
  /** The one sentence ("Showing the last frame · reconnecting"). Say what is not normal, not the mechanism. */
  text: string;
  /** Work is under way: a spinner leads the sentence. */
  busy?: boolean;
  /** The one way out, beside the sentence. */
  action?: Readonly<{ label: string; onPress: () => void }>;
  /** Keep it mounted and flip this to get the leave as well as the arrival. Defaults to shown. */
  visible?: boolean;
  testID: string;
}>;

/**
 * A small capsule docked under the top edge of a page, a preview or a stream, shown only while
 * something is not normal. Healthy is quiet: stop showing it when things recover. Render it inside the
 * box it narrates (it positions itself absolutely at that box's top edge).
 */
export function StatusCapsule(props: StatusCapsuleProps): ReactElement | null {
  const theme = usePluginTheme();
  const host = useCapsuleHost();
  const colors = useCapsuleColors(theme);
  return <HappierStatusCapsule {...props} colors={colors} host={host} />;
}

export type PresenceCapsuleProps = Readonly<{
  /** Who is in control, from the surface's controller owner. */
  presence: HappierPresence;
  /** The agent's display name, said in the capsule's default words ("Stopping Claude…"). */
  agentName: string;
  /** The agent's mark at the given size (for example your plugin's `BrandMark`); omitted, a sparkle. */
  renderAgentMark?: (size: number) => ReactNode;
  /** What the agent is doing, said for this surface ("Claude is editing the board"). */
  agentTitle: string;
  /** Its line right now ("Moving “Launch plan”"), or where it is. */
  agentDetail?: string;
  /** Your words for the person's control, and its line. */
  humanTitle?: string;
  humanDetail?: string;
  /** The takeover control's label, where this surface says it differently. */
  takeControlLabel?: string;
  /**
   * Run your surface's takeover Action. The capsule says "Stopping…" until `presence.controlEpoch`
   * moves; it never decides who has control itself. Asynchronous routes return the typed command
   * result so failed or unknown delivery leaves the pending state and offers Take control again.
   */
  onTakeControl?: HappierPresenceCapsuleProps['onTakeControl'];
  /** Run your surface's hand-back Action. */
  onHandBack?: () => void;
  /** Take a fresh look that confirms an unconfirmed stop. */
  onCheckAgain?: () => void;
  checking?: boolean;
  /** Open the surface this capsule narrates. */
  onWatch?: () => void;
  compact?: boolean;
  /** Container width; narrow frames keep the mark and an accessible icon action instead of clipped words. */
  availableWidth?: number;
  placement?: HappierPresenceCapsulePlacement;
  testID: string;
}>;

const PRESENCE_KEYS = {
  stopping: ['happier.plugin-ui.presence.stopping', 'Stopping {agent}…'],
  stoppingDetail: ['happier.plugin-ui.presence.stoppingDetail', 'Finishing its last action'],
  humanTitle: ['happier.plugin-ui.presence.youHaveControl', 'You have control'],
  pausedUntilHandBack: ['happier.plugin-ui.presence.pausedUntilHandBack', '{agent} is paused until you hand back'],
  stopUnconfirmed: ['happier.plugin-ui.presence.stopUnconfirmed', 'Couldn’t confirm the stop'],
  lastActionMayHaveLanded: ['happier.plugin-ui.presence.lastActionMayHaveLanded', '{agent}’s last action may have landed'],
  takeControl: ['happier.plugin-ui.presence.takeControl', 'Take control'],
  handBack: ['happier.plugin-ui.presence.handBack', 'Hand back'],
  checkAgain: ['happier.plugin-ui.presence.checkAgain', 'Check again'],
  watch: ['happier.plugin-ui.presence.watch', 'Watch'],
} as const;

function presenceText(translate: PluginTranslate, entry: readonly [string, string], agentName: string): string {
  return translate(entry[0], entry[1]).replace('{agent}', agentName);
}

/**
 * Who is driving a surface an agent can act on — the agent's mark, what it is doing, and the one
 * control (Take control → Stopping → You have control · Hand back). It is the same capsule Happier's
 * browser and shared-window viewers draw. It holds no authority: wire Take control and Hand back to
 * your surface's Actions, and feed `presence` from the owner of who is in control.
 */
export function PresenceCapsule(props: PresenceCapsuleProps): ReactElement | null {
  const theme = usePluginTheme();
  const translate = usePluginTranslation();
  const host = useCapsuleHost();
  const colors = useCapsuleColors(theme);
  const name = props.agentName;
  const copy = {
    agentTitle: props.agentTitle,
    agentDetail: props.agentDetail ?? null,
    stopping: presenceText(translate, PRESENCE_KEYS.stopping, name),
    stoppingDetail: presenceText(translate, PRESENCE_KEYS.stoppingDetail, name),
    humanTitle: props.humanTitle ?? presenceText(translate, PRESENCE_KEYS.humanTitle, name),
    humanDetail: props.humanDetail ?? null,
    pausedUntilHandBack: presenceText(translate, PRESENCE_KEYS.pausedUntilHandBack, name),
    stopUnconfirmed: presenceText(translate, PRESENCE_KEYS.stopUnconfirmed, name),
    lastActionMayHaveLanded: presenceText(translate, PRESENCE_KEYS.lastActionMayHaveLanded, name),
    takeControl: props.takeControlLabel ?? presenceText(translate, PRESENCE_KEYS.takeControl, name),
    handBack: presenceText(translate, PRESENCE_KEYS.handBack, name),
    checkAgain: presenceText(translate, PRESENCE_KEYS.checkAgain, name),
    watch: presenceText(translate, PRESENCE_KEYS.watch, name),
  };
  return (
    <HappierPresenceCapsule
      presence={props.presence}
      copy={copy}
      renderAgentMark={props.renderAgentMark}
      onTakeControl={props.onTakeControl}
      onHandBack={props.onHandBack}
      onCheckAgain={props.onCheckAgain}
      checking={props.checking}
      onWatch={props.onWatch}
      compact={props.compact}
      availableWidth={props.availableWidth}
      placement={props.placement}
      colors={colors}
      host={host}
      testID={props.testID}
    />
  );
}

export type AgentCursorProps = Readonly<{
  /** Where the agent acts, normalized to the page (0..1); `null` when it is not acting. */
  target: HappierAgentTarget | null;
  /**
   * The agent's latest pointer action, kept by you until the next one replaces it. Each new `id` is shown
   * once (arrive, hold while `target` is live, leave) even when the action began and ended between two
   * renders, which `target` alone cannot show. Pass it for any stream whose actions can be short.
   */
  point?: HappierAgentPoint | null;
  /** Where the page is drawn inside this layer when it does not fill it (a letterboxed stream). */
  pageRect?: HappierAgentPageRect | null;
  renderAgentMark?: (size: number) => ReactNode;
  testID: string;
}>;

/**
 * The agent's hand over a page or a stream, travelling to where it acts, with a cased ring around the
 * element when the target has one. Decorative: it never takes input and is hidden from assistive
 * technology (pair it with a `PresenceCapsule`, which says the same thing in words). Render it inside
 * the box it covers.
 */
export function AgentCursor(props: AgentCursorProps): ReactElement {
  const theme = usePluginTheme();
  const accessibility = useOptionalHappierUiAccessibility();
  const presentationHost = useOptionalPluginUiPresentationHost();
  const host = useCapsuleHost();
  const colors = useMemo(() => ({ line: theme.colors.text, casing: theme.colors.surface }), [theme]);
  return (
    <HappierAgentCursor
      target={props.target}
      point={props.point}
      pageRect={props.pageRect}
      renderAgentMark={props.renderAgentMark}
      renderGlyph={host.renderGlyph}
      colors={colors}
      reducedMotion={accessibility?.reducedMotion ?? false}
      motion={presentationHost?.agentCursorMotion ?? HAPPIER_INSTANT_AGENT_CURSOR_MOTION}
      testID={props.testID}
    />
  );
}
