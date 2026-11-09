import { Typography } from '@/constants/Typography';
import { useAuthoringMemoryField } from '@/sync/domains/state/storage';
import * as React from 'react';

import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { LlmTaskRunnerConfigV1WriteSchema, type LlmTaskRunnerConfigV1 } from '@happier-dev/protocol/llm/tasks/llmTaskRunnerConfigV1';

import { NEUTRAL_AGENT_ICON_NAME } from '@/agents/backendCatalog/agentCatalogProjection';
import { getAgentCore } from '@/agents/catalog/catalog';
import { resolvePreferredMachineId } from '@/components/settings/pickers/resolvePreferredMachineId';
import { useAgentModelChoices } from '@/components/settings/pickers/useAgentModelChoices';
import { encodeScmDiffSummaryModelOverride } from '@/settings/scmDiffSummary/settings';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { useActiveMachineFacts } from '@/sync/store/hooks';
import { t } from '@/text';
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
  const machines = useActiveMachineFacts();
  const scope = useActiveServerAccountScope();
  const reachabilityRevision = useMachineReachabilityRevision();
  const recentMachinePaths = useAuthoringMemoryField('recentMachinePaths');
  const [openMenu, setOpenMenu] = React.useState<null | 'backend' | 'model'>(null);
  const [customModelDraft, setCustomModelDraft] = React.useState<string | null>(null);

  const modelId = normalizeNonEmptyString(props.value?.modelSelection.modelId) ?? 'default';
  const preflightMachineId = React.useMemo(() => {
    return resolvePreferredMachineId({
      machines,
      scope,
      recentMachinePaths: Array.isArray(recentMachinePaths) ? recentMachinePaths : [],
    });
  }, [machines, recentMachinePaths, scope, reachabilityRevision]);
  const choices = useAgentModelChoices({ purpose: 'runner',
    value: props.value ? encodeScmDiffSummaryModelOverride({ backendTargetKey: props.value.modelSelection.agentTargetKey, modelId }) : '',
    machineId: preflightMachineId, serverId: scope?.serverId });
  const backendEntries = choices.groups.map(group => group.entry);
  const selectedGroup = choices.groups.find(group => group.targetKey === props.value?.modelSelection.agentTargetKey) ?? null;
  const selectedBackendEntry = selectedGroup?.entry ?? null;
  React.useEffect(() => choices.setOpen(openMenu !== null), [openMenu, choices.setOpen]);
  const writeModel = (targetKey: string, nextModelId: string) => props.onChange(LlmTaskRunnerConfigV1WriteSchema.parse({
    v: 1, modelSelection: { agentTargetKey: targetKey, providerConnectionId: null, modelId: nextModelId }, permissionMode: 'no_tools',
  }));

  const backendMenuItems = React.useMemo(() => {
    return choices.groups.map(({ entry, selectable }) => {
      const displayAgentId = entry.iconAgentId ?? entry.catalogAgentId ?? entry.builtInAgentId;
      const iconName = getAgentCore(displayAgentId ?? '')?.ui?.agentPickerIconName ?? NEUTRAL_AGENT_ICON_NAME;
      return {
        id: entry.backendTargetKey,
        title: entry.title,
        subtitle: entry.subtitle ?? undefined,
        disabled: !selectable,
        icon: <Icon name={iconName as any} size={20} color={theme.colors.text.secondary} />,
      };
    });
  }, [choices.groups, theme.colors.text.secondary]);

  const selectableModelMenuItems = selectedGroup ? choices.items.flatMap(item => {
    const profile = selectedGroup.offered.find(profile => profile.catalogId === item.id);
    if (profile?.modelSelector)
      return [{ ...item, id: profile.modelSelector.modelId }];
    if (choices.customModelTargets.get(item.id) === selectedGroup.targetKey) return [{ ...item, id: '__custom__' }];
    return choices.discoveryTargets.get(item.id) === selectedGroup.targetKey ? [item] : [];
  }) : [];

  const modelMenuItems = selectableModelMenuItems;

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
  const selectedBackendKey = props.value?.modelSelection.agentTargetKey ?? null;
  React.useEffect(() => setCustomModelDraft(null), [selectedBackendKey, props.value?.modelSelection.modelId]);
  const customModelTestID = `${props.modelTestID ?? 'llm-task-runner-model'}.custom`;
  const saveCustomModel = () => {
    if (customModelDraft === null || !selectedBackendEntry || !selectedGroup?.selectable) return;
    writeModel(selectedGroup!.targetKey, customModelDraft.trim() || 'default');
    setCustomModelDraft(null);
  };

  // Without labels the two selects are rows of the caller's section: no wrapper, a divider between them.
  const Wrapper = showLabels ? LabelledPickerStack : React.Fragment;
  return (
    <>
      <Wrapper>
        {showLabels ? (
          <Text style={{ ...Typography.variant('meta', 'medium'),  color: theme.colors.text.secondary }}>
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
          if (choices.groups.find(group => group.targetKey === targetKey)?.selectable === false) return;
          if (!nextBackendEntry) {
            props.onChange(null);
            setOpenMenu(null);
            return;
          }
          writeModel(nextBackendEntry.backendTargetKey, 'default');
          setOpenMenu(null);
        }}
      />

      {showLabels ? (
        <Text style={{ ...Typography.variant('meta', 'medium'),  color: theme.colors.text.secondary }}>
          {t('settingsSession.replayResume.summaryRunner.modelTitle')}
        </Text>
      ) : null}
      <DropdownMenu
        open={openMenu === 'model'}
        onOpenChange={(next) => setOpenMenu(next ? 'model' : null)}
        variant="selectable"
        search={true}
        searchPlaceholder={t('settingsSession.replayResume.summaryRunner.searchModelsPlaceholder')}
        emptyLabel={selectedGroup ? t('walkthroughSettings.noModels') : t('settingsSession.replayResume.summaryRunner.chooseBackendFirst')}
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
          if (selectedGroup?.selectable === false) return;
          if (!selectedBackendEntry) {
            props.onChange(null);
            setOpenMenu(null);
            return;
          }
          const discoveryTarget = choices.discoveryTargets.get(id);
          if (discoveryTarget) {
            choices.setDiscoveryTargetKey(discoveryTarget);
            if (discoveryTarget === choices.discoveryTargetKey) choices.onRefresh?.();
            return;
          }
          if (id === '__custom__') {
            setOpenMenu(null);
            setCustomModelDraft(modelId);
            return;
          }

          const nextModelId = String(id ?? '').trim();
          if (!nextModelId) return;
          writeModel(selectedGroup!.targetKey, nextModelId);
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
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: theme.space.s8 }}>
              <RoundButton testID={`${customModelTestID}.cancel`} size="small" display="secondary" title={t('common.cancel')} onPress={() => setCustomModelDraft(null)} />
              <RoundButton testID={`${customModelTestID}.save`} size="small" title={t('common.save')} disabled={!selectedGroup?.selectable} onPress={saveCustomModel} />
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
