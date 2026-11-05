import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { BotFaceMarker } from '@/components/sessions/bots/BotFaceMarker';
import { IconButton } from '@/components/ui/buttons/IconButton';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { formatRelativeTimeShort, readRelativeTimeShortRefreshAtMs } from '@/utils/time/formatShortRelativeTime';

import type {
  BotFaceSnapshot,
  NotchBotFaces,
} from '../../presentation/notchBotTypes';
import { createDesktopActivityOverlayFocusRingStyle } from '../DesktopActivityOverlayChrome';
import { DESKTOP_ACTIVITY_OVERLAY_ROW_LEADING_SIZE, DesktopActivityOverlaySessionRow } from '../DesktopActivityOverlaySessionRow';
import type { DesktopActivityOverlayPressableInteractionState } from '../DesktopActivityOverlayPressableInteractionState';

/** "Four, then +N" (DESIGN.md, lab `ntfaces`): the wing draws the first four; every member stays in the list. */
export const NOTCH_FACES_SHOWN = 4;
/** The Inbox slot in the wing; the rail slot in the panel header and Bot rows (living-bots R1/R5). */
export const NOTCH_FACE_WING_SIZE = 20;
export const NOTCH_FACE_PANEL_SIZE = DESKTOP_ACTIVITY_OVERLAY_ROW_LEADING_SIZE;

export type NotchBotOpenPresentation = 'overlay' | 'window';
export type NotchBotHandlers = Readonly<{
  /** A click, Enter or Space: the person's "Open Bot conversations" preference decides where. */
  onOpen: (face: BotFaceSnapshot) => void;
  /** A menu choice: the presentation is explicit. */
  onOpenIn: (
    face: BotFaceSnapshot,
    presentation: NotchBotOpenPresentation,
  ) => void;
}>;

const OPEN_IN_WINDOW_ID = 'notch.bot.open.window';
const OPEN_IN_OVERLAY_ID = 'notch.bot.open.overlay';

/** The accessible name the rail pins use: the Bot's name, plus its state when it speaks. */
export function readBotFaceLabel(face: BotFaceSnapshot): string {
  return face.activity === 'needsYou'
    ? t('bots.roster.rowNeedsYou', { name: face.name })
    : face.activity === 'working'
      ? t('bots.roster.rowWorking', { name: face.name })
      : face.name;
}

/**
 * The Bot opener menu (lab `ntwin-R`, notch side): "Open in new window" and "Open in the overlay".
 * Pointer right-click, Shift+F10 and the Menu key open it at its trigger, from faces and Bot rows alike.
 */
