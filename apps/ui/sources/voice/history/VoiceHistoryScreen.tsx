import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { VirtualizedItemList } from '@/components/ui/lists/VirtualizedItemList';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { Text } from '@/components/ui/text/Text';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { formatRelativeTime } from '@/utils/time/formatShortRelativeTime';
import { Modal } from '@/modal';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';

import { getDefaultVoiceHistoryConsumer } from './defaultVoiceHistoryConsumer';
import { useVoiceConversationHistoryRows, type VoiceHistoryPageRow } from './VoiceConversationHistorySection';
import { useVoiceHistoryPendingRecovery, type VoiceHistoryPendingRecovery } from './useVoiceHistoryPendingRecovery';
import { useVoiceHistoryRecoveryAddress } from './useVoiceHistoryRecoveryAddress';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { VoiceConversationActionOutputSchemas } from '@happier-dev/protocol/actions/voiceConversationActionFamily';
import {
  isVoiceHistoryReadStateError,
  type VoiceHistoryExportArtifact,
  type VoiceHistoryRow,
  type VoiceHistorySnapshot,
} from './voiceHistoryConsumer';
import { saveVoiceHistoryExportArtifact } from './voiceHistoryExportTarget';
import { Icon } from '@/components/ui/icons/Icon';
import { PoliteAccessibilityStatus } from '@/components/ui/accessibility/PoliteAccessibilityStatus';
import {
  isVoiceHistoryOperationSupersededError,
  resolveVoiceHistoryInitialLoadFailureState,
  type VoiceHistoryInitialLoadFailureState,
} from './voiceHistoryInitialLoadState';

type VoiceHistoryConsumer = ReturnType<typeof getDefaultVoiceHistoryConsumer>;
type TranscriptPageRow = VoiceHistoryPageRow;

type VoiceHistoryScreenProps = Readonly<{
  consumer?: VoiceHistoryConsumer;
  saveExportArtifact?: (artifact: VoiceHistoryExportArtifact) => Promise<void>;
}>;

type InitialLoadState = 'idle' | 'loading' | 'ready' | VoiceHistoryInitialLoadFailureState;
type VoiceHistoryScreenOperation = 'load_older' | 'export' | 'clear';

const EMPTY_SNAPSHOT: VoiceHistorySnapshot = Object.freeze({
  sessionId: null,
  rows: Object.freeze([]),
  loadedRowCount: 0,
  hasMore: null,
});

