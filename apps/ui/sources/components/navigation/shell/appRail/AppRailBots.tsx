import { useDestinationPathname } from '@/components/appShell/workspace/DestinationInstanceHost';
import * as React from 'react';
import { View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
  ZoomIn,
  ZoomOut,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useShallow } from 'zustand/react/shallow';

import { readBotActivity } from '@/components/sessions/bots/botActivity';
import { BotMarkerFeedback } from '@/components/sessions/bots/botMarkerFeedback';
import { useBotsHomeServerIds, useBotsSummary } from '@/components/sessions/bots/botsSummary';
import {
  forgetRailPinOrigin,
  measureWindowRect,
  peekRailPinOrigin,
  resolveRailPinFlightStart,
  type WindowRect,
} from '@/components/sessions/bots/railPinFlight';
import { BotsPopoverContent } from '@/components/sessions/bots/BotsPopoverContent';
import { useOptionalBotsRosterRuntime } from '@/components/sessions/bots/BotsRosterRuntime';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { motionTokens } from '@/components/ui/motion';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import {
  storage,
  useSessionOrganizationProjections,
} from '@/sync/domains/state/storage';
import { t } from '@/text';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';

import type { SidebarFooterPopoverContentProps } from '../sidebarFooter/SidebarFooterPopoverButton';
import { SidebarFooterPopoverButton } from '../sidebarFooter/SidebarFooterPopoverButton';
import { AppRailBadge } from './AppRailBadge';
import { AppRailIcon } from './AppRailIcon';
import { AppRailSlot } from './AppRailSlot';
import {
  APP_RAIL_ICON_GLYPH_SIZE_PX,
  APP_RAIL_ITEM_EDGES_PX,
  APP_RAIL_ITEM_SIZE_PX,
} from './appRailMetrics';
import type {
  AppRailBotEntry,
  AppRailBotHome,
  AppRailEntry,
} from './appRailModel';
import { useAppRailBotReorder } from './useAppRailBotReorder';

/** The roster's drawn width (lab `b-rail A`): a name, its current line and the trailing time on one row. */
const ROSTER_WIDTH_PX = 376;
const PIN_AVATAR_SIZE_PX = 24;
const PIN_RING_SIZE_PX = 32;

/**
 * The rail's lean Bot facts: explicit rail membership (organization projection) joined with the
 * already-loaded rows of exactly those Sessions. Never pages, never reads transcripts.
 */
export function useAppRailBotHomes(): readonly AppRailBotHome[] {
  const serverIds = useBotsHomeServerIds();
  const isSessionVisible = useSessionRecordingVisibility();
  const projections = useSessionOrganizationProjections(serverIds);
  const pinned = React.useMemo(
    () =>
      serverIds.flatMap((serverId) =>
        (projections[serverId]?.railPinnedSessionIds ?? []).map(
          (sessionId) => ({ serverId, sessionId }),
        ),
      ).filter(isSessionVisible),
    [projections, serverIds, isSessionVisible],
  );
  const rows = storage(
    useShallow((state) => {
      const next: Record<string, SessionListRenderableSession | undefined> = {};
      for (const { serverId, sessionId } of pinned) {
        next[`${serverId}\u0000${sessionId}`] =
          readSessionListRowForServerId(
            state.sessionListRowsByServerId,
            serverId,
            sessionId,
          ) ?? undefined;
      }
      return next;
    }),
  );
  return React.useMemo(
    () =>
      serverIds.flatMap((serverId) => {
        const organization = projections[serverId];
        if (!organization) return [];
        const rowsBySessionId: Record<
          string,
          SessionListRenderableSession | undefined
        > = {};
        for (const sessionId of organization.railPinnedSessionIds) {
          const key = `${serverId}\u0000${sessionId}`;
          if (key in rows) rowsBySessionId[sessionId] = rows[key];
        }
        return [{ serverId, rowsBySessionId, organization }];
      }),
    [projections, rows, serverIds],
  );
}

const renderRoster = (content: SidebarFooterPopoverContentProps) => (
  <BotsPopoverContent {...content} />
);

/**
 * The rail's one Bots entry (lab `b-rail A`): the roster popover beside it, opened by a press, the
 * command palette or the phone launcher through the Bots runtime. Its dot signals contextual attention.
 */
