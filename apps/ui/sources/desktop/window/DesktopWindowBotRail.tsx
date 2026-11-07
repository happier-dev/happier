import * as React from 'react';
import { View } from 'react-native';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { DesktopWindowTarget } from '@happier-dev/protocol/actions/actionSpecs';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useWorkspaceOpenActions } from '@/components/appShell/workspace/useWorkspaceOpenActions';
import { executeWorkspaceUiAction } from '@/components/appShell/workspace/workspaceActionRuntime';
import type { OrderedBot } from '@/components/sessions/bots/botActivity';
import { BotFaceMarker } from '@/components/sessions/bots/BotFaceMarker';
import {
  orderedBotAccessibilityLabel,
  useOrderedBotNames,
  useOrderedBots,
} from '@/components/sessions/bots/botsSummary';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { useSessionOrganizationProjections } from '@/sync/domains/state/storage';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { t } from '@/text';

/** The window rail's face size: the notch wing's (lab `ntwin` A, `fc(k, 20)`). */
const RAIL_FACE_SIZE_PX = 20;
export const DESKTOP_WINDOW_OPEN_IN_HAPPIER_ID = 'desktop.window.openInHappier';

type SessionWindowScope = Readonly<{
  windowId: string;
  homeId: string;
  accountId: string;
  sessionId: string;
}>;
type SessionTarget = Extract<DesktopWindowTarget, { kind: 'session' }>;

/**
 * Opens a Session in the main window through the canonical `session.open` presentation. The answering
 * client decides whether that returns a Session window or opens a main tab.
 */
export function openSessionInHappier(
  target: Pick<SessionTarget, 'serverId' | 'sessionId'>,
  openApproval: (
    href: Parameters<Parameters<typeof executeWorkspaceUiAction>[1]>[0],
  ) => void,
) {
  fireAndForget(
    executeWorkspaceUiAction(
      {
        actionId: 'session.open',
        input: {
          sessionId: target.sessionId,
          serverId: target.serverId,
          presentation: 'main',
        },
      },
      openApproval,
    ),
    { tag: 'DesktopWindow.openInHappier' },
  );
}

/**
 * The optional Bot rail in a Bot's Session window (lab `ntwin` A): its Home's rail-pinned Bots in roster
 * order with the shared markers, the current Bot named. A click retargets this window in place; the
 * menu is the shared open menu with "Open in Happier". A Session that is not a Bot keeps its title.
 */
export const DesktopWindowBotRail = React.memo(function DesktopWindowBotRail(
  props: Readonly<{
    scope: SessionWindowScope;
    fallback: React.ReactElement;
  }>,
) {
  const { scope } = props;
  const ordered = useOrderedBots();
  const homeIds = React.useMemo(() => [scope.homeId], [scope.homeId]);
  const pinned =
    useSessionOrganizationProjections(homeIds)[scope.homeId]
      ?.railPinnedSessionIds;
  const bots = React.useMemo(() => {
    const members = ordered.filter(
      (bot) =>
        bot.serverId === scope.homeId &&
        (bot.sessionId === scope.sessionId ||
          pinned?.includes(bot.sessionId) === true),
    );
    return members.some((bot) => bot.sessionId === scope.sessionId)
      ? members
      : EMPTY_BOTS;
  }, [ordered, pinned, scope.homeId, scope.sessionId]);
  const names = useOrderedBotNames(bots);
  if (bots.length === 0) return props.fallback;
  return (
    <View
      testID="desktop-window-bot-rail"
      accessibilityRole="tablist"
      accessibilityLabel={t('bots.title')}
      style={styles.rail}
    >
      {bots.map((bot, index) => (
        <DesktopWindowBotRailFace
          key={bot.key}
          bot={bot}
          name={names[index] ?? ''}
          current={bot.sessionId === scope.sessionId}
          scope={scope}
        />
      ))}
    </View>
  );
});

