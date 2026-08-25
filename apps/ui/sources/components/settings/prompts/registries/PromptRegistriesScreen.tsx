import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
  type MachineAdministrationTargetV1,
  type PromptRegistryAdapterDescriptorV1,
  PromptRegistryConfiguredSourceV1Schema,
  type PromptRegistryConfiguredSourceV1,
  type PromptRegistryItemSummaryV1,
  type PromptRegistrySourceDescriptorV1,
} from '@happier-dev/protocol';

import { ContextBar } from '@/components/settings/contextBar/ContextBar';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { InlineAddExpander } from '@/components/ui/forms/InlineAddExpander';
import { SETTINGS_TEXT_INPUT_METRICS } from '@/components/ui/forms/settingsTextInputMetrics';
import { useContextBarSelection } from '@/components/settings/contextBar/useContextBarSelection';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { Text, TextInput } from '@/components/ui/text/Text';
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
import { machineAdministrationTargetsEqual } from '@/sync/domains/machines/administration/targetSelection';
import {
  useMachineAdministrationTargetSelection,
  type FreshMachineAdministrationExecutionTargetV1,
} from '@/sync/domains/machines/administration/useTargetSelection';
import { isMachineAdministrationExecutionTargetCurrent } from '@/sync/domains/machines/administration/operationCurrentness';
import { t, type TranslationKey } from '@/text';
import { buildPromptRegistryItemDetailsHref } from './promptRegistryItemDetailsHref';
import { Icon } from '@/components/ui/icons/Icon';

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background.canvas,
  },
  content: {
    paddingVertical: 12,
    width: '100%',
    alignSelf: 'center',
  },
  input: {
    backgroundColor: theme.colors.input.background,
    color: theme.colors.input.text,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    ...SETTINGS_TEXT_INPUT_METRICS,
    marginHorizontal: 12,
    marginBottom: 12,
  },
  searchInput: {
    marginTop: 12,
  },
  fieldLabel: {
    color: theme.colors.text.secondary,
    fontSize: 14,
    marginHorizontal: 12,
    marginBottom: 8,
  },
}));

