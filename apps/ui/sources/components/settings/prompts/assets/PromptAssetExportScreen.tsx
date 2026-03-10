import * as React from 'react';
import { TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
  type PromptAssetInstallModeV1,
  type PromptAssetScopeV1,
  type PromptAssetTypeDescriptorV1,
} from '@happier-dev/protocol';

import { ContextBar } from '@/components/contextBar/ContextBar';
import { useContextBarSelection } from '@/components/contextBar/useContextBarSelection';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SETTINGS_TEXT_INPUT_METRICS } from '@/components/ui/forms/settingsTextInputMetrics';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { layout } from '@/components/ui/layout/layout';
import { SettingsActionFooter } from '@/components/ui/settingsSurface/SettingsActionFooter';
import { Modal } from '@/modal';
import { storage, useAllMachines, useSettingMutable } from '@/sync/domains/state/storage';
import { machinePromptAssetsDelete, machinePromptAssetsListTypes } from '@/sync/ops/machinePromptAssets';
import { removePromptExternalLink } from '@/sync/ops/promptLibrary/promptDocs';
import { readPromptLibraryArtifactForExport, writePromptLibraryArtifactToExternalAsset, type ExportablePromptLibraryArtifact } from '@/sync/ops/promptLibrary/exportPromptLibraryArtifact';
import { translatePromptLibraryMessage } from '@/sync/ops/promptLibrary/translatePromptLibraryMessage';
import { t } from '@/text';
import { describePromptExternalLinkSubtitle, describePromptExternalLinkTitle } from '@/components/settings/prompts/shared/promptExternalLinkPresentation';
import {
  listPromptAssetTypesForScope,
  resolvePromptAssetTypeSelection,
} from '@/components/settings/prompts/shared/promptAssetTypeSelection';
import {
  listPromptAssetInstallModesForType,
  resolvePromptAssetInstallModeSelection,
} from '@/components/settings/prompts/shared/promptAssetInstallModeSelection';

import { defaultPromptAssetTargetInput } from './promptAssetExportDefaults';

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.groupped.background,
  },
  content: {
    padding: 16,
    paddingBottom: 64,
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
    marginTop: 12,
  },
}));

type PromptAssetExportInitialSelection = Readonly<{
  assetTypeId?: string | null;
  machineId?: string | null;
  scope?: PromptAssetScopeV1 | null;
  workspacePath?: string | null;
}>;

function describeMachine(
  machineId: string,
  machines: ReadonlyArray<{ id: string; metadata?: { displayName?: string | null; host?: string | null; homeDir?: string | null } | null }>,
): string {
  const machine = machines.find((entry) => entry.id === machineId) ?? null;
  return machine?.metadata?.displayName || machine?.metadata?.host || machineId;
}

function resolveProjectDirectory(
  workspacePath: string,
): string | null {
  const trimmedWorkspacePath = workspacePath.trim();
  return trimmedWorkspacePath.length > 0 ? trimmedWorkspacePath : null;
}

