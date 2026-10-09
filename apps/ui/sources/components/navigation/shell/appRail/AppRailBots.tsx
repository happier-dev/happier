import { readSessionBotV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { usePathname } from 'expo-router';
import * as React from 'react';
import { View } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  ZoomIn,
  ZoomOut,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useShallow } from 'zustand/react/shallow';

import { BotsPopoverContent } from '@/components/sessions/bots/BotsPopoverContent';
import { useOptionalBotsRosterRuntime } from '@/components/sessions/bots/BotsRosterRuntime';
import { WorkspaceDestinationRow } from '@/components/appShell/workspace/WorkspaceDestinationRow';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { Icon } from '@/components/ui/icons/Icon';
import { motionTokens } from '@/components/ui/motion';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useSessionListSelectionState } from '@/hooks/session/useSessionListSelectionState';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import {
  isUrgentSessionListAttentionState,
  mapSessionAwarenessToListAttentionState,
} from '@/sync/domains/session/listing/deriveSessionListActivity';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { resolveSessionListOrganizationServerIds } from '@/sync/domains/session/organization/sessionListOrganizationServerIds';
import {
  storage,
  useSessionOrganizationProjections,
} from '@/sync/domains/state/storage';
import { t } from '@/text';
import {
  getSessionName,
  getSessionStatus,
} from '@/utils/sessions/sessionUtils';

import type {
  SidebarFooterPopoverContentProps,
  SidebarFooterPopoverTrigger,
} from '../sidebarFooter/SidebarFooterPopoverButton';
import { SidebarFooterPopoverButton } from '../sidebarFooter/SidebarFooterPopoverButton';
import { AppRailBadge } from './AppRailBadge';
import {
  APP_RAIL_ICON_GLYPH_SIZE_PX,
  APP_RAIL_ITEM_SIZE_PX,
} from './appRailMetrics';
import type {
  AppRailBotEntry,
  AppRailBotHome,
  AppRailEntry,
} from './appRailModel';

const ROSTER_WIDTH_PX = 340;
const PIN_AVATAR_SIZE_PX = 24;
const PIN_RING_SIZE_PX = 32;

type BotActivity = 'needsYou' | 'working' | 'quiet';

/** The one classification the roster header, the rail badge and the pins share (operational awareness). */
export function readBotActivity(
  session: SessionListRenderableSession,
  nowMs: number,
): BotActivity {
  const state = mapSessionAwarenessToListAttentionState(
    getSessionStatus(session, nowMs).awareness.operational.primary,
  );
  if (isUrgentSessionListAttentionState(state)) return 'needsYou';
  return state === 'thinking' ? 'working' : 'quiet';
}

/** The Homes whose rail membership the rail reads: the same Homes the Sessions list presents. */
function useRailBotServerIds(): readonly string[] {
  const selection = useSessionListSelectionState();
  return React.useMemo(
    () =>
      resolveSessionListOrganizationServerIds({
        allowedServerIds: selection.allowedServerIds,
        activeServerId: selection.activeServerId,
      }),
    [selection.activeServerId, selection.allowedServerIds],
  );
}

/**
 * The rail's lean Bot facts: explicit rail membership (organization projection) joined with the
 * already-loaded rows of exactly those Sessions. Never pages, never reads transcripts.
 */
export function useAppRailBotHomes(): readonly AppRailBotHome[] {
  const serverIds = useRailBotServerIds();
  const projections = useSessionOrganizationProjections(serverIds);
  const pinned = React.useMemo(
    () =>
      serverIds.flatMap((serverId) =>
        (projections[serverId]?.railPinnedSessionIds ?? []).map(
          (sessionId) => ({ serverId, sessionId }),
        ),
      ),
    [projections, serverIds],
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
        for (const sessionId of organization.railPinnedSessionIds)
          rowsBySessionId[sessionId] = rows[`${serverId}\u0000${sessionId}`];
        return [{ serverId, rowsBySessionId, organization }];
      }),
    [projections, rows, serverIds],
  );
}

