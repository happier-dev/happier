import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type {
  PromptAssetInstallModeV1,
  PromptAssetScopeV1,
  PromptAssetTypeDescriptorV1,
  PromptRegistryConfiguredSourceV1,
  PromptRegistryFetchedItemV1,
} from '@happier-dev/protocol';

import { defaultPromptAssetTargetInput } from '@/components/settings/prompts/assets/promptAssetExportDefaults';
import { ContextBar } from '@/components/contextBar/ContextBar';
import { useContextBarSelection } from '@/components/contextBar/useContextBarSelection';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { layout } from '@/components/ui/layout/layout';
import { SettingsActionFooter } from '@/components/ui/settingsSurface/SettingsActionFooter';
import { Text, TextInput } from '@/components/ui/text/Text';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { Modal } from '@/modal';
import { useAllMachines, useSettingMutable } from '@/sync/domains/state/storage';
import { machinePromptAssetsListTypes } from '@/sync/ops/machinePromptAssets';
import { machinePromptRegistriesFetchItem } from '@/sync/ops/machinePromptRegistries';
import { installPromptRegistryItem } from '@/sync/ops/promptLibrary/installPromptRegistryItem';
import { createPromptRegistrySkillArtifactFromFetchedItem } from '@/sync/ops/promptLibrary/promptRegistrySkillImports';
import { translatePromptLibraryMessage } from '@/sync/ops/promptLibrary/translatePromptLibraryMessage';
import { t, type TranslationKey } from '@/text';
import {
  listPromptAssetTypesForScope,
  resolvePromptAssetTypeSelection,
} from '@/components/settings/prompts/shared/promptAssetTypeSelection';
import {
  listPromptAssetInstallModesForType,
  resolvePromptAssetInstallModeSelection,
} from '@/components/settings/prompts/shared/promptAssetInstallModeSelection';

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.groupped.background,
  },
  content: {
    paddingVertical: 12,
    maxWidth: layout.maxWidth,
    width: '100%',
    alignSelf: 'center',
  },
  previewGroup: {
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  previewText: {
    color: theme.colors.text,
    fontFamily: 'monospace',
    fontSize: 13,
    lineHeight: 20,
  },
  previewEmpty: {
    color: theme.colors.textSecondary,
    fontSize: 14,
  },
  input: {
    backgroundColor: theme.colors.input.background,
    color: theme.colors.input.text,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 12,
  },
}));

