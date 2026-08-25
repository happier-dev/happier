import * as React from 'react';
import { TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
  type MachineAdministrationTargetV1,
  type PromptAssetInstallModeV1,
  type PromptAssetScopeV1,
  type PromptAssetTypeDescriptorV1,
} from '@happier-dev/protocol';

import { ContextBar } from '@/components/settings/contextBar/ContextBar';
import { useContextBarSelection } from '@/components/settings/contextBar/useContextBarSelection';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SETTINGS_TEXT_INPUT_METRICS } from '@/components/ui/forms/settingsTextInputMetrics';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { SettingsActionFooter } from '@/components/ui/settingsSurface/SettingsActionFooter';
import { Modal } from '@/modal';
import { useAllMachines, useSettingMutable } from '@/sync/domains/state/storage';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { machineAdministrationTargetsEqual } from '@/sync/domains/machines/administration/targetSelection';
import {
  type FreshMachineAdministrationExecutionTargetV1,
  useMachineAdministrationTargetSelection,
} from '@/sync/domains/machines/administration/useTargetSelection';
import { isMachineAdministrationExecutionTargetCurrent } from '@/sync/domains/machines/administration/operationCurrentness';
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
import { Icon } from '@/components/ui/icons/Icon';

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background.canvas,
  },
  content: {
    padding: 16,
    paddingBottom: 64,
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
  scope?: PromptAssetScopeV1 | null;
  workspacePath?: string | null;
}>;

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
  // Composed at render time: the module-scope stylesheet evaluates once, so a
  // baked-in `layout.maxWidth` would freeze the user's content-width preference.
  const contentMaxWidthStyle = useLayoutMaxWidthStyle();
  const contentStyle = React.useMemo(() => [styles.content, contentMaxWidthStyle], [contentMaxWidthStyle]);
  const { theme } = useUnistyles();
  const machines = useAllMachines();
  const [promptExternalLinksV1, setPromptExternalLinksV1] = useSettingMutable('promptExternalLinksV1');
  const administrationTargetSelection = useMachineAdministrationTargetSelection(
    MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.promptAssets,
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
  const [types, setTypes] = React.useState<PromptAssetTypeDescriptorV1[]>([]);
  const [scope, setScope] = React.useState<PromptAssetScopeV1>(props.initialSelection?.scope ?? 'project');
  const [scopeMenuOpen, setScopeMenuOpen] = React.useState(false);
  const [selectedAssetTypeId, setSelectedAssetTypeId] = React.useState<string | null>(props.initialSelection?.assetTypeId ?? null);
  const [assetTypeMenuOpen, setAssetTypeMenuOpen] = React.useState(false);
  const [installMode, setInstallMode] = React.useState<PromptAssetInstallModeV1 | null>(null);
  const [installModeMenuOpen, setInstallModeMenuOpen] = React.useState(false);
  const [artifactState, setArtifactState] = React.useState<ExportablePromptLibraryArtifact | null>(null);
  const [busy, setBusy] = React.useState(false);
  const {
    workspacePath,
    setWorkspacePath,
  } = useContextBarSelection({
    selectionKey: `promptAssets.export.${props.artifactId}`,
    // This legacy context entry carries only the workspace path. Its machine
    // field is deliberately ignored so it cannot compete with the
    // Administration-owned portable target.
    defaultMachineId: null,
    defaultWorkspacePath: props.initialSelection?.workspacePath ?? '',
  });
  const [targetInput, setTargetInput] = React.useState('');
  const previousSelectionKeyRef = React.useRef(selectionKey);

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

  React.useLayoutEffect(() => {
    const previousSelectionKey = previousSelectionKeyRef.current;
    previousSelectionKeyRef.current = selectionKey;
    if (!previousSelectionKey || previousSelectionKey === selectionKey) return;
    setWorkspacePath('');
  }, [selectionKey, setWorkspacePath]);

  React.useEffect(() => {
    let cancelled = false;
    const requestedSelection = selectionKey;
    const executionTarget = resolveExactExecutionTarget(selectedTarget);
    if (!artifactState || !executionTarget) {
      setTypes([]);
      return () => {
        cancelled = true;
      };
    }
    (async () => {
      const listed = await machinePromptAssetsListTypes(executionTarget.machine.id, {
        serverId: executionTarget.serverId,
      });
      if (cancelled || !isExecutionTargetCurrent(requestedSelection, executionTarget)) return;
      const compatibleTypes = listed.types.filter((entry) => entry.libraryKind === artifactState.libraryKind);
      setTypes(compatibleTypes);
    })().catch(() => {
      if (!cancelled && isExecutionTargetCurrent(requestedSelection, executionTarget)) setTypes([]);
    });

    return () => {
      cancelled = true;
    };
  }, [
    artifactState,
    isExecutionTargetCurrent,
    resolveExactExecutionTarget,
    selectedTarget,
    selectionKey,
  ]);

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
    if (!selectedTarget || !selectedAssetTypeId) return null;
    const projectDirectory = scope === 'project'
      ? resolveProjectDirectory(workspacePath)
      : null;
    return (promptExternalLinksV1?.links ?? []).find((entry) => (
      entry.artifactId === props.artifactId
      && entry.assetTypeId === selectedAssetTypeId
      && entry.machineId === selectedTarget.machineId
      && entry.scope === scope
      && (entry.workspacePath ?? null) === projectDirectory
    )) ?? null;
  }, [promptExternalLinksV1, props.artifactId, scope, selectedAssetTypeId, selectedTarget, workspacePath]);

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

  const scopeItems = React.useMemo((): DropdownMenuItem[] => ([
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
  ]), [theme.colors.accent.blue, theme.colors.accent.indigo]);

  const assetTypeItems = React.useMemo((): DropdownMenuItem[] => {
    return scopeCompatibleTypes
      .map((entry) => ({
        id: entry.id,
        title: entry.title,
        subtitle: entry.description,
        icon: <Icon name="stack-simple" size={20} color={theme.colors.text.secondary} />,
      }));
  }, [scopeCompatibleTypes, theme.colors.text.secondary]);

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
      assetType: currentType,
      selectedInstallMode: installMode,
    }),
    [currentType, installMode],
  );

  const exportAsset = React.useCallback(async () => {
    const requestedSelection = selectionKey;
    const executionTarget = resolveExactExecutionTarget(selectedTarget);
    if (!artifactState || !executionTarget || !currentType) return;
    if (scope === 'project' && !resolveProjectDirectory(workspacePath)) return;
    const resolvedInstallMode = artifactState.libraryKind === 'bundle'
      ? selectedInstallMode
      : undefined;

    try {
      setBusy(true);
      const preview = await writePromptLibraryArtifactToExternalAsset({
        artifactId: props.artifactId,
        machineId: executionTarget.machine.id,
        serverId: executionTarget.serverId,
        assetTypeId: currentType.id,
        scope,
        workspacePath,
        targetInput,
        installMode: resolvedInstallMode,
        promptExternalLinks: promptExternalLinksV1,
        previewOnly: true,
      });
      if (!isExecutionTargetCurrent(requestedSelection, executionTarget)) return;
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

      const currentExecutionTarget = resolveExactExecutionTarget(selectedTarget);
      if (
        !currentExecutionTarget
        || !isExecutionTargetCurrent(requestedSelection, currentExecutionTarget)
      ) return;
      const committed = await writePromptLibraryArtifactToExternalAsset({
        artifactId: props.artifactId,
        machineId: currentExecutionTarget.machine.id,
        serverId: currentExecutionTarget.serverId,
        assetTypeId: currentType.id,
        scope,
        workspacePath,
        targetInput,
        installMode: resolvedInstallMode,
        promptExternalLinks: promptExternalLinksV1,
        previewOnly: false,
      });
      if (!isExecutionTargetCurrent(requestedSelection, currentExecutionTarget)) return;
      if (!committed.ok || !committed.nextPromptExternalLinks) {
        Modal.alert(t('common.error'), translatePromptLibraryMessage(committed.ok ? 'promptLibrary.saveError' : committed.error));
        return;
      }

      setPromptExternalLinksV1(committed.nextPromptExternalLinks);
    } finally {
      setBusy(false);
    }
  }, [
    artifactState,
    currentType,
    isExecutionTargetCurrent,
    promptExternalLinksV1,
    props.artifactId,
    resolveExactExecutionTarget,
    scope,
    selectedInstallMode,
    selectedTarget,
    selectionKey,
    setPromptExternalLinksV1,
    targetInput,
    workspacePath,
  ]);

  const deleteExport = React.useCallback(async () => {
    if (!currentType || !currentLink) return;

    const directory = currentLink.scope === 'project'
      ? (currentLink.workspacePath ?? resolveProjectDirectory(workspacePath) ?? undefined)
      : undefined;

    const confirmed = await Modal.confirm(
      t('promptLibrary.externalAssetsDeleteConfirmTitle'),
      t('promptLibrary.externalAssetsDeleteConfirmBody'),
      { confirmText: t('common.delete'), destructive: true },
    );
    if (!confirmed) return;

    const requestedSelection = selectionKey;
    const executionTarget = resolveExactExecutionTarget(selectedTarget);
    if (!executionTarget || executionTarget.machine.id !== currentLink.machineId) return;

    try {
      setBusy(true);
      const result = await machinePromptAssetsDelete(executionTarget.machine.id, {
        assetTypeId: currentType.id,
        scope: currentLink.scope,
        directory,
        externalRef: currentLink.externalRef,
        previewOnly: false,
        expectedDigest: currentLink.lastExternalDigest ?? null,
      }, { serverId: executionTarget.serverId });
      if (!isExecutionTargetCurrent(requestedSelection, executionTarget)) return;
      if (!result.ok) {
        Modal.alert(t('common.error'), result.error);
        return;
      }
      setPromptExternalLinksV1(removePromptExternalLink(promptExternalLinksV1, currentLink.id));
    } finally {
      setBusy(false);
    }
  }, [
    currentLink,
    currentType,
    isExecutionTargetCurrent,
    promptExternalLinksV1,
    resolveExactExecutionTarget,
    selectedTarget,
    selectionKey,
    setPromptExternalLinksV1,
    workspacePath,
  ]);

  const executionTarget = resolveExactExecutionTarget(selectedTarget);

  return (
    <View style={styles.container}>
      <ItemList containerStyle={contentStyle} keyboardShouldPersistTaps="handled">
        <MachineAdministrationTargetSelector
          selection={administrationTargetSelection}
          testIDPrefix="settings.promptAssetExport.administration.target"
        />
        <ItemGroup title={t('promptLibrary.externalAssetsContext')}>
          <ContextBar
            mode="workspace_only"
            workspace={scope === 'project' ? {
              value: workspacePath,
              onChange: setWorkspacePath,
              placeholder: t('promptLibrary.externalAssetsProjectDirectory'),
              testID: 'promptAssetExport.directoryInput',
              browse: {
                machineId: executionTarget?.machine.id ?? null,
                serverId: executionTarget?.serverId ?? null,
                enabled: executionTarget !== null,
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
              icon: <Icon name="stack" size={29} color={theme.colors.accent.indigo} />,
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
              icon: <Icon name="stack-simple" size={29} color={theme.colors.text.secondary} />,
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
                icon: <Icon name={selectedInstallMode === 'symlink' ? 'git-branch' : 'copy'} size={29} color={theme.colors.text.secondary} />,
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
            icon={<Icon name={artifactState?.libraryKind === 'bundle' ? 'sparkle' : 'file-text'} size={29} color={theme.colors.text.secondary} />}
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
              icon={<Icon name="link" size={29} color={theme.colors.text.secondary} />}
              detail={describePromptExternalLinkTitle(currentLink)}
              showChevron={false}
            />
          ) : null}
        </ItemGroup>

        <SettingsActionFooter
          primaryLabel={t('promptLibrary.externalAssetsExportAction')}
          onPrimaryPress={() => { void exportAsset(); }}
          primaryDisabled={busy || !artifactState || !executionTarget || !currentType || targetInput.trim().length === 0 || (scope === 'project' && !resolveProjectDirectory(workspacePath))}
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
