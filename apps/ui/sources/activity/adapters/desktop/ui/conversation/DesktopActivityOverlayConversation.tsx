import * as React from 'react';
import { ScrollView, View, type LayoutChangeEvent } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { BotFaceMarker } from '@/components/sessions/bots/BotFaceMarker';
import { SessionBotFace } from '@/components/sessions/bots/face/SessionBotFace';
import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import { UserMessageBubble } from '@/components/sessions/transcript/UserMessageBubble';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { playElementRectFlight } from '@/components/ui/motion/rectFlight';
import { resolveVerticalScrollEdgeMaskStyle } from '@/components/ui/scroll/resolveScrollEdgeMaskStyle';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { HAPPIER_PAGE_METRICS, HappierPageSectionContext } from '@happier-dev/plugin-ui/presentation';
import { DESKTOP_ACTIVITY_OVERLAY_LINE_ON_CONTENT_EDGE, resolveDesktopActivityOverlayPanelInsets } from '../desktopActivityOverlayPanelInsets';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { workStatusWordStyle } from '@/components/work/status/workStatusTreatment';
import { t } from '@/text';
import {
  formatRelativeTimeShort,
  readRelativeTimeShortRefreshAtMs,
} from '@/utils/time/formatShortRelativeTime';

import type {
  BotFaceSnapshot,
  PinnedDesktopOverlayConversation,
} from '../../presentation/notchBotTypes';
import { DesktopActivityOverlayExpandedCards } from '../cards/DesktopActivityOverlayExpandedCards';
import { DesktopActivityOverlayPinButton } from '../DesktopActivityOverlayPinButton';
import {
  DESKTOP_ACTIVITY_OVERLAY_AGENT_MARK_SIZE,
  DesktopActivityOverlayContextLine,
} from '../DesktopActivityOverlaySessionRow';
import { DesktopActivityOverlayConversationLiftContext } from './conversationLift';
import { resolveConversationTurnsLayout } from './conversationTurnsLayout';
import { DesktopActivityOverlayPanelRoomContext } from '../panelRoom';
import { DesktopActivityOverlayQuickReplyComposer } from '../quickReply/DesktopActivityOverlayQuickReplyComposer';
import type { DesktopActivityOverlayFocusTargetRef } from '../resolveDesktopActivityOverlayInitialFocusTarget';
import type {
    DesktopActivityOverlayActionHandler,
  DesktopActivityOverlayExpandedCard,
  DesktopActivityOverlaySessionRowModel,
} from '../shared/desktopActivityOverlayUiModel';


/** "Needs you · 6 min": the Bot's state word in the attention owner's words, then its age, ticking in this leaf only. */
function BotStateLine(
  props: Readonly<{ face: BotFaceSnapshot }>,
): React.ReactElement {
  const { face } = props;
  const readNextRefresh = React.useCallback(
    (nowMs: number) =>
      readRelativeTimeShortRefreshAtMs(face.meaningfulActivityAt, nowMs),
    [face.meaningfulActivityAt],
  );
  const nowMs = useSessionListRuntimeDeadlineNowMs(
    readNextRefresh,
    face.meaningfulActivityAt > 0,
  );
  const word =
    face.activity === 'needsYou'
      ? t('workStatus.buckets.needs_you')
      : face.activity === 'working'
        ? t('workStatus.buckets.working')
        : null;
  const age =
    face.meaningfulActivityAt > 0
      ? formatRelativeTimeShort(face.meaningfulActivityAt, nowMs)
      : null;
  const text = [word, age].filter(Boolean).join(' · ');
  return (
    <Text
      testID="desktop-activity-overlay-conversation-state"
      variant="meta"
      numberOfLines={1}
      style={face.activity === 'needsYou' ? styles.stateNeedsYou : styles.state}
    >
      {text}
    </Text>
  );
}

/**
 * A Session pinned in the notch, with its recent messages, asks and reply field.
 * The chrome stays mounted as the content changes to the selected Session.
 */
