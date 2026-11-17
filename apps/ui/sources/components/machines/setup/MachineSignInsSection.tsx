import * as React from 'react';

import {
  useMachineCliSignIns,
  type MachineCliSignInRow,
} from '@/agents/machineAgents/signIn/useAgentSignIn';
import { MachineAgentMark } from '@/components/machines/agents/MachineAgentMark';
import { showAgentSignInTerminalSheet } from '@/components/machines/agents/AgentSignInTerminalSheet';
import { useAgentSignInTerminalHost } from '@/components/machines/agents/signInTerminalHost';
import { ConnectedServiceMark } from '@/components/settings/connectedServices/ConnectedServiceMark';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useMachineField } from '@/sync/store/hooks';
import { t } from '@/text';

import { confirmMachineSignInScope } from './machineSignInScope';

/** One row's state in words: the native sign-in owner's reported status, never a local guess. */
function describeSignIn(row: MachineCliSignInRow): string {
  if (row.signIn.phase === 'opening' || row.signIn.phase === 'waiting')
    return t('machineAgents.waitingForSignIn');
  const status = row.authentication;
  if (!status)
    return row.signIn.phase === 'failed'
      ? t('machineAgents.unknown')
      : t('machineAgents.checking');
  if (status.status === 'signedIn') {
    return status.accountLabel
      ? t('machineAgents.signedInAs', { label: status.accountLabel })
      : t('machineAgents.signedInHere');
  }
  // A CLI that only signs in through a connected account says so instead of asking for a login it can't run.
  if (status.nativeLogin === 'unsupported')
    return t('machinePresets.setup.tab.signInConnectedOnly');
  return status.status === 'signedOut'
    ? t('machineAgents.needsSignIn')
    : t('machineAgents.unknown');
}

function canStartNativeSignIn(row: MachineCliSignInRow): boolean {
  const status = row.authentication;
  return (
    status !== null &&
    status.status !== 'signedIn' &&
    status.nativeLogin === 'login_terminal' &&
    row.signIn.phase !== 'opening' &&
    row.signIn.phase !== 'waiting'
  );
}

/**
 * The Machine's own sign-ins (lab L10 row): every CLI that signs in on it, agents and declared tools (GitHub CLI,
 * 1Password CLI) in one list, read through the one machine sign-in owner (`machines.agents.signIn.*`). "Sign in…"
 * opens that owner's terminal sign-in, the same one the Agents tab uses. A connected account chosen for a CLI is
 * used instead of this login when the CLI runs; that choice belongs to Connected services.
 */
export const MachineSignInsSection = React.memo(function MachineSignInsSection(
  props: Readonly<{
    serverId: string;
    machineId: string;
    machineName: string;
    presented: boolean;
    editable: boolean;
  }>,
) {
  const signIns = useMachineCliSignIns({
    serverId: props.serverId,
    machineId: props.machineId,
    presented: props.presented,
  });
  const terminalHost = useAgentSignInTerminalHost();
  const hostUser = useMachineField(props.machineId, 'metadata', 'username', { serverId: props.serverId }) ?? null;
  const open = React.useCallback(
    async (row: MachineCliSignInRow) => {
      // A sign-in into an OS user other people's Sessions run as is theirs to use too: say so before it starts.
      const confirmed = await confirmMachineSignInScope({ scope: row.authentication?.signInScope,
        tool: row.title, machine: props.machineName, hostUser });
      if (!confirmed) return;
      const target = {
        serverId: props.serverId,
        machineId: props.machineId,
        machineName: props.machineName,
        agentId: row.id,
        agentTitle: row.title,
      };
      if (terminalHost) terminalHost.open(target);
      else showAgentSignInTerminalSheet(target);
    },
    [hostUser, props.machineId, props.machineName, props.serverId, terminalHost],
  );
  // Only CLIs whose sign-in the Machine could read: one it can't check (today: not installed there) belongs to the
  // Agents tab's install flow, not to a wall of "Couldn't check" rows here.
  const rows = React.useMemo(() => signIns.items.filter((row) => row.authentication !== null
    && (row.authentication.status !== 'unknown' || row.authentication.nativeLogin === 'unsupported')), [signIns.items]);
  if (rows.length === 0) return null;
  return (
    <ItemGroup
      testID="machine-setup-sign-ins"
      title={t('machinePresets.setup.tab.signInsTitle', {
        machine: props.machineName,
      })}
      description={t('machinePresets.setup.tab.signInsHelp', {
        machine: props.machineName,
      })}
    >
      {rows.map((row) => (
        <Item
          key={row.id}
          testID={`machine-setup-sign-in:${row.id}`}
          accessoryLayout="adaptive"
          icon={
            row.kind === 'agent' ? (
              <MachineAgentMark
                agentId={row.id}
                machineId={props.machineId}
                serverId={props.serverId}
              />
            ) : (
              <ConnectedServiceMark
                legacyServiceId={null}
                pluginId={row.id.split('/')[0] ?? null}
                size="title"
              />
            )
          }
          title={row.title}
          subtitle={describeSignIn(row)}
          showChevron={false}
          rightElement={
            props.editable && canStartNativeSignIn(row) ? (
              <RoundButton
                testID={`machine-setup-sign-in-start:${row.id}`}
                size="small"
                display="secondary"
                title={t('machinePresets.setup.tab.signInAction')}
                onPress={() => { void open(row); }}
              />
            ) : undefined
          }
        />
      ))}
    </ItemGroup>
  );
});
