import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { VirtualizedList } from '@/components/ui/lists/virtualized';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SurfaceStateCard, type SurfaceStateKind } from '@/components/ui/surfaces/SurfaceStateCard';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';

import { getDefaultVoiceHistoryConsumer } from './defaultVoiceHistoryConsumer';
import { useVoiceHistoryPendingRecovery, type VoiceHistoryPendingRecovery } from './useVoiceHistoryPendingRecovery';
import { useVoiceHomeConversationAddress } from '@/voice/persistence/useVoiceHomeConversationAddress';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { VoiceConversationActionOutputSchemas } from '@happier-dev/protocol/actions/voiceConversationActionFamily';
import {
  type VoiceHistoryExportArtifact,
  type VoiceHistoryRow,
  type VoiceHistorySnapshot,
} from './voiceHistoryConsumer';
import { saveVoiceHistoryExportArtifact } from './voiceHistoryExportTarget';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { PoliteAccessibilityStatus } from '@/components/ui/accessibility/PoliteAccessibilityStatus';
import {
  isVoiceHistoryOperationSupersededError,
  resolveVoiceHistoryInitialLoadFailureState,
  type VoiceHistoryInitialLoadFailureState,
} from './voiceHistoryInitialLoadState';

type VoiceHistoryConsumer = ReturnType<typeof getDefaultVoiceHistoryConsumer>;

type VoiceHistoryScreenProps = Readonly<{
  consumer?: VoiceHistoryConsumer;
  saveExportArtifact?: (artifact: VoiceHistoryExportArtifact) => Promise<void>;
}>;

type InitialLoadState = 'loading' | 'ready' | VoiceHistoryInitialLoadFailureState;
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

const VoiceHistoryRowView = React.memo(function VoiceHistoryRowView(
  props: Readonly<{ row: VoiceHistoryRow }>,
) {
  // Composed at render time: the module-scope stylesheet evaluates once, so a
  // baked-in `layout.maxWidth` would freeze the user's content-width preference.
  const rowMaxWidthStyle = useLayoutMaxWidthStyle();
  const roleLabel = props.row.role === 'user'
    ? t('settingsVoice.history.roleYou')
    : t('settingsVoice.history.roleAssistant');
  const timestamp = formatVoiceHistoryTimestamp(props.row.createdAt);
  const accessibilityLabel = [
    roleLabel,
    props.row.providerLabel,
    timestamp,
    props.row.text,
  ].join('. ');

  return (
    <View style={[styles.rowOuter, rowMaxWidthStyle]}>
      <View
        testID={`voice-history-row-${props.row.id}`}
        accessible
        accessibilityRole="text"
        accessibilityLabel={accessibilityLabel}
        style={styles.row}
      >
        <View style={styles.rowMeta}>
          <Text style={styles.rowProvider}>{props.row.providerLabel}</Text>
          <Text style={styles.rowTimestamp}>{timestamp}</Text>
        </View>
        <Text style={styles.rowRole}>{roleLabel}</Text>
        <Text selectable style={styles.rowText}>{props.row.text}</Text>
      </View>
    </View>
  );
});

