import * as React from 'react';
import { MachineCreationContinuation, type MachineCreationContinuationDraft } from '@/components/machines/add/MachineCreationContinuation';
import { View } from 'react-native';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SessionMachineField } from '@/components/sessions/new/placement/SessionPlacementChips';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { deploymentSheetStyles, showDeploymentSheet } from './deploymentSheet';
import { DeploymentMachinesEmpty } from './DeploymentMachinesEmpty';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import type { CustomModalInjectedProps } from '@/modal/types';
import { useMachineListForServer } from '@/sync/store/hooks';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';

import {
  DeploymentRetentionChoice,
  type DeploymentRetentionChoiceValue,
} from './DeploymentRetentionChoice';
import type {
  DeploymentEnvironmentDeletionOutcome,
  DeploymentLinkMachine,
} from './useDeploymentEnvironmentDeletion';

export type DeploymentLinkMachineSheetInput = Readonly<{
  name: string;
  serverId: string;
  /** Preselected when it can host the Environment: it already runs the Environment's tasks. */
  suggestedMachineId: string | null;
  /** Links the chosen Machine through the page's target-membership hook. */
  run: (
    machine: DeploymentLinkMachine,
  ) => Promise<DeploymentEnvironmentDeletionOutcome>;
  /** A held approval continues on the page's one approval handle. */
  onApproval: (artifactId: string) => void;
}>;

/**
 * Link a machine (lab `servers/add`, first server): choose the Machine an undeployed Environment deploys to.
 * Linking starts nothing; the next Deploy builds and starts it there.
 */
function DeploymentLinkMachineSheet(
  props: DeploymentLinkMachineSheetInput & CustomModalInjectedProps,
) {
  const all = useMachineListForServer(props.serverId);
  // A target link names each Machine's installation; a Machine without one cannot be linked.
  const machines = React.useMemo(
    () =>
      (all ?? []).filter(
        (machine): machine is typeof machine & { installationId: string } =>
          Boolean(machine.installationId),
      ),
    [all],
  );
  const [creatingMachine, setCreatingMachine] = React.useState(false);
  const [machineCreationDraft, setMachineCreationDraft] = React.useState<MachineCreationContinuationDraft | null>(null);
  const [chosenId, setChosenId] = React.useState<string | null>(null);
  const chosen =
    chosenId !== null ? machines.find((machine) => machine.id === chosenId) ?? null :
    machines.find((machine) => machine.id === props.suggestedMachineId) ?? (machines.length === 1 ? machines[0] : null);
  const chosenName = chosen ? getMachineDisplayName(chosen, machines) : null;
  const [retention, setRetention] =
    React.useState<DeploymentRetentionChoiceValue>('alwaysOn');
  const [busy, setBusy] = React.useState(false);
  const [refused, setRefused] = React.useState<string | null>(null);
  const { onClose, onApproval, run } = props;
  const confirm = async () => {
    if (busy || !chosen) return;
    setBusy(true);
    setRefused(null);
    const outcome = await run({
      machineId: chosen.id,
      installationId: chosen.installationId,
      retention,
    });
    setBusy(false);
    if (outcome.kind === 'linked') {
      onClose();
      return;
    }
    if (outcome.kind === 'approval') {
      onClose();
      onApproval(outcome.artifactId);
      return;
    }
    if (outcome.kind === 'refused') setRefused(outcome.code);
  };
  const footer = (
    <ModalCardFooterActions cancel={{ onPress: onClose, testID: 'project-deployments.link.cancel', disabled: busy }}>
      <RoundButton
        testID="project-deployments.link.confirm"
        size="normal"
        loading={busy}
        disabled={busy || !chosen}
        title={
          chosenName
            ? t('projects.deployments.linkConfirm', { machine: chosenName })
            : t('projects.deployments.linkMachine')
        }
        onPress={() => {
          void confirm();
        }}
      />
    </ModalCardFooterActions>
  );
  const { setChrome } = props;
  React.useEffect(() => {
    setChrome?.({ kind: 'card', footer: creatingMachine ? null : footer });
  });
  React.useEffect(() => () => setChrome?.(null), [setChrome]);

  if (creatingMachine) return <MachineCreationContinuation serverId={props.serverId}
    testID="project-deployments.link.createMachine" draft={machineCreationDraft} onDraftChange={setMachineCreationDraft}
    onCancel={() => setCreatingMachine(false)}
    onArrived={({ machineId }) => { setChosenId(machineId); setCreatingMachine(false); }} />;

  return (
    <ListPresentationProvider value="page" pageInsets="contained">
      <View testID="project-deployments.link" style={deploymentSheetStyles.body}>
        <Text style={deploymentSheetStyles.lead}>
          {t('projects.deployments.linkLead', { name: props.name })}
        </Text>
        {machines.length === 0 && chosenId === null ? (
          <DeploymentMachinesEmpty serverId={props.serverId} testID="project-deployments.link" empty={
            <SurfaceStateCard
              testID="project-deployments.link.noMachine"
              size="line"
              kind="empty"
              title={t('projects.deployments.noMachineTitle')}
              reason={t('projects.deployments.noMachineBody')}
              action={{ label: t('managedMachines.add.createPath'), onPress: () => setCreatingMachine(true),
                testID: 'project-deployments.link.noMachine.create' }}
            />} />
        ) : (
          <ItemGroup header="none">
            <SessionMachineField
              testID="project-deployments.link.machine"
              serverId={props.serverId}
              machines={machines}
              machineId={chosenId ?? chosen?.id ?? null}
              machineName={t('approvals.machineNotKnown')}
              title={t('projects.deployments.machine')}
              awayMachinesChoosable
              onSelectMachine={(machine) => {
                setChosenId(machine.id);
                setRetention('alwaysOn');
                setRefused(null);
              }}
            />
            <DeploymentRetentionChoice
              testID="project-deployments.link.retention"
              serverId={props.serverId}
              machineId={chosen?.id ?? null}
              value={retention}
              onChange={setRetention}
            />
          </ItemGroup>
        )}
        {refused ? (
          <SurfaceStateCard
            testID="project-deployments.link.refused"
            size="line"
            kind="error"
            title={t('projects.deployments.linkRefused', {
              machine: chosenName ?? t('projects.deployments.aMachine'),
            })}
            diagnosticCode={refused}
          />
        ) : null}
        {/* Without card chrome (an embedding host), the footer ends the body. */}
        {setChrome ? null : footer}
      </View>
    </ListPresentationProvider>
  );
}

export function showDeploymentLinkMachineSheet(
  input: DeploymentLinkMachineSheetInput,
): void {
  showDeploymentSheet({
    component: DeploymentLinkMachineSheet,
    props: input,
    title: t('projects.deployments.linkTitle', { name: input.name }),
    testID: 'project-deployments.link.modal',
  });
}
