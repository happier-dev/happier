import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
  type PromptAssetInstallModeV1,
  type PromptAssetScopeV1,
  type PromptAssetTypeDescriptorV1,
} from '@happier-dev/protocol';

import { ContextBar } from '@/components/settings/contextBar/ContextBar';
import { useContextBarSelection } from '@/components/settings/contextBar/useContextBarSelection';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PageHeaderMenu } from '@/components/ui/layout/PageHeaderEntityParts';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Modal } from '@/modal';
import { useAllMachines } from '@/sync/domains/state/storage';
import { usePromptLibraryCatalogValue } from '@/sync/store/usePromptLibraryCatalog';
import { requireUpdatedPromptLibraryMutation } from '@/sync/api/account/apiPromptLibraryCatalog';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { useMachineAdministrationTargetSelection } from '@/sync/domains/machines/administration/useTargetSelection';
import { useMachineAdministrationExecutionTargetBinding } from '@/sync/domains/machines/administration/useExecutionTargetBinding';
import { machinePromptAssetsDelete, machinePromptAssetsListTypes } from '@/sync/ops/machinePromptAssets';
import { findPromptExternalLink, removePromptExternalLink } from '@/sync/ops/promptLibrary/promptDocs';
import { isPromptExternalLinkForMachine } from '@happier-dev/protocol/prompts/library/promptExternalLinksV1';
import { writePromptLibraryArtifactToExternalAsset, type ExportablePromptLibraryArtifact } from '@/sync/ops/promptLibrary/exportPromptLibraryArtifact';
import { readPromptLibraryArtifactForExport } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createUiPromptLibraryArtifactStore } from '@/sync/ops/promptLibrary/promptLibraryArtifactStore';
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
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';

const styles = StyleSheet.create(() => ({
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
}));