function VoiceHistoryStateMessage(props: Readonly<{
  testID: string;
  kind: SurfaceStateKind;
  icon: IconName;
  title: string;
  body: string;
  actionMessage?: string | null;
  retry?: (() => void) | null;
}>) {
  return (
    <View style={styles.stateOuter}>
      <SurfaceStateCard
        testID={props.testID}
        kind={props.kind}
        iconName={props.icon}
        title={props.title}
        reason={props.body}
        action={props.retry ? { label: t('settingsVoice.history.retry'), onPress: props.retry } : undefined}
      />
      {props.actionMessage ? <VoiceHistoryActionMessage message={props.actionMessage} /> : null}
    </View>
  );
}

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
  const recovery = useVoiceHistoryPendingRecovery(useVoiceHomeConversationAddress());
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
  // Composed at render time: the module-scope stylesheet evaluates once, so a
  // baked-in `layout.maxWidth` would freeze the user's content-width preference.
  const headerMaxWidthStyle = useLayoutMaxWidthStyle();
  const [consumer] = React.useState<VoiceHistoryConsumer>(
    () => props.consumer ?? getDefaultVoiceHistoryConsumer(),
  );
  const saveExport = props.saveExportArtifact ?? saveVoiceHistoryExportArtifact;
  const scope = useActiveServerAccountScope();
  const executorOptions = React.useMemo(() => ({ voiceHistory: { consumer, saveExportArtifact: saveExport } }), [consumer, saveExport]);
  const actions = useMountedActionExecution(scope, { executorOptions, openOnRequest: true });
  const executeAction = actions.executeValue;
  const [query, setQuery] = React.useState('');
  const [appliedQuery, setAppliedQuery] = React.useState('');
  const [loadState, setLoadState] = React.useState<InitialLoadState>('loading');
  const activeOperationRef = React.useRef<VoiceHistoryScreenOperation | null>(null);
  const [activeOperation, setActiveOperation] = React.useState<VoiceHistoryScreenOperation | null>(
    null,
  );
  const [actionMessage, setActionMessage] = React.useState<string | null>(null);
  const requestEpochRef = React.useRef(0);
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
  const snapshot: VoiceHistorySnapshot = React.useMemo(
    () => (loadState === 'loading' ? EMPTY_SNAPSHOT : consumer.read(appliedQuery)),
    [consumer, loadState, appliedQuery, revision],
  );


  const showOperationError = React.useCallback((error: unknown, fallback: string) => {
    if (isVoiceHistoryOperationSupersededError(error)) {
      setLoadState('superseded');
      return;
    }
    setActionMessage(fallback);
  }, []);

  const open = React.useCallback(async () => {
    requestEpochRef.current += 1;
    const requestEpoch = requestEpochRef.current;
    setLoadState('loading');
    setActionMessage(null);
    try {
      await executeAction('ui.voice_global.history.search', { query: appliedQuery, refresh: true });
      if (requestEpoch !== requestEpochRef.current) return;
      setLoadState('ready');
    } catch (error) {
      if (requestEpoch !== requestEpochRef.current) return;
      setLoadState(resolveVoiceHistoryInitialLoadFailureState(error));
    }
  }, [executeAction, appliedQuery]);

  React.useEffect(() => {
    if (actions.ready) void open();
    return () => {
      requestEpochRef.current += 1;
    };
    // Admitted search is applied against already-loaded decrypted rows.
    // Opening again for each keystroke would refresh the network-owned page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consumer, actions.ready]);

  const onSearchChange = React.useCallback((nextQuery: string) => {
    requestEpochRef.current += 1;
    const requestEpoch = requestEpochRef.current;
    setQuery(nextQuery);
    setActionMessage(null);
    // Keep the last admitted projection while this input passes Action policy.
    void executeAction('ui.voice_global.history.search', { query: nextQuery }).then(() => {
      if (requestEpoch !== requestEpochRef.current) return;
      setAppliedQuery(nextQuery);
    }).catch(error => {
      if (requestEpoch !== requestEpochRef.current) return;
      showOperationError(error, t('settingsVoice.history.loadOlderFailed'));
    });
  }, [executeAction, showOperationError]);

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
          presentUserConfirmation: { actionId: 'ui.voice_global.history.clear' },
        }),
      );
      if (!result.cleared) return;
      requestEpochRef.current += 1;
      setQuery('');
      setAppliedQuery('');
      setLoadState('ready');
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
  const withAccessibilityStatus = (content: React.ReactNode) => (
    <ListPresentationProvider value="page">
      {content}
      <PoliteAccessibilityStatus
        announcement={statusAnnouncement}
        statusTestID="voice-history-operation-status"
        transitionKey={`${loadState}\u0001${statusAnnouncement}`}
      />
    </ListPresentationProvider>
  );
  const pageHeader = <SettingsPageHeader description={t('settingsVoice.history.pageDescription')} />;
  // Full-surface states keep the page header above them, like every other settings page.
  const withPageState = (content: React.ReactNode) => withAccessibilityStatus(
    <View style={styles.screen}>
      {pageHeader}
      {content}
    </View>,
  );

  if (loadState === 'loading') {
    return withPageState(
      <View testID="voice-history-loading" style={styles.loading}>
        <ActivitySpinner size="large" />
        <Text style={styles.stateBody}>{t('settingsVoice.history.loading')}</Text>
      </View>,
    );
  }

  if (loadState === 'error') {
    return withPageState(
      <VoiceHistoryStateMessage
        testID="voice-history-error"
        kind="error"
        icon="cloud-slash"
        title={t('settingsVoice.history.errorTitle')}
        body={t('settingsVoice.history.errorBody')}
        retry={() => { void open(); }}
      />,
    );
  }

  if (loadState === 'superseded') {
    return withPageState(
      <VoiceHistoryStateMessage
        testID="voice-history-superseded"
        kind="warning"
        icon="arrows-left-right"
        title={t('settingsVoice.history.supersededTitle')}
        body={t('settingsVoice.history.supersededBody')}
        retry={() => { void open(); }}
      />,
    );
  }

  if (!snapshot.sessionId && snapshot.loadedRowCount === 0) {
    return withPageState(
      <>
        <View style={[styles.header, headerMaxWidthStyle]}>
          <VoiceHistoryRecoveryGroup onOpen={openRecovery} />
        </View>
        <VoiceHistoryStateMessage
          testID="voice-history-empty"
          kind="empty"
          icon="clock"
          title={t('settingsVoice.history.emptyTitle')}
          body={t('settingsVoice.history.emptyBody')}
          actionMessage={actionMessage}
        />
      </>,
    );
  }

  const noSearchResults = appliedQuery.trim().length > 0
    && snapshot.loadedRowCount > 0
    && snapshot.rows.length === 0;
  const listHeader = (
    <View style={[styles.header, headerMaxWidthStyle]}>
      {pageHeader}
      <VoiceHistoryRecoveryGroup onOpen={openRecovery} />
      <ItemGroup
        title={t('settingsVoice.history.searchTitle')}
        description={t('settingsVoice.history.searchFooter')}
      >
        <View style={styles.searchFieldWrap}>
          <Icon
            name="magnifying-glass"
            size={20}
            color={theme.colors.text.secondary}
          />
          <TextInput
            testID="voice-history-search"
            value={query}
            onChangeText={onSearchChange}
            placeholder={t('settingsVoice.history.searchPlaceholder')}
            accessibilityLabel={t('settingsVoice.history.searchAccessibilityLabel')}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            style={styles.searchField}
          />
        </View>
      </ItemGroup>
      <ItemGroup title={t('settingsVoice.history.actionsTitle')}>
        <Item
          testID="voice-history-export"
          title={exporting
            ? t('settingsVoice.history.exporting')
            : t('settingsVoice.history.exportTitle')}
          subtitle={t('settingsVoice.history.exportSubtitle')}
          accessibilityRole="button"
          accessibilityLabel={t('settingsVoice.history.exportTitle')}
          disabled={operationInFlight}
          loading={exporting}
          onPress={() => { void exportAll(); }}
        />
        <Item
          testID="voice-history-clear"
          title={clearing
            ? t('settingsVoice.history.clearing')
            : t('settingsVoice.history.clearTitle')}
          subtitle={t('settingsVoice.history.clearSubtitle')}
          accessibilityRole="button"
          accessibilityLabel={t('settingsVoice.history.clearTitle')}
          disabled={operationInFlight}
          loading={clearing}
          destructive
          showChevron={false}
          onPress={() => { void clear(); }}
        />
      </ItemGroup>
      {snapshot.hasMore !== false ? (
        <ItemGroup description={t('settingsVoice.history.loadOlderFooter')}>
          <Item
            testID="voice-history-load-older"
            title={loadingOlder
              ? t('settingsVoice.history.loadingOlder')
              : t('settingsVoice.history.loadOlderTitle')}
            subtitle={t('settingsVoice.history.loadOlderSubtitle')}
            accessibilityRole="button"
            accessibilityLabel={t('settingsVoice.history.loadOlderTitle')}
            disabled={operationInFlight}
            loading={loadingOlder}
            showChevron={false}
            onPress={() => { void loadOlder(); }}
          />
        </ItemGroup>
      ) : null}
      {actionMessage ? <VoiceHistoryActionMessage message={actionMessage} /> : null}
    </View>
  );

  return withAccessibilityStatus(
    <View testID="voice-history-screen" style={styles.screen}>
      <VirtualizedList
        testID="voice-history-list"
        data={snapshot.rows}
        estimatedItemSize={132}
        recycleItems
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        keyExtractor={(row) => row.id}
        renderItem={({ item }) => <VoiceHistoryRowView row={item} />}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={(
          <VoiceHistoryStateMessage
            testID={noSearchResults ? 'voice-history-no-results' : 'voice-history-empty'}
            kind="empty"
            icon={noSearchResults ? 'magnifying-glass' : 'clock'}
            title={noSearchResults
              ? t('settingsVoice.history.noResultsTitle')
              : t('settingsVoice.history.emptyTitle')}
            body={noSearchResults
              ? t('settingsVoice.history.noResultsBody')
              : t('settingsVoice.history.emptyBody')}
          />
        )}
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      />
    </View>,
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
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space.s12,
    padding: theme.space.s24,
  },
  listContent: {
    paddingBottom: theme.space.s32,
  },
  header: {
    width: '100%',
    alignSelf: 'center',
  },
  searchFieldWrap: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s10,
    paddingHorizontal: theme.space.s16,
  },
  searchField: {
    flex: 1,
    color: theme.colors.text.primary,
    paddingVertical: theme.space.s12,
  },
  actionMessage: {
    color: theme.colors.text.secondary,
    textAlign: 'center',
    paddingHorizontal: theme.space.s24,
    paddingVertical: theme.space.s8,
  },
  rowOuter: {
    width: '100%',
    alignSelf: 'center',
    paddingHorizontal: theme.space.s16,
    paddingTop: theme.space.s10,
  },
  row: {
    paddingHorizontal: theme.space.s16,
    paddingVertical: 14,
    borderRadius: 14,
    // Transcript entries sit on the page like its sheets do.
    backgroundColor: theme.colors.surface.sectionTint,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.default,
  },
  rowMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.space.s12,
  },
  rowProvider: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
    flexShrink: 1,
  },
  rowTimestamp: {
    color: theme.colors.text.secondary,
  },
  rowRole: {
    color: theme.colors.text.secondary,
    marginTop: theme.space.s4,
  },
  rowText: {
    color: theme.colors.text.primary,
    marginTop: theme.space.s8,
    lineHeight: 21,
  },
  stateOuter: {
    flex: 1,
    width: '100%',
    alignSelf: 'center',
  },
  stateBody: {
    color: theme.colors.text.secondary,
    textAlign: 'center',
    marginTop: theme.space.s6,
    lineHeight: 20,
  },
}));
