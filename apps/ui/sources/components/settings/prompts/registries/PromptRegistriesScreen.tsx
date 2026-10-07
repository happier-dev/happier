import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet } from 'react-native-unistyles';

import {
  type PromptRegistryAdapterDescriptorV1,
  PromptRegistryConfiguredSourceV1Schema,
  type PromptRegistryConfiguredSourceV1,
  type PromptRegistryItemSummaryV1,
  type PromptRegistrySourceDescriptorV1,
} from '@happier-dev/protocol/prompts/library/promptRegistriesV1';

import { ContextBar } from '@/components/settings/contextBar/ContextBar';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { InlineAddExpander } from '@/components/ui/forms/InlineAddExpander';
import { useContextBarSelection } from '@/components/settings/contextBar/useContextBarSelection';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import { useSettingMutable } from '@/sync/domains/state/storage';
import {
  machinePromptRegistriesListAdapters,
  machinePromptRegistriesListSources,
  machinePromptRegistriesScanSource,
} from '@/sync/ops/machinePromptRegistries';
import { importPromptRegistrySkillItem } from '@/sync/ops/promptLibrary/promptRegistrySkillImports';
import { translatePromptLibraryMessage } from '@/sync/ops/promptLibrary/translatePromptLibraryMessage';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { useMachineAdministrationTargetSelection } from '@/sync/domains/machines/administration/useTargetSelection';
import { useMachineAdministrationExecutionTargetBinding } from '@/sync/domains/machines/administration/useExecutionTargetBinding';
import { t } from '@/text';
import { buildPromptRegistryItemDetailsHref } from './promptRegistryItemDetailsHref';

const styles = StyleSheet.create(() => ({
  addSourceFields: {
    gap: 12,
  },
}));

/**
 * `/settings/prompts/registries`: skill registries a machine can read (built in, or Git sources you
 * add), the skills in the selected source, and importing one into the library. Everything here is
 * read on the machine in the header chip; the configured Git sources belong to the Account.
 */
