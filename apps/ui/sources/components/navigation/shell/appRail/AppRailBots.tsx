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

import { readBotActivity } from '@/components/sessions/bots/botActivity';
import { BotsPopoverContent } from '@/components/sessions/bots/BotsPopoverContent';
import { useOptionalBotsRosterRuntime } from '@/components/sessions/bots/BotsRosterRuntime';
import { WorkspaceDestinationRow } from '@/components/appShell/workspace/WorkspaceDestinationRow';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { Icon } from '@/components/ui/icons/Icon';
import { motionTokens } from '@/components/ui/motion';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useSessionListSelectionState } from '@/hooks/session/useSessionListSelectionState';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { resolveSessionListOrganizationServerIds } from '@/sync/domains/session/organization/sessionListOrganizationServerIds';
import {
  storage,
  useSessionOrganizationProjections,
} from '@/sync/domains/state/storage';
import { t } from '@/text';
import { getSessionName } from '@/utils/sessions/sessionUtils';

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
import { useAppRailBotReorder } from './useAppRailBotReorder';

/** The roster's drawn width (lab `b-rail A`): a name, its current line and the trailing time on one row. */
const ROSTER_WIDTH_PX = 376;
const PIN_AVATAR_SIZE_PX = 24;
const PIN_RING_SIZE_PX = 32;

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

type SessionListRowsByServerId = Readonly<
  Record<
    string,
    Readonly<Record<string, SessionListRenderableSession>> | undefined
  >
>;

/**
 * Counts the loaded Bots that need the person. The rail is always mounted and the store notifies on
 * every change anywhere, so the count is recomputed only when one of these Homes' row maps was
 * replaced; every other notification returns the previous number without walking a row.
 */
export function createBotsNeedingYouCounter(
  serverIds: readonly string[],
): (rowsByServerId: SessionListRowsByServerId) => number {
  let countedRows: ReadonlyArray<SessionListRowsByServerId[string]> | null =
    null;
  let count = 0;
  return (rowsByServerId) => {
    const rows = serverIds.map((serverId) => rowsByServerId[serverId]);
    if (
      countedRows !== null &&
      rows.every((homeRows, index) => homeRows === countedRows![index])
    )
      return count;
    const now = Date.now();
    count = 0;
    for (const homeRows of rows) {
      if (!homeRows) continue;
      for (const row of Object.values(homeRows)) {
        if (readSessionBotV1(row.metadata?.bot)?.kind !== 'bot') continue;
        if (readBotActivity(row, now) === 'needsYou') count += 1;
      }
    }
    countedRows = rows;
    return count;
  };
}

/** How many loaded Bots need the person: the Bots entry's only badge (no offline or working count). */
function useBotsNeedingYouCount(): number {
  const serverIds = useRailBotServerIds();
  const count = React.useMemo(
    () => createBotsNeedingYouCounter(serverIds),
    [serverIds],
  );
  return storage((state) => count(state.sessionListRowsByServerId));
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
    previousBotSessionId?: string;
    nextBotSessionId?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const reducedMotion = useReducedMotionPreference();
  const navigateToSession = useNavigateToSession();
  const pathname = usePathname();
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
    : ZoomOut.duration(motionTokens.overlay.popover.exitMs);
  return (
    <Animated.View entering={entering} exiting={exiting} ref={reorder.ref}>
      <WorkspaceDestinationRow style={props.slotStyle} href={href} existingMenu dragSource={false}>
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
          accessibilityLabel={label}
          tooltip={name}
          tooltipPlacement="right"
          selected={active}
          onLongPress={openMenu}
          onContextMenu={event => { event.preventDefault(); event.stopPropagation(); openMenu(); }}
          onKeyDown={async event => {
            if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
              event.preventDefault(); event.stopPropagation(); openMenu(); return;
            }
            if (!event.altKey || !reorder.available) return;
            const target = event.key === 'ArrowUp' ? props.previousBotSessionId : event.key === 'ArrowDown' ? props.nextBotSessionId : undefined;
            if (!target) return;
            event.preventDefault(); event.stopPropagation();
            await reorder.move(target, event.key === 'ArrowUp' ? 'top' : 'bottom');
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
        />}
        />
        {activity === 'needsYou' ? (
          <AppRailBadge
            testID={`app-rail:${bot.id}-badge`}
            signal={{ kind: 'dot', tone: 'attention' }}
          />
        ) : null}
        </>}
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