export function DesktopActivityOverlayConversation(
  props: Readonly<{
    conversation: PinnedDesktopOverlayConversation;
    /** The pinned Bot's face entry; a plain Session (or a Bot demoted while pinned) has none. */
    face: BotFaceSnapshot | null;
    /**
     * The pinned Session's row from the open list: its name, state and where it runs. The header is that row,
     * lifted to the top, so it reads the same (lab `ntshape` C).
     */
    row: DesktopActivityOverlaySessionRowModel | null;
    cards: readonly DesktopActivityOverlayExpandedCard[];
    phrases: readonly string[];
    draft: string;
    draftWriteError: string | null;
    onRetryDraft: () => void;
    initialFocusRef?: DesktopActivityOverlayFocusTargetRef;
    onDraftChange: (draft: string) => void;
    onSend: React.ComponentProps<typeof DesktopActivityOverlayQuickReplyComposer>['onSend'];
    onBack: () => void;
    onUnpin: () => void;
    /** Opens the same Session in its window; resolves whether a window opened or was focused. */
    onExtract: () => Promise<boolean>;
    onAction: DesktopActivityOverlayActionHandler;
    onDismissKey: () => void;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const reducedMotion = useReducedMotionPreference();
  const { conversation, face } = props;
  const row = props.row;
  const name = face?.name ?? row?.title ?? '';
  const context = row?.subtitle ?? null;
  const [extract, setExtract] = React.useState<'idle' | 'opening' | 'failed'>(
    'idle',
  );
  const targetKey = JSON.stringify([conversation.serverId, conversation.accountId, conversation.sessionId]);
  React.useEffect(() => {
    setExtract('idle');
  }, [targetKey]);
  const runExtract = React.useCallback(() => {
    setExtract('opening');
    void props.onExtract().then(
      (opened) => setExtract(opened ? 'idle' : 'failed'),
      () => setExtract('failed'),
    );
  }, [props.onExtract]);
  const asking = props.cards.length > 0;
  const cardsModel = React.useMemo(
    () => ({ expanded: { title: '', rows: [], cards: props.cards } }),
    [props.cards],
  );
  const reply = conversation.reply;
  // The pressed row lifts into this header: one flight from where it stood, once per opened Session.
  const lift = React.useContext(DesktopActivityOverlayConversationLiftContext);
  const liftRef = React.useRef<View | null>(null);
  React.useLayoutEffect(() => {
    const origin = lift?.take(conversation.sessionId) ?? null;
    if (!origin || reducedMotion) return;
    playElementRectFlight(liftRef.current as unknown as HTMLElement, origin, {
      animationId: 'notch-conversation-lift',
      durationMs: motionTokens.durationMs.base,
      translateOnly: true,
    });
  }, [conversation.sessionId, lift, reducedMotion]);
  const turnsRef = React.useRef<ScrollView | null>(null);
  const turnFades = useScrollEdgeFades({ enabledEdges: { top: true, bottom: false }, overflowThreshold: 2, edgeThreshold: 2 });
  const turnMask = React.useMemo(
    () => resolveVerticalScrollEdgeMaskStyle(turnFades.visibility, { fadeSize: theme.space.s16 }),
    [turnFades.visibility, theme.space.s16],
  );
  const onTurnsContentSizeChange = turnFades.onContentSizeChange;
  // The turns grow into the panel's room and scroll only past it (owner 11-19); the island asks the planner
  // for every turn, so the conversation grows to the screen's height.
  const room = React.useContext(DesktopActivityOverlayPanelRoomContext);
  const [measured, setMeasured] = React.useState({ container: 0, turnsViewport: 0, turnsContent: 0 });
  const measure = React.useCallback((key: keyof typeof measured, value: number) => {
    setMeasured((previous) => previous[key] === value ? previous : { ...previous, [key]: value });
  }, []);
  const turnsShown = conversation.reply.state === 'ready' && conversation.reply.messages.length > 0;
  const turnsLayout = resolveConversationTurnsLayout({
    available: turnsShown ? room?.available ?? null : null,
    chromeHeight: Math.max(0, measured.container - measured.turnsViewport),
    turnsContentHeight: measured.turnsContent,
  });
  const reportOverflow = room?.reportOverflow;
  React.useEffect(() => {
    reportOverflow?.(turnsLayout.overflow);
  }, [reportOverflow, turnsLayout.overflow]);
  React.useEffect(() => () => reportOverflow?.(0), [reportOverflow]);
  // Newest at the bottom: the area opens on the latest turn and follows new ones.
  const followLatest = React.useCallback((width: number, height: number) => {
    onTurnsContentSizeChange(width, height);
    measure('turnsContent', height);
    turnsRef.current?.scrollToEnd({ animated: false });
  }, [measure, onTurnsContentSizeChange]);
  const onTurnsViewportLayout = turnFades.onViewportLayout;
  const handleTurnsLayout = React.useCallback((event: LayoutChangeEvent) => {
    onTurnsViewportLayout(event);
    measure('turnsViewport', event.nativeEvent.layout.height);
    // The room changed with the island: keep the newest turn in view.
    turnsRef.current?.scrollToEnd({ animated: false });
  }, [measure, onTurnsViewportLayout]);
  const handleContainerLayout = React.useCallback((event: LayoutChangeEvent) => {
    measure('container', event.nativeEvent.layout.height);
  }, [measure]);

  return (
    <View
      testID="desktop-activity-overlay-conversation"
      style={styles.container}
      onLayout={handleContainerLayout}
    >
      <View
        testID="desktop-activity-overlay-conversation-header"
        style={styles.header}
      >
        <IconButton
          testID="desktop-activity-overlay-conversation-back"
          variant="plain"
          iconName="caret-left"
          iconSize={DESKTOP_ACTIVITY_OVERLAY_AGENT_MARK_SIZE}
          accessibilityLabel={t('settingsDesktop.overlay.notchBack')}
          tooltip={t('settingsDesktop.overlay.notchBack')}
          onPress={props.onBack}
        />
        <View ref={liftRef} testID="desktop-activity-overlay-conversation-identity" style={styles.identity}>
          <View style={styles.mark}>
            {face ? (
              <BotFaceMarker
                facts={face.face}
                size={HAPPIER_PAGE_METRICS.pageHeaderMarkGlyphPx}
                activity={face.activity}
                monochrome={!face.live}
                planeColor={theme.colors.overlay.stageImmersive}
              />
            ) : row?.botFace ? (
              <SessionBotFace facts={row.botFace} size={HAPPIER_PAGE_METRICS.pageHeaderMarkGlyphPx} />
            ) : row?.agentId ? (
              <SessionAgentCatalogIdentityIcon
                agentId={row.agentId}
                machineId={row.machineId ?? null}
                serverId={conversation.serverId}
                color={theme.colors.text.secondary}
                size={DESKTOP_ACTIVITY_OVERLAY_AGENT_MARK_SIZE}
              />
            ) : null}
          </View>
          <View style={styles.identityText}>
            <Text
              testID="desktop-activity-overlay-conversation-name"
              variant="body"
              emphasis="medium"
              numberOfLines={1}
              style={styles.name}
            >
              {name}
            </Text>
            {asking && context ? (
              <DesktopActivityOverlayContextLine
                testID="desktop-activity-overlay-conversation-context"
                agentId={face ? face.agentId : null}
                machineId={face?.machineId}
                serverId={conversation.serverId}
                text={context}
              />
            ) : face ? (
              <BotStateLine face={face} />
            ) : row?.statusText || context ? (
              <Text testID="desktop-activity-overlay-conversation-state" variant="meta" numberOfLines={1} style={styles.state}>
                {row?.statusText ? <Text variant="meta" style={workStatusWordStyle(row.tone ?? 'neutral')}>{row.statusText}</Text> : null}
                {row?.statusText && context ? ' · ' : null}
                {context}
              </Text>
            ) : null}
          </View>
        </View>
        <IconButton
          testID="desktop-activity-overlay-conversation-extract"
          variant="plain"
          iconName="arrow-square-out"
          iconSize={DESKTOP_ACTIVITY_OVERLAY_AGENT_MARK_SIZE}
          accessibilityLabel={t('settingsDesktop.overlay.notchOpenInWindow')}
          tooltip={t('settingsDesktop.overlay.notchOpenInWindow')}
          busy={extract === 'opening'}
          onPress={runExtract}
        />
        <DesktopActivityOverlayPinButton
          testID="desktop-activity-overlay-conversation-pin"
          pinned
          onPress={props.onUnpin}
        />
      </View>
      <Animated.View
        key={targetKey}
        entering={
          reducedMotion
            ? undefined
            : FadeIn.duration(motionTokens.durationMs.fast)
        }
        style={styles.body}
      >
        {reply.state === 'hidden' ? (
          <View
            testID="desktop-activity-overlay-conversation-hidden"
            style={styles.hidden}
          >
            <Text variant="body" style={styles.secondary}>
              {t('settingsDesktop.overlay.notchHiddenReply')}
            </Text>
            <View style={styles.hiddenAction}>
              <RoundButton
                size="small"
                display="secondary"
                title={t('settingsDesktop.overlay.notchOpenInWindow')}
                loading={extract === 'opening'}
                onPress={runExtract}
              />
            </View>
          </View>
        ) : reply.state === 'loading' ? (
          <SurfaceStateCard
            kind="loading"
            size="line"
            title={t('common.loading')}
          />
        ) : reply.state === 'ready' && reply.messages.length > 0 ? (
          <ScrollView
            ref={turnsRef}
            testID="desktop-activity-overlay-conversation-turns"
            style={[styles.turns, { maxHeight: turnsLayout.maxHeight }, turnMask]}
            contentContainerStyle={styles.turnsContent}
            showsVerticalScrollIndicator={false}
            scrollEventThrottle={16}
            onLayout={handleTurnsLayout}
            onContentSizeChange={followLatest}
            onScroll={turnFades.onScroll}
            onMomentumScrollEnd={turnFades.onMomentumScrollEnd}
          >
            {reply.messages.map((message) => message.role === 'user' ? (
              <View key={message.id} style={styles.yourTurn}>
                <UserMessageBubble testID="desktop-activity-overlay-conversation-yours">
                  <Text variant="body" style={styles.reply}>{message.text}</Text>
                </UserMessageBubble>
              </View>
            ) : (
              <Text
                key={message.id}
                testID="desktop-activity-overlay-conversation-reply"
                variant="body"
                style={[styles.reply, styles.agentTurn]}
              >
                {message.text}
              </Text>
            ))}
          </ScrollView>
        ) : (
          <Text variant="body" style={styles.secondary}>
            {t('settingsDesktop.overlay.notchNoReply')}
          </Text>
        )}
        {face?.activity === 'working' && face.currentLine ? (
          <View
            testID="desktop-activity-overlay-conversation-activity"
            style={styles.activity}
          >
            <ActivitySpinner
              size={theme.space.s12}
              color={theme.colors.text.primary}
              animationEnabled={!reducedMotion}
            />
            <Text variant="body" numberOfLines={1} style={styles.secondary}>
              {face.currentLine}
            </Text>
          </View>
        ) : null}
        {conversation.refreshing && reply.state === 'ready' ? (
          <DesktopActivityOverlayEdgeLine
            testID="desktop-activity-overlay-conversation-refreshing"
            busy
            reason={t('settingsDesktop.overlay.notchUpdating')}
          />
        ) : null}
        {!conversation.reachable ? (
          <DesktopActivityOverlayEdgeLine
            testID="desktop-activity-overlay-conversation-unreachable"
            tone="warning"
            glyph="wifi-slash"
            reason={t('settingsDesktop.overlay.notchUnreachable')}
          />
        ) : null}
        {extract === 'failed' ? (
          <DesktopActivityOverlayEdgeLine
            testID="desktop-activity-overlay-conversation-extract-failed"
            tone="warning"
            reason={t('settingsDesktop.overlay.notchOpenWindowFailed')}
            action={{ label: t('common.retry'), onPress: runExtract }}
          />
        ) : null}
        {asking ? (
          <DesktopActivityOverlayExpandedCards
            model={cardsModel}
            askerShown
            visualMode="notch_integrated"
            onOpenSession={() => runExtract()}
            onAction={props.onAction}
            onDismissKey={props.onDismissKey}
          />
        ) : null}
        {props.draftWriteError ? (
          <DesktopActivityOverlayEdgeLine
            testID="desktop-activity-overlay-conversation-draft-failed"
            tone="warning"
            reason={t('common.saveError')}
            action={{
              testID: 'desktop-activity-overlay-conversation-draft-retry',
              label: t('common.retry'),
              onPress: props.onRetryDraft,
            }}
          />
        ) : null}
        <DesktopActivityOverlayQuickReplyComposer
          visualMode="notch_integrated"
          // A pending ask is answered on its card; phrases return once it is settled (lab ntconvo-T).
          phrases={asking ? [] : props.phrases}
          draft={props.draft}
          placeholder={t('settingsDesktop.overlay.notchReplyTo', { name })}
          inputRef={asking ? undefined : props.initialFocusRef}
          onDraftChange={props.onDraftChange}
          onSend={props.onSend}
          onDismissKey={props.onDismissKey}
        />
      </Animated.View>
    </View>
  );
}

/** A banner on the conversation's content edge, not inset again by a list's tool inset (O9). */
function DesktopActivityOverlayEdgeLine(props: React.ComponentProps<typeof SurfaceFreshnessLine>): React.ReactElement {
  return (
    <HappierPageSectionContext.Provider value={DESKTOP_ACTIVITY_OVERLAY_LINE_ON_CONTENT_EDGE}>
      <SurfaceFreshnessLine {...props} />
    </HappierPageSectionContext.Provider>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.space.s10,
  },
  // Lab `.nt-ph`: one row at the small control height; Back hugs the panel's leading edge.
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    // Back sits close to the identity it returns from (owner 11-19 O9).
    gap: theme.space.s4,
    minHeight: PAGE_LIST_METRICS.smallControlHeightPx,
  },
  // The list row's anatomy (`DesktopActivityOverlaySessionRow`): mark slot, then name over state · where.
  identity: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s10,
  },
  // The header's face reads a step up from the rows' (the page header's mark glyph): it is the asker.
  mark: {
    width: HAPPIER_PAGE_METRICS.pageHeaderMarkGlyphPx,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  identityText: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    color: theme.colors.text.primary,
  },
  state: {
    color: theme.colors.text.secondary,
  },
  stateNeedsYou: {
    color: theme.colors.state.attention.textForeground,
    flexShrink: 0,
  },
  // The turns, the Loading row, banners, asks and the reply field all stand on the panel's content edge.
  body: {
    gap: theme.space.s10,
    paddingHorizontal: resolveDesktopActivityOverlayPanelInsets(theme).content,
  },
  reply: {
    color: theme.colors.text.primary,
  },
  turns: {
    flexGrow: 0,
  },
  turnsContent: {
    gap: theme.space.s8,
  },
  // Your turns stand right in the transcript's own bubble; the agent's read as plain text (lab `ntshape` C).
  yourTurn: {
    alignSelf: 'flex-end',
    maxWidth: '85%',
  },
  agentTurn: {
    alignSelf: 'stretch',
  },
  secondary: {
    color: theme.colors.text.secondary,
    flexShrink: 1,
  },
  activity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  hidden: {
    gap: theme.space.s8,
  },
  hiddenAction: {
    flexDirection: 'row',
  },
}));
