import * as React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { RowActionRevealSlot } from '@/components/ui/lists/RowActionRevealSlot';
import { useItemRowHovered } from '@/components/ui/lists/ItemRowHover';
import { useCoarsePrimaryPointer } from '@/components/sessions/transcript/messageActions/rowActionRevealHost';
import { SurfaceFreshnessLine, SurfaceFreshnessOnSheetProvider } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import {
  sessionAddressKey,
  type SessionAddress,
} from '@/sync/domains/session/sessionAddress';
import { t } from '@/text';
import { formatRelativeTime } from '@/utils/time/formatShortRelativeTime';
import {
  getVoiceSessionSnapshot,
  subscribeToVoiceSessionSnapshot,
} from '@/voice/session/voiceSessionStore';

import { useVoiceConversationHistory } from './useVoiceConversationHistory';

/** One page row of the History list: the page virtualizes these, not the conversations inside them. */
export type VoiceHistoryPageRow = Readonly<{
  key: string;
  type: string;
  render: () => React.ReactElement;
}>;

type VoiceConversation = ReturnType<
  typeof useVoiceConversationHistory
>['conversations'][number];
type VoiceHistoryListPhase = NonNullable<
  ReturnType<typeof useVoiceConversationHistory>['states']['active']
>['phase'];

/** Conversations per page row; one sheet is cut into runs so only the visible runs mount. */
const CONVERSATIONS_PER_SEGMENT = 12;

const readVoiceIdle = () => getVoiceSessionSnapshot().status === 'disconnected';

/**
 * The Voice conversation list's settled state, read from the Session-list owner's own lifecycle: a
 * first read still pending, a page that failed or went offline, more pages behind it, and whether
 * what is loaded is the whole list. Nothing here fetches or retries on its own.
 */
function resolveListState(
  history: ReturnType<typeof useVoiceConversationHistory>,
) {
  const phases: readonly (VoiceHistoryListPhase | undefined)[] = [
    history.states.active?.phase,
    history.states.archived?.phase,
  ];
  const offline = phases.includes('offline');
  const failed = offline || phases.includes('error');
  const pending = phases.some(
    (phase) => phase === undefined || phase === 'idle' || phase === 'loading',
  );
  const busy = phases.some(
    (phase) => phase === 'loading' || phase === 'refreshing',
  );
  const freshness = [
    history.states.active?.freshnessAt,
    history.states.archived?.freshnessAt,
  ].filter((at): at is number => typeof at === 'number');
  return {
    offline,
    failed,
    pending,
    busy,
    asOf: freshness.length > 0 ? Math.min(...freshness) : null,
    hasMore: history.nextCursor !== null,
  };
}

/** Whether the row's actions sit beside its meta (touch: always shown) or take its place on engagement. */
function useContinueBesideMeta(): boolean {
  const coarsePrimaryPointer = useCoarsePrimaryPointer();
  return Platform.OS !== 'web' || coarsePrimaryPointer;
}

/**
 * Continue is quiet until the row is engaged and stays focusable. On touch it always shows, after the
 * time. With a fine pointer it reserves no width: the time keeps the trailing edge at rest, and Continue
 * takes its place while the row is hovered or focused (`onRevealChange` lets the row hide the time).
 */
function ConversationContinueSlot(props: Readonly<{
  children: React.ReactElement;
  besideMeta: boolean;
  onRevealChange: (revealed: boolean) => void;
}>) {
  const rowHovered = useItemRowHovered();
  const [focused, setFocused] = React.useState(false);
  const revealed = props.besideMeta || rowHovered || focused;
  const { onRevealChange } = props;
  React.useEffect(() => { onRevealChange(revealed); }, [onRevealChange, revealed]);
  const slot = (
    <RowActionRevealSlot
      revealed={revealed}
      style={props.besideMeta ? undefined : continueSlotStyles.overlay}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      {props.children}
    </RowActionRevealSlot>
  );
  return props.besideMeta ? slot : <View style={continueSlotStyles.anchor}>{slot}</View>;
}

const continueSlotStyles = StyleSheet.create({
  // A zero-width anchor at the row's trailing edge; the slot lies over the time it replaces.
  anchor: { alignSelf: 'stretch', width: 0 },
  overlay: { position: 'absolute', right: 0, top: 0, bottom: 0 },
});

const detailAtEdge = { marginRight: 0 } as const;
const detailYielded = { marginRight: 0, opacity: 0 } as const;