export const AppRailBots = React.memo(function AppRailBots(
  props: Readonly<{ entry: AppRailEntry }>,
) {
  const runtime = useOptionalBotsRosterRuntime();
  const needsYou = useBotsSummary().needsYou;
  const label =
    needsYou > 0
      ? `${props.entry.title}, ${t('bots.roster.needsYou', { count: needsYou })}`
      : props.entry.title;
  return (
    <AppRailSlot
      badge={
        needsYou > 0 ? (
          <AppRailBadge
            testID={`app-rail:${props.entry.id}-badge`}
            signal={{ kind: 'dot', tone: 'attention' }}
          />
        ) : null
      }
    >
      {/* An accepted promotion nudges the one place Bots live, once (plan 60: "where-did-it-go nudge"). */}
      <BotMarkerFeedback kind="nudge">
      <SidebarFooterPopoverButton
        testID={`app-rail:${props.entry.id}`}
        iconName={props.entry.icon}
        label={label}
        placement="right"
        anchorAlignVertical="start"
        buttonSizePx={APP_RAIL_ITEM_SIZE_PX}
        interactiveTargetEdgesPx={APP_RAIL_ITEM_EDGES_PX}
        iconSizePx={APP_RAIL_ICON_GLYPH_SIZE_PX}
        popoverWidthPx={ROSTER_WIDTH_PX}
        renderContent={renderRoster}
        registerOpener={runtime?.registerAnchoredOpener}
        renderIcon={(open) => <AppRailIcon name={props.entry.icon} active={open} />}
      />
      </BotMarkerFeedback>
    </AppRailSlot>
  );
});

/** How far the travelling picture lifts while it leaves the row and settles as it lands. */
const PIN_FLIGHT_LIFT = 0.06;

/**
 * The accepted pin's signature move (lab `b-rail`, plan 60 "pin shared-element flight"): when the
 * person pinned from a row that recorded where its picture was, the new slot starts there, at that
 * size, and travels to the rail on the success-moment track — lift (`gatherMs`), travel (`travelMs`),
 * land (`landMs`). Transform and opacity only. No recorded origin (a pin from elsewhere) or reduced
 * motion leaves the slot to its ordinary arrival.
 */
function useRailPinLanding(
  session: Readonly<{ serverId: string; sessionId: string }> | null,
  reducedMotion: boolean,
) {
  const [origin] = React.useState<WindowRect | null>(() =>
    session && !reducedMotion ? peekRailPinOrigin(session) : null,
  );
  const clock = useSharedValue(origin ? 0 : 3);
  const from = useSharedValue({ translateX: 0, translateY: 0, scale: 1 });
  const avatarRef = React.useRef<View>(null);
  const startedRef = React.useRef(false);
  const onAvatarLayout = React.useCallback(() => {
    if (!origin || !session || startedRef.current) return;
    startedRef.current = true;
    forgetRailPinOrigin(session);
    fireAndForget(
      measureWindowRect(avatarRef.current).then((slot) => {
        const start = resolveRailPinFlightStart(origin, slot);
        if (!start) {
          clock.value = 3;
          return;
        }
        from.value = start;
        const track = motionTokens.successMoment;
        const ease = reanimatedMotionTokens.easing.standard;
        clock.value = withSequence(
          withTiming(1, { duration: track.gatherMs, easing: ease }),
          withTiming(2, { duration: track.travelMs, easing: ease }),
          withTiming(3, { duration: track.landMs, easing: Easing.out(Easing.quad) }),
        );
      }),
      { tag: 'AppRail.Bot.pinLanding' },
    );
  }, [clock, from, origin, session]);
  const style = useAnimatedStyle(() => {
    const t = clock.value;
    const gather = Math.min(1, t);
    const travel = Math.min(1, Math.max(0, t - 1));
    const land = Math.min(1, Math.max(0, t - 2));
    const lifted = 1 + PIN_FLIGHT_LIFT * (gather - land);
    const size = from.value.scale + (1 - from.value.scale) * travel;
    return {
      opacity: gather,
      transform: [
        { translateX: from.value.translateX * (1 - travel) },
        { translateY: from.value.translateY * (1 - travel) },
        { scale: size * lifted },
      ],
    };
  });
  return { flying: origin !== null, style, avatarRef, onAvatarLayout };
}

/**
 * One Bot the person pinned to the rail (lab `b-rail A`, 60s3): its seeded avatar, a thin ring while
 * it works, the attention dot when it needs you. It lands on the rail after the accepted pin
 * (`successMoment` travel + land) and leaves faster; reduced motion cross-fades. Pins present when
 * the rail mounts do not animate.
 */