function decodeUtf8BundleEntry(item: PromptRegistryFetchedItemV1 | null, path: string): string | null {
  const entry = item?.bundleBody.entries.find((candidate) => candidate.path === path && candidate.contentKind === 'utf8') ?? null;
  if (!entry) return null;
  try {
    return Buffer.from(entry.contentBase64, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

export const PromptRegistryItemDetailsScreen = React.memo(function PromptRegistryItemDetailsScreen(props: Readonly<{
  machineId: string;
  sourceId: string;
  itemId: string;
  configuredSources: PromptRegistryConfiguredSourceV1[];
  title?: string | null;
  displayPath?: string | null;
  workspacePath?: string | null;
}>) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const machines = useAllMachines();
  const [promptExternalLinksV1, setPromptExternalLinksV1] = useSettingMutable('promptExternalLinksV1');
  const [item, setItem] = React.useState<PromptRegistryFetchedItemV1 | null>(null);
  const [installTypes, setInstallTypes] = React.useState<PromptAssetTypeDescriptorV1[]>([]);
  const [installScope, setInstallScope] = React.useState<PromptAssetScopeV1>('project');
  const [scopeMenuOpen, setScopeMenuOpen] = React.useState(false);
  const [typeMenuOpen, setTypeMenuOpen] = React.useState(false);
  const [selectedInstallTypeId, setSelectedInstallTypeId] = React.useState<string | null>(null);
  const [installMode, setInstallMode] = React.useState<PromptAssetInstallModeV1 | null>(null);
  const [installModeMenuOpen, setInstallModeMenuOpen] = React.useState(false);
  const [targetInput, setTargetInput] = React.useState('');
  const {
    machineId: selectedMachineId,
    setMachineId,
    workspacePath,
    setWorkspacePath,
  } = useContextBarSelection({
    selectionKey: `promptRegistries.details.install.${props.itemId}`,
    defaultMachineId: props.machineId,
    defaultWorkspacePath: props.workspacePath ?? '',
  });

  const loadItem = React.useCallback(async () => {
    if (!selectedMachineId) return;
    const response = await machinePromptRegistriesFetchItem(selectedMachineId, {
      sourceId: props.sourceId,
      itemId: props.itemId,
      configuredSources: props.configuredSources,
    });
    if (!response.ok) {
      Modal.alert(t('common.error'), response.error);
      return;
    }
    setItem(response.item);
  }, [props.configuredSources, props.itemId, props.sourceId, selectedMachineId]);

  const [loading, runLoad] = useHappyAction(loadItem);

  React.useEffect(() => {
    runLoad();
  }, [runLoad]);

  React.useEffect(() => {
    if (!selectedMachineId) {
      setInstallTypes([]);
      setSelectedInstallTypeId(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const listed = await machinePromptAssetsListTypes(selectedMachineId);
      if (cancelled || !listed.ok) return;
      const nextTypes = listed.types.filter((entry) => entry.libraryKind === 'bundle' && entry.capabilities.supportsCatalogInstall === true);
      setInstallTypes(nextTypes);
    })().catch(() => {
      if (!cancelled) setInstallTypes([]);
    });

    return () => {
      cancelled = true;
    };
  }, [selectedMachineId]);

  const scopeCompatibleInstallTypes = React.useMemo(
    () => listPromptAssetTypesForScope(installTypes, installScope),
    [installScope, installTypes],
  );

  React.useEffect(() => {
    setSelectedInstallTypeId((current) => resolvePromptAssetTypeSelection({
      types: installTypes,
      scope: installScope,
      selectedTypeId: current,
    }));
  }, [installScope, installTypes]);

  React.useEffect(() => {
    if (!item) return;
    setTargetInput((current) => current || defaultPromptAssetTargetInput({
      libraryKind: 'bundle',
      title: item.title,
    }));
  }, [item]);

  const installType = React.useMemo(
    () => scopeCompatibleInstallTypes.find((entry) => entry.id === selectedInstallTypeId) ?? null,
    [scopeCompatibleInstallTypes, selectedInstallTypeId],
  );

  const availableInstallModes = React.useMemo(
    () => listPromptAssetInstallModesForType(installType),
    [installType],
  );

  const installTypeItems = React.useMemo((): DropdownMenuItem[] => {
    return scopeCompatibleInstallTypes
      .map((entry) => ({
        id: entry.id,
        title: entry.title,
        subtitle: entry.description,
        icon: <Ionicons name="layers-outline" size={22} color={theme.colors.textSecondary} />,
      }));
  }, [scopeCompatibleInstallTypes, theme.colors.textSecondary]);

  const installModeItems = React.useMemo((): DropdownMenuItem[] => {
    return availableInstallModes.map((entry) => ({
      id: entry,
      title: entry === 'symlink'
        ? t('promptLibrary.externalAssetsInstallMethodSymlink')
        : t('promptLibrary.externalAssetsInstallMethodCopy'),
      subtitle: entry === 'symlink'
        ? t('promptLibrary.externalAssetsInstallMethodSymlinkSubtitle')
        : t('promptLibrary.externalAssetsInstallMethodCopySubtitle'),
      icon: <Ionicons name={entry === 'symlink' ? 'git-branch-outline' : 'copy-outline'} size={22} color={theme.colors.textSecondary} />,
    }));
  }, [availableInstallModes, theme.colors.textSecondary]);

  const selectedInstallMode = React.useMemo(
    () => resolvePromptAssetInstallModeSelection({
      assetType: installType,
      selectedInstallMode: installMode,
    }),
    [installMode, installType],
  );

  const importItem = React.useCallback(async () => {
    if (!item) return;
    const imported = await createPromptRegistrySkillArtifactFromFetchedItem(item);
    if (!imported.ok) {
      Modal.alert(t('common.error'), translatePromptLibraryMessage(imported.error));
      return;
    }
    router.push(`/(app)/settings/prompts/skills/${imported.artifactId}`);
  }, [item, router]);

  const [importing, runImport] = useHappyAction(importItem);

  const installItem = React.useCallback(async () => {
    if (!installType || !selectedMachineId) return;
    const resolvedInstallMode = selectedInstallMode;
    const preview = await installPromptRegistryItem({
      machineId: selectedMachineId,
      configuredSources: props.configuredSources,
      sourceId: props.sourceId,
      itemId: props.itemId,
      installTarget: {
        assetTypeId: installType.id,
        scope: installScope,
        ...(installScope === 'project' && workspacePath.trim().length > 0 ? { directory: workspacePath.trim() } : {}),
        targetName: targetInput.trim(),
        installMode: resolvedInstallMode,
      },
      promptExternalLinks: promptExternalLinksV1,
      previewOnly: true,
    });
    if (!preview.ok) {
      Modal.alert(t('common.error'), translatePromptLibraryMessage(preview.error));
      if (preview.artifactId) {
        router.push(`/(app)/settings/prompts/skills/${preview.artifactId}`);
      }
      return;
    }

    const confirmed = await Modal.confirm(
      t('promptLibrary.registriesItemInstallConfirmTitle'),
      preview.response?.preview?.targetPath ?? t('promptLibrary.registriesItemInstallConfirmBody'),
      { confirmText: t('promptLibrary.registriesItemInstallAction') },
    );
    if (!confirmed) return;

    const installed = await installPromptRegistryItem({
      machineId: selectedMachineId,
      configuredSources: props.configuredSources,
      sourceId: props.sourceId,
      itemId: props.itemId,
      installTarget: {
        assetTypeId: installType.id,
        scope: installScope,
        ...(installScope === 'project' && workspacePath.trim().length > 0 ? { directory: workspacePath.trim() } : {}),
        targetName: targetInput.trim(),
        installMode: resolvedInstallMode,
      },
      promptExternalLinks: promptExternalLinksV1,
      previewOnly: false,
    });
    if (!installed.ok) {
      Modal.alert(t('common.error'), translatePromptLibraryMessage(installed.error));
      if (installed.artifactId) {
        router.push(`/(app)/settings/prompts/skills/${installed.artifactId}`);
      }
      return;
    }
    setPromptExternalLinksV1(installed.nextPromptExternalLinks ?? { v: 1, links: [] });
    router.push(`/(app)/settings/prompts/skills/${installed.artifactId}`);
  }, [installScope, installType, promptExternalLinksV1, props.configuredSources, props.itemId, props.sourceId, router, selectedInstallMode, selectedMachineId, setPromptExternalLinksV1, targetInput, workspacePath]);

  const [installing, runInstall] = useHappyAction(installItem);

  const skillMarkdown = React.useMemo(() => decodeUtf8BundleEntry(item, 'SKILL.md'), [item]);
  const additionalFilesCount = Math.max(0, (item?.bundleBody.entries.length ?? 0) - (skillMarkdown ? 1 : 0));
  const screenTitle = item?.title ?? props.title ?? t('common.details');
  const sourceLabel = props.displayPath?.split('/').slice(0, -1).join('/') || item?.description || props.sourceId;
  const machineLabel = React.useMemo(() => {
    const machine = machines.find((entry) => entry.id === selectedMachineId) ?? null;
    return machine?.metadata?.displayName || machine?.metadata?.host || selectedMachineId || t('promptLibrary.registriesNoMachine');
  }, [machines, selectedMachineId]);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: screenTitle }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <ItemList>
          <ItemGroup title={t('common.details')}>
            <ContextBar
              mode={installScope === 'project' ? 'machine_and_workspace' : 'machine_only'}
              machine={{
                selectedId: selectedMachineId,
                subtitle: machineLabel,
                items: machines.map((machine) => ({
                  id: machine.id,
                  title: machine.metadata?.displayName || machine.metadata?.host || machine.id,
                  subtitle: machine.id,
                  icon: <Ionicons name="laptop-outline" size={22} color={theme.colors.textSecondary} />,
                })),
                onSelect: setMachineId,
              }}
              workspace={installScope === 'project' ? {
                value: workspacePath,
                onChange: setWorkspacePath,
                placeholder: t('promptLibrary.externalAssetsProjectDirectoryPlaceholder' as TranslationKey),
                testID: 'promptRegistries.details.directoryInput',
                browse: {
                  machineId: selectedMachineId,
                  enabled: true,
                },
              } : undefined}
            />
            <Item
              testID="promptRegistries.details.source"
              title={t('promptLibrary.registriesItemSource')}
              subtitle={sourceLabel}
              icon={<Ionicons name="git-branch-outline" size={29} color={theme.colors.textSecondary} />}
              showChevron={false}
            />
            <Item
              testID="promptRegistries.details.path"
              title={t('promptLibrary.registriesItemPath')}
              subtitle={props.displayPath ?? item?.description ?? props.itemId}
              icon={<Ionicons name="sparkles-outline" size={29} color={theme.colors.accent.indigo} />}
              showChevron={false}
            />
            <Item
              testID="promptRegistries.details.files"
              title={t('promptLibrary.registriesItemFiles')}
              subtitle={String(additionalFilesCount)}
              icon={<Ionicons name="document-text-outline" size={29} color={theme.colors.textSecondary} />}
              showChevron={false}
            />
            <Item
              testID="promptRegistries.details.import"
              title={t('promptLibrary.externalAssetsImportAction')}
              subtitle={importing ? t('common.loading') : t('promptLibrary.registriesItemImportSubtitle')}
              icon={<Ionicons name="download-outline" size={29} color={theme.colors.accent.purple} />}
              disabled={!item || importing}
              onPress={runImport}
            />
            <DropdownMenu
              open={scopeMenuOpen}
              onOpenChange={setScopeMenuOpen}
              items={[
                {
                  id: 'project',
                  title: t('promptLibrary.externalAssetsProjectScope'),
                  subtitle: t('promptLibrary.externalAssetsProjectScopeSubtitle'),
                  icon: <Ionicons name="folder-outline" size={22} color={theme.colors.accent.indigo} />,
                },
                {
                  id: 'user',
                  title: t('promptLibrary.externalAssetsUserScope'),
                  subtitle: t('promptLibrary.externalAssetsUserScopeSubtitle'),
                  icon: <Ionicons name="person-outline" size={22} color={theme.colors.accent.blue} />,
                },
              ]}
              selectedId={installScope}
              onSelect={(nextScope) => setInstallScope(nextScope as PromptAssetScopeV1)}
              itemTrigger={{
                title: t('promptLibrary.externalAssetsScope'),
                subtitle: installScope === 'project' ? t('promptLibrary.externalAssetsProjectScope') : t('promptLibrary.externalAssetsUserScope'),
                icon: <Ionicons name="albums-outline" size={29} color={theme.colors.accent.indigo} />,
              }}
              rowKind="item"
              connectToTrigger
              variant="default"
            />
            <DropdownMenu
              open={typeMenuOpen}
              onOpenChange={setTypeMenuOpen}
              items={installTypeItems}
              selectedId={selectedInstallTypeId}
              onSelect={(nextTypeId) => setSelectedInstallTypeId(nextTypeId)}
              itemTrigger={{
                title: t('promptLibrary.externalAssetsExportType'),
                subtitle: installType?.title ?? t('promptLibrary.externalAssetsNoTypes'),
                icon: <Ionicons name="layers-outline" size={29} color={theme.colors.textSecondary} />,
              }}
              rowKind="item"
              connectToTrigger
              variant="default"
            />
            <DropdownMenu
              open={installModeMenuOpen}
              onOpenChange={setInstallModeMenuOpen}
              items={installModeItems}
              selectedId={selectedInstallMode}
              onSelect={(nextInstallMode) => setInstallMode(nextInstallMode as PromptAssetInstallModeV1)}
              itemTrigger={{
                title: t('promptLibrary.externalAssetsInstallMethod'),
                subtitle: selectedInstallMode === 'symlink'
                  ? t('promptLibrary.externalAssetsInstallMethodSymlink')
                  : t('promptLibrary.externalAssetsInstallMethodCopy'),
                icon: <Ionicons name={selectedInstallMode === 'symlink' ? 'git-branch-outline' : 'copy-outline'} size={29} color={theme.colors.textSecondary} />,
              }}
              rowKind="item"
              connectToTrigger
              variant="default"
            />
            <Item
              title={t('promptLibrary.externalAssetsExportTarget')}
              subtitle={(
                <TextInput
                  testID="promptRegistries.details.targetInput"
                  placeholder={t('promptLibrary.externalAssetsExportTargetNamePlaceholder')}
                  placeholderTextColor={theme.colors.input.placeholder}
                  value={targetInput}
                  onChangeText={setTargetInput}
                  style={styles.input}
                />
              )}
              subtitleLines={0}
              icon={<Ionicons name="sparkles-outline" size={29} color={theme.colors.textSecondary} />}
              mode="info"
              showChevron={false}
            />
          </ItemGroup>

          <ItemGroup title={t('promptLibrary.registriesItemPreview')}>
            <View style={styles.previewGroup}>
              {loading && !item ? (
                <Text style={styles.previewEmpty}>{t('common.loading')}</Text>
              ) : skillMarkdown ? (
                <Text style={styles.previewText}>{skillMarkdown}</Text>
              ) : (
                <Text style={styles.previewEmpty}>{t('promptLibrary.registriesItemPreviewUnavailable')}</Text>
              )}
            </View>
          </ItemGroup>
        </ItemList>
        {installType ? (
          <SettingsActionFooter
            primaryLabel={t('common.install' as TranslationKey)}
            onPrimaryPress={runInstall}
            primaryDisabled={installing || targetInput.trim().length === 0 || (installScope === 'project' && workspacePath.trim().length === 0)}
            primaryTestID="promptRegistries.details.install"
          />
        ) : null}
      </ScrollView>
    </View>
  );
});