/** A prompt exports as one file, so it can only be copied. */
const COPY_ONLY_INSTALL_MODES: readonly PromptAssetInstallModeV1[] = ['copy'];

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
  serverId?: string | null;
  initialSelection?: PromptAssetExportInitialSelection;
}>) => {
  const { theme } = useUnistyles();
  const machines = useAllMachines();
  const activeScope = useAccountSettingsScope();
  const libraryServerId = props.serverId?.trim() || activeScope?.serverId;
  const libraryActiveAccountId = libraryServerId === activeScope?.serverId ? activeScope?.accountId : undefined;
  const [libraryScope, setLibraryScope] = React.useState<ServerAccountScope | null>(null);
  const libraryAccountRef = React.useRef<LazyActionAccountContext | null>(null);
  const { value: promptExternalLinksV1, write: writeLinks, status: linksStatus, stale: linksStale } = usePromptLibraryCatalogValue('external-links', libraryScope);
  const administrationTargetSelection = useMachineAdministrationTargetSelection(
    MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.promptAssets,
  );
  const selectedTarget = administrationTargetSelection.selectedTarget;
  const {
    selectionKey,
    resolveExactExecutionTarget,
    isExecutionTargetCurrent,
  } = useMachineAdministrationExecutionTargetBinding(administrationTargetSelection);
  const [types, setTypes] = React.useState<PromptAssetTypeDescriptorV1[]>([]);
  const [scope, setScope] = React.useState<PromptAssetScopeV1>(props.initialSelection?.scope ?? 'project');
  const [selectedAssetTypeId, setSelectedAssetTypeId] = React.useState<string | null>(props.initialSelection?.assetTypeId ?? null);
  const [assetTypeMenuOpen, setAssetTypeMenuOpen] = React.useState(false);
  const [installMode, setInstallMode] = React.useState<PromptAssetInstallModeV1 | null>(null);
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
    workspaceBindingKey: selectionKey,
  });
  const [targetInput, setTargetInput] = React.useState('');

  React.useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    let account: LazyActionAccountContext | null = null;
    let retirement: Readonly<{ dispose(): void }> | null = null;
    libraryAccountRef.current = null; setLibraryScope(null); setArtifactState(null);
    (async () => {
      if (!libraryServerId) return;
      account = await captureLazyActionAccountContext(libraryServerId, controller.signal);
      if (cancelled) { account.dispose(); return; }
      retirement = account.accountLifetime.onRetire(() => {
        if (!cancelled) { libraryAccountRef.current = null; setLibraryScope(null); setArtifactState(null); }
      });
      const nextState = await readPromptLibraryArtifactForExport({ store: createUiPromptLibraryArtifactStore(account.workflowArtifacts, account),
        artifactId: props.artifactId, signal: controller.signal });
      account.assertCurrent();
      if (!cancelled) {
        libraryAccountRef.current = account;
        setLibraryScope({ serverId: account.serverId, accountId: account.accountId });
        setArtifactState(nextState);
      }
    })().catch(() => { if (!cancelled) { libraryAccountRef.current = null; setLibraryScope(null); setArtifactState(null); } });

    return () => {
      cancelled = true;
      controller.abort(); retirement?.dispose(); account?.dispose();
    };
  }, [props.artifactId, libraryServerId, libraryActiveAccountId]);

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
      : ['copy'] as const,
    [artifactState?.libraryKind, currentType],
  );

  const currentLink = React.useMemo(() => {
    const libraryServerIdentityId = libraryAccountRef.current?.serverIdentityId;
    if (!selectedTarget || !selectedAssetTypeId || !libraryServerIdentityId) return null;
    const projectDirectory = scope === 'project'
      ? resolveProjectDirectory(workspacePath)
      : null;
    return findPromptExternalLink(promptExternalLinksV1, {
      artifactId: props.artifactId, assetTypeId: selectedAssetTypeId, target: selectedTarget,
      libraryServerIdentityId, scope, workspacePath: projectDirectory,
    });
  }, [libraryScope, promptExternalLinksV1, props.artifactId, scope, selectedAssetTypeId, selectedTarget, workspacePath]);

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

  const assetTypeItems = React.useMemo((): DropdownMenuItem[] => {
    return scopeCompatibleTypes
      .map((entry) => ({
        id: entry.id,
        title: entry.title,
        subtitle: entry.description,
        icon: <Icon name="stack-simple" size={20} color={theme.colors.text.secondary} />,
      }));
  }, [scopeCompatibleTypes, theme.colors.text.secondary]);

  const installModeOptions = React.useMemo(() => availableInstallModes.map((entry) => ({
    id: entry,
    label: entry === 'symlink' ? t('promptLibrary.surface.installMethodLink') : t('promptLibrary.surface.installMethodCopy'),
    description: entry === 'symlink'
      ? t('promptLibrary.surface.installMethodLinkDescription')
      : t('promptLibrary.externalAssetsInstallMethodCopySubtitle'),
  })), [availableInstallModes]);

  const selectedInstallMode = React.useMemo(
    () => resolvePromptAssetInstallModeSelection({
      assetType: currentType,
      selectedInstallMode: installMode,
    }),
    [currentType, installMode],
  );

  const exportAsset = React.useCallback(async () => {
    if (!promptExternalLinksV1 || linksStatus !== 'ready' || linksStale) return;
    const requestedSelection = selectionKey;
    const executionTarget = resolveExactExecutionTarget(selectedTarget);
    if (!artifactState || !executionTarget || !currentType) return;
    if (scope === 'project' && !resolveProjectDirectory(workspacePath)) return;
    const resolvedInstallMode = artifactState.libraryKind === 'bundle'
      ? selectedInstallMode
      : undefined;

    try {
      setBusy(true);
      const account = libraryAccountRef.current;
      if (!account) throw new Error('action_account_scope_changed');
      account.assertCurrent();
      if (!account.serverIdentityId) throw new Error('content_unavailable');
      const store = createUiPromptLibraryArtifactStore(account.workflowArtifacts, account);
      const preview = await writePromptLibraryArtifactToExternalAsset({
        artifactId: props.artifactId,
        machineId: executionTarget.machine.id,
        machineTarget: executionTarget.target,
        libraryServerIdentityId: account.serverIdentityId,
        serverId: executionTarget.serverId,
        assetTypeId: currentType.id,
        scope,
        workspacePath,
        targetInput,
        installMode: resolvedInstallMode,
        promptExternalLinks: promptExternalLinksV1,
        previewOnly: true,
      }, store);
      account.assertCurrent();
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
      account.assertCurrent();

      const currentExecutionTarget = resolveExactExecutionTarget(selectedTarget);
      if (
        !currentExecutionTarget
        || !isExecutionTargetCurrent(requestedSelection, currentExecutionTarget)
      ) return;
      const committed = await writePromptLibraryArtifactToExternalAsset({
        artifactId: props.artifactId,
        machineId: currentExecutionTarget.machine.id,
        machineTarget: currentExecutionTarget.target,
        libraryServerIdentityId: account.serverIdentityId,
        serverId: currentExecutionTarget.serverId,
        assetTypeId: currentType.id,
        scope,
        workspacePath,
        targetInput,
        installMode: resolvedInstallMode,
        promptExternalLinks: promptExternalLinksV1,
        previewOnly: false,
      }, store);
      account.assertCurrent();
      if (!isExecutionTargetCurrent(requestedSelection, currentExecutionTarget)) return;
      if (!committed.ok || !committed.nextPromptExternalLinks) {
        Modal.alert(t('common.error'), translatePromptLibraryMessage(committed.ok ? 'promptLibrary.saveError' : committed.error));
        return;
      }

      requireUpdatedPromptLibraryMutation(await writeLinks(committed.nextPromptExternalLinks));
    } catch {
      Modal.alert(t('common.error'), t('promptLibrary.saveError'));
    } finally {
      setBusy(false);
    }
  }, [
    artifactState,
    currentType,
    isExecutionTargetCurrent,
    linksStatus,
    linksStale,
    promptExternalLinksV1,
    props.artifactId,
    resolveExactExecutionTarget,
    scope,
    selectedInstallMode,
    selectedTarget,
    selectionKey,
    writeLinks,
    targetInput,
    workspacePath,
  ]);

  const deleteExport = React.useCallback(async () => {
    if (!promptExternalLinksV1 || linksStatus !== 'ready' || linksStale || !currentType || !currentLink) return;
    const account = libraryAccountRef.current;
    if (!account || !account.accountLifetime.isCurrent()) return;

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
    if (!executionTarget || !account.serverIdentityId || !isPromptExternalLinkForMachine(currentLink, {
      target: executionTarget.target, libraryServerIdentityId: account.serverIdentityId,
    })) return;

    try {
      setBusy(true);
      account.assertCurrent();
      const result = await machinePromptAssetsDelete(executionTarget.machine.id, {
        assetTypeId: currentType.id,
        scope: currentLink.scope,
        directory,
        externalRef: currentLink.externalRef,
        previewOnly: false,
        expectedDigest: currentLink.lastExternalDigest ?? null,
      }, { serverId: executionTarget.serverId });
      account.assertCurrent();
      if (!isExecutionTargetCurrent(requestedSelection, executionTarget)) return;
      if (!result.ok) {
        Modal.alert(t('common.error'), result.error);
        return;
      }
      requireUpdatedPromptLibraryMutation(await writeLinks(removePromptExternalLink(promptExternalLinksV1, currentLink.id)));
    } catch {
      Modal.alert(t('common.error'), t('promptLibrary.saveError'));
    } finally {
      setBusy(false);
    }
  }, [
    currentLink,
    currentType,
    isExecutionTargetCurrent,
    linksStatus,
    linksStale,
    promptExternalLinksV1,
    resolveExactExecutionTarget,
    selectedTarget,
    selectionKey,
    writeLinks,
    workspacePath,
  ]);

  const executionTarget = resolveExactExecutionTarget(selectedTarget);

  const exportDisabled = busy || !artifactState || !executionTarget || !currentType || targetInput.trim().length === 0 || (scope === 'project' && !resolveProjectDirectory(workspacePath));

  return (
    <ItemList keyboardShouldPersistTaps="handled">
      <PageHeader
        testID="promptAssetExport.header"
        alwaysShowTitle
        title={t('promptLibrary.externalAssetsExportTitle')}
        description={artifactState?.title
          ? t('promptLibrary.surface.exportDescription', { title: artifactState.title })
          : undefined}
        primaryAction={{
          testID: 'promptAssetExport.export',
          title: t('promptLibrary.externalAssetsExportAction'),
          disabled: exportDisabled,
          loading: busy,
          onPress: exportAsset,
        }}
        actions={(
          <View style={styles.headerActions}>
            <MachineAdministrationTargetSelector
              selection={administrationTargetSelection}
              presentation="chip"
              testIDPrefix="settings.promptAssetExport.administration.target"
            />
            {currentLink ? (
              <PageHeaderMenu
                testID="promptAssetExport.menu"
                actions={[{ id: 'delete', testID: 'promptAssetExport.delete', title: t('common.delete'), onSelect: () => { void deleteExport(); } }]}
              />
            ) : null}
          </View>
        )}
      />

      <ItemGroup title={t('promptLibrary.externalAssetsExportOptions')} description={t('promptLibrary.surface.exportOptionsDescription')}>
        <SegmentedChoiceItem
            title={t('promptLibrary.externalAssetsScope')}
            options={[
                { id: 'project', label: t('promptLibrary.externalAssetsProjectScope'), description: t('promptLibrary.surface.installProjectScopeDescription') },
                { id: 'user', label: t('promptLibrary.externalAssetsUserScope'), description: t('promptLibrary.surface.installUserScopeDescription') },
            ]}
            value={scope}
            onChange={(nextScope) => setScope(nextScope as PromptAssetScopeV1)}
        />
        {scope === 'project' ? (
          <ContextBar
            mode="workspace_only"
            workspace={{
              value: workspacePath,
              onChange: setWorkspacePath,
              placeholder: t('promptLibrary.externalAssetsProjectDirectory'),
              testID: 'promptAssetExport.directoryInput',
              browse: {
                machineId: executionTarget?.machine.id ?? null,
                serverId: executionTarget?.serverId ?? null,
                enabled: executionTarget !== null,
              },
            }}
          />
        ) : null}

        <DropdownMenu
          open={assetTypeMenuOpen}
          onOpenChange={setAssetTypeMenuOpen}
          items={assetTypeItems}
          selectedId={selectedAssetTypeId}
          onSelect={(nextTypeId) => setSelectedAssetTypeId(nextTypeId)}
          itemTrigger={{
            title: t('promptLibrary.externalAssetsExportType'),
            subtitle: currentType?.title ?? t('promptLibrary.externalAssetsNoTypes'),
          }}
          rowKind="item"
          connectToTrigger
          variant="default"
        />

        {artifactState?.libraryKind === 'bundle' && installModeOptions.length > 0 && selectedInstallMode ? (
          <SegmentedChoiceItem<PromptAssetInstallModeV1>
            title={t('promptLibrary.externalAssetsInstallMethod')}
            options={installModeOptions}
            value={selectedInstallMode}
            onChange={setInstallMode}
            testIDPrefix="promptAssetExport.installMode"
          />
        ) : null}

        <Item
          title={t('promptLibrary.externalAssetsExportTarget')}
          subtitle={t('promptLibrary.surface.installTargetDescription')}
          accessoryLayout="adaptive"
          showChevron={false}
          rightElement={(
            <FieldTextInput
              testID="promptAssetExport.targetInput"
              accessibilityLabel={t('promptLibrary.externalAssetsExportTarget')}
              placeholder={artifactState?.libraryKind === 'doc'
                ? t('promptLibrary.externalAssetsExportTargetPathPlaceholder')
                : t('promptLibrary.externalAssetsExportTargetNamePlaceholder')}
              value={targetInput}
              onChangeText={setTargetInput}
              autoCapitalize="none"
              monospace
            />
          )}
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
            detail={describePromptExternalLinkTitle(currentLink)}
            mode="info"
            showChevron={false}
          />
        ) : null}
      </ItemGroup>
    </ItemList>
  );
});

PromptAssetExportScreen.displayName = 'PromptAssetExportScreen';
