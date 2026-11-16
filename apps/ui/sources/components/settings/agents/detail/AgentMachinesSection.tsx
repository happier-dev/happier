import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import type { MachineAgent } from '@/agents/machineAgents/machineAgentTypes';
import { buildMachineAgentInventoryKey } from '@happier-dev/protocol/capabilities';
import { useMachineAgentsByMachine, useRefreshMachineAgents } from '@/agents/machineAgents/useMachineAgents';
import {
  CapabilityMachineTruth,
  type CapabilityMachineTruthRow,
} from '@/components/capabilities/detail/CapabilityMachineTruth';
import { AgentSetupForm } from '@/components/machines/agents/AgentSetupForm';
import { MachineAgentStatusLine } from '@/components/machines/agents/MachineAgentStatusLine';
import { formatMachineAgentLastKnown } from '@/components/machines/agents/machineAgentCopy';
import { canPerformMachineAgentAction } from '@/components/machines/agents/machineAgentPresentation';
import { canManageMachine } from '@/sync/domains/machines/canManageMachine';
import { useServerScopedMachine } from '@/sync/store/hooks';
import { useMachineAgentRowActions } from '@/components/machines/agents/useMachineAgentRowActions';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { MachineAdministrationTargetSelectionV1 } from '@/sync/domains/machines/administration/useTargetSelection';
import { t } from '@/text';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

import { AgentMachineActionButtons } from './AgentMachineActionButtons';
import {
  buildAgentMachineRows,
  countAgentMachineRowsToShow,
  listAgentMachines,
  type AgentMachineAction,
  type AgentMachineRow,
  type AgentMachinesMachine,
} from './agentMachinesModel';

/**
 * "On your machines" (P9 F9, PD7): the agent on every machine of the Account at once, each with its
 * version, one status and its own Install / Update / Remove / Sign in. A row opens in place into that
 * machine's setup rows (CLI source, sign-in) and becomes the machine the page's machine-dependent
 * sections read. One grammar for built-in and registry agents.
 */
export function AgentMachinesSection(
  props: Readonly<{
    agentTitle: string;
    /** The inventory id: the agent's own id, or `custom-acp` for a definition. */
    agentId: string;
    definitionId?: string;
    /** A registry definition's chosen version: an install at another version offers Update. */
    pinnedVersion: string | null;
    /** The Account's server; machines of other servers belong to their own Account's page. */
    serverId: string;
    targetSelection: MachineAdministrationTargetSelectionV1;
    /** Open on arrival (a recovery link that sent the person here to install on that machine). */
    initialExpandedMachineId?: string | null;
    testID: string;
  }>,
) {
  const { targetSelection, serverId } = props;
  const pickerRows = React.useMemo(
    () =>
      targetSelection.pickerRows.filter(
        // Revoked and replaced machines are no longer the Account's; only live members are listed.
        (row) =>
          serverId !== null &&
          areServerProfileIdentifiersEquivalent(row.serverId, serverId) &&
          (row.candidate.availability === 'online' ||
            row.candidate.availability === 'offline'),
      ),
    [serverId, targetSelection.pickerRows],
  );
  const machines = React.useMemo(() => listAgentMachines(pickerRows), [pickerRows]);
  const machineIds = React.useMemo(
    () => machines.map((machine) => machine.machineId),
    [machines],
  );
  // The one retry entry for a machine whose check failed: the inventory owner's forced refresh of that machine.
  const refreshMachine = useRefreshMachineAgents(serverId);
  const snapshots = useMachineAgentsByMachine({
    serverId,
    machineIds,
    load: true,
  });
  const agentKey = buildMachineAgentInventoryKey({
    agentId: props.agentId,
    definitionId: props.definitionId,
  });
  const rows = React.useMemo(
    () =>
      buildAgentMachineRows({
        machines,
        agentsByMachineId: new Map(
          machines.map((machine) => [
            machine.machineId,
            snapshots
              .get(machine.machineId)
              ?.agents.find(
                (agent) => buildMachineAgentInventoryKey(agent) === agentKey,
              ) ?? null,
          ]),
        ),
        inventoryStatusByMachineId: new Map(machines.map(machine => [
          machine.machineId, snapshots.get(machine.machineId)?.status ?? 'loading',
        ])),
        pinnedVersion: props.pinnedVersion,
      }),
    [agentKey, machines, props.pinnedVersion, snapshots],
  );

  // The open row is also the machine the page manages (External sessions, plugin settings read it).
  const selectedMachineId = targetSelection.selectedTarget?.machineId ?? null;
  const [expandedMachineId, setExpandedMachineId] = React.useState<
    string | null
  >(props.initialExpandedMachineId ?? null);
  // Route selection may settle after this section mounts. Apply that arrival once;
  // unchanged route props must still let the person collapse or open another row.
  React.useEffect(() => {
    if (props.initialExpandedMachineId) setExpandedMachineId(props.initialExpandedMachineId);
  }, [props.initialExpandedMachineId]);
  const selectTarget = targetSelection.selectTarget;
  const onExpandedMachineChange = React.useCallback(
    (machineId: string | null) => {
      setExpandedMachineId(machineId);
      if (!machineId || machineId === selectedMachineId) return;
      const row = pickerRows.find(
        (candidate) => candidate.machine.id === machineId,
      );
      if (row) selectTarget(row.candidate.target);
    },
    [pickerRows, selectTarget, selectedMachineId],
  );

  // One cause says itself once: when several machines could not be checked, the section offers one Try again
  // for them and the rows keep only their status, instead of a wall of identical buttons.
  const failedMachineIds = rows
    .filter((row) => row.actions.some((action) => action.kind === 'checkAgain'))
    .map((row) => row.machine.machineId);
  const retryTogether = failedMachineIds.length > 1;
  const retryAll = React.useCallback(() => {
    for (const machineId of failedMachineIds) void refreshMachine(machineId);
  }, [failedMachineIds, refreshMachine]);

  const truthRows = rows.map((sourceRow): CapabilityMachineTruthRow => {
    // An open row's form is its sign-in, so the row's own Sign in would only repeat it.
    const open = sourceRow.machine.machineId === expandedMachineId;
    const row = retryTogether || open
      ? { ...sourceRow, actions: sourceRow.actions.filter((action) =>
          !(retryTogether && action.kind === 'checkAgain') && !(open && action.kind === 'signIn')) }
      : sourceRow;
    return {
      machineId: row.machine.machineId,
      machineName: row.machine.name,
      namePending: row.machine.namePending,
      deviceIcon: 'desktop',
      ...(row.machine.os ? { os: row.machine.os } : {}),
      who: (
        <AgentMachineWho
          row={row}
          testID={`${props.testID}:machine:${row.machine.machineId}:who`}
        />
      ),
      offline: !row.machine.online,
      ...(row.actions.length > 0
        ? {
            actions: (
              <AgentMachineRowActions
                serverId={serverId}
                machine={row.machine}
                agent={row.agent}
                actions={row.actions}
                onOpenForm={() => onExpandedMachineChange(row.machine.machineId)}
                onCheckAgain={() => {
                  void refreshMachine(row.machine.machineId);
                }}
                testID={`${props.testID}:machine:${row.machine.machineId}`}
              />
            ),
          }
        : {}),
      ...(row.expandable
        ? {
            detail: (
              <AgentSetupForm
                testID={`${props.testID}:machine:${row.machine.machineId}:setup`}
                serverId={serverId}
                machineId={row.machine.machineId}
                machineName={row.machine.sentenceName}
                agentId={props.agentId}
                {...(props.definitionId
                  ? { definitionId: props.definitionId }
                  : {})}
                layout="full"
              />
            ),
          }
        : {}),
    };
  });

  // An agent no machine knows (no CLI to install, e.g. an auxiliary-only Agent) has nothing per machine.
  const knownNowhere =
    rows.every((row) => row.agent === null) &&
    machines.some(
      (machine) => snapshots.get(machine.machineId)?.status === 'ready',
    ) &&
    machines.every(
      (machine) => {
        const status = snapshots.get(machine.machineId)?.status;
        return status === 'ready' || status === 'offline';
      },
    );
  if (knownNowhere) return null;

  return (
    <CapabilityMachineTruth
      testID={props.testID}
      presentation="list"
      visibleCount={Math.min(8, countAgentMachineRowsToShow(rows))}
      description={t('settingsAgents.detailPage.machinesDescription', {
        agent: props.agentTitle,
      })}
      rows={truthRows}
      {...(retryTogether
        ? { sectionAction: { label: t('machineAgents.actionRetry'), onPress: retryAll } }
        : {})}
      summary=""
      expandedMachineId={expandedMachineId}
      onExpandedMachineChange={onExpandedMachineChange}
    />
  );
}

