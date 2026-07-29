import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { VirtualizedList } from '@/components/ui/lists/virtualized';
import { layout } from '@/components/ui/layout/layout';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';

import { createDefaultVoiceHistoryConsumer } from './defaultVoiceHistoryConsumer';
import {
  isVoiceHistoryClearActiveCallError,
  VoiceHistoryOperationSupersededError,
  type VoiceHistoryExportArtifact,
  type VoiceHistoryRow,
  type VoiceHistorySnapshot,
} from './voiceHistoryConsumer';
import { saveVoiceHistoryExportArtifact } from './voiceHistoryExportTarget';

type VoiceHistoryConsumer = ReturnType<typeof createDefaultVoiceHistoryConsumer>;

type VoiceHistoryScreenProps = Readonly<{
  consumer?: VoiceHistoryConsumer;
  saveExportArtifact?: (artifact: VoiceHistoryExportArtifact) => Promise<void>;
}>;

type InitialLoadState = 'loading' | 'ready' | 'error' | 'superseded';

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

function isSupersededError(error: unknown): boolean {
  return error instanceof VoiceHistoryOperationSupersededError
    || (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'voice_history_operation_superseded'
    );
}

const VoiceHistoryRowView = React.memo(function VoiceHistoryRowView(
  props: Readonly<{ row: VoiceHistoryRow }>,
) {
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
    <View style={styles.rowOuter}>
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
  icon: React.ComponentProps<typeof Ionicons>['name'];
  title: string;
  body: string;
  retry?: (() => void) | null;
}>) {
  const { theme } = useUnistyles();
  return (
    <View testID={props.testID} style={styles.stateOuter}>
      <View style={styles.stateCard}>
        <Ionicons name={props.icon} size={30} color={theme.colors.text.secondary} />
        <Text style={styles.stateTitle}>{props.title}</Text>
        <Text style={styles.stateBody}>{props.body}</Text>
        {props.retry ? (
          <Item
            testID={`${props.testID}-retry`}
            title={t('settingsVoice.history.retry')}
            accessibilityRole="button"
            accessibilityLabel={t('settingsVoice.history.retry')}
            onPress={props.retry}
            showChevron={false}
          />
        ) : null}
      </View>
    </View>
  );
}

