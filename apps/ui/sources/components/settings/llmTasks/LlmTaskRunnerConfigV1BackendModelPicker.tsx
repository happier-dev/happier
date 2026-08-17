import * as React from 'react';

import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { AcpCatalogSettingsV1, LlmTaskRunnerConfigV1 } from '@happier-dev/protocol';

import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { getAgentCore } from '@/agents/catalog/catalog';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { getModelDropdownMenuItems, REFRESH_MODELS_DROPDOWN_ITEM_ID } from '@/components/settings/pickers/modelDropdownItems';
import { resolvePreferredMachineId } from '@/components/settings/pickers/resolvePreferredMachineId';
import { useNewSessionPreflightModelsState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useSetting } from '@/sync/domains/state/storage';
import { useAllMachines } from '@/sync/store/hooks';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { Icon } from '@/components/ui/icons/Icon';

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function LlmTaskRunnerConfigV1BackendModelPicker(props: Readonly<{
  value: LlmTaskRunnerConfigV1 | null;
  onChange: (next: LlmTaskRunnerConfigV1 | null) => void;
  backendTestID?: string;
  modelTestID?: string;
  popoverBoundaryRef?: React.RefObject<any> | null;
  showLabels?: boolean;
}>): React.ReactElement {
  const { theme } = useUnistyles();
  const showLabels = props.showLabels !== false;
  const enabledAgentIds = useEnabledAgentIds();
  const acpCatalogSettings = useSetting('acpCatalogSettingsV1') as AcpCatalogSettingsV1 | undefined;
  const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey') as Record<string, boolean> | undefined;
  const machines = useAllMachines();
  const recentMachinePaths = useSetting('recentMachinePaths') as any[] | undefined;
  const [openMenu, setOpenMenu] = React.useState<null | 'backend' | 'model'>(null);

  const modelId = normalizeNonEmptyString(props.value?.modelId) ?? 'default';
  const preflightMachineId = React.useMemo(() => {
    return resolvePreferredMachineId({
      machines,
      recentMachinePaths: Array.isArray(recentMachinePaths) ? recentMachinePaths : [],
    });
  }, [machines, recentMachinePaths]);
  const daemonMergedProjection = useDaemonMergedProjectionInputs({
    machineId: preflightMachineId,
    serverId: String(getActiveServerSnapshot().serverId ?? '').trim() || null,
    enabled: Boolean(preflightMachineId),
    staleMs: 60_000,
  });
  const backendEntries = React.useMemo(() => {
    return getResolvedBackendCatalogEntries({
      enabledAgentIds,
      acpCatalogSettingsV1: acpCatalogSettings ?? { v: 2, backends: [] },
      backendEnabledByTargetKey,
      discoveredBackendIds: daemonMergedProjection.inputs?.discoveredBackendIds ?? undefined,
      mergedProviderProjectionById: daemonMergedProjection.inputs?.mergedProviderProjectionById ?? null,
      mergedBackendProjectionById: daemonMergedProjection.inputs?.mergedBackendProjectionById ?? null,
    });
  }, [
    acpCatalogSettings,
    backendEnabledByTargetKey,
    daemonMergedProjection.inputs?.discoveredBackendIds,
    daemonMergedProjection.inputs?.mergedBackendProjectionById,
    daemonMergedProjection.inputs?.mergedProviderProjectionById,
    enabledAgentIds,
  ]);
  const selectedBackendEntry = React.useMemo(() => {
    const target = props.value?.backendTarget;
    if (!target) return null;
    const targetKey = resolveBackendTargetKeyV2(target as any);
    return backendEntries.find((entry) => entry.backendTargetKey === targetKey) ?? null;
  }, [backendEntries, props.value?.backendTarget]);

  const selectedBackendTargetForModelOptions = React.useMemo(() => {
    return selectedBackendEntry?.backendTarget ?? null;
  }, [selectedBackendEntry]);

  const preflightModels = useNewSessionPreflightModelsState({
    backendTarget: selectedBackendTargetForModelOptions,
    selectedMachineId: preflightMachineId,
    capabilityServerId: String(getActiveServerSnapshot().serverId ?? '').trim(),
  });

  const backendMenuItems = React.useMemo(() => {
    return backendEntries.map((entry) => {
      const displayAgentId = entry.iconAgentId ?? entry.catalogAgentId ?? entry.builtInAgentId;
      const iconName = displayAgentId ? getAgentCore(displayAgentId).ui?.agentPickerIconName : 'layers-outline';
      return {
        id: entry.backendTargetKey,
        title: entry.title,
        subtitle: entry.subtitle ?? undefined,
        icon: <Icon name={iconName as any} size={20} color={theme.colors.text.secondary} />,
      };
    });
  }, [backendEntries, theme.colors.text.secondary]);

  const selectableModelMenuItems = React.useMemo(() => {
    return getModelDropdownMenuItems({
      modelOptions: preflightModels.modelOptions,
      iconColor: theme.colors.text.secondary,
      probe: {
        phase: preflightModels.probe.phase,
        onRefresh: preflightModels.probe.onRefresh,
      },
    });
  }, [preflightModels.modelOptions, preflightModels.probe.onRefresh, preflightModels.probe.phase, theme.colors.text.secondary]);

  const modelMenuItems = React.useMemo(() => {
    return [
      ...selectableModelMenuItems,
      {
        id: '__custom__',
        title: t('settingsSession.replayResume.summaryRunner.customTitle'),
        subtitle: t('settingsSession.replayResume.summaryRunner.customModelIdSubtitle'),
        icon: <Icon name="pencil-simple" size={20} color={theme.colors.text.secondary} />,
      },
    ];
  }, [selectableModelMenuItems, theme.colors.text.secondary]);

  const selectedBackendLabel = React.useMemo(() => {
    return selectedBackendEntry?.title ?? t('settingsSession.replayResume.summaryRunner.notSet');
  }, [selectedBackendEntry]);

  const selectedModelLabel = React.useMemo(() => {
    const trimmed = modelId.trim();
    if (!trimmed) return t('settingsSession.replayResume.summaryRunner.notSet');
    const opt = selectableModelMenuItems.find((it) => it.id === trimmed);
    return opt?.title ?? trimmed;
  }, [modelId, selectableModelMenuItems]);

  return (
    <>
      <View style={{ gap: 8 }}>
        {showLabels ? (
          <Text style={{ fontSize: 12, fontWeight: '500', color: theme.colors.text.secondary }}>
            {t('settingsSession.replayResume.summaryRunner.backendTitle')}
          </Text>
        ) : null}
      <DropdownMenu
        open={openMenu === 'backend'}
        onOpenChange={(next) => setOpenMenu(next ? 'backend' : null)}
        variant="selectable"
        search={true}
        searchPlaceholder={t('settingsSession.replayResume.summaryRunner.searchBackendsPlaceholder')}
        selectedId={selectedBackendEntry?.backendTargetKey ?? ''}
        showCategoryTitles={false}
        matchTriggerWidth={true}
        connectToTrigger={true}
        rowKind="item"
        popoverBoundaryRef={props.popoverBoundaryRef}
        itemTrigger={{
          title: t('settingsSession.replayResume.summaryRunner.backendTitle'),
          subtitle: t('settingsSession.replayResume.summaryRunner.backendPlaceholder'),
          detailFormatter: () => selectedBackendLabel,
          itemProps: { testID: props.backendTestID },
        }}
        items={backendMenuItems as any}
        onSelect={(id) => {
          const targetKey = String(id ?? '').trim();
          if (!targetKey) {
            props.onChange(null);
            setOpenMenu(null);
            return;
          }
          const nextBackendEntry = backendEntries.find((entry) => entry.backendTargetKey === targetKey) ?? null;
          if (!nextBackendEntry) {
            props.onChange(null);
            setOpenMenu(null);
            return;
          }
          props.onChange({
            v: 1,
            backendTarget: nextBackendEntry.backendTarget,
            modelId: 'default',
            permissionMode: 'no_tools',
          } as any);
          setOpenMenu(null);
        }}
      />

      {showLabels ? (
        <Text style={{ fontSize: 12, fontWeight: '500', color: theme.colors.text.secondary }}>
          {t('settingsSession.replayResume.summaryRunner.modelTitle')}
        </Text>
      ) : null}
      <DropdownMenu
        open={openMenu === 'model'}
        onOpenChange={(next) => setOpenMenu(next ? 'model' : null)}
        variant="selectable"
        search={true}
        searchPlaceholder={t('settingsSession.replayResume.summaryRunner.searchModelsPlaceholder')}
        selectedId={modelId}
        showCategoryTitles={false}
        matchTriggerWidth={true}
        connectToTrigger={true}
        rowKind="item"
        popoverBoundaryRef={props.popoverBoundaryRef}
        itemTrigger={{
          title: t('settingsSession.replayResume.summaryRunner.modelTitle'),
          subtitle: t('settingsSession.replayResume.summaryRunner.modelPlaceholder'),
          detailFormatter: () => selectedModelLabel,
          itemProps: { testID: props.modelTestID },
        }}
        items={modelMenuItems as any}
        onSelect={(id) => {
          if (!selectedBackendEntry) {
            props.onChange(null);
            setOpenMenu(null);
            return;
          }
          if (id === REFRESH_MODELS_DROPDOWN_ITEM_ID) {
            preflightModels.probe.onRefresh?.();
            setOpenMenu(null);
            return;
          }
          if (id === '__custom__') {
            setOpenMenu(null);
            fireAndForget((async () => {
              const raw = await Modal.prompt(
                t('settingsSession.replayResume.summaryRunner.modelTitle'),
                t('settingsSession.replayResume.summaryRunner.modelPlaceholder'),
                { placeholder: modelId || 'default' },
              );
              if (raw === null) return;
              const nextModelId = String(raw).trim();
              props.onChange({
                v: 1,
                backendTarget: selectedBackendEntry.backendTarget,
                modelId: nextModelId || 'default',
                permissionMode: 'no_tools',
              } as any);
            })(), { tag: 'LlmTaskRunnerConfigV1BackendModelPicker.prompt.modelId' });
            return;
          }

          const nextModelId = String(id ?? '').trim();
          if (!nextModelId) return;
          props.onChange({
            v: 1,
            backendTarget: selectedBackendEntry.backendTarget,
            modelId: nextModelId,
            permissionMode: 'no_tools',
          } as any);
          setOpenMenu(null);
        }}
      />
      </View>
    </>
  );
}
