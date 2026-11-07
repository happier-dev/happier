import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { FieldSelect } from '@/components/workflows/triggers/TriggerPopover';
import { useMachineDisplayNamesById } from '@/sync/store/hooks';
import { t } from '@/text';
import { unnamedMachineName } from '@/utils/sessions/machineDisplayNames';

import type {
  HealthNoticeInvestigationOutcome,
  HealthNoticeInvestigationPlacement,
} from './healthNoticeInvestigation';

type PlacementChoice = Extract<
  HealthNoticeInvestigationOutcome,
  { kind: 'placement_choice_required' }
>;

/**
 * Triage couldn't place the investigation on its own: the reachable Machines and folders it found, and
 * the agent, chosen here with one confirm. Offline candidates stay listed so the person sees why.
 */
export function InvestigationPlacementChooser(
  props: Readonly<{
    choice: PlacementChoice;
    pending: boolean;
    onChoose: (placement: HealthNoticeInvestigationPlacement) => void;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const { candidates, agents, reason } = props.choice;
  const machineIds = React.useMemo(
    () => candidates.map((candidate) => candidate.machine.machineId),
    [candidates],
  );
  const names = useMachineDisplayNamesById(machineIds);
  const firstReachable = candidates.findIndex(
    (candidate) => candidate.reachable,
  );
  const [picked, setPicked] = React.useState(firstReachable);
  const [agent, setAgent] = React.useState(agents[0]?.targetKey ?? null);
  const candidate = picked >= 0 ? candidates[picked] : undefined;
  const ready =
    (candidates.length === 0 || candidate !== undefined) &&
    (agents.length === 0 || agent !== null);
  const confirm = () =>
    props.onChoose({
      ...(candidate ? { machine: candidate.machine } : {}),
      ...(candidate?.workspace ? { workspace: candidate.workspace } : {}),
      ...(agent ? { agentTargetKey: agent } : {}),
    });
  return (
    <ItemGroup
      testID={props.testID}
      title={t('inbox.work.healthNotice.placementTitle')}
      description={t(`inbox.work.healthNotice.placementReason.${reason}`)}
      accessibilityRole={candidates.length > 0 ? 'radiogroup' : undefined}
      action={
        <RoundButton
          testID={`${props.testID}.confirm`}
          size="small"
          title={t('inbox.work.healthNotice.placementConfirm')}
          disabled={!ready || props.pending}
          loading={props.pending}
          onPress={confirm}
        />
      }
    >
      {candidates.map((entry, index) => {
        const selected = index === picked;
        return (
          <Item
            key={`${entry.machine.machineId}:${entry.workspace?.workspaceId ?? ''}`}
            testID={`${props.testID}.candidate:${index}`}
            title={names[entry.machine.machineId] ?? unnamedMachineName()}
            subtitle={
              entry.reachable
                ? (entry.workspace?.rootPath ??
                  t('inbox.work.healthNotice.placementAnyFolder'))
                : t('inbox.work.healthNotice.placementOffline')
            }
            accessibilityRole="radio"
            webRole="radio"
            accessibilityChecked={selected}
            disabled={!entry.reachable}
            rightElement={
              selected ? (
                <Icon
                  name="check"
                  size={16}
                  color={theme.colors.text.primary}
                />
              ) : undefined
            }
            showChevron={false}
            onPress={() => setPicked(index)}
          />
        );
      })}
      {agents.length > 0 ? (
        <FieldSelect
          testID={`${props.testID}.agent`}
          title={t('inbox.work.healthNotice.placementAgent')}
          items={agents.map((entry) => ({
            id: entry.targetKey,
            title: entry.label,
            testID: `${props.testID}.agent:${entry.targetKey}`,
          }))}
          selectedId={agent}
          onSelect={(id) => setAgent(agents.find((entry) => entry.targetKey === id)?.targetKey ?? null)}
        />
      ) : null}
    </ItemGroup>
  );
}