export function NotchBotMenu(
  props: Readonly<{
    face: BotFaceSnapshot;
    handlers: NotchBotHandlers;
    testID: string;
    placement?: 'bottom' | 'right' | 'left' | 'top';
    trigger: (
      menu: Readonly<{
        openMenu: () => void;
        onContextMenu: (event: unknown) => void;
        onKeyDown: (key: string, event: unknown) => boolean;
      }>,
    ) => React.ReactElement;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const { face, handlers } = props;
  const items = React.useMemo(
    (): readonly DropdownMenuItem[] => [
      {
        id: OPEN_IN_WINDOW_ID,
        testID: `${props.testID}-window`,
        title: t('settingsDesktop.overlay.notchOpenInNewWindow'),
        icon: (
          <Icon
            name="arrow-square-out"
            size={16}
            color={theme.colors.text.secondary}
          />
        ),
      },
      {
        id: OPEN_IN_OVERLAY_ID,
        testID: `${props.testID}-overlay`,
        title: t('settingsDesktop.overlay.notchOpenInOverlay'),
        icon: (
          <Icon name="push-pin" size={16} color={theme.colors.text.secondary} />
        ),
      },
    ],
    [props.testID, theme.colors.text.secondary],
  );
  return (
    <DropdownMenu
      testID={props.testID}
      open={open}
      onOpenChange={setOpen}
      items={items}
      onSelect={(id) =>
        handlers.onOpenIn(face, id === OPEN_IN_WINDOW_ID ? 'window' : 'overlay')
      }
      placement={props.placement ?? 'bottom'}
      variant="slim"
      matchTriggerWidth={false}
      trigger={({ openMenu }) =>
        props.trigger({
          openMenu,
          onContextMenu: (event) => {
            if (event && typeof event === 'object') {
              const gesture = event as {
                preventDefault?: () => void;
                stopPropagation?: () => void;
              };
              gesture.preventDefault?.();
              gesture.stopPropagation?.();
            }
            openMenu();
          },
          onKeyDown: (key, event) => {
            const gesture =
              event && typeof event === 'object'
                ? (event as {
                    shiftKey?: boolean;
                    nativeEvent?: { shiftKey?: boolean };
                  })
                : {};
            const shift = (gesture.nativeEvent ?? gesture).shiftKey === true;
            if (key === 'ContextMenu' || (shift && key === 'F10')) {
              openMenu();
              return true;
            }
            return false;
          },
        })
      }
    />
  );
}

/**
 * The faces wing: Show-Bots members in the one Bot order, four then "+N", each a press target that
 * opens that Bot's conversation. Horizontal on Top and Floating, stacked on the side docks. Every face
 * keeps its identity across republications (the producer reuses unchanged entries), so a state change
 * re-renders that face's marker only.
 */
export const DesktopActivityOverlayFaces = React.memo(
  function DesktopActivityOverlayFaces(
    props: Readonly<{
      faces: NotchBotFaces;
      orientation: 'row' | 'column';
      handlers: NotchBotHandlers;
      /** "+N": opens the list, where every member is reachable. */
      onMore: () => void;
    }>,
  ) {
    const { theme } = useUnistyles();
    const shown = props.faces.faces.slice(0, NOTCH_FACES_SHOWN);
    const more = props.faces.faces.length - shown.length;
    const column = props.orientation === 'column';
    const tooltipPlacement = column ? 'right' : 'bottom';
    if (shown.length === 0) return null;
    return (
      <View
        testID="desktop-activity-overlay-faces"
        style={column ? styles.column : styles.row}
      >
        {shown.map((face) => (
          <NotchBotMenu
            key={`${face.serverId}:${face.sessionId}`}
            face={face}
            handlers={props.handlers}
            testID={`desktop-activity-overlay-face-menu-${face.sessionId}`}
            placement={column ? 'right' : 'bottom'}
            trigger={(menu) => (
              <IconButton
                testID={`desktop-activity-overlay-face-${face.sessionId}`}
                variant="plain"
                size={NOTCH_FACE_WING_SIZE}
                interactiveTargetEdgesPx={FACE_HIT_EDGES}
                accessibilityLabel={readBotFaceLabel(face)}
                tooltip={face.name}
                tooltipPlacement={tooltipPlacement}
                onLongPress={menu.openMenu}
                onContextMenu={menu.onContextMenu}
                onKeyDown={menu.onKeyDown}
                onPress={() => props.handlers.onOpen(face)}
                icon={
                  <BotFaceMarker
                    facts={face.face}
                    size={NOTCH_FACE_WING_SIZE}
                    activity={face.activity}
                    monochrome={!face.live}
                    planeColor={theme.colors.overlay.notch}
                    dotTestID={`desktop-activity-overlay-face-${face.sessionId}-needs-you`}
                  />
                }
              />
            )}
          />
        ))}
        {more > 0 ? (
          <Pressable
            testID="desktop-activity-overlay-faces-more"
            accessibilityRole="button"
            accessibilityLabel={t('settingsDesktop.overlay.notchMoreBots', {
              count: more,
            })}
            onPress={props.onMore}
            style={(state) => [
              styles.more,
              state.pressed
                ? { opacity: motionTokens.press.opacitySubtle }
                : null,
              createDesktopActivityOverlayFocusRingStyle(
                theme,
                (state as DesktopActivityOverlayPressableInteractionState)
                  .focused,
              ),
            ]}
          >
            <Text variant="meta" style={styles.moreText}>{`+${more}`}</Text>
          </Pressable>
        ) : null}
      </View>
    );
  },
);

/** The strip's gap between faces (lab `.nt-strip`, `theme.space.s10`); each face's hit area reaches half of it. */
const FACE_GAP_PX = 10;
/**
 * Each face reaches half the strip gap along the strip and the island's full thickness across it, so
 * neighbouring hit areas meet without overlapping (C03) and a press anywhere on the black lands.
 */
const FACE_HIT_EDGES = Object.freeze({
    leading: FACE_GAP_PX / 2,
    trailing: FACE_GAP_PX / 2,
    top: (PAGE_LIST_METRICS.controlHeightPx - NOTCH_FACE_WING_SIZE) / 2,
    bottom: (PAGE_LIST_METRICS.controlHeightPx - NOTCH_FACE_WING_SIZE) / 2,
});

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s10,
  },
  column: {
    flexDirection: 'column',
    alignItems: 'center',
    gap: theme.space.s10,
  },
  more: {
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.space.s2,
  },
  moreText: {
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
}));

