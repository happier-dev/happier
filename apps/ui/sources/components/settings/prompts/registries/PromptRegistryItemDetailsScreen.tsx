import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type {
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
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { Text } from '@/components/ui/text/Text';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { Modal } from '@/modal';
import { usePromptLibraryCatalogValue } from '@/sync/store/usePromptLibraryCatalog';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createUiPromptLibraryArtifactStore } from '@/sync/ops/promptLibrary/promptLibraryArtifactStore';
import { promptCollectionItemHref } from '@/components/settings/prompts/collection/promptCollectionRoutes';
import { requireUpdatedPromptLibraryMutation, writePromptLibraryRecordAndPublishInContext } from '@/sync/api/account/apiPromptLibraryCatalog';
import { machinePromptAssetsListTypes } from '@/sync/ops/machinePromptAssets';
import { machinePromptRegistriesDownloadItem } from '@/sync/ops/machinePromptRegistries';
import { installPromptRegistryItem, type PromptRegistryInstallResult } from '@/sync/ops/promptLibrary/installPromptRegistryItem';
import { createPromptRegistrySkillArtifactFromFetchedItem } from '@/sync/ops/promptLibrary/promptRegistrySkillImports';
import { translatePromptLibraryMessage } from '@/sync/ops/promptLibrary/translatePromptLibraryMessage';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { useMachineAdministrationTargetSelection } from '@/sync/domains/machines/administration/useTargetSelection';
import { useMachineAdministrationExecutionTargetBinding } from '@/sync/domains/machines/administration/useExecutionTargetBinding';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import {
  listPromptAssetTypesForScope,
  resolvePromptAssetTypeSelection,
} from '@/components/settings/prompts/shared/promptAssetTypeSelection';
import {
  listPromptAssetInstallModesForType,
  resolvePromptAssetInstallModeSelection,
} from '@/components/settings/prompts/shared/promptAssetInstallModeSelection';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';

