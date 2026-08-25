import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type {
  MachineAdministrationTargetV1,
  PromptAssetInstallModeV1,
  PromptAssetScopeV1,
  PromptAssetTypeDescriptorV1,
  PromptRegistryConfiguredSourceV1,
  PromptRegistryFetchedItemV1,
} from '@happier-dev/protocol';

import { decodeBase64 } from '@/encryption/base64';
import { defaultPromptAssetTargetInput } from '@/components/settings/prompts/assets/promptAssetExportDefaults';
import { ContextBar } from '@/components/settings/contextBar/ContextBar';
import { useContextBarSelection } from '@/components/settings/contextBar/useContextBarSelection';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { SettingsActionFooter } from '@/components/ui/settingsSurface/SettingsActionFooter';
import { Text, TextInput } from '@/components/ui/text/Text';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { Modal } from '@/modal';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { machinePromptAssetsListTypes } from '@/sync/ops/machinePromptAssets';
import { machinePromptRegistriesDownloadItem } from '@/sync/ops/machinePromptRegistries';
import { installPromptRegistryItem } from '@/sync/ops/promptLibrary/installPromptRegistryItem';
import { createPromptRegistrySkillArtifactFromFetchedItem } from '@/sync/ops/promptLibrary/promptRegistrySkillImports';
import { translatePromptLibraryMessage } from '@/sync/ops/promptLibrary/translatePromptLibraryMessage';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { machineAdministrationTargetsEqual } from '@/sync/domains/machines/administration/targetSelection';
import {
  useMachineAdministrationTargetSelection,
  type FreshMachineAdministrationExecutionTargetV1,
} from '@/sync/domains/machines/administration/useTargetSelection';
import { isMachineAdministrationExecutionTargetCurrent } from '@/sync/domains/machines/administration/operationCurrentness';
import { t, type TranslationKey } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
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
    backgroundColor: theme.colors.background.canvas,
  },
  content: {
    paddingVertical: 12,
    width: '100%',
    alignSelf: 'center',
  },
  previewGroup: {
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  previewText: {
    color: theme.colors.text.primary,
    fontFamily: 'monospace',
    fontSize: 13,
    lineHeight: 20,
  },
  previewEmpty: {
    color: theme.colors.text.secondary,
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
    const bytes = decodeBase64(entry.contentBase64, 'base64');
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

export const PromptRegistryItemDetailsScreen = React.memo(function PromptRegistryItemDetailsScreen(props: Readonly<{
  sourceId: string;
  itemId: string;
  configuredSources: PromptRegistryConfiguredSourceV1[];
  title?: string | null;
  displayPath?: string | null;
  workspacePath?: string | null;
}>) {
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
    workspacePath,
    setWorkspacePath,
  } = useContextBarSelection({
    selectionKey: `promptRegistries.details.install.${props.itemId}`,
    // This compatibility entry stores only workspace text. Administration owns
    // the exact machine/server target for every registry operation below.
    defaultMachineId: null,
    defaultWorkspacePath: props.workspacePath ?? '',
  });
  const previousSelectionKeyRef = React.useRef(selectionKey);

  React.useLayoutEffect(() => {
    const previousSelectionKey = previousSelectionKeyRef.current;
    previousSelectionKeyRef.current = selectionKey;
    if (!previousSelectionKey || previousSelectionKey === selectionKey) return;
    setWorkspacePath('');
  }, [selectionKey, setWorkspacePath]);

  React.useEffect(() => {
    setItem(null);
    setInstallTypes([]);
    setSelectedInstallTypeId(null);
  }, [selectionKey]);

  const loadItem = React.useCallback(async () => {
    const requestedSelection = selectionKey;
    const executionTarget = resolveExactExecutionTarget(selectedTarget);
    if (!executionTarget) return;
    const response = await machinePromptRegistriesDownloadItem(executionTarget.machine.id, {
      sourceId: props.sourceId,
      itemId: props.itemId,
      configuredSources: props.configuredSources,
    }, { serverId: executionTarget.serverId });
    if (!isExecutionTargetCurrent(requestedSelection, executionTarget)) return;
    if (!response.ok) {
      Modal.alert(t('common.error'), response.error);
      return;
    }
    setItem(response.item);
  }, [isExecutionTargetCurrent, props.configuredSources, props.itemId, props.sourceId, resolveExactExecutionTarget, selectedTarget, selectionKey]);

  const [loading, runLoad] = useHappyAction(loadItem);

  React.useEffect(() => {
    runLoad();
  }, [runLoad]);

  React.useEffect(() => {
    const requestedSelection = selectionKey;
    const executionTarget = resolveExactExecutionTarget(selectedTarget);
    if (!executionTarget) {
      setInstallTypes([]);
      setSelectedInstallTypeId(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const listed = await machinePromptAssetsListTypes(executionTarget.machine.id, {
        serverId: executionTarget.serverId,
      });
      if (cancelled || !isExecutionTargetCurrent(requestedSelection, executionTarget) || !listed.ok) return;
      const nextTypes = listed.types.filter((entry) => entry.libraryKind === 'bundle' && entry.capabilities.supportsCatalogInstall === true);
      setInstallTypes(nextTypes);
    })().catch(() => {
      if (!cancelled) setInstallTypes([]);
    });

    return () => {
      cancelled = true;
    };
  }, [isExecutionTargetCurrent, resolveExactExecutionTarget, selectedTarget, selectionKey]);

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
        icon: <Icon name="stack-simple" size={20} color={theme.colors.text.secondary} />,
      }));
  }, [scopeCompatibleInstallTypes, theme.colors.text.secondary]);

  const installModeItems = React.useMemo((): DropdownMenuItem[] => {
    return availableInstallModes.map((entry) => ({
      id: entry,
      title: entry === 'symlink'
        ? t('promptLibrary.externalAssetsInstallMethodSymlink')
        : t('promptLibrary.externalAssetsInstallMethodCopy'),
      subtitle: entry === 'symlink'
        ? t('promptLibrary.externalAssetsInstallMethodSymlinkSubtitle')
        : t('promptLibrary.externalAssetsInstallMethodCopySubtitle'),
      icon: <Icon name={entry === 'symlink' ? 'git-branch' : 'copy'} size={20} color={theme.colors.text.secondary} />,
    }));
  }, [availableInstallModes, theme.colors.text.secondary]);

  const selectedInstallMode = React.useMemo(
    () => resolvePromptAssetInstallModeSelection({
      assetType: installType,
      selectedInstallMode: installMode,
    }),
    [installMode, installType],
  );

  const importItem = React.useCallback(async () => {
    if (!item || !resolveExactExecutionTarget(selectedTarget)) return;
    const imported = await createPromptRegistrySkillArtifactFromFetchedItem(item);
    if (!imported.ok) {
      Modal.alert(t('common.error'), translatePromptLibraryMessage(imported.error));
      return;
    }
    router.push(`/settings/prompts/skills/${imported.artifactId}`);
  }, [item, resolveExactExecutionTarget, router, selectedTarget]);

  const [importing, runImport] = useHappyAction(importItem);

  const installItem = React.useCallback(async () => {
    const requestedSelection = selectionKey;
    const executionTarget = resolveExactExecutionTarget(selectedTarget);
    if (!installType || !executionTarget) return;
    const resolvedInstallMode = selectedInstallMode;
    const preview = await installPromptRegistryItem({
      machineId: executionTarget.machine.id,
      serverId: executionTarget.serverId,
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
    if (!isExecutionTargetCurrent(requestedSelection, executionTarget)) return;
    if (!preview.ok) {
      Modal.alert(t('common.error'), translatePromptLibraryMessage(preview.error));
      if (preview.artifactId) {
        router.push(`/settings/prompts/skills/${preview.artifactId}`);
      }
      return;
    }

    const confirmed = await Modal.confirm(
      t('promptLibrary.registriesItemInstallConfirmTitle'),
      preview.response?.preview?.targetPath ?? t('promptLibrary.registriesItemInstallConfirmBody'),
      { confirmText: t('promptLibrary.registriesItemInstallAction') },
    );
    if (!confirmed) return;

    const committedExecutionTarget = resolveExactExecutionTarget(executionTarget.target);
    if (
      !committedExecutionTarget
      || !isExecutionTargetCurrent(requestedSelection, committedExecutionTarget)
    ) {
      return;
    }

    const installed = await installPromptRegistryItem({
      machineId: committedExecutionTarget.machine.id,
      serverId: committedExecutionTarget.serverId,
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
    if (!isExecutionTargetCurrent(requestedSelection, committedExecutionTarget)) return;
    if (!installed.ok) {
      Modal.alert(t('common.error'), translatePromptLibraryMessage(installed.error));
      if (installed.artifactId) {
        router.push(`/settings/prompts/skills/${installed.artifactId}`);
      }
      return;
    }
    setPromptExternalLinksV1(installed.nextPromptExternalLinks ?? { v: 1, links: [] });
    router.push(`/settings/prompts/skills/${installed.artifactId}`);
  }, [installScope, installType, isExecutionTargetCurrent, promptExternalLinksV1, props.configuredSources, props.itemId, props.sourceId, resolveExactExecutionTarget, router, selectedInstallMode, selectedTarget, selectionKey, setPromptExternalLinksV1, targetInput, workspacePath]);

  const [installing, runInstall] = useHappyAction(installItem);

  const skillMarkdown = React.useMemo(() => decodeUtf8BundleEntry(item, 'SKILL.md'), [item]);
  const additionalFilesCount = Math.max(0, (item?.bundleBody.entries.length ?? 0) - (skillMarkdown ? 1 : 0));
  const screenTitle = item?.title ?? props.title ?? t('common.details');
  const sourceLabel = props.displayPath?.split('/').slice(0, -1).join('/') || item?.description || props.sourceId;
  const executionTarget = resolveExactExecutionTarget(selectedTarget);

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={contentStyle} keyboardShouldPersistTaps="handled">
        <ItemList>
          <MachineAdministrationTargetSelector
            selection={administrationTargetSelection}
            testIDPrefix="settings.promptRegistries.administration.target"
          />
          <ItemGroup title={t('common.details')}>
            <ContextBar
              mode="workspace_only"
              workspace={installScope === 'project' ? {
                value: workspacePath,
                onChange: setWorkspacePath,
                placeholder: t('promptLibrary.externalAssetsProjectDirectoryPlaceholder' as TranslationKey),
                testID: 'promptRegistries.details.directoryInput',
                browse: {
                  machineId: executionTarget?.machine.id ?? null,
                  serverId: executionTarget?.serverId ?? null,
                  enabled: executionTarget !== null,
                },
              } : undefined}
            />
            <Item
              testID="promptRegistries.details.source"
              title={t('promptLibrary.registriesItemSource')}
              subtitle={sourceLabel}
              icon={<Icon name="git-branch" size={29} color={theme.colors.text.secondary} />}
              showChevron={false}
            />
            <Item
              testID="promptRegistries.details.path"
              title={t('promptLibrary.registriesItemPath')}
              subtitle={props.displayPath ?? item?.description ?? props.itemId}
              icon={<Icon name="sparkle" size={29} color={theme.colors.accent.indigo} />}
              showChevron={false}
            />
            <Item
              testID="promptRegistries.details.files"
              title={t('promptLibrary.registriesItemFiles')}
              subtitle={String(additionalFilesCount)}
              icon={<Icon name="file-text" size={29} color={theme.colors.text.secondary} />}
              showChevron={false}
            />
            <Item
              testID="promptRegistries.details.import"
              title={t('promptLibrary.externalAssetsImportAction')}
              subtitle={importing ? t('common.loading') : t('promptLibrary.registriesItemImportSubtitle')}
              icon={<Icon name="download" size={29} color={theme.colors.accent.purple} />}
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
                  icon: <Icon name="folder" size={20} color={theme.colors.accent.indigo} />,
                },
                {
                  id: 'user',
                  title: t('promptLibrary.externalAssetsUserScope'),
                  subtitle: t('promptLibrary.externalAssetsUserScopeSubtitle'),
                  icon: <Icon name="person" size={20} color={theme.colors.accent.blue} />,
                },
              ]}
              selectedId={installScope}
              onSelect={(nextScope) => setInstallScope(nextScope as PromptAssetScopeV1)}
              itemTrigger={{
                title: t('promptLibrary.externalAssetsScope'),
                subtitle: installScope === 'project' ? t('promptLibrary.externalAssetsProjectScope') : t('promptLibrary.externalAssetsUserScope'),
                icon: <Icon name="stack" size={29} color={theme.colors.accent.indigo} />,
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
                icon: <Icon name="stack-simple" size={29} color={theme.colors.text.secondary} />,
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
                icon: <Icon name={selectedInstallMode === 'symlink' ? 'git-branch' : 'copy'} size={29} color={theme.colors.text.secondary} />,
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
              icon={<Icon name="sparkle" size={29} color={theme.colors.text.secondary} />}
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
            primaryDisabled={executionTarget === null || installing || targetInput.trim().length === 0 || (installScope === 'project' && workspacePath.trim().length === 0)}
            primaryTestID="promptRegistries.details.install"
          />
        ) : null}
      </ScrollView>
    </View>
  );
});