export const AppRailBotPin = React.memo(function AppRailBotPin(
  props: Readonly<{
    bot: AppRailBotEntry;
    animateEntry: boolean;
    previousBotSessionId?: string;
    nextBotSessionId?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const reducedMotion = useReducedMotionPreference();
  const navigateToSession = useNavigateToSession();
  const pathname = useDestinationPathname();
  const { bot } = props;
  const reorder = useAppRailBotReorder(bot);
  const [orderMenuOpen, setOrderMenuOpen] = React.useState(false);
  const name = getSessionName(bot.session, bot.serverId);
  const activity = readBotActivity(bot.session, Date.now());
  const href = buildScopedSessionRouteHref({
    sessionId: bot.sessionId,
    serverId: bot.serverId,
  });
  const active = pathname.startsWith(`/session/${bot.sessionId}`);
  const label =
    activity === 'needsYou'
      ? t('bots.roster.rowNeedsYou', { name })
      : activity === 'working'
        ? t('bots.roster.rowWorking', { name })
        : name;
  const landing = useRailPinLanding(
    props.animateEntry ? { serverId: bot.serverId, sessionId: bot.sessionId } : null,
    reducedMotion,
  );
  const entering = !props.animateEntry || landing.flying
    ? undefined
    : reducedMotion
      ? FadeIn.duration(motionTokens.successMoment.reducedCrossFadeMs)
      : ZoomIn.duration(
          motionTokens.successMoment.travelMs +
            motionTokens.successMoment.landMs,
        );
  const exiting = reducedMotion
    ? FadeOut.duration(motionTokens.successMoment.reducedCrossFadeMs)
    : ZoomOut.duration(motionTokens.overlay.popover.exitMs);
  return (
    <Animated.View entering={entering} exiting={exiting} ref={reorder.ref} style={landing.style}>
      <AppRailSlot href={href} existingMenu dragSource={false} badge={activity === 'needsYou' ? (
          <AppRailBadge
            testID={`app-rail:${bot.id}-badge`}
            signal={{ kind: 'dot', tone: 'attention' }}
          />
        ) : null}>
        {actions => <>
        <DropdownMenu
          testID={`app-rail:${bot.id}.order-menu`}
          open={orderMenuOpen}
          onOpenChange={setOrderMenuOpen}
          items={[...actions.items,
            ...(reorder.available && props.previousBotSessionId ? [{ id: 'move-up', title: t('common.moveUp'), shortcut: 'Alt+↑' }] : []),
            ...(reorder.available && props.nextBotSessionId ? [{ id: 'move-down', title: t('common.moveDown'), shortcut: 'Alt+↓' }] : []),
          ]}
          onSelect={id => {
            if (id === 'move-up' && props.previousBotSessionId) fireAndForget(reorder.move(props.previousBotSessionId, 'top'), { tag: 'AppRail.Bot.moveUp' });
            else if (id === 'move-down' && props.nextBotSessionId) fireAndForget(reorder.move(props.nextBotSessionId, 'bottom'), { tag: 'AppRail.Bot.moveDown' });
            else actions.select(id);
          }}
          placement="right" variant="slim" matchTriggerWidth={false}
          trigger={({ openMenu }) =>
        <IconButton
          testID={`app-rail:${bot.id}`}
          variant="plain"
          size={APP_RAIL_ITEM_SIZE_PX}
          interactiveTargetEdgesPx={APP_RAIL_ITEM_EDGES_PX}
          accessibilityLabel={label}
          tooltip={name}
          tooltipPlacement="right"
          selected={active}
          onLongPress={openMenu}
          onContextMenu={event => {
            if (event && typeof event === 'object') {
              const gesture = event as { preventDefault?: () => void; stopPropagation?: () => void };
              gesture.preventDefault?.(); gesture.stopPropagation?.();
            }
            openMenu();
          }}
          onKeyDown={(key, event) => {
            // The shared pressable owns key normalization and stopping a handled event.
            const gesture = event && typeof event === 'object'
              ? event as { altKey?: boolean; shiftKey?: boolean; nativeEvent?: { altKey?: boolean; shiftKey?: boolean } }
              : {};
            const modifiers = gesture.nativeEvent ?? gesture;
            if (key === 'ContextMenu' || (modifiers.shiftKey && key === 'F10')) {
              openMenu(); return true;
            }
            if (!modifiers.altKey || !reorder.available) return false;
            const target = key === 'ArrowUp' ? props.previousBotSessionId : key === 'ArrowDown' ? props.nextBotSessionId : undefined;
            if (!target) return false;
            fireAndForget(reorder.move(target, key === 'ArrowUp' ? 'top' : 'bottom'), { tag: 'AppRail.Bot.keyboardMove' });
            return true;
          }}
          icon={
            <View style={styles.pin}>
              {activity === 'working' ? (
                <View style={styles.ring} pointerEvents="none">
                  <ActivitySpinner
                    size={PIN_RING_SIZE_PX}
                    color={theme.colors.text.tertiary}
                    animationEnabled={!reducedMotion}
                  />
                </View>
              ) : null}
              <View ref={landing.avatarRef} collapsable={false} onLayout={landing.onAvatarLayout}>
                <Avatar
                  id={bot.avatarId}
                  size={PIN_AVATAR_SIZE_PX}
                  monochrome={bot.session.active !== true}
                />
              </View>
            </View>
          }
          onPress={() => {
            void navigateToSession(bot.sessionId, { serverId: bot.serverId });
          }}
        />}
        />
        </>}
      </AppRailSlot>
    </Animated.View>
  );
});

/** The More menu row of a pin that did not fit on the rail: the same avatar, the Bot's name. */
export function AppRailBotMenuIcon(
  props: Readonly<{ bot: AppRailBotEntry; size: number }>,
) {
  return (
    <Avatar
      id={props.bot.avatarId}
      size={props.size}
      monochrome={props.bot.session.active !== true}
    />
  );
}

const styles = StyleSheet.create(() => ({
  pin: {
    width: PIN_RING_SIZE_PX,
    height: PIN_RING_SIZE_PX,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: {
    position: 'absolute',
    inset: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
}));