/** Version, then the one status line; an install made outside Happier says so instead of offering Remove. */
function AgentMachineWho(
  props: Readonly<{ row: AgentMachineRow; testID: string }>,
) {
  const { row } = props;
  const lastKnown = row.status.kind === 'offline' ? formatMachineAgentLastKnown(row.status) : null;
  return (
    <View style={styles.who} testID={props.testID}>
      {row.version ? <Text style={styles.version}>{row.version}</Text> : null}
      {/* An offline machine sits behind the section's one offline row: it keeps only what it last reported. */}
      {row.status.kind === 'offline' ? (
        lastKnown ? <Text style={styles.quiet} numberOfLines={1}>{lastKnown}</Text> : null
      ) : (
        <View style={styles.status}>
          <MachineAgentStatusLine status={row.status} />
        </View>
      )}
      {row.installedOutsideHappier ? (
        <Text
          style={styles.quiet}
          numberOfLines={1}
        >{`· ${t('settingsAgents.detailPage.installedOutsideHappier')}`}</Text>
      ) : null}
    </View>
  );
}

/** A machine row's operations: Try again asks that machine again; the rest run through the one machine-agent action owner. */
function AgentMachineRowActions(
  props: Readonly<{
    serverId: string;
    machine: AgentMachinesMachine;
    agent: MachineAgent | null;
    actions: readonly AgentMachineAction[];
    onOpenForm: () => void;
    onCheckAgain: () => void;
    testID: string;
  }>,
) {
  const { agent, onOpenForm, onCheckAgain } = props;
  const canManage = useServerScopedMachine(props.serverId, props.machine.machineId, canManageMachine);
  const actions = props.actions.filter(action => action.kind === 'checkAgain'
    || (agent !== null && canPerformMachineAgentAction(agent, action.kind, canManage)));
  const run = useMachineAgentRowActions({
    serverId: props.serverId,
    machineId: props.machine.machineId,
    machineName: props.machine.sentenceName,
    onOpenForm,
  });
  const onAction = React.useCallback(
    (action: AgentMachineAction) => {
      if (action.kind === 'checkAgain') onCheckAgain();
      else if (agent) run(agent, action);
    },
    [agent, onCheckAgain, run],
  );
  return (
    <AgentMachineActionButtons
      actions={actions}
      machineName={props.machine.sentenceName}
      onAction={onAction}
      testID={props.testID}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  who: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    minWidth: 0,
  },
  status: { flexShrink: 1, minWidth: 0 },
  version: {
    ...Typography.mono(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  quiet: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.tertiary,
    flexShrink: 1,
  },
}));