const VoiceConversationRow = React.memo(function VoiceConversationRow(
  props: Readonly<{
    conversation: VoiceConversation;
    continueAvailable: boolean;
    onContinue: (address: SessionAddress) => void;
    onOpen: (address: SessionAddress) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const { conversation } = props;
  const besideMeta = useContinueBesideMeta();
  const [continueRevealed, setContinueRevealed] = React.useState(false);
  // The meta column holds how long the conversation is (when its turns are loaded) and when it last spoke.
  const when = conversation.loadedMessageCount
    ? `${t('settingsVoice.history.transcriptMessageCount', { count: conversation.loadedMessageCount })} · ${formatRelativeTime(conversation.lastActivityAt)}`
    : formatRelativeTime(conversation.lastActivityAt);
  // Unknown eligibility (null) is not a refusal: Continue resolves that exact conversation.
  const retired = conversation.canContinue === false;
  // The time sits in the meta column; the description speaks only when the row needs something said.
  const subtitle = conversation.hasBlockedInputs
    ? t('workStatus.buckets.needs_you')
    : retired
      ? t('settingsVoice.history.conversationReadOnly')
      : undefined;
  return (
    <Item
      testID={`voice-history-conversation-${conversation.address.sessionId}`}
      title={conversation.title}
      titleLines={1}
      subtitle={subtitle}
      detail={when}
      // With a fine pointer the time owns the trailing edge and steps aside for Continue.
      detailStyle={besideMeta ? undefined : continueRevealed && !retired ? detailYielded : detailAtEdge}
      subtitleStyle={
        conversation.hasBlockedInputs
          ? { color: theme.colors.state.attention.textForeground }
          : undefined
      }
      accessibilityHint={t('settingsVoice.history.conversationOpenHint')}
      showChevron={false}
      accessoryLayout="inline"
      onPress={() => props.onOpen(conversation.address)}
      rightElementOutsidePressable
      rightElement={
        retired ? undefined : (
          <ConversationContinueSlot besideMeta={besideMeta} onRevealChange={setContinueRevealed}>
          <RoundButton
            testID={`voice-history-conversation-${conversation.address.sessionId}-continue`}
            size="small"
            display="secondary"
            title={t('settingsVoice.history.conversationContinue')}
            accessibilityLabel={t(
              'settingsVoice.history.conversationContinueLabel',
              { title: conversation.title },
            )}
            disabled={!props.continueAvailable}
            onPress={() => props.onContinue(conversation.address)}
          />
          </ConversationContinueSlot>
        )
      }
    />
  );
});

/**
 * The Voice conversations section of History as page rows: every conversation this person had with
 * Voice at this Home, newest first, from the ordinary Session list. A row opens its Session;
 * Continue resumes that exact conversation. Mounted only while History is open.
 */
export function useVoiceConversationHistoryRows(
  props: Readonly<{
    query?: string;
    onContinue: (address: SessionAddress) => void;
    onOpen: (address: SessionAddress) => void;
  }>,
): readonly VoiceHistoryPageRow[] {
  const history = useVoiceConversationHistory(props.query);
  const voiceIdle = React.useSyncExternalStore(
    subscribeToVoiceSessionSnapshot,
    readVoiceIdle,
    readVoiceIdle,
  );
  const state = resolveListState(history);
  const { conversations, loadNext, retry } = history;
  const { onContinue, onOpen } = props;
  const [loadingMore, setLoadingMore] = React.useState(false);
  const loadMore = React.useCallback(() => {
    setLoadingMore(true);
    void loadNext().finally(() => setLoadingMore(false));
  }, [loadNext]);
  const retryList = React.useCallback(() => {
    void retry();
  }, [retry]);
  const loadMoreBusy = loadingMore || (state.busy && !state.pending);

  return React.useMemo((): readonly VoiceHistoryPageRow[] => {
    // The page header already says what History is for; the section is named, not described again.
    const title = t('settingsVoice.history.conversationsTitle');
    const sectionState = (
      key: string,
      content: React.ReactElement,
    ): VoiceHistoryPageRow => ({
      key: `conversations:${key}`,
      type: 'conversations-state',
      render: () => (
        <ItemGroup title={title}>
          {content}
        </ItemGroup>
      ),
    });
    if (conversations.length === 0) {
      if (state.failed) {
        return [
          sectionState(
            'error',
            <SurfaceStateCard
              testID="voice-history-conversations-error"
              kind="error"
              size="line"
              title={t(
                state.offline
                  ? 'settingsVoice.history.conversationsOfflineTitle'
                  : 'settingsVoice.history.conversationsErrorTitle',
              )}
              action={{
                label: t('settingsVoice.history.retry'),
                onPress: retryList,
              }}
            />,
          ),
        ];
      }
      if (state.pending) {
        return [
          sectionState(
            'loading',
            <SurfaceStateCard
              testID="voice-history-conversations-loading"
              kind="loading"
              size="line"
              title={t('settingsVoice.history.conversationsLoading')}
            />,
          ),
        ];
      }
      // Only a settled list that is known to be whole is empty; anything else may hold more.
      if (history.coverageComplete && !state.hasMore) {
        return [
          {
            key: 'conversations:empty',
            type: 'conversations-state',
            render: () => (
              <ItemGroup title={title} surface="none">
                <EmptyState
                  testID="voice-history-conversations-empty"
                  layout="inline"
                  iconName="microphone"
                  title={t('settingsVoice.history.conversationsEmptyTitle')}
                  subtitle={t('settingsVoice.history.conversationsEmptyBody')}
                />
              </ItemGroup>
            ),
          },
        ];
      }
      return [
        sectionState(
          'none-loaded',
          <SurfaceStateCard
            testID="voice-history-conversations-none-loaded"
            kind="empty"
            size="line"
            title={t('settingsVoice.history.conversationsNoneLoaded')}
            action={
              state.hasMore && !loadMoreBusy
                ? {
                    label: t('settingsVoice.history.conversationsLoadMore'),
                    onPress: loadMore,
                  }
                : undefined
            }
          />,
        ),
      ];
    }

    const rows: VoiceHistoryPageRow[] = [];
    const footer = state.hasMore;
    for (
      let start = 0;
      start < conversations.length;
      start += CONVERSATIONS_PER_SEGMENT
    ) {
      const segment = conversations.slice(
        start,
        start + CONVERSATIONS_PER_SEGMENT,
      );
      const first = start === 0;
      const last =
        !footer && start + CONVERSATIONS_PER_SEGMENT >= conversations.length;
      rows.push({
        key: `conversations:rows:${sessionAddressKey(segment[0]!.address)}`,
        type: first ? 'conversations-first' : 'conversations-rows',
        render: () => (
          <ItemGroup
            title={first ? title : undefined}
            virtualizedSegment={{ first, last }}
          >
            {/* Known rows stay at full strength; one quiet line says they may be out of date. */}
            {first && state.failed ? (
              <SectionContentRow>
                <SurfaceFreshnessOnSheetProvider>
                  <SurfaceFreshnessLine
                    testID="voice-history-conversations-stale"
                    asOf={state.asOf}
                    reason={t(
                      state.offline
                        ? 'settingsVoice.history.conversationsOfflineTitle'
                        : 'settingsVoice.history.conversationsRefreshFailed',
                    )}
                    busy={state.busy}
                    action={{
                      label: t('settingsVoice.history.retry'),
                      onPress: retryList,
                    }}
                  />
                </SurfaceFreshnessOnSheetProvider>
              </SectionContentRow>
            ) : null}
            {segment.map((conversation) => (
              <VoiceConversationRow
                key={sessionAddressKey(conversation.address)}
                conversation={conversation}
                continueAvailable={voiceIdle}
                onContinue={onContinue}
                onOpen={onOpen}
              />
            ))}
          </ItemGroup>
        ),
      });
    }
    if (footer) {
      rows.push({
        key: 'conversations:more',
        type: 'conversations-more',
        render: () => (
          <ItemGroup virtualizedSegment={{ first: false, last: true }}>
            <Item
              testID="voice-history-conversations-load-more"
              title={
                loadMoreBusy
                  ? t('settingsVoice.history.conversationsLoadingMore')
                  : t('settingsVoice.history.conversationsLoadMore')
              }
              accessibilityRole="button"
              loading={loadMoreBusy}
              disabled={loadMoreBusy}
              showChevron={false}
              onPress={loadMore}
            />
          </ItemGroup>
        ),
      });
    }
    return rows;
  }, [
    conversations,
    history.coverageComplete,
    loadMore,
    loadMoreBusy,
    onContinue,
    onOpen,
    retryList,
    state.asOf,
    state.busy,
    state.failed,
    state.hasMore,
    state.offline,
    state.pending,
    voiceIdle,
  ]);
}