const styles = StyleSheet.create((theme) => ({
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
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
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

function installFailureMessage(error: string, result: PromptRegistryInstallResult): string {
  const message = translatePromptLibraryMessage(error);
  const targetPath = result.exported === true ? result.response?.preview?.targetPath : undefined;
  return targetPath ? `${message}\n${targetPath}` : message;
}

export const PromptRegistryItemDetailsScreen = React.memo(function PromptRegistryItemDetailsScreen(props: Readonly<{
  sourceId: string;
  itemId: string;
  configuredSources: PromptRegistryConfiguredSourceV1[] | null;
  title?: string | null;
  displayPath?: string | null;
  workspacePath?: string | null;
}>) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const libraryScope = useAccountSettingsScope();
  const administrationTargetSelection = useMachineAdministrationTargetSelection(
    MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.promptRegistries,
  );
  const selectedTarget = administrationTargetSelection.selectedTarget;
  const {
    selectionKey,
    resolveExactExecutionTarget,
    isExecutionTargetCurrent,
  } = useMachineAdministrationExecutionTargetBinding(administrationTargetSelection);
  const { value: promptExternalLinksV1, revision: linksRevision, sourceSettingsVersion: linksSourceSettingsVersion,
    status: linksStatus, stale: linksStale } = usePromptLibraryCatalogValue('external-links');
  const [item, setItem] = React.useState<PromptRegistryFetchedItemV1 | null>(null);
  const [installTypes, setInstallTypes] = React.useState<PromptAssetTypeDescriptorV1[]>([]);
  const [installScope, setInstallScope] = React.useState<PromptAssetScopeV1>('project');
  const [typeMenuOpen, setTypeMenuOpen] = React.useState(false);
  const [selectedInstallTypeId, setSelectedInstallTypeId] = React.useState<string | null>(null);
  const [installMode, setInstallMode] = React.useState<PromptAssetInstallModeV1 | null>(null);
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
    workspaceBindingKey: selectionKey,
  });

  React.useEffect(() => {
    setItem(null);
    setInstallTypes([]);
    setSelectedInstallTypeId(null);
  }, [selectionKey]);

  const loadItem = React.useCallback(async () => {
    if (!props.configuredSources) return;
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

  const installModeOptions = React.useMemo(() => availableInstallModes.map((entry) => ({
    id: entry,
    label: entry === 'symlink' ? t('promptLibrary.surface.installMethodLink') : t('promptLibrary.surface.installMethodCopy'),
    description: entry === 'symlink'
      ? t('promptLibrary.surface.installMethodLinkDescription')
      : t('promptLibrary.externalAssetsInstallMethodCopySubtitle'),
  })), [availableInstallModes]);

  const selectedInstallMode = React.useMemo(
    () => resolvePromptAssetInstallModeSelection({
      assetType: installType,
      selectedInstallMode: installMode,
    }),
    [installMode, installType],
  );

  const importItem = React.useCallback(async () => {
    if (!libraryScope || !props.configuredSources || !item || !resolveExactExecutionTarget(selectedTarget)) return;
    const libraryAccount = await captureLazyActionAccountContext(libraryScope.serverId);
    try {
      if (libraryAccount.accountId !== libraryScope.accountId) throw new Error('action_account_scope_changed');
      libraryAccount.assertCurrent();
      const imported = await createPromptRegistrySkillArtifactFromFetchedItem(item,
        createUiPromptLibraryArtifactStore(libraryAccount.workflowArtifacts, libraryAccount));
      libraryAccount.assertCurrent();
      if (!imported.ok) {
        Modal.alert(t('common.error'), translatePromptLibraryMessage(imported.error));
        return;
      }
      router.push(promptCollectionItemHref('bundle', imported.artifactId, { serverId: libraryAccount.serverId }));
    } finally {
      libraryAccount.dispose();
    }
  }, [item, libraryScope, props.configuredSources, resolveExactExecutionTarget, router, selectedTarget]);

  const [importing, runImport] = useHappyAction(importItem);

  const installItem = React.useCallback(async () => {
    if (!libraryScope || !props.configuredSources) return;
    if (!promptExternalLinksV1 || linksStatus !== 'ready' || linksStale) return;
    const requestedSelection = selectionKey;
    const executionTarget = resolveExactExecutionTarget(selectedTarget);
    if (!installType || !executionTarget) return;
    const resolvedInstallMode = selectedInstallMode;
    const libraryAccount = await captureLazyActionAccountContext(libraryScope.serverId);
    const controller = new AbortController();
    const retirement = libraryAccount.accountLifetime.onRetire(() => controller.abort());
    let installed: PromptRegistryInstallResult | undefined;
    try {
      if (libraryAccount.accountId !== libraryScope.accountId) throw new Error('action_account_scope_changed');
      libraryAccount.assertCurrent();
      if (!libraryAccount.serverIdentityId) throw new Error('content_unavailable');
      const store = createUiPromptLibraryArtifactStore(libraryAccount.workflowArtifacts, libraryAccount);
      const preview = await installPromptRegistryItem({
        machineId: executionTarget.machine.id,
        machineTarget: executionTarget.target,
        libraryServerIdentityId: libraryAccount.serverIdentityId,
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
        signal: controller.signal,
      }, store);
      libraryAccount.assertCurrent();
      if (!isExecutionTargetCurrent(requestedSelection, executionTarget)) return;
      if (!preview.ok) {
        Modal.alert(t('common.error'), translatePromptLibraryMessage(preview.error));
        if (preview.artifactId) {
          router.push(promptCollectionItemHref('bundle', preview.artifactId, { serverId: libraryAccount.serverId }));
        }
        return;
      }

      const confirmed = await Modal.confirm(
        t('promptLibrary.registriesItemInstallConfirmTitle'),
        preview.response?.preview?.targetPath ?? t('promptLibrary.registriesItemInstallConfirmBody'),
        { confirmText: t('promptLibrary.registriesItemInstallAction') },
      );
      libraryAccount.assertCurrent();
      if (!confirmed) return;

      const committedExecutionTarget = resolveExactExecutionTarget(executionTarget.target);
      if (
        !committedExecutionTarget
        || !isExecutionTargetCurrent(requestedSelection, committedExecutionTarget)
      ) {
        return;
      }

      installed = await installPromptRegistryItem({
        machineId: committedExecutionTarget.machine.id,
        machineTarget: committedExecutionTarget.target,
        libraryServerIdentityId: libraryAccount.serverIdentityId,
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
        signal: controller.signal,
      }, store);
      if (!installed.ok) {
        Modal.alert(t('common.error'), installFailureMessage(installed.error, installed));
        if (installed.artifactId && libraryAccount.accountLifetime.isCurrent()
          && isExecutionTargetCurrent(requestedSelection, committedExecutionTarget)) {
          router.push(promptCollectionItemHref('bundle', installed.artifactId, { serverId: libraryAccount.serverId }));
        }
        return;
      }
      libraryAccount.assertCurrent();
      if (!isExecutionTargetCurrent(requestedSelection, committedExecutionTarget)) return;
      if (!installed.nextPromptExternalLinks) throw new Error('Prompt external links were not acknowledged');
      requireUpdatedPromptLibraryMutation(await writePromptLibraryRecordAndPublishInContext(libraryAccount, {
        record: { key: 'external-links', value: installed.nextPromptExternalLinks },
        expectedRevision: linksRevision,
        ...(linksRevision === 'absent' && linksSourceSettingsVersion !== null ? { sourceSettingsVersion: linksSourceSettingsVersion } : {}),
      }, controller.signal));
      libraryAccount.assertCurrent();
      if (!installed.artifactId) throw new Error('Prompt library Artifact was not acknowledged');
      router.push(promptCollectionItemHref('bundle', installed.artifactId, { serverId: libraryAccount.serverId }));
    } catch (error) {
      if (installed?.exported !== true) throw error;
      Modal.alert(t('common.error'), installFailureMessage('promptLibrary.saveError', installed));
    } finally {
      retirement.dispose();
      libraryAccount.dispose();
    }
  }, [installScope, installType, isExecutionTargetCurrent, libraryScope, linksRevision, linksSourceSettingsVersion, linksStatus, linksStale, promptExternalLinksV1, props.configuredSources, props.itemId, props.sourceId, resolveExactExecutionTarget, router, selectedInstallMode, selectedTarget, selectionKey, targetInput, workspacePath]);

  const [installing, runInstall] = useHappyAction(installItem);

  const skillMarkdown = React.useMemo(() => decodeUtf8BundleEntry(item, 'SKILL.md'), [item]);
  const additionalFilesCount = Math.max(0, (item?.bundleBody.entries.length ?? 0) - (skillMarkdown ? 1 : 0));
  const screenTitle = item?.title ?? props.title ?? t('common.details');
  const sourceLabel = props.displayPath?.split('/').slice(0, -1).join('/') || item?.description || props.sourceId;
  const executionTarget = resolveExactExecutionTarget(selectedTarget);

  const installDisabled = executionTarget === null || installing || !installType || targetInput.trim().length === 0 || (installScope === 'project' && workspacePath.trim().length === 0);

  return (
    <ItemList keyboardShouldPersistTaps="handled">
      <PageHeader
        testID="promptRegistries.details.header"
        alwaysShowTitle
        title={screenTitle}
        description={t('promptLibrary.surface.registryItemDescription')}
        actions={(
          <View style={styles.headerActions}>
            <MachineAdministrationTargetSelector
              selection={administrationTargetSelection}
              presentation="chip"
              testIDPrefix="settings.promptRegistries.administration.target"
            />
            {installType ? (
              <RoundButton
                testID="promptRegistries.details.install"
                size="small"
                title={t('promptLibrary.surface.installAction')}
                disabled={installDisabled}
                loading={installing}
                onPress={runInstall}
              />
            ) : null}
          </View>
        )}
      />

      <ItemGroup title={t('promptLibrary.surface.registryItemSection')}>
        <Item
          testID="promptRegistries.details.source"
          title={t('promptLibrary.registriesItemSource')}
          subtitle={sourceLabel}
          mode="info"
          showChevron={false}
        />
        <Item
          testID="promptRegistries.details.path"
          title={t('promptLibrary.registriesItemPath')}
          subtitle={props.displayPath ?? item?.description ?? props.itemId}
          mode="info"
          showChevron={false}
        />
        <Item
          testID="promptRegistries.details.files"
          title={t('promptLibrary.registriesItemFiles')}
          detail={String(additionalFilesCount)}
          mode="info"
          showChevron={false}
        />
        <Item
          testID="promptRegistries.details.import"
          title={t('promptLibrary.surface.importToLibrary')}
          subtitle={importing ? t('common.loading') : t('promptLibrary.registriesItemImportSubtitle')}
          disabled={!item || importing}
          onPress={runImport}
        />
      </ItemGroup>

      <ItemGroup title={t('promptLibrary.registriesItemInstallAction')} description={t('promptLibrary.surface.registryInstallDescription')}>
        <SegmentedChoiceItem
          title={t('promptLibrary.externalAssetsScope')}
          options={[
            { id: 'project', label: t('promptLibrary.externalAssetsProjectScope'), description: t('promptLibrary.surface.installProjectScopeDescription') },
            { id: 'user', label: t('promptLibrary.externalAssetsUserScope'), description: t('promptLibrary.surface.installUserScopeDescription') },
          ]}
          value={installScope}
          onChange={(nextScope) => setInstallScope(nextScope as PromptAssetScopeV1)}
        />
        {installScope === 'project' ? (
          <ContextBar
            mode="workspace_only"
            workspace={{
              value: workspacePath,
              onChange: setWorkspacePath,
              placeholder: t('promptLibrary.surface.projectDirectoryPlaceholder'),
              testID: 'promptRegistries.details.directoryInput',
              browse: {
                machineId: executionTarget?.machine.id ?? null,
                serverId: executionTarget?.serverId ?? null,
                enabled: executionTarget !== null,
              },
            }}
          />
        ) : null}
        <DropdownMenu
          open={typeMenuOpen}
          onOpenChange={setTypeMenuOpen}
          items={installTypeItems}
          selectedId={selectedInstallTypeId}
          onSelect={(nextTypeId) => setSelectedInstallTypeId(nextTypeId)}
          itemTrigger={{
            title: t('promptLibrary.externalAssetsExportType'),
            subtitle: installType?.title ?? t('promptLibrary.externalAssetsNoTypes'),
          }}
          rowKind="item"
          connectToTrigger
          variant="default"
        />
        {installModeOptions.length > 0 && selectedInstallMode ? (
          <SegmentedChoiceItem<PromptAssetInstallModeV1>
            title={t('promptLibrary.externalAssetsInstallMethod')}
            options={installModeOptions}
            value={selectedInstallMode}
            onChange={setInstallMode}
            testIDPrefix="promptRegistries.details.installMode"
          />
        ) : null}
        <Item
          title={t('promptLibrary.externalAssetsExportTarget')}
          subtitle={t('promptLibrary.surface.installTargetDescription')}
          accessoryLayout="adaptive"
          showChevron={false}
          rightElement={(
            <FieldTextInput
              testID="promptRegistries.details.targetInput"
              accessibilityLabel={t('promptLibrary.externalAssetsExportTarget')}
              placeholder={t('promptLibrary.externalAssetsExportTargetNamePlaceholder')}
              value={targetInput}
              onChangeText={setTargetInput}
              autoCapitalize="none"
              monospace
            />
          )}
        />
      </ItemGroup>

      <ItemGroup title={t('promptLibrary.registriesItemPreview')}>
        <SectionContentRow>
          {loading && !item ? (
            <Text style={styles.previewEmpty}>{t('common.loading')}</Text>
          ) : skillMarkdown ? (
            <Text style={styles.previewText}>{skillMarkdown}</Text>
          ) : (
            <Text style={styles.previewEmpty}>{t('promptLibrary.registriesItemPreviewUnavailable')}</Text>
          )}
        </SectionContentRow>
      </ItemGroup>
    </ItemList>
  );
});