const EMPTY_BOTS: readonly OrderedBot[] = [];

const DesktopWindowBotRailFace = React.memo(function DesktopWindowBotRailFace(
  props: Readonly<{
    bot: OrderedBot;
    name: string;
    current: boolean;
    scope: SessionWindowScope;
  }>,
) {
  const { bot, scope } = props;
  const { theme } = useUnistyles();
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const openApproval = React.useCallback(
    (href: Parameters<typeof router.push>[0]) => router.push(href),
    [router],
  );
  const target = React.useMemo(
    (): SessionTarget => ({
      kind: 'session',
      serverId: bot.serverId,
      accountId: scope.accountId,
      sessionId: bot.sessionId,
    }),
    [bot.serverId, bot.sessionId, scope.accountId],
  );
  const presentationAction = React.useMemo(
    () => ({
      item: {
        id: DESKTOP_WINDOW_OPEN_IN_HAPPIER_ID,
        testID: `desktop-window-bot-rail-${bot.sessionId}-happier`,
        title: t('settingsDesktop.windows.openInHappier'),
        icon: (
          <Icon
            name="arrow-elbow-up-left"
            size={16}
            color={theme.colors.text.secondary}
          />
        ),
      },
      onSelect: () => openSessionInHappier(target, openApproval),
    }),
    [bot.sessionId, openApproval, target, theme.colors.text.secondary],
  );
  const menu = useWorkspaceOpenActions(null, undefined, {
    windowTarget: target,
    presentationAction,
  });
  const retarget = React.useCallback(() => {
    if (props.current) return;
    fireAndForget(
      executeWorkspaceUiAction(
        {
          actionId: 'desktop.windows.open',
          input: { windowId: scope.windowId, target },
        },
        openApproval,
      ),
      { tag: 'DesktopWindowBotRail.retarget' },
    );
  }, [openApproval, props.current, scope.windowId, target]);
  return (
    <DropdownMenu
      testID={`desktop-window-bot-rail-${bot.sessionId}-menu`}
      open={open}
      onOpenChange={setOpen}
      items={menu.presentationItems}
      onSelect={(id) => {
        menu.select(id);
      }}
      placement="bottom"
      variant="slim"
      matchTriggerWidth={false}
      trigger={({ openMenu }) => (
        <HappierPressable
          testID={`desktop-window-bot-rail-${bot.sessionId}`}
          accessibilityRole="tab"
          selected={props.current}
          hasPopup="menu"
          accessibilityLabel={orderedBotAccessibilityLabel(bot, props.name)}
          onPress={retarget}
          onLongPress={openMenu}
          onContextMenu={(event) => {
            (event as { preventDefault?: () => void } | null)?.preventDefault?.();
            openMenu();
          }}
          onKeyDown={(key, event) => {
            const gesture = event as { shiftKey?: boolean; nativeEvent?: { shiftKey?: boolean } } | null;
            const shift = (gesture?.nativeEvent ?? gesture)?.shiftKey === true;
            if (key !== 'ContextMenu' && !(shift && key === 'F10')) return false;
            openMenu();
            return true;
          }}
          style={(state) => [styles.face, state.hovered && !props.current ? styles.hovered : null]}
        >
          <BotFaceMarker
            facts={bot.face}
            size={RAIL_FACE_SIZE_PX}
            activity={bot.activity}
            planeColor={theme.colors.chrome.header.background}
          />
          {props.current ? (
            <Text numberOfLines={1} style={styles.name}>
              {props.name}
            </Text>
          ) : null}
        </HappierPressable>
      )}
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  rail: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
  },
  face: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    minWidth: 0,
    flexShrink: 1,
    paddingHorizontal: theme.space.s4,
    paddingVertical: theme.space.s2,
    borderRadius: theme.borderRadius.sm,
  },
  hovered: { backgroundColor: theme.colors.surface.hover },
  name: { flexShrink: 1, color: theme.colors.chrome.header.foreground },
}));