/** How many loaded Bots need the person: the Bots entry's only badge (no offline or working count). */
function useBotsNeedingYouCount(): number {
  const serverIds = useRailBotServerIds();
  return storage((state) => {
    const now = Date.now();
    let count = 0;
    for (const serverId of serverIds) {
      const rows = state.sessionListRowsByServerId[serverId];
      if (!rows) continue;
      for (const row of Object.values(rows)) {
        if (readSessionBotV1(row.metadata?.bot)?.kind !== 'bot') continue;
        if (readBotActivity(row, now) === 'needsYou') count += 1;
      }
    }
    return count;
  });
}

const renderRoster = (content: SidebarFooterPopoverContentProps) => (
  <BotsPopoverContent {...content} />
);

/**
 * The rail's one Bots entry (lab `b-rail A`): the roster popover beside it, opened by a press, the
 * command palette or the phone launcher through the Bots runtime. Its badge is the needs-you count.
 */
export const AppRailBots = React.memo(function AppRailBots(
  props: Readonly<{
    entry: AppRailEntry;
    renderTrigger?: SidebarFooterPopoverTrigger;
  }>,
) {
  const { theme } = useUnistyles();
  const runtime = useOptionalBotsRosterRuntime();
  const needsYou = useBotsNeedingYouCount();
  const label =
    needsYou > 0
      ? `${props.entry.title}, ${t('bots.roster.needsYou', { count: needsYou })}`
      : props.entry.title;
  return (
    <>
      <SidebarFooterPopoverButton
        testID={`app-rail:${props.entry.id}`}
        iconName={props.entry.icon}
        label={label}
        placement="right"
        anchorAlignVertical="start"
        buttonSizePx={APP_RAIL_ITEM_SIZE_PX}
        iconSizePx={APP_RAIL_ICON_GLYPH_SIZE_PX}
        popoverWidthPx={ROSTER_WIDTH_PX}
        renderContent={renderRoster}
        renderTrigger={props.renderTrigger}
        registerOpener={runtime?.registerAnchoredOpener}
        renderIcon={(open) => (
          <Icon
            name={props.entry.icon}
            size={APP_RAIL_ICON_GLYPH_SIZE_PX}
            weight={open ? 'fill' : 'regular'}
            color={
              open ? theme.colors.text.primary : theme.colors.text.secondary
            }
          />
        )}
      />
      {needsYou > 0 && !props.renderTrigger ? (
        <AppRailBadge
          testID={`app-rail:${props.entry.id}-badge`}
          signal={{ kind: 'count', value: needsYou, tone: 'attention' }}
        />
      ) : null}
    </>
  );
});

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
    slotStyle: object;
  }>,
) {
  const { theme } = useUnistyles();
  const reducedMotion = useReducedMotionPreference();
  const navigateToSession = useNavigateToSession();
  const pathname = usePathname();
  const { bot } = props;
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
  const entering = !props.animateEntry
    ? undefined
    : reducedMotion
      ? FadeIn.duration(motionTokens.successMoment.reducedCrossFadeMs)
      : ZoomIn.duration(
          motionTokens.successMoment.travelMs +
            motionTokens.successMoment.landMs,
        );
  const exiting = reducedMotion
    ? FadeOut.duration(motionTokens.successMoment.reducedCrossFadeMs)
    : ZoomOut.duration(120);
  return (
    <Animated.View entering={entering} exiting={exiting}>
      <WorkspaceDestinationRow style={props.slotStyle} href={href}>
        <IconButton
          testID={`app-rail:${bot.id}`}
          variant="plain"
          size={APP_RAIL_ITEM_SIZE_PX}
          accessibilityLabel={label}
          tooltip={name}
          tooltipPlacement="right"
          selected={active}
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
              <Avatar
                id={bot.avatarId}
                size={PIN_AVATAR_SIZE_PX}
                monochrome={bot.session.active !== true}
              />
            </View>
          }
          onPress={() => {
            void navigateToSession(bot.sessionId, { serverId: bot.serverId });
          }}
        />
        {activity === 'needsYou' ? (
          <AppRailBadge
            testID={`app-rail:${bot.id}-badge`}
            signal={{ kind: 'dot', tone: 'attention' }}
          />
        ) : null}
      </WorkspaceDestinationRow>
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
