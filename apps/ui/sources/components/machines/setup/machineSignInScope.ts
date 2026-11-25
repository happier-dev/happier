import type { MachineCliSignInAuthentication, MachineCliSignInRow } from '@/agents/machineAgents/signIn/useAgentSignIn';
import { Modal } from '@/modal';
import { t } from '@/text';

type SignInTarget = Pick<MachineCliSignInRow, 'title' | 'authentication'>;

/**
 * What signing in on a shared OS user means, in words (owner ruling Q5, SECURITY-REVIEW S4): a login made where
 * other people's Sessions run is theirs to use too. `member` signs in the requester's own OS user, so it says
 * nothing; an unreported scope says nothing either (the daemon decides, the UI only words its answer). The account
 * named is the service the CLI declares (GitHub for GitHub CLI), else the CLI itself.
 */
export function describeMachineSignInScope(
  input: Readonly<{
    scope: MachineCliSignInAuthentication['signInScope'] | null;
    account: string;
    /** The Machine's own OS user, when the scope is that user and the Machine published its name. */
    hostUser: string | null | undefined;
  }>,
): string | null {
  const { scope, account } = input;
  if (scope === 'machineOwner' && input.hostUser)
    return t('machinePresets.setup.tab.signInSharedUser', { user: input.hostUser, account });
  if (scope === 'machineOwner' || scope === 'sharedAgent')
    return t('machinePresets.setup.tab.signInSharedUserUnnamed', { account });
  return null;
}

/** The confirm step before a shared-user sign-in starts; a sign-in into the requester's own user starts at once. */
export async function confirmMachineSignInScope(
  input: Readonly<{
    row: SignInTarget;
    machine: string;
    hostUser: string | null;
  }>,
): Promise<boolean> {
  const warning = describeMachineSignInScope({ scope: input.row.authentication?.signInScope,
    account: input.row.authentication?.connectedServices[0]?.title ?? input.row.title, hostUser: input.hostUser });
  if (!warning) return true;
  return Modal.confirm(
    t('machinePresets.setup.tab.signInConfirmTitle', {
      machine: input.machine,
      tool: input.row.title,
    }),
    warning,
    { confirmText: t('machinePresets.setup.tab.signInConfirmCta') },
  );
}
