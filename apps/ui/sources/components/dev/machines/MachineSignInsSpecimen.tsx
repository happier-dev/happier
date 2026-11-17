import * as React from 'react';

import type { MachineCliSignInRow } from '@/agents/machineAgents/signIn/useAgentSignIn';
import { MachineSignInsList } from '@/components/machines/setup/MachineSignInsSection';
import { confirmMachineSignInScope } from '@/components/machines/setup/machineSignInScope';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import {
  useActiveServerAccountScope,
  useAllMachines,
} from '@/sync/domains/state/storage';

const IDLE = {
  phase: 'idle',
  terminalKey: null,
  authUrl: null,
  startedAtMs: null,
  failure: null,
} as const;
const row = (
  id: string,
  title: string,
  kind: MachineCliSignInRow['kind'],
  authentication: MachineCliSignInRow['authentication'],
): MachineCliSignInRow => ({ id, title, kind, authentication, signIn: IDLE });

/** The lab's devbox: two agents signed in, Gemini only through a connected account, GitHub CLI and 1Password CLI signed out. */
const ROWS: readonly MachineCliSignInRow[] = [
  row('claude', 'Claude', 'agent', {
    status: 'signedIn',
    accountLabel: 'leeroy@acme.dev',
    nativeLogin: 'login_terminal',
    connectedServices: [],
    signInScope: 'member',
  }),
  row('codex', 'Codex', 'agent', {
    status: 'signedIn',
    accountLabel: null,
    nativeLogin: 'login_terminal',
    connectedServices: [],
    signInScope: 'member',
  }),
  row('gemini', 'Gemini', 'agent', {
    status: 'unknown',
    nativeLogin: 'unsupported',
    connectedServices: [{ serviceId: 'google', title: 'Google' }],
  }),
  row('happier.scm.forge.github/gh', 'GitHub CLI', 'systemTool', {
    status: 'signedOut',
    nativeLogin: 'login_terminal',
    connectedServices: [
      { serviceId: 'happier.scm.forge.github/github-account', title: 'GitHub' },
    ],
    signInScope: 'machineOwner',
  }),
  row('happier.secret-source.onepassword/op', '1Password CLI', 'systemTool', {
    status: 'signedOut',
    nativeLogin: 'login_terminal',
    connectedServices: [],
    signInScope: 'member',
  }),
];

/**
 * Dev-only: the Setup tab's "Sign-ins on {machine}" (lab L10 row) through the real `MachineSignInsList`, and the
 * LOW-1 shared-OS-user warning through the real `confirmMachineSignInScope`. `?state=list|warning`. Signing in here
 * only opens the warning; nothing starts a CLI.
 */
export function MachineSignInsSpecimen(
  props: Readonly<{ state: 'list' | 'warning' }>,
) {
  const scope = useActiveServerAccountScope();
  const machineId =
    useAllMachines((machines) => machines[0]?.id ?? null) ?? 'devbox';
  const warn = React.useCallback((target: MachineCliSignInRow) => {
    void confirmMachineSignInScope({
      scope: target.authentication?.signInScope,
      tool: target.title,
      machine: 'devbox',
      hostUser: 'leeroy',
    });
  }, []);
  React.useEffect(() => {
    if (props.state === 'warning') warn(ROWS[3]!);
  }, [props.state, warn]);
  return (
    <ItemList>
      <PageHeader
        title="Machine sign-ins"
        description={`Specimen · ${props.state}`}
      />
      <MachineSignInsList
        serverId={scope?.serverId ?? ''}
        machineId={machineId}
        machineName="devbox"
        rows={ROWS}
        editable
        onSignIn={warn}
      />
    </ItemList>
  );
}