export const PromptAssetExportScreen = React.memo((props: Readonly<{
  artifactId: string;
  initialSelection?: PromptAssetExportInitialSelection;
}>) => {
  const { theme } = useUnistyles();
  const machines = useAllMachines();
  const [promptExternalLinksV1, setPromptExternalLinksV1] = useSettingMutable('promptExternalLinksV1');
  const [types, setTypes] = React.useState<PromptAssetTypeDescriptorV1[]>([]);
  const [scope, setScope] = React.useState<PromptAssetScopeV1>(props.initialSelection?.scope ?? 'project');
  const [scopeMenuOpen, setScopeMenuOpen] = React.useState(false);
  const [selectedAssetTypeId, setSelectedAssetTypeId] = React.useState<string | null>(props.initialSelection?.assetTypeId ?? null);
  const [assetTypeMenuOpen, setAssetTypeMenuOpen] = React.useState(false);
  const [installMode, setInstallMode] = React.useState<PromptAssetInstallModeV1 | null>(null);
  const [installModeMenuOpen, setInstallModeMenuOpen] = React.useState(false);
  const [artifactState, setArtifactState] = React.useState<ExportablePromptLibraryArtifact | null>(null);
  const [busy, setBusy] = React.useState(false);
  const defaultMachineId = props.initialSelection?.machineId ?? machines[0]?.id ?? null;
  const {
    machineId,
    setMachineId,
    workspacePath,
    setWorkspacePath,
  } = useContextBarSelection({
    selectionKey: `promptAssets.export.${props.artifactId}`,
    defaultMachineId,
    defaultWorkspacePath: props.initialSelection?.workspacePath ?? '',
  });
  const [targetInput, setTargetInput] = React.useState('');

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const nextState = await readPromptLibraryArtifactForExport(props.artifactId);
      if (!cancelled) {
        setArtifactState(nextState);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [props.artifactId]);

  React.useEffect(() => {
    if (machineId && machines.some((entry) => entry.id === machineId)) return;
    const nextMachineId = defaultMachineId;
    setMachineId(nextMachineId);
    setWorkspacePath('');
  }, [defaultMachineId, machineId, machines, setMachineId, setWorkspacePath]);

  React.useEffect(() => {
    if (!machineId || !artifactState) return;

    let cancelled = false;
    (async () => {
      const listed = await machinePromptAssetsListTypes(machineId, undefined);
      if (cancelled) return;
      const compatibleTypes = listed.types.filter((entry) => entry.libraryKind === artifactState.libraryKind);
      setTypes(compatibleTypes);
    })().catch(() => {
      if (!cancelled) setTypes([]);
    });

    return () => {
      cancelled = true;
    };
  }, [artifactState, machineId]);

  const scopeCompatibleTypes = React.useMemo(
    () => listPromptAssetTypesForScope(types, scope),
    [scope, types],
  );

  React.useEffect(() => {
    setSelectedAssetTypeId((current) => resolvePromptAssetTypeSelection({
      types,
      scope,
      selectedTypeId: current,
    }));
  }, [scope, types]);

  const currentType = React.useMemo(
    () => scopeCompatibleTypes.find((entry) => entry.id === selectedAssetTypeId) ?? null,
    [scopeCompatibleTypes, selectedAssetTypeId],
  );

  const availableInstallModes = React.useMemo(
    () => artifactState?.libraryKind === 'bundle'
      ? listPromptAssetInstallModesForType(currentType)
      : ['copy'],
    [artifactState?.libraryKind, currentType],
  );

  const currentLink = React.useMemo(() => {
    if (!machineId || !selectedAssetTypeId) return null;
    const projectDirectory = scope === 'project'
      ? resolveProjectDirectory(workspacePath)
      : null;
    return (promptExternalLinksV1?.links ?? []).find((entry) => (
      entry.artifactId === props.artifactId
      && entry.assetTypeId === selectedAssetTypeId
      && entry.machineId === machineId
      && entry.scope === scope
      && (entry.workspacePath ?? null) === projectDirectory
    )) ?? null;
  }, [machineId, promptExternalLinksV1, props.artifactId, scope, selectedAssetTypeId, workspacePath]);

  React.useEffect(() => {
    if (!artifactState) return;
    if (currentLink) {
      if ('relativePath' in currentLink.externalRef && typeof currentLink.externalRef.relativePath === 'string') {
        setTargetInput(currentLink.externalRef.relativePath);
        return;
      }
      if ('skillName' in currentLink.externalRef && typeof currentLink.externalRef.skillName === 'string') {
        setTargetInput(currentLink.externalRef.skillName);
        return;
      }
    }
    setTargetInput(defaultPromptAssetTargetInput({
      libraryKind: artifactState.libraryKind,
      title: artifactState.title,
    }));
  }, [artifactState, currentLink]);

  const machineItems = React.useMemo((): DropdownMenuItem[] => {
    return machines.map((machine) => ({
      id: machine.id,
      title: machine.metadata?.displayName || machine.metadata?.host || machine.id,
      subtitle: machine.id,
      icon: <Ionicons name="laptop-outline" size={22} color={theme.colors.textSecondary} />,
    }));
  }, [machines, theme.colors.textSecondary]);

  const scopeItems = React.useMemo((): DropdownMenuItem[] => ([
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
  ]), [theme.colors.accent.blue, theme.colors.accent.indigo]);

  const assetTypeItems = React.useMemo((): DropdownMenuItem[] => {
    return scopeCompatibleTypes
      .map((entry) => ({
        id: entry.id,
        title: entry.title,
        subtitle: entry.description,
        icon: <Ionicons name="layers-outline" size={22} color={theme.colors.textSecondary} />,
      }));
  }, [scopeCompatibleTypes, theme.colors.textSecondary]);

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
      assetType: currentType,
      selectedInstallMode: installMode,
    }),
    [currentType, installMode],
  );

  const exportAsset = React.useCallback(async () => {
    if (!artifactState || !machineId || !currentType) return;
    const resolvedInstallMode = artifactState.libraryKind === 'bundle'
      ? selectedInstallMode
      : undefined;

    try {
      setBusy(true);
      const preview = await writePromptLibraryArtifactToExternalAsset({
        artifactId: props.artifactId,
        machineId,
        assetTypeId: currentType.id,
        scope,
        workspacePath,
        targetInput,
        installMode: resolvedInstallMode,
        promptExternalLinks: promptExternalLinksV1,
        previewOnly: true,
      });
      if (!preview.ok) {
        Modal.alert(t('common.error'), translatePromptLibraryMessage(preview.error));
        return;
      }

      const confirmed = await Modal.confirm(
        t('promptLibrary.externalAssetsExportConfirmTitle'),
        preview.response.preview?.targetPath ?? t('promptLibrary.externalAssetsExportConfirmBody'),
        { confirmText: t('promptLibrary.externalAssetsExportAction') },
      );
      if (!confirmed) return;

      const committed = await writePromptLibraryArtifactToExternalAsset({
        artifactId: props.artifactId,
        machineId,
        assetTypeId: currentType.id,
        scope,
        workspacePath,
        targetInput,
        installMode: resolvedInstallMode,
        promptExternalLinks: promptExternalLinksV1,
        previewOnly: false,
      });
      if (!committed.ok || !committed.nextPromptExternalLinks) {
        Modal.alert(t('common.error'), translatePromptLibraryMessage(committed.ok ? 'promptLibrary.saveError' : committed.error));
        return;
      }

      setPromptExternalLinksV1(committed.nextPromptExternalLinks);
    } finally {
      setBusy(false);
    }
  }, [artifactState, currentType, installMode, machineId, promptExternalLinksV1, props.artifactId, scope, setPromptExternalLinksV1, targetInput, workspacePath]);

  const deleteExport = React.useCallback(async () => {
    if (!machineId || !currentType || !currentLink) return;

    const directory = currentLink.scope === 'project'
      ? (currentLink.workspacePath ?? resolveProjectDirectory(workspacePath) ?? undefined)
      : undefined;

    const confirmed = await Modal.confirm(
      t('promptLibrary.externalAssetsDeleteConfirmTitle'),
      t('promptLibrary.externalAssetsDeleteConfirmBody'),
      { confirmText: t('common.delete'), destructive: true },
    );
    if (!confirmed) return;

    try {
      setBusy(true);
      const result = await machinePromptAssetsDelete(machineId, {
        assetTypeId: currentType.id,
        scope: currentLink.scope,
        directory,
        externalRef: currentLink.externalRef,
        previewOnly: false,
        expectedDigest: currentLink.lastExternalDigest ?? null,
      }, undefined);
      if (!result.ok) {
        Modal.alert(t('common.error'), result.error);
        return;
      }
      setPromptExternalLinksV1(removePromptExternalLink(promptExternalLinksV1, currentLink.id));
    } finally {
      setBusy(false);
    }
  }, [currentLink, currentType, machineId, machines, promptExternalLinksV1, setPromptExternalLinksV1, workspacePath]);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: t('promptLibrary.externalAssetsExportTitle') }} />
      <ItemList containerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <ItemGroup title={t('promptLibrary.externalAssetsContext')}>
          <ContextBar
            mode={scope === 'project' ? 'machine_and_workspace' : 'machine_only'}
            machine={{
              selectedId: machineId,
              subtitle: machineId ? describeMachine(machineId, machines) : t('promptLibrary.externalAssetsNoMachine'),
              items: machineItems,
              onSelect: (nextMachineId) => {
                setMachineId(nextMachineId);
                setWorkspacePath('');
              },
            }}
            workspace={scope === 'project' ? {
              value: workspacePath,
              onChange: setWorkspacePath,
              placeholder: t('promptLibrary.externalAssetsProjectDirectory'),
              testID: 'promptAssetExport.directoryInput',
              browse: {
                machineId,
                enabled: true,
              },
            } : undefined}
          />
        </ItemGroup>

        <ItemGroup title={t('promptLibrary.externalAssetsExportOptions')}>
          <DropdownMenu
            open={scopeMenuOpen}
            onOpenChange={setScopeMenuOpen}
            items={scopeItems}
            selectedId={scope}
            onSelect={(nextScope) => setScope(nextScope as PromptAssetScopeV1)}
            itemTrigger={{
              title: t('promptLibrary.externalAssetsScope'),
              subtitle: scope === 'project' ? t('promptLibrary.externalAssetsProjectScope') : t('promptLibrary.externalAssetsUserScope'),
              icon: <Ionicons name="albums-outline" size={29} color={theme.colors.accent.indigo} />,
            }}
            rowKind="item"
            connectToTrigger
            variant="default"
          />

          <DropdownMenu
            open={assetTypeMenuOpen}
            onOpenChange={setAssetTypeMenuOpen}
            items={assetTypeItems}
            selectedId={selectedAssetTypeId}
            onSelect={(nextTypeId) => setSelectedAssetTypeId(nextTypeId)}
            itemTrigger={{
              title: t('promptLibrary.externalAssetsExportType'),
              subtitle: currentType?.title ?? t('promptLibrary.externalAssetsNoTypes'),
              icon: <Ionicons name="layers-outline" size={29} color={theme.colors.textSecondary} />,
            }}
            rowKind="item"
            connectToTrigger
            variant="default"
          />

          {artifactState?.libraryKind === 'bundle' ? (
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
          ) : null}

          <Item
            title={t('promptLibrary.externalAssetsExportTarget')}
            subtitle={(
              <TextInput
                testID="promptAssetExport.targetInput"
                placeholder={artifactState?.libraryKind === 'doc'
                  ? t('promptLibrary.externalAssetsExportTargetPathPlaceholder')
                  : t('promptLibrary.externalAssetsExportTargetNamePlaceholder')}
                placeholderTextColor={theme.colors.input.placeholder}
                value={targetInput}
                onChangeText={setTargetInput}
                style={styles.input}
              />
            )}
            subtitleLines={0}
            icon={<Ionicons name={artifactState?.libraryKind === 'bundle' ? 'sparkles-outline' : 'document-text-outline'} size={29} color={theme.colors.textSecondary} />}
            mode="info"
            showChevron={false}
          />

          {currentLink ? (
            <Item
              testID="promptAssetExport.linked"
              title={t('promptLibrary.externalAssetsLinkedTitle')}
              subtitle={describePromptExternalLinkSubtitle({
                link: currentLink,
                machines,
                scopeLabel: currentLink.scope === 'project'
                  ? t('promptLibrary.externalAssetsProjectScope')
                  : t('promptLibrary.externalAssetsUserScope'),
              })}
              icon={<Ionicons name="link-outline" size={29} color={theme.colors.textSecondary} />}
              detail={describePromptExternalLinkTitle(currentLink)}
              showChevron={false}
            />
          ) : null}
        </ItemGroup>

        <SettingsActionFooter
          primaryLabel={t('promptLibrary.externalAssetsExportAction')}
          onPrimaryPress={() => { void exportAsset(); }}
          primaryDisabled={busy || !artifactState || !machineId || !currentType || targetInput.trim().length === 0}
          primaryTestID="promptAssetExport.export"
          secondaryLabel={currentLink ? t('common.delete') : undefined}
          onSecondaryPress={currentLink ? (() => { void deleteExport(); }) : undefined}
          secondaryTestID={currentLink ? 'promptAssetExport.delete' : undefined}
          secondaryTone="destructive"
        />
      </ItemList>
    </View>
  );
});

PromptAssetExportScreen.displayName = 'PromptAssetExportScreen';
