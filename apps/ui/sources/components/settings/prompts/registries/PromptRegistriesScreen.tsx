import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
  type PromptRegistryAdapterDescriptorV1,
  PromptRegistryConfiguredSourceV1Schema,
  type PromptRegistryConfiguredSourceV1,
  type PromptRegistryItemSummaryV1,
  type PromptRegistrySourceDescriptorV1,
} from '@happier-dev/protocol';

import { ContextBar } from '@/components/settings/contextBar/ContextBar';
import { InlineAddExpander } from '@/components/ui/forms/InlineAddExpander';
import { SETTINGS_TEXT_INPUT_METRICS } from '@/components/ui/forms/settingsTextInputMetrics';
import { useContextBarSelection } from '@/components/settings/contextBar/useContextBarSelection';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { layout } from '@/components/ui/layout/layout';
import { Text, TextInput } from '@/components/ui/text/Text';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import { useAllMachines, useSettingMutable } from '@/sync/domains/state/storage';
import {
  machinePromptRegistriesListAdapters,
  machinePromptRegistriesListSources,
  machinePromptRegistriesScanSource,
} from '@/sync/ops/machinePromptRegistries';
import { importPromptRegistrySkillItem } from '@/sync/ops/promptLibrary/promptRegistrySkillImports';
import { translatePromptLibraryMessage } from '@/sync/ops/promptLibrary/translatePromptLibraryMessage';
import { usePrimaryMachineFromActiveSelection } from '@/components/settings/server/hooks/usePrimaryMachineFromActiveSelection';
import { t, type TranslationKey } from '@/text';
import { buildPromptRegistryItemDetailsHref } from './promptRegistryItemDetailsHref';

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background.canvas,
  },
  content: {
    paddingVertical: 12,
    maxWidth: layout.maxWidth,
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

function describeMachine(
  machineId: string,
  machines: ReadonlyArray<{ id: string; metadata?: { displayName?: string | null; host?: string | null } | null }>,
): string {
  const machine = machines.find((entry) => entry.id === machineId) ?? null;
  return machine?.metadata?.displayName || machine?.metadata?.host || machineId;
}

export const PromptRegistriesScreen = React.memo(function PromptRegistriesScreen() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const machines = useAllMachines();
  const primaryMachineId = usePrimaryMachineFromActiveSelection();
  const [storedSources, setStoredSources] = useSettingMutable('promptRegistrySourcesV1');
  const defaultMachineId = primaryMachineId;
  const {
    machineId,
    setMachineId,
    workspacePath,
    setWorkspacePath,
  } = useContextBarSelection({
    selectionKey: 'promptRegistries.browse',
    defaultMachineId,
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

  React.useEffect(() => {
    if (machineId && machines.some((entry) => entry.id === machineId)) return;
    setMachineId(defaultMachineId);
  }, [defaultMachineId, machineId, machines, setMachineId]);

  const machineItems = React.useMemo(() => {
    return machines.map((machine) => ({
      id: machine.id,
      title: machine.metadata?.displayName || machine.metadata?.host || machine.id,
      subtitle: machine.id,
      icon: <Ionicons name="laptop-outline" size={22} color={theme.colors.text.secondary} />,
    }));
  }, [machines, theme.colors.text.secondary]);

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
    if (!machineId) {
      setHasLoadedOnce(true);
      return [];
    }

    const response = await machinePromptRegistriesListSources(machineId, {
      configuredSources,
    });
    if (!response.ok) {
      Modal.alert(t('common.error'), response.error);
      return [];
    }
    setSources(response.sources);
    setHasLoadedOnce(true);
    return response.sources;
  }, [configuredSources, machineId]);

  const listAdapters = React.useCallback(async (): Promise<PromptRegistryAdapterDescriptorV1[]> => {
    if (!machineId) {
      setAdapterDescriptors([]);
      return [];
    }

    const response = await machinePromptRegistriesListAdapters(machineId);
    if (!response.ok) {
      Modal.alert(t('common.error'), response.error);
      return [];
    }
    setAdapterDescriptors(response.adapters);
    return response.adapters;
  }, [machineId]);

  const scanSource = React.useCallback(async (
    sourceId: string,
    query?: string | null,
    nextSources: readonly PromptRegistrySourceDescriptorV1[] = sourcesRef.current,
    nextAdapterDescriptors: readonly PromptRegistryAdapterDescriptorV1[] = adapterDescriptorsRef.current,
  ): Promise<PromptRegistryItemSummaryV1[]> => {
    if (!machineId) return [];

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

    const response = await machinePromptRegistriesScanSource(machineId, {
      sourceId,
      configuredSources,
      query: trimmedQuery || undefined,
    });
    if (latestScanRequestIdRef.current !== requestId) {
      return [];
    }
    if (!response.ok) {
      Modal.alert(t('common.error'), response.error);
      return [];
    }
    setItems(response.items);
    return response.items;
  }, [configuredSources, machineId]);

  const refreshSources = React.useCallback(async () => {
    const nextAdapterDescriptors = await listAdapters();
    const nextSources = await listSources();
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
  }, [listAdapters, listSources, scanSource]);

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
    if (!machineId) return;

    const imported = await importPromptRegistrySkillItem({
      machineId,
      configuredSources,
      sourceId: item.sourceId,
      itemId: item.itemId,
    });
    if (!imported.ok) {
      Modal.alert(t('common.error'), translatePromptLibraryMessage(imported.error));
      return;
    }
    router.push(`/settings/prompts/skills/${imported.artifactId}`);
  }, [configuredSources, machineId, router]);

  const openItemDetails = React.useCallback((item: PromptRegistryItemSummaryV1) => {
    if (!machineId) return;
    router.push(buildPromptRegistryItemDetailsHref({
      machineId,
      item,
      workspacePath,
    }));
  }, [machineId, router, workspacePath]);

  const searchSelectedSource = React.useCallback(async () => {
    if (!selectedSourceId) return;
    await scanSource(selectedSourceId, searchQuery);
  }, [scanSource, searchQuery, selectedSourceId]);

  const [searching, runSearchSelectedSource] = useHappyAction(searchSelectedSource);

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <ItemList>
          <ItemGroup title={t('promptLibrary.registriesContext')}>
            <ContextBar
              mode="machine_and_workspace"
              machine={{
                selectedId: machineId,
                subtitle: machineId ? describeMachine(machineId, machines) : t('promptLibrary.registriesNoMachine'),
                items: machineItems,
                onSelect: (nextMachineId) => {
                  setMachineId(nextMachineId);
                  setWorkspacePath('');
                },
              }}
              workspace={{
                value: workspacePath,
                onChange: setWorkspacePath,
                placeholder: t('promptLibrary.externalAssetsProjectDirectoryPlaceholder' as TranslationKey),
                testID: 'promptRegistries.workspacePath',
                browse: {
                  machineId,
                  enabled: true,
                },
              }}
            />
            <Item
              testID="promptRegistries.refresh"
              title={t('promptLibrary.registriesRefresh')}
              subtitle={refreshing ? t('common.loading') : t('promptLibrary.registriesRefreshSubtitle')}
              icon={<Ionicons name="refresh-outline" size={29} color={theme.colors.accent.purple} />}
              disabled={refreshing || !machineId}
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
                icon={<Ionicons name="refresh-outline" size={29} color={theme.colors.accent.purple} />}
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
                icon={<Ionicons name="git-branch-outline" size={29} color={theme.colors.text.secondary} />}
                onPress={() => void scanSource(source.id)}
                rightElement={source.origin === 'user' ? (
                  <ItemRowActions
                    title={source.title}
                    compactActionIds={['delete']}
                    actions={[
                      {
                        id: 'delete',
                        title: t('common.delete'),
                        icon: 'trash-outline',
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
                icon={<Ionicons name="albums-outline" size={29} color={theme.colors.text.secondary} />}
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
              icon={<Ionicons name="add-circle-outline" size={29} color={theme.colors.accent.blue} />}
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
                icon={<Ionicons name="sparkles-outline" size={29} color={theme.colors.accent.indigo} />}
                onPress={() => openItemDetails(item)}
                rightElement={(
                  <ItemRowActions
                    title={item.title}
                    compactActionIds={['details', 'import']}
                    actions={[
                      {
                        id: 'details',
                        title: t('common.details'),
                        icon: 'eye-outline',
                        onPress: () => openItemDetails(item),
                      },
                      {
                        id: 'import',
                        title: t('promptLibrary.externalAssetsImportAction'),
                        icon: 'download-outline',
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
                icon={<Ionicons name="sparkles-outline" size={29} color={theme.colors.text.secondary} />}
                showChevron={false}
              />
            )}
          </ItemGroup>
        </ItemList>
      </ScrollView>
    </View>
  );
});
