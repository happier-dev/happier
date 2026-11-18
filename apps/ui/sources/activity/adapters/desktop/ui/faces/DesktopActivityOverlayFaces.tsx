import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { BotFaceMarker } from '@/components/sessions/bots/BotFaceMarker';
import { SessionBotFace } from '@/components/sessions/bots/face/SessionBotFace';
import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import { AppRailBadge } from '@/components/navigation/shell/appRail/AppRailBadge';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { createActivitySurfaceSessionRoute } from '@/activity/actions/activitySurfaceTargets';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { useWorkspaceOpenActions, WORKSPACE_OPEN_IN_WINDOW_ID } from '@/components/appShell/workspace/useWorkspaceOpenActions';
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
import type { DesktopActivityOverlayAttentionMark } from '../../presentation/model/desktopActivityOverlayModelTypes';
import { resolveNotchRestMarkShiftPx, resolveNotchRestMarks } from './notchRestMarks';
import { createDesktopActivityOverlayFocusRingStyle } from '../DesktopActivityOverlayChrome';
import { DESKTOP_ACTIVITY_OVERLAY_AGENT_MARK_SIZE, DESKTOP_ACTIVITY_OVERLAY_ROW_LEADING_SIZE, DesktopActivityOverlaySessionRow } from '../DesktopActivityOverlaySessionRow';
import type { DesktopActivityOverlayPressableInteractionState } from '../DesktopActivityOverlayPressableInteractionState';

/** "Four, then +N" (DESIGN.md, lab `ntfaces`): the wing draws the first four; every member stays in the list. */
export const NOTCH_FACES_SHOWN = 4;
/** The Inbox slot in the wing; the rail slot in the panel header and Bot rows (living-bots R1/R5). */
export const NOTCH_FACE_WING_SIZE = 20;
export const NOTCH_FACE_PANEL_SIZE = DESKTOP_ACTIVITY_OVERLAY_ROW_LEADING_SIZE;
/** An Agent mark on the island, in rows and in the side stack (owner 2026-11-18: 14, no setting). */
export const NOTCH_AGENT_MARK_SIZE = DESKTOP_ACTIVITY_OVERLAY_AGENT_MARK_SIZE;

export type NotchConversationPresentation = 'overlay' | 'window';
export type NotchConversationTarget = Readonly<{ sessionId: string; serverId: string | null }>;
export type NotchConversationHandlers = Readonly<{
  /** A click, Enter or Space: the person's notch preference decides where. */
  onOpen: (target: NotchConversationTarget) => void;
  /** A menu choice: the presentation is explicit. */
  onOpenIn: (
    target: NotchConversationTarget,
    presentation: NotchConversationPresentation,
  ) => void;
}>;

const OPEN_IN_OVERLAY_ID = 'notch.conversation.open.overlay';

/** The accessible name the rail pins use: the Bot's name, plus its state when it speaks. */
export function readBotFaceLabel(face: BotFaceSnapshot): string {
  return face.activity === 'needsYou'
    ? t('bots.roster.rowNeedsYou', { name: face.name })
    : face.activity === 'working'
      ? t('bots.roster.rowWorking', { name: face.name })
      : face.name;
}

/**
 * The conversation opener menu (lab `ntwin-R`, notch side): the shared "Open in window" and "Open in the overlay".
 * Pointer right-click, Shift+F10 and the Menu key open it at its trigger, from faces and Session rows alike.
 */