/**
 * One Bot in the opened list (lab `ntdock-T` expanded): the shared face with its marker at the panel's
 * face slot, the name, what it is doing (amber when it needs you) and its age in the tabular meta
 * column. It opens like its face, and its menu is the face's menu.
 */
export const DesktopActivityOverlayBotRow = React.memo(function DesktopActivityOverlayBotRow(
    props: Readonly<{
        face: BotFaceSnapshot;
        handlers: NotchBotHandlers;
        pressableRef?: React.Ref<View>;
        /** How many asks it heads (0: none); it then says where it runs, its Session's context line. */
        askCount?: number;
        askContext?: string | null;
    }>,
) {
    const { theme } = useUnistyles();
    const { face } = props;
    const askCount = props.askCount ?? 0;
    const readNextRefresh = React.useCallback(
        (nowMs: number) => readRelativeTimeShortRefreshAtMs(face.meaningfulActivityAt, nowMs),
        [face.meaningfulActivityAt],
    );
    const nowMs = useSessionListRuntimeDeadlineNowMs(readNextRefresh, face.meaningfulActivityAt > 0);
    return (
        <NotchBotMenu
            face={face}
            handlers={props.handlers}
            testID={`desktop-activity-overlay-bot-row-menu-${face.sessionId}`}
            trigger={(menu) => (
                <DesktopActivityOverlaySessionRow
                    testID={`desktop-activity-overlay-bot-row-${face.sessionId}`}
                    visualMode="notch_integrated"
                    pressableRef={props.pressableRef}
                    title={face.name}
                    subtitle={askCount > 0 ? props.askContext ?? null : null}
                    statusText={face.currentLine}
                    previewText={null}
                    tone={face.activity === 'needsYou' ? 'attention' : 'neutral'}
                    asking={askCount > 0 ? { count: askCount } : null}
                    agentId={face.agentId}
                    machineId={face.machineId}
                    serverId={face.serverId}
                    meta={face.meaningfulActivityAt > 0 ? formatRelativeTimeShort(face.meaningfulActivityAt, nowMs) : null}
                    leading={(
                        <BotFaceMarker
                            facts={face.face}
                            size={NOTCH_FACE_PANEL_SIZE}
                            activity={face.activity}
                            monochrome={!face.live}
                            planeColor={theme.colors.overlay.notch}
                        />
                    )}
                    onPress={() => props.handlers.onOpen(face)}
                    onContextMenu={menu.onContextMenu}
                    onKeyDown={menu.onKeyDown}
                />
            )}
        />
    );
});
