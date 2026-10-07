import { useAuthoringMemoryField } from '@/sync/domains/state/storage';
import * as React from 'react';

import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { convertBackendTargetRefV2ToV1, readBackendTargetRefV2, type BackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { AcpCatalogSettingsV1 } from '@happier-dev/protocol/acp/catalog/settingsV1';
import type { LlmTaskRunnerConfigV1 } from '@happier-dev/protocol/llm/tasks/llmTaskRunnerConfigV1';

import {
  getResolvedBackendCatalogEntries,
  type ResolvedBackendCatalogEntry,
} from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { getAgentCore } from '@/agents/catalog/catalog';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { getModelDropdownMenuItems, REFRESH_MODELS_DROPDOWN_ITEM_ID } from '@/components/settings/pickers/modelDropdownItems';
import { resolvePreferredMachineId } from '@/components/settings/pickers/resolvePreferredMachineId';
import { useNewSessionPreflightModelsState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useSetting } from '@/sync/domains/state/storage';
import { useAllMachines } from '@/sync/store/hooks';
import { t } from '@/text';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { Icon } from '@/components/ui/icons/Icon';

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveTaskRunnerBackendTarget(entry: ResolvedBackendCatalogEntry): BackendTargetRefV2 {
  if (entry.backendTarget.kind === 'backend') return entry.backendTarget;
  return entry.compatibilityBackendTargets?.[0] ?? {
    kind: 'backend',
    backendId: entry.backendId,
  };
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
  const recentMachinePaths = useAuthoringMemoryField('recentMachinePaths');
  const [openMenu, setOpenMenu] = React.useState<null | 'backend' | 'model'>(null);
  const [customModelDraft, setCustomModelDraft] = React.useState<string | null>(null);

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
    const targetKey = resolveBackendTargetKeyV2(target);
    return backendEntries.find((entry) => entry.backendTargetKey === targetKey) ?? null;
  }, [backendEntries, props.value?.backendTarget]);

  const selectedBackendTargetForModelOptions = React.useMemo(() => {
    return selectedBackendEntry
      ? resolveTaskRunnerBackendTarget(selectedBackendEntry)
      : props.value ? readBackendTargetRefV2(props.value.backendTarget) : null;
  }, [selectedBackendEntry, props.value?.backendTarget]);

  const preflightModels = useNewSessionPreflightModelsState({
    backendTarget: selectedBackendTargetForModelOptions,
    selectedMachineId: preflightMachineId,
    capabilityServerId: String(getActiveServerSnapshot().serverId ?? '').trim(),
  });

  const backendMenuItems = React.useMemo(() => {
    return backendEntries.map((entry) => {
      const displayAgentId = entry.iconAgentId ?? entry.catalogAgentId ?? entry.builtInAgentId;
      const iconName = getAgentCore(displayAgentId ?? '')?.ui?.agentPickerIconName ?? 'layers-outline';
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

  // A different backend/model retires an unfinished custom id instead of applying it to another agent.
  const selectedBackendKey = selectedBackendEntry?.backendTargetKey ?? null;
  React.useEffect(() => setCustomModelDraft(null), [selectedBackendKey, props.value?.modelId]);
  const customModelTestID = `${props.modelTestID ?? 'llm-task-runner-model'}.custom`;
  const saveCustomModel = () => {
    if (customModelDraft === null || !selectedBackendEntry) return;
    props.onChange({
      v: 1,
      backendTarget: convertBackendTargetRefV2ToV1(resolveTaskRunnerBackendTarget(selectedBackendEntry)),
      modelId: customModelDraft.trim() || 'default',
      permissionMode: 'no_tools',
    });
    setCustomModelDraft(null);
  };

  // Without labels the two selects are rows of the caller's section: no wrapper, a divider between them.
  const Wrapper = showLabels ? LabelledPickerStack : React.Fragment;
  return (
    <>
      <Wrapper>
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
          itemProps: { testID: props.backendTestID, ...(showLabels ? {} : { showDivider: true }) },
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
            backendTarget: convertBackendTargetRefV2ToV1(resolveTaskRunnerBackendTarget(nextBackendEntry)),
            modelId: 'default',
            permissionMode: 'no_tools',
          });
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
            setCustomModelDraft(modelId);
            return;
          }

          const nextModelId = String(id ?? '').trim();
          if (!nextModelId) return;
          props.onChange({
            v: 1,
            backendTarget: convertBackendTargetRefV2ToV1(resolveTaskRunnerBackendTarget(selectedBackendEntry)),
            modelId: nextModelId,
            permissionMode: 'no_tools',
          });
          setOpenMenu(null);
        }}
      />
      {customModelDraft !== null ? (
        <>
          <FieldItem label={t('settingsSession.replayResume.summaryRunner.customTitle')}>
            <FieldTextInput
              testID={customModelTestID}
              accessibilityLabel={t('settingsSession.replayResume.summaryRunner.modelTitle')}
              placeholder={t('settingsSession.replayResume.summaryRunner.modelPlaceholder')}
              value={customModelDraft}
              onChangeText={setCustomModelDraft}
              onSubmitEditing={saveCustomModel}
              autoFocus
            />
          </FieldItem>
          <SectionContentRow>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 }}>
              <RoundButton testID={`${customModelTestID}.cancel`} size="small" display="secondary" title={t('common.cancel')} onPress={() => setCustomModelDraft(null)} />
              <RoundButton testID={`${customModelTestID}.save`} size="small" title={t('common.save')} onPress={saveCustomModel} />
            </View>
          </SectionContentRow>
        </>
      ) : null}
      </Wrapper>
    </>
  );
}

function LabelledPickerStack(props: Readonly<{ children?: React.ReactNode }>) {
  return <View style={{ gap: 8 }}>{props.children}</View>;
}