export const VoiceHistoryScreen = React.memo(function VoiceHistoryScreen(
  props: VoiceHistoryScreenProps,
) {
  const { theme } = useUnistyles();
  const [consumer] = React.useState<VoiceHistoryConsumer>(
    () => props.consumer ?? createDefaultVoiceHistoryConsumer(),
  );
  const saveExport = props.saveExportArtifact ?? saveVoiceHistoryExportArtifact;
  const [snapshot, setSnapshot] = React.useState<VoiceHistorySnapshot>(EMPTY_SNAPSHOT);
  const [query, setQuery] = React.useState('');
  const queryRef = React.useRef('');
  const [loadState, setLoadState] = React.useState<InitialLoadState>('loading');
  const [loadingOlder, setLoadingOlder] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const [clearing, setClearing] = React.useState(false);
  const [actionMessage, setActionMessage] = React.useState<string | null>(null);
  const requestEpochRef = React.useRef(0);

  const showOperationError = React.useCallback((error: unknown, fallback: string) => {
    if (isSupersededError(error)) {
      setLoadState('superseded');
      return;
    }
    if (isVoiceHistoryClearActiveCallError(error)) {
      setActionMessage(t('settingsVoice.history.clearActiveCall'));
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
      const next = await consumer.open(query);
      if (requestEpoch !== requestEpochRef.current) return;
      setSnapshot(next);
      setLoadState('ready');
    } catch (error) {
      if (requestEpoch !== requestEpochRef.current) return;
      setLoadState(isSupersededError(error) ? 'superseded' : 'error');
    }
  }, [consumer, query]);

  React.useEffect(() => {
    void open();
    return () => {
      requestEpochRef.current += 1;
    };
    // Search is applied synchronously against already-loaded decrypted rows.
    // Opening again for each keystroke would refresh the network-owned page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consumer]);

  const onSearchChange = React.useCallback((nextQuery: string) => {
    queryRef.current = nextQuery;
    setQuery(nextQuery);
    setSnapshot(consumer.read(nextQuery));
    setActionMessage(null);
  }, [consumer]);

  const loadOlder = React.useCallback(async () => {
    if (loadingOlder) return;
    setLoadingOlder(true);
    setActionMessage(null);
    try {
      await consumer.loadOlder(queryRef.current);
      setSnapshot(consumer.read(queryRef.current));
    } catch (error) {
      showOperationError(error, t('settingsVoice.history.loadOlderFailed'));
    } finally {
      setLoadingOlder(false);
    }
  }, [consumer, loadingOlder, showOperationError]);

  const exportAll = React.useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    setActionMessage(null);
    try {
      const artifact = await consumer.exportHistory({ range: 'all' });
      await saveExport(artifact);
      setSnapshot(consumer.read(queryRef.current));
      setActionMessage(t('settingsVoice.history.exportSucceeded'));
    } catch (error) {
      showOperationError(error, t('settingsVoice.history.exportFailed'));
    } finally {
      setExporting(false);
    }
  }, [consumer, exporting, saveExport, showOperationError]);

  const clear = React.useCallback(async () => {
    if (clearing) return;
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
    setClearing(true);
    setActionMessage(null);
    try {
      await consumer.clear();
      queryRef.current = '';
      setQuery('');
      setSnapshot(consumer.read());
      setLoadState('ready');
      setActionMessage(t('settingsVoice.history.clearSucceeded'));
    } catch (error) {
      showOperationError(error, t('settingsVoice.history.clearFailed'));
    } finally {
      setClearing(false);
    }
  }, [clearing, consumer, showOperationError]);

  if (loadState === 'loading') {
    return (
      <View testID="voice-history-loading" style={styles.loading}>
        <ActivitySpinner size="large" />
        <Text style={styles.stateBody}>{t('settingsVoice.history.loading')}</Text>
      </View>
    );
  }

  if (loadState === 'error') {
    return (
      <VoiceHistoryStateMessage
        testID="voice-history-error"
        icon="cloud-offline-outline"
        title={t('settingsVoice.history.errorTitle')}
        body={t('settingsVoice.history.errorBody')}
        retry={() => { void open(); }}
      />
    );
  }

  if (loadState === 'superseded') {
    return (
      <VoiceHistoryStateMessage
        testID="voice-history-superseded"
        icon="swap-horizontal-outline"
        title={t('settingsVoice.history.supersededTitle')}
        body={t('settingsVoice.history.supersededBody')}
        retry={() => { void open(); }}
      />
    );
  }

  if (!snapshot.sessionId) {
    return (
      <VoiceHistoryStateMessage
        testID="voice-history-empty"
        icon="time-outline"
        title={t('settingsVoice.history.emptyTitle')}
        body={t('settingsVoice.history.emptyBody')}
      />
    );
  }

  const noSearchResults = query.trim().length > 0
    && snapshot.loadedRowCount > 0
    && snapshot.rows.length === 0;
  const listHeader = (
    <View style={styles.header}>
      <ItemGroup
        title={t('settingsVoice.history.searchTitle')}
        footer={t('settingsVoice.history.searchFooter')}
      >
        <View style={styles.searchFieldWrap}>
          <Ionicons
            name="search-outline"
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
          icon={<Ionicons name="download-outline" size={22} color={theme.colors.text.secondary} />}
          accessibilityRole="button"
          accessibilityLabel={t('settingsVoice.history.exportTitle')}
          disabled={exporting || clearing}
          loading={exporting}
          onPress={() => { void exportAll(); }}
        />
        <Item
          testID="voice-history-clear"
          title={clearing
            ? t('settingsVoice.history.clearing')
            : t('settingsVoice.history.clearTitle')}
          subtitle={t('settingsVoice.history.clearSubtitle')}
          icon={<Ionicons name="trash-outline" size={22} color={theme.colors.state.danger.foreground} />}
          accessibilityRole="button"
          accessibilityLabel={t('settingsVoice.history.clearTitle')}
          disabled={exporting || clearing}
          loading={clearing}
          destructive
          showChevron={false}
          onPress={() => { void clear(); }}
        />
      </ItemGroup>
      {snapshot.hasMore !== false ? (
        <ItemGroup footer={t('settingsVoice.history.loadOlderFooter')}>
          <Item
            testID="voice-history-load-older"
            title={loadingOlder
              ? t('settingsVoice.history.loadingOlder')
              : t('settingsVoice.history.loadOlderTitle')}
            subtitle={t('settingsVoice.history.loadOlderSubtitle')}
            accessibilityRole="button"
            accessibilityLabel={t('settingsVoice.history.loadOlderTitle')}
            disabled={loadingOlder || exporting || clearing}
            loading={loadingOlder}
            showChevron={false}
            onPress={() => { void loadOlder(); }}
          />
        </ItemGroup>
      ) : null}
      {actionMessage ? (
        <Text testID="voice-history-action-message" accessibilityLiveRegion="polite" style={styles.actionMessage}>
          {actionMessage}
        </Text>
      ) : null}
    </View>
  );

  return (
    <View testID="voice-history-screen" style={styles.screen}>
      <VirtualizedList
        testID="voice-history-list"
        data={snapshot.rows}
        backendPreference="auto"
        estimatedItemSize={132}
        recycleItems
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        keyExtractor={(row) => row.id}
        renderItem={({ item }) => <VoiceHistoryRowView row={item} />}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={(
          <VoiceHistoryStateMessage
            testID={noSearchResults ? 'voice-history-no-results' : 'voice-history-empty'}
            icon={noSearchResults ? 'search-outline' : 'time-outline'}
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
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  screen: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.background.canvas,
  },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
    backgroundColor: theme.colors.background.canvas,
  },
  listContent: {
    paddingBottom: 32,
  },
  header: {
    width: '100%',
    maxWidth: layout.maxWidth,
    alignSelf: 'center',
  },
  searchFieldWrap: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
  },
  searchField: {
    flex: 1,
    color: theme.colors.text.primary,
    paddingVertical: 12,
  },
  actionMessage: {
    color: theme.colors.text.secondary,
    textAlign: 'center',
    paddingHorizontal: 24,
    paddingVertical: 8,
  },
  rowOuter: {
    width: '100%',
    maxWidth: layout.maxWidth,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  row: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 14,
    backgroundColor: theme.colors.surface.base,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.surface,
  },
  rowMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
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
    marginTop: 4,
  },
  rowText: {
    color: theme.colors.text.primary,
    marginTop: 8,
    lineHeight: 21,
  },
  stateOuter: {
    width: '100%',
    maxWidth: layout.maxWidth,
    alignSelf: 'center',
    padding: 20,
  },
  stateCard: {
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 32,
    borderRadius: 16,
    backgroundColor: theme.colors.surface.base,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.surface,
  },
  stateTitle: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
    textAlign: 'center',
    marginTop: 12,
  },
  stateBody: {
    color: theme.colors.text.secondary,
    textAlign: 'center',
    marginTop: 6,
    lineHeight: 20,
  },
}));
