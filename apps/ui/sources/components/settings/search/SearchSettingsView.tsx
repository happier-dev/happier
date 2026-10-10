import * as React from 'react';

import type { MemorySettingsV1 } from '@happier-dev/protocol/memory/memorySettings';

import {
  resolveAgentCatalogProjection,
  type ResolvedAgentCatalogEntry,
} from '@/agents/backendCatalog/agentCatalogProjection';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { useMachineMemorySettings } from '@/components/settings/memory/useMachineMemorySettings';
import { SEARCH_SETTINGS } from '@/components/settings/search/searchSettings';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import {
  SettingAnchor,
  SettingRow,
  SettingSection,
} from '@/components/settings/shell/SettingRow';
import { listExternalSessionBrowseProviderIds } from '@/components/sessions/external/browse/resolveExternalSessionBrowseSourceOptions';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { Modal } from '@/modal';
import { clearDaemonMemoryIndex } from '@/sync/domains/memory/clearDaemonMemoryIndex';
import { getDaemonMemoryStatusStateTranslationKey } from '@/sync/domains/memory/getDaemonMemoryStatusStateTranslationKey';
import { presentDaemonMemoryStatus } from '@/sync/domains/memory/presentDaemonMemoryStatus';
import { useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';

type ConversationSearchSettings = MemorySettingsV1['conversationSearch'];

/** Until the machine's settings are read, the first section's row says what is missing; it answers for the rest. */
const SEARCH_SECTIONS_AFTER_READY = [
  SEARCH_SETTINGS.sectionRefs.external,
  SEARCH_SETTINGS.sectionRefs.index,
];

/** How far back native conversations are indexed. `null` is all history. */
const HISTORY_WINDOW_DAYS: readonly (number | null)[] = [30, 90, 365, null];

function historyWindowId(days: number | null): string {
  return days === null ? 'all' : String(days);
}

function historyWindowLabel(days: number | null): string {
  if (days === null) return t('conversationSearch.historyAll');
  return days === 365
    ? t('conversationSearch.historyYear')
    : t('conversationSearch.historyDays', { count: days });
}

/**
 * Search settings for one machine: which search modes run there and whether conversations started
 * outside Happier join its memory index. It binds to `MemorySettingsV1.conversationSearch`, the same
 * machine-local settings the Memory page manages, so both pages share the machine choice and reader.
 */
export const SearchSettingsView = React.memo(function SearchSettingsView() {
  const router = useRouter();
  const memorySearchAvailable = useFeatureEnabled('memory.search');
  const {
    administrationTargetSelection,
    executionTarget,
    access,
    loading,
    settings,
    memoryStatus,
    fetchSettings,
    writeSettings,
    resolveWritableTarget,
    refreshStatus,
  } = useMachineMemorySettings({ enabled: true });
  const conversationSearch = settings.conversationSearch;
  const indexExternal = conversationSearch.indexExternal;
  const ready = access === 'ready';
  const indexing =
    ready && memorySearchAvailable && settings.enabled && indexExternal.enabled;

  const writeConversationSearch = React.useCallback(
    (next: ConversationSearchSettings) => {
      void writeSettings({ ...settings, conversationSearch: next });
    },
    [settings, writeSettings],
  );
  const writeIndexExternal = React.useCallback(
    (patch: Partial<ConversationSearchSettings['indexExternal']>) => {
      writeConversationSearch({
        ...conversationSearch,
        indexExternal: { ...indexExternal, ...patch },
      });
    },
    [conversationSearch, indexExternal, writeConversationSearch],
  );

  // The Agent rows are read from the machine only while they are shown.
  const machineId = executionTarget?.machine.id ?? null;
  const serverId = executionTarget?.serverId ?? null;
  const projection = useDaemonMergedProjectionInputs({
    machineId,
    serverId,
    enabled: indexing,
  });
  const projectionInputs =
    projection.phase === 'ready' ? projection.inputs : null;
  const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey');
  const agents = React.useMemo<
    ReadonlyArray<
      Readonly<{
        id: string;
        entry: ResolvedAgentCatalogEntry | null;
        title: string;
      }>
    >
  >(() => {
    const ids = listExternalSessionBrowseProviderIds({
      projection: projectionInputs?.pluginProjectionV2,
      machineId,
    });
    const known = ids.map((id) => {
      const entry = resolveAgentCatalogProjection(id, {
        enabledAgentIds: ids,
        backendEnabledByTargetKey,
        mergedProviderProjectionById:
          projectionInputs?.mergedProviderProjectionById ?? null,
        mergedBackendProjectionById:
          projectionInputs?.mergedBackendProjectionById ?? null,
      });
      return { id, entry, title: entry.title };
    });
    // An Agent chosen earlier (or by an Action) that this machine no longer reports stays listed, so it can be turned off.
    const unknown = indexExternal.agents
      .filter((id) => !ids.includes(id))
      .map((id) => ({ id, entry: null, title: id }));
    return [...known, ...unknown];
  }, [
    backendEnabledByTargetKey,
    indexExternal.agents,
    machineId,
    projectionInputs,
  ]);

  const historyOptions = React.useMemo(() => {
    const windows = HISTORY_WINDOW_DAYS.includes(indexExternal.historyDays)
      ? HISTORY_WINDOW_DAYS
      : // A window set elsewhere (an Action) is shown as it is rather than as its nearest preset.
        [indexExternal.historyDays, ...HISTORY_WINDOW_DAYS];
    return windows.map((days) => ({
      id: historyWindowId(days),
      label: historyWindowLabel(days),
    }));
  }, [indexExternal.historyDays]);

  const [clearing, setClearing] = React.useState(false);
  const machineName = getMachineDisplayName(executionTarget?.machine) ?? '';
  const clearIndex = React.useCallback(async () => {
    const target = resolveWritableTarget();
    if (!target) return;
    const confirmed = await Modal.confirm(
      t('conversationSearch.clearConfirmTitle', {
        machine: getMachineDisplayName(target.machine),
      }),
      t('conversationSearch.clearConfirmBody'),
      { confirmText: t('conversationSearch.clearAction'), destructive: true },
    );
    if (!confirmed) return;
    setClearing(true);
    try {
      await clearDaemonMemoryIndex({
        machineId: target.machine.id,
        serverId: target.serverId,
      });
      await refreshStatus(target);
    } catch {
      Modal.alert(t('common.error'), t('conversationSearch.clearFailed'));
    } finally {
      setClearing(false);
    }
  }, [refreshStatus, resolveWritableTarget]);

  // The chip names the machine this page manages; it stays in every state because it is how the
  // user recovers from a missing or unreachable machine.
  const machineChip = (
    <MachineAdministrationTargetSelector
      selection={administrationTargetSelection}
      testIDPrefix="search-settings-target"
      presentation="chip"
    />
  );

  const standardSubtitle = ready
    ? undefined
    : access === 'noMachine'
      ? t('conversationSearch.chooseMachine')
      : access === 'pending'
        ? t('common.loading')
        : access === 'unreachable'
          ? t('conversationSearch.unreachable')
          : t('conversationSearch.updateRequired');

  const statusPresentation = presentDaemonMemoryStatus(memoryStatus);

  return (
    <ItemList>
      <SettingsPageHeader
        description={t('conversationSearch.pagePurpose')}
        actions={machineChip}
      />
      <SettingSection
        section={SEARCH_SETTINGS.sectionRefs.modes}
        answersFor={ready && memorySearchAvailable ? undefined : SEARCH_SECTIONS_AFTER_READY}
      >
        <ItemGroup
          title={t('conversationSearch.modesTitle')}
          description={t('conversationSearch.modesDescription')}
        >
          <SettingRow
            testID="search-settings-standard-item"
            setting={SEARCH_SETTINGS.settings.standardSearch}
            subtitle={standardSubtitle}
            subtitleLines={0}
            rightElement={
              ready ? (
                <Switch
                  testID="search-settings-standard"
                  value={conversationSearch.standardSearch.enabled}
                  onValueChange={(value) => {
                    writeConversationSearch({
                      ...conversationSearch,
                      standardSearch: { enabled: Boolean(value) },
                    });
                  }}
                />
              ) : access === 'unreachable' ? (
                <RoundButton
                  testID="search-settings-retry"
                  size="small"
                  display="secondary"
                  title={t('common.retry')}
                  disabled={loading}
                  onPress={() => fetchSettings()}
                />
              ) : null
            }
            showChevron={false}
          />
          {/* Memory search has one owner, the Memory page; this row says its state and leads there. */}
          {ready && memorySearchAvailable ? (
            <SettingRow
              testID="search-settings-memory-item"
              setting={SEARCH_SETTINGS.settings.memorySearch}
              subtitle={
                settings.enabled
                  ? t('conversationSearch.memoryOn')
                  : t('conversationSearch.memoryOff')
              }
              onPress={() => router.push(SETTINGS_ROUTES.memory)}
            />
          ) : null}
        </ItemGroup>
      </SettingSection>

      {ready && memorySearchAvailable ? (
        <SettingSection section={SEARCH_SETTINGS.sectionRefs.external}>
          <ItemGroup
            title={t('conversationSearch.externalTitle')}
            description={t('conversationSearch.externalDescription')}
          >
            <SettingRow
              testID="search-settings-index-external-item"
              setting={SEARCH_SETTINGS.settings.indexExternal}
              subtitle={
                settings.enabled
                  ? t('conversationSearch.externalEnableDescription')
                  : t('conversationSearch.externalNeedsMemory')
              }
              rightElement={
                <Switch
                  testID="search-settings-index-external"
                  value={settings.enabled && indexExternal.enabled}
                  disabled={!settings.enabled}
                  onValueChange={(value) =>
                    writeIndexExternal({ enabled: Boolean(value) })
                  }
                />
              }
              showChevron={false}
            />
            {indexing ? (
              <>
                <SettingAnchor setting={SEARCH_SETTINGS.settings.history}>
                  <SegmentedChoiceItem
                    title={t(SEARCH_SETTINGS.settings.history.titleKey)}
                    options={historyOptions}
                    value={historyWindowId(indexExternal.historyDays)}
                    onChange={(id) =>
                      writeIndexExternal({
                        historyDays: id === 'all' ? null : Number(id),
                      })
                    }
                    testIDPrefix="search-settings-history"
                  />
                </SettingAnchor>
                <SettingRow
                  testID="search-settings-tool-output-item"
                  setting={SEARCH_SETTINGS.settings.toolOutput}
                  rightElement={
                    <Switch
                      testID="search-settings-tool-output"
                      value={indexExternal.includeToolOutput}
                      onValueChange={(value) =>
                        writeIndexExternal({
                          includeToolOutput: Boolean(value),
                        })
                      }
                    />
                  }
                  showChevron={false}
                />
              </>
            ) : null}
          </ItemGroup>
        </SettingSection>
      ) : null}

      {indexing ? (
        <SettingAnchor setting={SEARCH_SETTINGS.settings.agents}>
        <ItemGroup
          title={t('conversationSearch.agentsTitle')}
          description={t('conversationSearch.agentsDescription')}
        >
          {agents.length === 0 ? (
            <Item
              testID="search-settings-agents-empty"
              title={
                projection.phase === 'ready'
                  ? t('conversationSearch.agentsNone')
                  : t('common.loading')
              }
              showChevron={false}
            />
          ) : (
            agents.map((agent) => (
              <Item
                key={agent.id}
                testID={`search-settings-agent-item:${agent.id}`}
                title={agent.title}
                icon={
                  agent.entry ? (
                    <AgentCatalogIdentityIcon
                      entry={agent.entry}
                      machineId={machineId}
                      serverId={serverId}
                      current
                      size={ICON_SIZE.md}
                    />
                  ) : (
                    <Icon name="stack-simple" />
                  )
                }
                rightElement={
                  <Switch
                    testID={`search-settings-agent:${agent.id}`}
                    value={indexExternal.agents.includes(agent.id)}
                    onValueChange={(value) =>
                      writeIndexExternal({
                        agents: value
                          ? [
                              ...indexExternal.agents.filter(
                                (id) => id !== agent.id,
                              ),
                              agent.id,
                            ]
                          : indexExternal.agents.filter(
                              (id) => id !== agent.id,
                            ),
                      })
                    }
                  />
                }
                showChevron={false}
              />
            ))
          )}
        </ItemGroup>
        </SettingAnchor>
      ) : null}

      {ready && memorySearchAvailable && settings.enabled ? (
        <SettingSection section={SEARCH_SETTINGS.sectionRefs.index}>
          <ItemGroup
            title={t('conversationSearch.indexTitle')}
            description={t('conversationSearch.indexDescription')}
          >
            <Item
              testID="search-settings-index-status"
              title={t('memorySearchSettings.status.title')}
              subtitle={
                loading && !statusPresentation
                  ? t('common.loading')
                  : t(
                      getDaemonMemoryStatusStateTranslationKey(
                        statusPresentation,
                      ),
                    )
              }
              subtitleLines={0}
              showChevron={false}
            />
            {/* Destructive, so it sits last and asks before it acts. */}
            <SettingRow
              testID="search-settings-clear-index-item"
              setting={SEARCH_SETTINGS.settings.clearIndex}
              subtitle={t('conversationSearch.clearDescription')}
              subtitleLines={0}
              rightElement={
                <RoundButton
                  testID="search-settings-clear-index"
                  size="small"
                  display="destructive"
                  title={t('conversationSearch.clearAction')}
                  accessibilityLabel={
                    machineName
                      ? t('conversationSearch.clearConfirmTitle', {
                          machine: machineName,
                        })
                      : undefined
                  }
                  loading={clearing}
                  disabled={clearing}
                  onPress={clearIndex}
                />
              }
              showChevron={false}
            />
          </ItemGroup>
        </SettingSection>
      ) : null}
    </ItemList>
  );
});