export const PromptRegistriesScreen = React.memo(function PromptRegistriesScreen() {
  const router = useRouter();
  const administrationTargetSelection = useMachineAdministrationTargetSelection(
    MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.promptRegistries,
  );
  const selectedTarget = administrationTargetSelection.selectedTarget;
  const {
    selectionKey,
    resolveExactExecutionTarget,
    isExecutionTargetCurrent,
    isSelectionCurrent,
  } = useMachineAdministrationExecutionTargetBinding(administrationTargetSelection);
  const [storedSources, setStoredSources] = useSettingMutable('promptRegistrySourcesV1');
  const {
    workspacePath,
    setWorkspacePath,
  } = useContextBarSelection({
    selectionKey: 'promptRegistries.browse',
    // This legacy context entry now carries only the workspace path. Its
    // machine field is deliberately ignored so it cannot compete with the
    // Administration-owned portable target.
    defaultMachineId: null,
  });
  const [configuredSources, setConfiguredSources] = React.useState<PromptRegistryConfiguredSourceV1[]>(() => storedSources.sources);
  const [adapterDescriptors, setAdapterDescriptors] = React.useState<PromptRegistryAdapterDescriptorV1[]>([]);
  const [sources, setSources] = React.useState<PromptRegistrySourceDescriptorV1[]>([]);
  const [selectedSourceId, setSelectedSourceId] = React.useState<string | null>(null);
  const [items, setItems] = React.useState<PromptRegistryItemSummaryV1[]>([]);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [isAddGitSourceOpen, setIsAddGitSourceOpen] = React.useState(false);
  const [sourceTitle, setSourceTitle] = React.useState('');
  const [sourceUrl, setSourceUrl] = React.useState('');
  const [hasLoadedOnce, setHasLoadedOnce] = React.useState(false);
  const storedSourcesSnapshot = React.useMemo(() => JSON.stringify(storedSources.sources), [storedSources.sources]);

  React.useEffect(() => {
    setConfiguredSources(storedSources.sources);
  }, [storedSourcesSnapshot]);

  const selectedSourceIdRef = React.useRef<string | null>(selectedSourceId);
  const searchQueryRef = React.useRef(searchQuery);
  const sourcesRef = React.useRef<PromptRegistrySourceDescriptorV1[]>(sources);
  const adapterDescriptorsRef = React.useRef<PromptRegistryAdapterDescriptorV1[]>(adapterDescriptors);
  const latestScanRequestIdRef = React.useRef(0);
  const previousSelectionKeyRef = React.useRef(selectionKey);

  React.useEffect(() => {
    selectedSourceIdRef.current = selectedSourceId;
  }, [selectedSourceId]);

  React.useEffect(() => {
    searchQueryRef.current = searchQuery;
  }, [searchQuery]);

  React.useEffect(() => {
    sourcesRef.current = sources;
  }, [sources]);

  React.useEffect(() => {
    adapterDescriptorsRef.current = adapterDescriptors;
  }, [adapterDescriptors]);

  React.useLayoutEffect(() => {
    const previousSelectionKey = previousSelectionKeyRef.current;
    previousSelectionKeyRef.current = selectionKey;
    if (!previousSelectionKey || previousSelectionKey === selectionKey) return;
    setWorkspacePath('');
  }, [selectionKey, setWorkspacePath]);

  React.useEffect(() => {
    latestScanRequestIdRef.current += 1;
    setAdapterDescriptors([]);
    setSources([]);
    setSelectedSourceId(null);
    setItems([]);
    setHasLoadedOnce(false);
  }, [selectionKey]);

  const persistConfiguredSources = React.useCallback((nextSources: PromptRegistryConfiguredSourceV1[]) => {
    setConfiguredSources(nextSources);
    setStoredSources({ v: 1, sources: nextSources });
  }, [setStoredSources]);

  const selectedSource = React.useMemo(
    () => sources.find((source) => source.id === selectedSourceId) ?? null,
    [selectedSourceId, sources],
  );

  const selectedAdapterDescriptor = React.useMemo(
    () => adapterDescriptors.find((adapter) => adapter.id === selectedSource?.adapterId) ?? null,
    [adapterDescriptors, selectedSource?.adapterId],
  );

  const listSources = React.useCallback(async (): Promise<PromptRegistrySourceDescriptorV1[]> => {
    const requestedSelection = selectionKey;
    const executionTarget = resolveExactExecutionTarget(selectedTarget);
    if (!executionTarget) {
      setHasLoadedOnce(true);
      return [];
    }

    const response = await machinePromptRegistriesListSources(executionTarget.machine.id, {
      configuredSources,
    }, { serverId: executionTarget.serverId });
    if (!isExecutionTargetCurrent(requestedSelection, executionTarget)) return [];
    if (!response.ok) {
      Modal.alert(t('common.error'), response.error);
      return [];
    }
    setSources(response.sources);
    setHasLoadedOnce(true);
    return response.sources;
  }, [configuredSources, isExecutionTargetCurrent, resolveExactExecutionTarget, selectedTarget, selectionKey]);

  const listAdapters = React.useCallback(async (): Promise<PromptRegistryAdapterDescriptorV1[]> => {
    const requestedSelection = selectionKey;
    const executionTarget = resolveExactExecutionTarget(selectedTarget);
    if (!executionTarget) {
      setAdapterDescriptors([]);
      return [];
    }

    const response = await machinePromptRegistriesListAdapters(executionTarget.machine.id, {
      serverId: executionTarget.serverId,
    });
    if (!isExecutionTargetCurrent(requestedSelection, executionTarget)) return [];
    if (!response.ok) {
      Modal.alert(t('common.error'), response.error);
      return [];
    }
    setAdapterDescriptors(response.adapters);
    return response.adapters;
  }, [isExecutionTargetCurrent, resolveExactExecutionTarget, selectedTarget, selectionKey]);

  const scanSource = React.useCallback(async (
    sourceId: string,
    query?: string | null,
    nextSources: readonly PromptRegistrySourceDescriptorV1[] = sourcesRef.current,
    nextAdapterDescriptors: readonly PromptRegistryAdapterDescriptorV1[] = adapterDescriptorsRef.current,
  ): Promise<PromptRegistryItemSummaryV1[]> => {
    const requestedSelection = selectionKey;
    const executionTarget = resolveExactExecutionTarget(selectedTarget);
    if (!executionTarget) return [];

    const requestId = latestScanRequestIdRef.current + 1;
    latestScanRequestIdRef.current = requestId;
    setSelectedSourceId(sourceId);
    const trimmedQuery = String(query ?? '').trim();
    const source = nextSources.find((entry) => entry.id === sourceId) ?? null;
    const minimumQueryLength = nextAdapterDescriptors.find((entry) => entry.id === source?.adapterId)?.minimumQueryLength ?? null;
    if (minimumQueryLength && trimmedQuery.length > 0 && trimmedQuery.length < minimumQueryLength) {
      if (latestScanRequestIdRef.current === requestId) {
        setItems([]);
      }
      return [];
    }

    const response = await machinePromptRegistriesScanSource(executionTarget.machine.id, {
      sourceId,
      configuredSources,
      query: trimmedQuery || undefined,
    }, { serverId: executionTarget.serverId });
    if (
      latestScanRequestIdRef.current !== requestId
      || !isExecutionTargetCurrent(requestedSelection, executionTarget)
    ) {
      return [];
    }
    if (!response.ok) {
      Modal.alert(t('common.error'), response.error);
      return [];
    }
    setItems(response.items);
    return response.items;
  }, [configuredSources, isExecutionTargetCurrent, resolveExactExecutionTarget, selectedTarget, selectionKey]);

  const refreshSources = React.useCallback(async () => {
    const requestedSelection = selectionKey;
    const nextAdapterDescriptors = await listAdapters();
    const nextSources = await listSources();
    if (!isSelectionCurrent(requestedSelection)) return;
    if (nextSources.length === 0) {
      setSelectedSourceId(null);
      setItems([]);
      return;
    }
    const nextSelectedSourceId = nextSources.some((source) => source.id === selectedSourceIdRef.current)
      ? selectedSourceIdRef.current
      : nextSources[0]?.id ?? null;
    setSelectedSourceId(nextSelectedSourceId);
    if (nextSelectedSourceId) {
      await scanSource(nextSelectedSourceId, searchQueryRef.current, nextSources, nextAdapterDescriptors);
    }
  }, [isSelectionCurrent, listAdapters, listSources, scanSource, selectionKey]);

  const [refreshing, runRefresh] = useHappyAction(refreshSources);

  React.useEffect(() => {
    runRefresh();
  }, [runRefresh]);

  const addGitSource = React.useCallback(() => {
    const title = sourceTitle.trim();
    const repositoryUrl = sourceUrl.trim();
    if (!title || !repositoryUrl) {
      Modal.alert(t('common.error'), t('promptLibrary.registriesAddGitSourceError'));
      return;
    }

    const nextSource = PromptRegistryConfiguredSourceV1Schema.parse({
      id: randomUUID(),
      adapterId: 'git',
      title,
      enabled: true,
      config: { repositoryUrl },
    });
    persistConfiguredSources([...configuredSources, nextSource]);
    setSourceTitle('');
    setSourceUrl('');
    setIsAddGitSourceOpen(false);
  }, [configuredSources, persistConfiguredSources, sourceTitle, sourceUrl]);

  const removeSource = React.useCallback((sourceId: string) => {
    const nextSources = configuredSources.filter((source) => `git:${source.id}` !== sourceId && source.id !== sourceId);
    persistConfiguredSources(nextSources);
    if (selectedSourceId === sourceId) {
      setSelectedSourceId(null);
      setItems([]);
    }
  }, [configuredSources, persistConfiguredSources, selectedSourceId]);

  const importItem = React.useCallback(async (item: PromptRegistryItemSummaryV1) => {
    const requestedSelection = selectionKey;
    const executionTarget = resolveExactExecutionTarget(selectedTarget);
    if (!executionTarget) return;

    const imported = await importPromptRegistrySkillItem({
      machineId: executionTarget.machine.id,
      serverId: executionTarget.serverId,
      configuredSources,
      sourceId: item.sourceId,
      itemId: item.itemId,
    });
    if (!isExecutionTargetCurrent(requestedSelection, executionTarget)) return;
    if (!imported.ok) {
      Modal.alert(t('common.error'), translatePromptLibraryMessage(imported.error));
      return;
    }
    router.push(`/settings/prompts/skills/${imported.artifactId}`);
  }, [configuredSources, isExecutionTargetCurrent, resolveExactExecutionTarget, router, selectedTarget, selectionKey]);

  const openItemDetails = React.useCallback((item: PromptRegistryItemSummaryV1) => {
    const executionTarget = resolveExactExecutionTarget(selectedTarget);
    if (!executionTarget) return;
    router.push(buildPromptRegistryItemDetailsHref({
      item,
      workspacePath,
    }));
  }, [resolveExactExecutionTarget, router, selectedTarget, workspacePath]);

  const searchSelectedSource = React.useCallback(async () => {
    if (!selectedSourceId) return;
    await scanSource(selectedSourceId, searchQuery);
  }, [scanSource, searchQuery, selectedSourceId]);

  const [searching, runSearchSelectedSource] = useHappyAction(searchSelectedSource);
  const executionTarget = resolveExactExecutionTarget(selectedTarget);

  return (
    <ItemList keyboardShouldPersistTaps="handled">
      <SettingsPageHeader
        description={t('promptLibrary.surface.registriesPageDescription')}
        actions={(
          <MachineAdministrationTargetSelector
            selection={administrationTargetSelection}
            presentation="chip"
            testIDPrefix="settings.promptRegistries.administration.target"
          />
        )}
      />
      <ItemGroup title={t('promptLibrary.surface.projectSection')} description={t('promptLibrary.surface.registriesProjectDescription')}>
        <ContextBar
          mode="workspace_only"
          workspace={{
            value: workspacePath,
            onChange: setWorkspacePath,
            placeholder: t('promptLibrary.surface.projectDirectoryPlaceholder'),
            testID: 'promptRegistries.workspacePath',
            browse: {
              machineId: executionTarget?.machine.id ?? null,
              serverId: executionTarget?.serverId ?? null,
              enabled: administrationTargetSelection.canExecute,
            },
          }}
        />
      </ItemGroup>

      <ItemGroup
        title={t('promptLibrary.registriesSources')}
        description={t('promptLibrary.surface.registriesSourcesDescription')}
        action={(
          <SectionActionButton
            testID="promptRegistries.refresh"
            title={t('common.refresh')}
            icon="arrow-clockwise"
            loading={refreshing}
            disabled={refreshing || !administrationTargetSelection.canExecute}
            onPress={runRefresh}
          />
        )}
      >
        {!hasLoadedOnce && refreshing ? (
          <Item
            testID="promptRegistries.loading"
            title={t('common.loading')}
            subtitle={t('promptLibrary.registriesRefreshSubtitle')}
            mode="info"
            showChevron={false}
          />
        ) : null}
        {sources.length > 0 ? sources.map((source, index) => (
          <Item
            key={source.id}
            testID={`promptRegistries.source.${index}`}
            title={source.title}
            subtitle={source.subtitle || source.id}
            selected={source.id === selectedSourceId}
            onPress={() => void scanSource(source.id)}
            rightElement={source.origin === 'user' ? (
              <ItemRowActions
                title={source.title}
                compactActionIds={['delete']}
                actions={[
                  {
                    id: 'delete',
                    title: t('common.delete'),
                    icon: 'trash',
                    destructive: true,
                    onPress: () => removeSource(source.id),
                  },
                ]}
              />
            ) : undefined}
          />
        )) : hasLoadedOnce || !refreshing ? (
          <Item
            testID="promptRegistries.sources.empty"
            title={t('promptLibrary.registriesNoSources')}
            subtitle={t('promptLibrary.registriesNoSourcesSubtitle')}
            mode="info"
            showChevron={false}
          />
        ) : null}
        <InlineAddExpander
          isOpen={isAddGitSourceOpen}
          onOpenChange={setIsAddGitSourceOpen}
          triggerTestID="promptRegistries.addGitSource"
          title={t('promptLibrary.registriesAddGitSource')}
          subtitle={t('promptLibrary.registriesAddGitSourceSubtitle')}
          onCancel={() => {
            setSourceTitle('');
            setSourceUrl('');
            setIsAddGitSourceOpen(false);
          }}
          onSave={addGitSource}
          saveDisabled={sourceTitle.trim().length === 0 || sourceUrl.trim().length === 0}
          cancelLabel={t('common.cancel')}
          saveLabel={t('common.save')}
        >
          <View style={styles.addSourceFields}>
            <FieldTextInput
              testID="promptRegistries.sourceTitle"
              accessibilityLabel={t('promptLibrary.registriesSourceTitleLabel')}
              placeholder={t('promptLibrary.registriesSourceTitlePlaceholder')}
              value={sourceTitle}
              onChangeText={setSourceTitle}
            />
            <FieldTextInput
              testID="promptRegistries.sourceUrl"
              accessibilityLabel={t('promptLibrary.registriesSourceUrlLabel')}
              placeholder={t('promptLibrary.registriesSourceUrlPlaceholder')}
              value={sourceUrl}
              onChangeText={setSourceUrl}
              autoCapitalize="none"
              monospace
            />
          </View>
        </InlineAddExpander>
      </ItemGroup>

      <ItemGroup title={t('promptLibrary.registriesItems')} description={t('promptLibrary.surface.registriesItemsDescription')}>
        <Item
          title={t('promptLibrary.registriesSearchLabel')}
          accessoryLayout="adaptive"
          showChevron={false}
          rightElement={(
            <FieldTextInput
              testID="promptRegistries.searchQuery"
              accessibilityLabel={t('promptLibrary.registriesSearchLabel')}
              placeholder={t('promptLibrary.registriesSearchPlaceholder')}
              value={searchQuery}
              onChangeText={setSearchQuery}
              onSubmitEditing={runSearchSelectedSource}
              autoCapitalize="none"
              returnKeyType="search"
            />
          )}
        />
        {items.length > 0 ? items.map((item, index) => (
          <Item
            key={item.itemId}
            testID={`promptRegistries.item.${index}`}
            title={item.title}
            subtitle={item.description || item.displayPath}
            onPress={() => openItemDetails(item)}
            rightElement={(
              <ItemRowActions
                title={item.title}
                compactActionIds={['details', 'import']}
                actions={[
                  {
                    id: 'details',
                    title: t('common.details'),
                    icon: 'eye',
                    onPress: () => openItemDetails(item),
                  },
                  {
                    id: 'import',
                    title: t('promptLibrary.externalAssetsImportAction'),
                    icon: 'download',
                    disabled: searching,
                    onPress: () => { void importItem(item); },
                  },
                ]}
              />
            )}
          />
        )) : (
          <Item
            testID="promptRegistries.items.empty"
            title={t('promptLibrary.registriesNoItems')}
            subtitle={t('promptLibrary.registriesNoItemsSubtitle')}
            mode="info"
            showChevron={false}
          />
        )}
      </ItemGroup>
    </ItemList>
  );
});