function formatVoiceHistoryTimestamp(createdAt: number): string {
  return formatWithCachedDateTimeFormatter(createdAt, undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** One turn of a realtime transcript, on the shared row: who spoke, what was said, when. */
const VoiceHistoryRowView = React.memo(function VoiceHistoryRowView(
  /** Set when this turn came through another service than the conversation row names. */
  props: Readonly<{ row: VoiceHistoryRow; showProvider: boolean }>,
) {
  const roleLabel = props.row.role === 'user'
    ? t('settingsVoice.history.roleYou')
    : t('settingsVoice.history.roleAssistant');
  const timestamp = formatVoiceHistoryTimestamp(props.row.createdAt);
  return (
    <Item
      testID={`voice-history-row-${props.row.id}`}
      title={props.showProvider ? `${roleLabel} · ${props.row.providerLabel}` : roleLabel}
      subtitle={props.row.text}
      subtitleLines={0}
      detail={timestamp}
      accessibilityRole="text"
      accessibilityLabel={[roleLabel, props.row.providerLabel, timestamp, props.row.text].join('. ')}
      mode="info"
      showChevron={false}
    />
  );
});

function VoiceHistoryActionMessage(props: Readonly<{ message: string }>) {
  return (
    <Text testID="voice-history-action-message" style={styles.actionMessage}>
      {props.message}
    </Text>
  );
}

/**
 * Retained Voice input that needs a decision is recovered in the carrier Session's existing
 * Pending block; History only flags it and opens that Session. It mounts only while this page
 * is data-active, so the carrier subscription ends with the page.
 */
const VoiceHistoryRecoveryGroup = React.memo(function VoiceHistoryRecoveryGroup(props: Readonly<{
  onOpen: (openAction: VoiceHistoryPendingRecovery['openAction']) => void;
}>) {
  const { theme } = useUnistyles();
  const recovery = useVoiceHistoryPendingRecovery(useVoiceHistoryRecoveryAddress());
  if (!recovery) return null;
  return (
    <ItemGroup description={t('settingsVoice.history.recoveryDescription')}>
      <Item
        testID="voice-history-recovery"
        icon={<Icon name="warning-circle" size={18} color={theme.colors.state.attention.foreground} />}
        title={t('settingsVoice.history.recoveryTitle')}
        subtitle={t('workStatus.buckets.needs_you')}
        subtitleStyle={{ color: theme.colors.state.attention.textForeground }}
        accessibilityRole="button"
        onPress={() => props.onOpen(recovery.openAction)}
      />
    </ItemGroup>
  );
});

const VoiceHistoryScreenBody = React.memo(function VoiceHistoryScreenBody(
  props: VoiceHistoryScreenProps,
) {
  const { theme } = useUnistyles();
  const [consumer] = React.useState<VoiceHistoryConsumer>(
    () => props.consumer ?? getDefaultVoiceHistoryConsumer(),
  );
  const saveExport = props.saveExportArtifact ?? saveVoiceHistoryExportArtifact;
  const scope = useActiveServerAccountScope();
  const executorOptions = React.useMemo(() => ({ voiceHistory: { consumer, saveExportArtifact: saveExport } }), [consumer, saveExport]);
  const actions = useMountedActionExecution(scope, { executorOptions });
  const executeAction = actions.executeValue;
  const [query, setQuery] = React.useState('');
  // Explicit global transcript Actions may publish loaded turns under a folded row.
  const [transcriptFolded, setTranscriptFolded] = React.useState(true);
  const [appliedQuery, setAppliedQuery] = React.useState('');
  const [loadFailure, setLoadFailure] = React.useState<VoiceHistoryInitialLoadFailureState | null>(null);
  const activeOperationRef = React.useRef<VoiceHistoryScreenOperation | null>(null);
  const [activeOperation, setActiveOperation] = React.useState<VoiceHistoryScreenOperation | null>(
    null,
  );
  const [actionMessage, setActionMessage] = React.useState<string | null>(null);
  const requestEpochRef = React.useRef(0);
  const searchEpochRef = React.useRef(0);
  /*
   * The rendered snapshot is derived from the consumer, never mirrored into
   * screen state. History is a live Account surface: a voice turn that lands
   * while this screen is open, a page loaded by an export, or a provider label
   * that resolves late all change what `read()` answers with no interaction to
   * hang a `setState` on, and a mirrored copy showed whatever the last one
   * returned. The revision changes only for those causes, so an unrelated
   * session write costs one string comparison.
   */
  const subscribeConsumer = React.useCallback(
    (listener: () => void) => consumer.subscribe(listener),
    [consumer],
  );
  const readConsumerRevision = React.useCallback(() => consumer.getRevision(), [consumer]);
  const revision = React.useSyncExternalStore(
    subscribeConsumer,
    readConsumerRevision,
    readConsumerRevision,
  );
  const ownerReadState = consumer.getReadState();
  const loadState: InitialLoadState = loadFailure ?? ownerReadState;
  const snapshot: VoiceHistorySnapshot = React.useMemo(
    () => (loadState === 'loading' ? EMPTY_SNAPSHOT : consumer.read(appliedQuery)),
    [consumer, loadState, appliedQuery, revision],
  );

  const showOperationError = React.useCallback((error: unknown, fallback: string) => {
    if (isVoiceHistoryOperationSupersededError(error)) {
      setLoadFailure('superseded');
      return;
    }
    setActionMessage(fallback);
  }, []);

  const open = React.useCallback(async (refresh = true) => {
    requestEpochRef.current += 1;
    const requestEpoch = requestEpochRef.current;
    setLoadFailure(null);
    setActionMessage(null);
    try {
      await executeAction('ui.voice_global.history.search', { query: appliedQuery, refresh });
    } catch (error) {
      if (requestEpoch !== requestEpochRef.current) return;
      if (isVoiceHistoryReadStateError(error)) return;
      setLoadFailure(resolveVoiceHistoryInitialLoadFailureState(error));
    }
  }, [executeAction, appliedQuery]);

  React.useEffect(() => {
    return () => {
      requestEpochRef.current += 1;
    };
  }, [consumer]);

  const onSearchChange = React.useCallback((nextQuery: string) => {
    searchEpochRef.current += 1;
    const requestEpoch = searchEpochRef.current;
    setQuery(nextQuery);
    setActionMessage(null);
    // Collection search never requests bodies for unopened conversations.
    if (consumer.getReadState() !== 'ready') {
      setAppliedQuery(nextQuery);
      return;
    }
    // Keep the last admitted projection while this input passes Action policy.
    void executeAction('ui.voice_global.history.search', { query: nextQuery }).then(() => {
      if (requestEpoch !== searchEpochRef.current) return;
      setAppliedQuery(nextQuery);
    }).catch(error => {
      if (requestEpoch !== searchEpochRef.current) return;
      if (isVoiceHistoryReadStateError(error)) {
        setAppliedQuery(nextQuery);
        return;
      }
      showOperationError(error, t('settingsVoice.history.loadOlderFailed'));
    });
  }, [consumer, executeAction, showOperationError]);

  const beginOperation = React.useCallback((operation: VoiceHistoryScreenOperation): boolean => {
    if (activeOperationRef.current !== null) return false;
    activeOperationRef.current = operation;
    setActiveOperation(operation);
    return true;
  }, []);

  const finishOperation = React.useCallback((operation: VoiceHistoryScreenOperation): void => {
    if (activeOperationRef.current !== operation) return;
    activeOperationRef.current = null;
    setActiveOperation(null);
  }, []);

  const loadOlder = React.useCallback(async () => {
    if (!beginOperation('load_older')) return;
    setActionMessage(null);
    try {
      await executeAction('ui.voice_global.history.load_older', { query: appliedQuery });
    } catch (error) {
      showOperationError(error, t('settingsVoice.history.loadOlderFailed'));
    } finally {
      finishOperation('load_older');
    }
  }, [appliedQuery, beginOperation, executeAction, finishOperation, showOperationError]);

  const exportAll = React.useCallback(async () => {
    if (!beginOperation('export')) return;
    setActionMessage(null);
    try {
      await executeAction('ui.voice_global.history.export', { range: 'all' });
      setActionMessage(t('settingsVoice.history.exportSucceeded'));
    } catch (error) {
      showOperationError(error, t('settingsVoice.history.exportFailed'));
    } finally {
      finishOperation('export');
    }
  }, [beginOperation, executeAction, finishOperation, showOperationError]);

  const clear = React.useCallback(async () => {
    if (!beginOperation('clear')) return;
    try {
      const confirmed = await Modal.confirm(
        t('settingsVoice.history.clearConfirmTitle'),
        t('settingsVoice.history.clearConfirmBody'),
        {
          cancelText: t('common.cancel'),
          confirmText: t('settingsVoice.history.clearConfirmAction'),
          destructive: true,
        },
      );
      if (!confirmed) return;
      setActionMessage(null);
      const result = VoiceConversationActionOutputSchemas['ui.voice_global.history.clear'].parse(
        await executeAction('ui.voice_global.history.clear', {}, {
          confirmed: true,
        }),
      );
      if (!result.cleared) return;
      requestEpochRef.current += 1;
      setQuery('');
      setAppliedQuery('');
      setLoadFailure(null);
      setActionMessage(t('settingsVoice.history.clearSucceeded'));
    } catch (error) {
      showOperationError(error, t('settingsVoice.history.clearFailed'));
    } finally {
      finishOperation('clear');
    }
  }, [beginOperation, executeAction, finishOperation, showOperationError]);

  const openRecovery = React.useCallback((openAction: VoiceHistoryPendingRecovery['openAction']) => {
    setActionMessage(null);
    void executeAction(openAction.actionId, openAction.input).catch(error => {
      showOperationError(error, t('settingsVoice.history.recoveryOpenFailed'));
    });
  }, [executeAction, showOperationError]);

  const loadingOlder = activeOperation === 'load_older';
  const exporting = activeOperation === 'export';
  const clearing = activeOperation === 'clear';
  const operationInFlight = activeOperation !== null;

  /*
   * Loading, failure and recovery are rendered as ordinary text, which a screen
   * reader never re-reads on its own. The announcement below is derived from the
   * same state that chooses the visible content, and it is rendered from ONE
   * region that outlives every transition — including the silent ones, where it
   * stays mounted holding an empty message. A live region mounted with its text
   * already inside it is not announced at all, so a region that appeared
   * together with each message could never announce the first one.
   */
  const statusAnnouncement = (() => {
    switch (loadState) {
      case 'loading':
        return t('settingsVoice.history.loading');
      case 'error':
        return `${t('settingsVoice.history.errorTitle')}. ${t('settingsVoice.history.errorBody')}`;
      case 'superseded':
        return `${t('settingsVoice.history.supersededTitle')}. `
          + t('settingsVoice.history.supersededBody');
      default:
        return actionMessage ?? '';
    }
  })();
  const openConversation = React.useCallback((address: Readonly<{ serverId: string; sessionId: string }>) => {
    setActionMessage(null);
    void executeAction('ui.voice_global.conversations.open', { conversationSessionAddress: address }).catch(error => {
      showOperationError(error, t('settingsVoice.history.recoveryOpenFailed'));
    });
  }, [executeAction, showOperationError]);
  const continueConversation = React.useCallback((address: Readonly<{ serverId: string; sessionId: string }>) => {
    setActionMessage(null);
    void executeAction('ui.voice_global.continue_conversation', { conversationSessionAddress: address, expectedAttempt: null }).catch(error => {
      showOperationError(error, t('settingsVoice.history.conversationContinueFailed'));
    });
  }, [executeAction, showOperationError]);
  const conversationRows = useVoiceConversationHistoryRows({ query: appliedQuery, onContinue: continueConversation, onOpen: openConversation });

  const transcriptsTitle = t('settingsVoice.history.transcriptsTitle');
  const actionsHeld = operationInFlight || (loadState !== 'idle' && loadState !== 'ready');
  /*
   * An explicitly requested global transcript read publishes its pending or
   * failed state here, then its loaded turns. Arrival renders only the ordinary
   * conversation list; a duplicate aggregate must not fetch unopened bodies.
   */
  const transcriptRows = ((): readonly TranscriptPageRow[] => {
    const messageRow: TranscriptPageRow[] = actionMessage
      ? [{ key: 'transcripts:message', type: 'transcripts-message', render: () => <VoiceHistoryActionMessage message={actionMessage} /> }]
      : [];
    if (loadState === 'idle') return messageRow;
    // A read still pending says so in place; it never leaves the section silently missing.
    if (loadState === 'loading') return [{
      key: 'transcripts:loading', type: 'transcripts-state',
      render: () => (
        <ItemGroup title={transcriptsTitle}>
          <SurfaceStateCard
            testID="voice-history-transcripts-loading"
            kind="loading"
            size="line"
            title={t('settingsVoice.history.loading')}
          />
        </ItemGroup>
      ),
    }];
    if (loadState === 'error' || loadState === 'superseded') {
      const superseded = loadState === 'superseded';
      return [{
        key: `transcripts:${loadState}`, type: 'transcripts-state',
        render: () => (
          <ItemGroup title={transcriptsTitle}>
            <SurfaceStateCard
              testID={superseded ? 'voice-history-superseded' : 'voice-history-error'}
              kind={superseded ? 'warning' : 'error'}
              size="line"
              title={t(superseded ? 'settingsVoice.history.supersededTitle' : 'settingsVoice.history.errorTitle')}
              reason={t(superseded ? 'settingsVoice.history.supersededBody' : 'settingsVoice.history.errorBody')}
              action={{ label: t('settingsVoice.history.retry'), onPress: () => { void open(); } }}
            />
          </ItemGroup>
        ),
      }, ...messageRow];
    }
    // A completed read without turns leaves no empty aggregate section.
    if (snapshot.loadedRowCount === 0) return messageRow;
    // Loaded turns that a search filtered out entirely.
    if (snapshot.rows.length === 0) {
      return [...messageRow, {
        key: 'transcripts:empty', type: 'transcripts-state',
        render: () => (
          <ItemGroup title={transcriptsTitle}>
            <SurfaceStateCard
              testID="voice-history-no-results"
              kind="empty"
              size="line"
              iconName="magnifying-glass"
              title={t('settingsVoice.history.noResultsTitle')}
              reason={t('settingsVoice.history.noResultsBody')}
            />
          </ItemGroup>
        ),
      }];
    }
    const latest = snapshot.rows.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
    const openTurns = !transcriptFolded || appliedQuery.trim().length > 0;
    const loadOlderRow = snapshot.hasMore !== false ? (
      <Item
        testID="voice-history-load-older"
        title={loadingOlder ? t('settingsVoice.history.loadingOlder') : t('settingsVoice.history.loadOlderTitle')}
        accessibilityRole="button"
        accessibilityLabel={t('settingsVoice.history.loadOlderTitle')}
        disabled={operationInFlight}
        loading={loadingOlder}
        showChevron={false}
        onPress={() => { void loadOlder(); }}
      />
    ) : null;
    const header: TranscriptPageRow = {
      key: 'transcripts:conversation', type: 'transcripts-conversation',
      render: () => (
        <ItemGroup
          title={transcriptsTitle}
          description={t('settingsVoice.history.transcriptsDescription')}
          virtualizedSegment={{ first: true, last: !openTurns }}
        >
          <Item
            testID="voice-history-transcript"
            title={latest.providerLabel}
            subtitle={`${latest.text} · ${t('settingsVoice.history.transcriptMessageCount', { count: snapshot.loadedRowCount })}`}
            detail={formatRelativeTime(latest.createdAt)}
            accessibilityRole="button"
            accessibilityState={{ expanded: openTurns }}
            showChevron={false}
            rightElement={<Icon name={openTurns ? 'caret-up' : 'caret-down'} size={16} color={theme.colors.text.secondary} />}
            onPress={() => setTranscriptFolded(openTurns)}
          />
        </ItemGroup>
      ),
    };
    if (!openTurns) return [header, ...messageRow];
    const turns: TranscriptPageRow[] = snapshot.rows.map((row, index) => ({
      key: `transcripts:row:${row.id}`, type: 'transcript',
      render: () => (
        <ItemGroup virtualizedSegment={{ first: false, last: index === snapshot.rows.length - 1 && !loadOlderRow }}>
          <VoiceHistoryRowView row={row} showProvider={row.providerLabel !== latest.providerLabel} />
        </ItemGroup>
      ),
    }));
    const older: TranscriptPageRow[] = loadOlderRow ? [{
      key: 'transcripts:older', type: 'transcripts-older',
      render: () => <ItemGroup virtualizedSegment={{ first: false, last: true }}>{loadOlderRow}</ItemGroup>,
    }] : [];
    return [header, ...turns, ...older, ...messageRow];
  })();
  // Export and Clear act on the whole history, so they close the page; Clear is the last row.
  const actionRows: readonly TranscriptPageRow[] = [{
    key: 'history:actions', type: 'history-actions',
    render: () => (
      <ItemGroup title={t('settingsVoice.history.actionsTitle')}>
        <Item
          testID="voice-history-export-row"
          title={t('settingsVoice.history.exportTitle')}
          subtitle={t('settingsVoice.history.exportSubtitle')}
          showChevron={false}
          accessoryLayout="adaptive"
          rightElementOutsidePressable
          rightElement={(
            <RoundButton
              testID="voice-history-export"
              title={exporting ? t('settingsVoice.history.exporting') : t('settingsVoice.history.exportAction')}
              accessibilityLabel={t('settingsVoice.history.exportTitle')}
              display="secondary"
              size="small"
              loading={exporting}
              disabled={actionsHeld}
              onPress={() => { void exportAll(); }}
            />
          )}
        />
        <Item
          testID="voice-history-clear"
          title={clearing ? t('settingsVoice.history.clearing') : t('settingsVoice.history.clearTitle')}
          subtitle={t('settingsVoice.history.clearSubtitle')}
          accessibilityRole="button"
          accessibilityLabel={t('settingsVoice.history.clearTitle')}
          disabled={actionsHeld}
          loading={clearing}
          destructive
          showChevron={false}
          onPress={() => { void clear(); }}
        />
      </ItemGroup>
    ),
  }];
  const rows = [...conversationRows, ...transcriptRows, ...actionRows];

  return (
    <ListPresentationProvider value="page">
      <View testID="voice-history-screen" style={styles.screen}>
        <VirtualizedItemList
          testID="voice-history-list"
          data={rows}
          keyExtractor={(row) => row.key}
          getItemType={(row) => row.type}
          renderItem={({ item }) => item.render()}
          estimatedItemSize={96}
          ListHeaderComponent={(
            <>
              <SettingsPageHeader description={t('settingsVoice.history.pageDescription')} />
              <CompactSearchField
                testID="voice-history-search"
                placement="page"
                value={query}
                onChangeText={onSearchChange}
                placeholder={t('settingsVoice.history.searchPlaceholder')}
                accessibilityLabel={t('settingsVoice.history.searchAccessibilityLabel')}
              />
              <VoiceHistoryRecoveryGroup onOpen={openRecovery} />
            </>
          )}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        />
      </View>
      <PoliteAccessibilityStatus
        announcement={statusAnnouncement}
        statusTestID="voice-history-operation-status"
        transitionKey={`${loadState}\u0001${statusAnnouncement}`}
      />
    </ListPresentationProvider>
  );
});

export const VoiceHistoryScreen = React.memo(function VoiceHistoryScreen(
  props: VoiceHistoryScreenProps,
) {
  // History is Account-owned content. The body holds a long-lived consumer and
  // its already-decrypted rendered rows, so remount it on the canonical
  // server-Account scope key: Account A's rows must leave the tree the moment
  // the scope changes, not when Account B's read resolves.
  const scope = useActiveServerAccountScope();
  return (
    <VoiceHistoryScreenBody
      key={scope ? serverAccountScopeKeySuffix(scope) : 'unscoped'}
      {...props}
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  screen: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface.base,
  },
  actionMessage: {
    color: theme.colors.text.secondary,
    textAlign: 'center',
    paddingHorizontal: theme.space.s24,
    paddingVertical: theme.space.s8,
  },
}));
