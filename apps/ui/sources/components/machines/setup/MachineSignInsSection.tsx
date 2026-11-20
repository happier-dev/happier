import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
  useMachineCliSignIns,
  type MachineCliConnectedLaunch,
  type MachineCliSignInRow,
} from '@/agents/machineAgents/signIn/useAgentSignIn';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { getStorage } from '@/sync/domains/state/storage';
import { MachineAgentMark } from '@/components/machines/agents/MachineAgentMark';
import { showAgentSignInTerminalSheet } from '@/components/machines/agents/AgentSignInTerminalSheet';
import { useAgentSignInTerminalHost } from '@/components/machines/agents/signInTerminalHost';
import { ConnectedServiceMark } from '@/components/settings/connectedServices/ConnectedServiceMark';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useMachineField, useSetting } from '@/sync/store/hooks';
import { t } from '@/text';

import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { presentConnectSheet } from '@/components/settings/connectedServices/setup/ConnectedServiceSetupModal';
import { resolveQualifiedConnectedAccountServiceKey } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { captureServerProfileScopeResolver } from '@/sync/domains/server/serverProfiles';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';

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

type ConnectedAccountRow = Readonly<{
  ref: Readonly<{ service: Readonly<{ pluginId: string; localId: string }>; accountId: string }>;
  status: string;
}>;

export type MachineSignInConnectedChoice =
  | Readonly<{ kind: 'set'; input: Readonly<{ purpose: MachineCliConnectedLaunch['purpose'];
      target: Readonly<{ kind: 'account'; account: ConnectedAccountRow['ref'] }> }> }>
  | Readonly<{ kind: 'connect' | 'choose'; service: MachineCliConnectedLaunch['service'] }>;

/**
 * What "Use connected account" does for one CLI (plan E U4): with one connected account for its service, or the
 * Account's default among several, it sets the Account default for the CLI's declared purpose
 * (`connectedServices.purposes.default.set`). With none it connects one; with several and no default, the
 * connected-services page lets the person choose. The launch owner then delivers that account to the process.
 */
export function resolveMachineSignInConnectedChoice(
  launch: MachineCliConnectedLaunch,
  accounts: readonly ConnectedAccountRow[],
  defaultAccountIdByServiceKey: Readonly<Record<string, string | undefined>>,
): MachineSignInConnectedChoice {
  const { service } = launch;
  const ready = accounts.filter(account => account.status === 'connected'
    && account.ref.service.pluginId === service.pluginId && account.ref.service.localId === service.localId);
  const preferred = ready.length === 1 ? ready[0]
    : ready.find(account => account.ref.accountId === defaultAccountIdByServiceKey[`${service.pluginId}/${service.localId}`]);
  if (preferred) return { kind: 'set', input: { purpose: launch.purpose, target: { kind: 'account', account: preferred.ref } } };
  return { kind: ready.length === 0 ? 'connect' : 'choose', service };
}

/**
 * The connected account this CLI accepts (plan E U4: "Use your GitHub connected account"), offered while the
 * CLI isn't already signed in through one. Choosing it goes to the connected-services owner; the launch then
 * delivers that account to the Session's process, never to the Machine's own login.
 */
function readConnectedChoice(row: MachineCliSignInRow): string | null {
  const status = row.authentication;
  // Only a CLI declaring a connected launch is chosen here; an Agent's connected account belongs to its own
  // sign-in chooser on the Agents tab, so its row offers only this Machine's sign-in.
  if (!row.connectedLaunch || !status || status.credentialSource === 'connectedAccount') return null;
  return status.connectedServices[0]?.serviceId ?? null;
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
  const execution = useMountedActionExecution(props.serverId);
  const router = useRouter();
  const hostUser = useMachineField(props.machineId, 'metadata', 'username', { serverId: props.serverId }) ?? null;
  const open = React.useCallback(
    async (row: MachineCliSignInRow) => {
      // A sign-in into an OS user other people's Sessions run as is theirs to use too: say so before it starts.
      const confirmed = await confirmMachineSignInScope({ row, machine: props.machineName, hostUser });
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
  const accounts = getStorage()((state) => state.profile.connectedAccountsV4);
  const defaultAccounts = useSetting('connectedServicesDefaultProfileByServiceId');
  const useConnected = React.useCallback((row: MachineCliSignInRow, serviceId: string) => {
    const choice = row.connectedLaunch ? resolveMachineSignInConnectedChoice(row.connectedLaunch, accounts, defaultAccounts) : null;
    if (choice?.kind === 'set') {
      fireAndForget((async () => {
        const result = await execution.execute('connectedServices.purposes.default.set', choice.input);
        if (!result.ok) throw createActionExecuteFailureError(result);
      })(), { tag: 'MachineSignIns.setConnectedDefault' });
      return;
    }
    if (choice?.kind === 'choose') {
      router.push(`${SETTINGS_ROUTES.connectedServices}/${encodeURIComponent(`${choice.service.pluginId}/${choice.service.localId}`)}` as never);
      return;
    }
    // Connecting an account is the connected-services owner's flow, started for this Machine.
    const serviceKey = resolveQualifiedConnectedAccountServiceKey(serviceId);
    const service = serviceKey ? parseQualifiedPluginContributionKey(serviceKey) : null;
    if (!service) return;
    fireAndForget(presentConnectSheet({
      scope: execution.binding?.scope ?? null,
      service,
      intent: 'link',
      initialMachineTarget: { serverIdentityId: captureServerProfileScopeResolver()(props.serverId), machineId: props.machineId },
    }), { tag: 'MachineSignIns.useConnected' });
  }, [accounts, defaultAccounts, execution, props.machineId, props.serverId, router]);
  // The owner lists only CLIs installed on this Machine (512b12e307d); each row says what the Machine reported.
  const rows = signIns.items;
  if (rows.length === 0) return null;
  return <MachineSignInsList serverId={props.serverId} machineId={props.machineId} machineName={props.machineName}
    rows={rows} editable={props.editable} onSignIn={(row) => { void open(row); }} onUseConnected={useConnected} />;
});

/** The rows themselves, drawn from the owner's reported rows; the section and its `/dev` specimen both mount it. */
export const MachineSignInsList = React.memo(function MachineSignInsList(
  props: Readonly<{
    serverId: string;
    machineId: string;
    machineName: string;
    rows: readonly MachineCliSignInRow[];
    editable: boolean;
    onSignIn: (row: MachineCliSignInRow) => void;
    onUseConnected: (row: MachineCliSignInRow, serviceId: string) => void;
  }>,
) {
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
      {props.rows.map((row) => (
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
            props.editable && (canStartNativeSignIn(row) || readConnectedChoice(row)) ? (
              // Natural width when the row stacks it under the words on a phone, not the row's full width.
              <View style={styles.action}>
                {readConnectedChoice(row) ? (
                  <RoundButton
                    testID={`machine-setup-sign-in-connected:${row.id}`}
                    size="small"
                    display="inverted"
                    title={t('machinePresets.setup.tab.signInConnected')}
                    onPress={() => props.onUseConnected(row, readConnectedChoice(row)!)}
                  />
                ) : null}
                {canStartNativeSignIn(row) ? <RoundButton
                  testID={`machine-setup-sign-in-start:${row.id}`}
                  size="small"
                  display="secondary"
                  title={t('machinePresets.setup.tab.signInAction')}
                  onPress={() => props.onSignIn(row)}
                /> : null}
              </View>
            ) : undefined
          }
        />
      ))}
    </ItemGroup>
  );
});

const styles = StyleSheet.create((theme) => ({
  action: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
}));
