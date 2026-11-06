import * as React from 'react';
import { View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { BotFaceMarker } from '@/components/sessions/bots/BotFaceMarker';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
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
import { DesktopActivityOverlayContextLine } from '../DesktopActivityOverlaySessionRow';
import { NOTCH_FACE_PANEL_SIZE } from '../faces/DesktopActivityOverlayFaces';
import { DesktopActivityOverlayQuickReplyComposer } from '../quickReply/DesktopActivityOverlayQuickReplyComposer';
import type { DesktopActivityOverlayFocusTargetRef } from '../resolveDesktopActivityOverlayInitialFocusTarget';
import type {
    DesktopActivityOverlayActionHandler,
  DesktopActivityOverlayExpandedCard,
} from '../shared/desktopActivityOverlayUiModel';

/** The last reply is a glance, not a transcript (lab `.nt-reply`): four lines, then Extract reads the rest. */
const REPLY_MAX_LINES = 4;

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
      variant="body"
      numberOfLines={1}
      style={face.activity === 'needsYou' ? styles.stateNeedsYou : styles.state}
    >
      {text}
    </Text>
  );
}

/**
 * A Bot's conversation pinned in the island (lab `ntconvo-T`/`-S`): who it is and how it is, its last
 * reply, what it asks of you through the existing inline cards, and a reply to that Session. The
 * chrome (Back, Extract, pin) stays put; only the content below it is keyed by the Bot, so switching
 * Bots cross-fades the body in place.
 */
export function DesktopActivityOverlayConversation(
  props: Readonly<{
    conversation: PinnedDesktopOverlayConversation;
    /** The pinned Bot's face entry; a Bot demoted while pinned keeps its last name through `fallbackName`. */
    face: BotFaceSnapshot | null;
    fallbackName: string;
    /** Where it runs (its Session's context line), shown instead of its state while it asks. */
    context: string | null;
    cards: readonly DesktopActivityOverlayExpandedCard[];
    phrases: readonly string[];
    draft: string;
    draftWriteError: string | null;
    onRetryDraft: () => void;
    initialFocusRef?: DesktopActivityOverlayFocusTargetRef;
    onDraftChange: (draft: string) => void;
    onSend: (message: string) => Promise<boolean>;
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
  const name = face?.name ?? props.fallbackName;
  const [extract, setExtract] = React.useState<'idle' | 'opening' | 'failed'>(
    'idle',
  );
  const targetKey = `${conversation.serverId}:${conversation.sessionId}`;
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

  return (
    <View
      testID="desktop-activity-overlay-conversation"
      style={styles.container}
    >
      <View
        testID="desktop-activity-overlay-conversation-header"
        style={styles.header}
      >
        <IconButton
          testID="desktop-activity-overlay-conversation-back"
          variant="plain"
          iconName="caret-left"
          accessibilityLabel={t('settingsDesktop.overlay.notchBack')}
          tooltip={t('settingsDesktop.overlay.notchBack')}
          onPress={props.onBack}
        />
        {face ? (
          <BotFaceMarker
            facts={face.face}
            size={NOTCH_FACE_PANEL_SIZE}
            activity={face.activity}
            monochrome={!face.live}
            planeColor={theme.colors.overlay.stageImmersive}
          />
        ) : null}
        <Text
          testID="desktop-activity-overlay-conversation-name"
          variant="label"
          emphasis="semiBold"
          numberOfLines={1}
          style={styles.name}
        >
          {name}
        </Text>
        {asking && props.context ? (
          <DesktopActivityOverlayContextLine
            testID="desktop-activity-overlay-conversation-context"
            agentId={face?.agentId}
            machineId={face?.machineId}
            serverId={conversation.serverId}
            text={props.context}
          />
        ) : face ? (
          <BotStateLine face={face} />
        ) : null}
        <View style={styles.grow} />
        <IconButton
          testID="desktop-activity-overlay-conversation-extract"
          variant="plain"
          iconName="arrow-square-out"
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
        ) : reply.state === 'ready' && reply.text ? (
          <Text
            testID="desktop-activity-overlay-conversation-reply"
            variant="body"
            numberOfLines={REPLY_MAX_LINES}
            style={styles.reply}
          >
            {reply.text}
          </Text>
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
          <SurfaceFreshnessLine
            testID="desktop-activity-overlay-conversation-refreshing"
            busy
            reason={t('settingsDesktop.overlay.notchUpdating')}
          />
        ) : null}
        {!conversation.reachable ? (
          <SurfaceFreshnessLine
            testID="desktop-activity-overlay-conversation-unreachable"
            tone="warning"
            glyph="wifi-slash"
            reason={t('settingsDesktop.overlay.notchUnreachable')}
          />
        ) : null}
        {extract === 'failed' ? (
          <SurfaceFreshnessLine
            testID="desktop-activity-overlay-conversation-extract-failed"
            tone="warning"
            reason={t('settingsDesktop.overlay.notchOpenWindowFailed')}
            action={{ label: t('common.retry'), onPress: runExtract }}
          />
        ) : null}
        {asking ? (
          <DesktopActivityOverlayExpandedCards
            model={cardsModel}
            visualMode="notch_integrated"
            onOpenSession={() => runExtract()}
            onAction={props.onAction}
            onDismissKey={props.onDismissKey}
          />
        ) : null}
        {props.draftWriteError ? (
          <SurfaceFreshnessLine
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

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.space.s10,
  },
  // Lab `.nt-ph`: one row at the small control height; Back hugs the panel's leading edge.
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    minHeight: PAGE_LIST_METRICS.smallControlHeightPx,
  },
  name: {
    color: theme.colors.text.primary,
    flexShrink: 1,
  },
  state: {
    color: theme.colors.text.secondary,
    flexShrink: 0,
  },
  stateNeedsYou: {
    color: theme.colors.state.attention.textForeground,
    flexShrink: 0,
  },
  grow: {
    flex: 1,
  },
  body: {
    gap: theme.space.s10,
  },
  reply: {
    color: theme.colors.text.primary,
    paddingHorizontal: theme.space.s4,
  },
  secondary: {
    color: theme.colors.text.secondary,
    flexShrink: 1,
  },
  activity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s4,
  },
  hidden: {
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s4,
  },
  hiddenAction: {
    flexDirection: 'row',
  },
}));