export function NotchConversationMenu(
  props: Readonly<{
    target: NotchConversationTarget;
    handlers: NotchConversationHandlers;
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
  const { target, handlers } = props;
  // The shared builder decides "Open in window" (and whether this computer can); the notch adds the overlay.
  const presentationAction = React.useMemo(() => ({
    item: {
      id: OPEN_IN_OVERLAY_ID,
      testID: `${props.testID}-overlay`,
      title: t('settingsDesktop.overlay.notchOpenInOverlay'),
      icon: <Icon name="push-pin" size={16} color={theme.colors.text.secondary} />,
    },
    onSelect: () => handlers.onOpenIn(target, 'overlay'),
  }), [target, handlers, props.testID, theme.colors.text.secondary]);
  const openActions = useWorkspaceOpenActions(createActivitySurfaceSessionRoute(target.sessionId, target.serverId), undefined, { presentationAction });
  return (
    <DropdownMenu
      testID={props.testID}
      open={open}
      onOpenChange={setOpen}
      items={openActions.presentationItems}
      onSelect={(id) => {
        // The island has no Sync of its own: its window request reaches main as the same session.open.
        if (id === WORKSPACE_OPEN_IN_WINDOW_ID) handlers.onOpenIn(target, 'window');
        else openActions.select(id);
      }}
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
 * opens that Bot's conversation. On Top and Floating; the side docks rest as `DesktopActivityOverlayRestMarks`. Every face
 * keeps its identity across republications (the producer reuses unchanged entries), so a state change
 * re-renders that face's marker only.
 */
export const DesktopActivityOverlayFaces = React.memo(
  function DesktopActivityOverlayFaces(
    props: Readonly<{
      faces: NotchBotFaces;
      handlers: NotchConversationHandlers;
      /** "+N": opens the list, where every member is reachable. */
      onMore: () => void;
    }>,
  ) {
    const { theme } = useUnistyles();
    const shown = props.faces.faces.slice(0, NOTCH_FACES_SHOWN);
    const more = props.faces.faces.length - shown.length;
    if (shown.length === 0) return null;
    return (
      <View
        testID="desktop-activity-overlay-faces"
        style={styles.row}
      >
        {shown.map((face) => (
          <NotchFaceButton
            key={`${face.serverId}:${face.sessionId}`}
            face={face}
            handlers={props.handlers}
            column={false}
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

/** One face in a strip: a press opens that Bot's conversation, a right-click or long press its menu. */
function NotchFaceButton(props: Readonly<{
  face: BotFaceSnapshot;
  handlers: NotchConversationHandlers;
  column: boolean;
}>) {
  const { theme } = useUnistyles();
  const { face } = props;
  return (
    <NotchConversationMenu
      target={face}
      handlers={props.handlers}
      testID={`desktop-activity-overlay-face-menu-${face.sessionId}`}
      placement={props.column ? 'right' : 'bottom'}
      trigger={(menu) => (
        <IconButton
          testID={`desktop-activity-overlay-face-${face.sessionId}`}
          variant="plain"
          size={NOTCH_FACE_WING_SIZE}
          interactiveTargetEdgesPx={FACE_HIT_EDGES}
          accessibilityLabel={readBotFaceLabel(face)}
          tooltip={face.name}
          tooltipPlacement={props.column ? 'right' : 'bottom'}
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
  );
}

/**
 * A Session that needs you, at a side dock's rest (lab `ntshape` R): its Bot face or its Agent mark at the
 * faces slot, with the face marker's needs-you dot. The column's press opens the list, where it acts.
 */
function NotchSessionMark(props: Readonly<{ mark: DesktopActivityOverlayAttentionMark }>) {
  const { theme } = useUnistyles();
  const { mark } = props;
  const size = mark.botFace ? NOTCH_FACE_WING_SIZE : NOTCH_AGENT_MARK_SIZE;
  return (
    <View testID={`desktop-activity-overlay-rest-mark-${mark.sessionId}`} style={styles.markSlot}>
      <View style={{ width: size, height: size }}>
        {mark.botFace ? (
          <SessionBotFace facts={mark.botFace} size={size} mood="needsYou" />
        ) : (
          <SessionAgentCatalogIdentityIcon
            agentId={mark.agentId ?? ''}
            machineId={mark.machineId}
            serverId={mark.serverId}
            color={theme.colors.text.secondary}
            size={size}
          />
        )}
        <AppRailBadge
          signal={NEEDS_YOU_DOT}
          glyphSizePx={size}
          corner="bottomRight"
          ringColor={theme.colors.overlay.notch}
        />
      </View>
    </View>
  );
}

const NEEDS_YOU_DOT = Object.freeze({ kind: 'dot', tone: 'attention' } as const);

/**
 * A side dock at rest (lab `ntshape` R): a slim column of what needs you, Bots by their face and Sessions by
 * their mark, then the other Show-Bots faces; three, then "+N". No text: the list says the rest.
 */
export const DesktopActivityOverlayRestMarks = React.memo(function DesktopActivityOverlayRestMarks(
  props: Readonly<{
    faces: readonly BotFaceSnapshot[];
    attention: readonly DesktopActivityOverlayAttentionMark[];
    handlers: NotchConversationHandlers;
  }>,
) {
  const { shown, more } = resolveNotchRestMarks(props.faces, props.attention);
  if (shown.length === 0) return null;
  return (
    <View testID="desktop-activity-overlay-rest-marks" style={styles.column}>
      {shown.map((mark) => (
        <View key={mark.kind === 'face' ? `face:${mark.face.serverId}:${mark.face.sessionId}` : `session:${mark.mark.serverId}:${mark.mark.sessionId}`}
          style={styles.markShift}>
          {mark.kind === 'face'
            ? <NotchFaceButton face={mark.face} handlers={props.handlers} column />
            : <NotchSessionMark mark={mark.mark} />}
        </View>
      ))}
      {more > 0 ? (
        <Text testID="desktop-activity-overlay-rest-more" variant="micro" style={styles.restMore}>{`+${more}`}</Text>
      ) : null}
    </View>
  );
});

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
  // A Session mark keeps the faces' slot, so a stack of faces and marks keeps one pitch.
  markSlot: {
    width: NOTCH_FACE_WING_SIZE,
    height: NOTCH_FACE_WING_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markShift: {
    transform: [{ translateX: resolveNotchRestMarkShiftPx() }],
  },
  // "+N" sits under the last mark a step closer than the marks' own gap.
  restMore: {
    marginTop: -theme.space.s4,
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
        handlers: NotchConversationHandlers;
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
        <NotchConversationMenu
            target={face}
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
                    liftKey={face.sessionId}
                    onPress={() => props.handlers.onOpen(face)}
                    onContextMenu={menu.onContextMenu}
                    onKeyDown={menu.onKeyDown}
                />
            )}
        />
    );
});