export const PromptRegistriesScreen = React.memo(function PromptRegistriesScreen() {
  // Composed at render time: the module-scope stylesheet evaluates once, so a
  // baked-in `layout.maxWidth` would freeze the user's content-width preference.
  const contentMaxWidthStyle = useLayoutMaxWidthStyle();
  const contentStyle = React.useMemo(() => [styles.content, contentMaxWidthStyle], [contentMaxWidthStyle]);
  const { theme } = useUnistyles();
  const router = useRouter();
  const administrationTargetSelection = useMachineAdministrationTargetSelection(
    MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.promptRegistries,
  );
  const selectedTarget = administrationTargetSelection.selectedTarget;
  const selectionKey = selectedTarget
    ? `${selectedTarget.serverIdentityId}\0${selectedTarget.machineId}`
    : '';
  const selectionKeyRef = React.useRef(selectionKey);
  selectionKeyRef.current = selectionKey;
  const resolveExecutionTargetRef = React.useRef(administrationTargetSelection.resolveExecutionTarget);
  resolveExecutionTargetRef.current = administrationTargetSelection.resolveExecutionTarget;
  const resolveExactExecutionTarget = React.useCallback((
    expectedTarget: MachineAdministrationTargetV1 | null,
  ): FreshMachineAdministrationExecutionTargetV1 | null => {
    const resolved = resolveExecutionTargetRef.current();
    return expectedTarget !== null
      && resolved !== null
      && machineAdministrationTargetsEqual(expectedTarget, resolved.target)
      ? resolved
      : null;
  }, []);
  const isExecutionTargetCurrent = React.useCallback((
    requestedSelection: string,
    executionTarget: FreshMachineAdministrationExecutionTargetV1,
  ): boolean => {
    return isMachineAdministrationExecutionTargetCurrent({
      expectedTarget: executionTarget,
      resolveCurrentTarget: resolveExecutionTargetRef.current,
      expectedSelectionKey: requestedSelection,
      currentSelectionKey: selectionKeyRef.current,
    });
  }, []);
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
    if (selectionKeyRef.current !== requestedSelection) return;
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
  }, [listAdapters, listSources, scanSource, selectionKey]);

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
    <View style={styles.container}>
      <ScrollView contentContainerStyle={contentStyle} keyboardShouldPersistTaps="handled">
        <ItemList>
          <MachineAdministrationTargetSelector
            selection={administrationTargetSelection}
            testIDPrefix="settings.promptRegistries.administration.target"
          />
          <ItemGroup title={t('promptLibrary.registriesContext')}>
            <ContextBar
              mode="workspace_only"
              workspace={{
                value: workspacePath,
                onChange: setWorkspacePath,
                placeholder: t('promptLibrary.externalAssetsProjectDirectoryPlaceholder' as TranslationKey),
                testID: 'promptRegistries.workspacePath',
                browse: {
                  machineId: executionTarget?.machine.id ?? null,
                  serverId: executionTarget?.serverId ?? null,
                  enabled: administrationTargetSelection.canExecute,
                },
              }}
            />
            <Item
              testID="promptRegistries.refresh"
              title={t('promptLibrary.registriesRefresh')}
              subtitle={refreshing ? t('common.loading') : t('promptLibrary.registriesRefreshSubtitle')}
              icon={<Icon name="arrow-clockwise" size={29} color={theme.colors.accent.purple} />}
              disabled={refreshing || !administrationTargetSelection.canExecute}
              onPress={runRefresh}
              showChevron={false}
            />
          </ItemGroup>

          <ItemGroup title={t('promptLibrary.registriesSources')}>
            {!hasLoadedOnce && refreshing ? (
              <Item
                testID="promptRegistries.loading"
                title={t('common.loading')}
                subtitle={t('promptLibrary.registriesRefreshSubtitle')}
                icon={<Icon name="arrow-clockwise" size={29} color={theme.colors.accent.purple} />}
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
                icon={<Icon name="git-branch" size={29} color={theme.colors.text.secondary} />}
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
            )) : (
              <Item
                testID="promptRegistries.sources.empty"
                title={t('promptLibrary.registriesNoSources')}
                subtitle={t('promptLibrary.registriesNoSourcesSubtitle')}
                icon={<Icon name="stack" size={29} color={theme.colors.text.secondary} />}
                showChevron={false}
              />
            )}
          </ItemGroup>

          <ItemGroup>
            <InlineAddExpander
              isOpen={isAddGitSourceOpen}
              onOpenChange={setIsAddGitSourceOpen}
              triggerTestID="promptRegistries.addGitSource"
              title={t('promptLibrary.registriesAddGitSource')}
              subtitle={t('promptLibrary.registriesAddGitSourceSubtitle')}
              icon={<Icon name="plus-circle" size={29} color={theme.colors.accent.blue} />}
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
              <Text style={styles.fieldLabel}>{t('promptLibrary.registriesSourceTitleLabel')}</Text>
              <TextInput
                testID="promptRegistries.sourceTitle"
                placeholder={t('promptLibrary.registriesSourceTitlePlaceholder')}
                placeholderTextColor={theme.colors.input.placeholder}
                value={sourceTitle}
                onChangeText={setSourceTitle}
                style={styles.input}
              />
              <Text style={styles.fieldLabel}>{t('promptLibrary.registriesSourceUrlLabel')}</Text>
              <TextInput
                testID="promptRegistries.sourceUrl"
                placeholder={t('promptLibrary.registriesSourceUrlPlaceholder')}
                placeholderTextColor={theme.colors.input.placeholder}
                value={sourceUrl}
                onChangeText={setSourceUrl}
                style={styles.input}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </InlineAddExpander>
          </ItemGroup>

          <ItemGroup title={t('promptLibrary.registriesItems')}>
            <TextInput
              testID="promptRegistries.searchQuery"
              placeholder={t('promptLibrary.registriesSearchPlaceholder')}
              placeholderTextColor={theme.colors.input.placeholder}
              value={searchQuery}
              onChangeText={setSearchQuery}
              onSubmitEditing={runSearchSelectedSource}
              style={[styles.input, styles.searchInput]}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
            />
            {items.length > 0 ? items.map((item, index) => (
              <Item
                key={item.itemId}
                testID={`promptRegistries.item.${index}`}
                title={item.title}
                subtitle={item.description || item.displayPath}
                icon={<Icon name="sparkle" size={29} color={theme.colors.accent.indigo} />}
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
                icon={<Icon name="sparkle" size={29} color={theme.colors.text.secondary} />}
                showChevron={false}
              />
            )}
          </ItemGroup>
        </ItemList>
      </ScrollView>
    </View>
  );
});
