import type { AgentSignInStatusResponse } from '@happier-dev/protocol/daemon/agentSignIn';

import { Modal } from '@/modal';
import { t } from '@/text';

type SignInScope = AgentSignInStatusResponse['signInScope'];

/**
 * What signing in on a shared OS user means, in words (owner ruling Q5, SECURITY-REVIEW S4): a login made where
 * other people's Sessions run is theirs to use too. `member` signs in the requester's own OS user, so it says
 * nothing; an unreported scope says nothing either (the daemon decides, the UI only words its answer).
 */
export function describeMachineSignInScope(
  input: Readonly<{
    scope: SignInScope;
    tool: string;
    /** The Machine's own OS user, when the scope is that user and the Machine published its name. */
    hostUser: string | null;
  }>,
): string | null {
  if (input.scope === 'machineOwner') {
    return input.hostUser
      ? t('machinePresets.setup.tab.signInSharedUser', {
          user: input.hostUser,
          tool: input.tool,
        })
      : t('machinePresets.setup.tab.signInSharedUserUnnamed', {
          tool: input.tool,
        });
  }
  if (input.scope === 'sharedAgent')
    return t('machinePresets.setup.tab.signInSharedUserUnnamed', {
      tool: input.tool,
    });
  return null;
}

/** The confirm step before a shared-user sign-in starts; a sign-in into the requester's own user starts at once. */
export async function confirmMachineSignInScope(
  input: Readonly<{
    scope: SignInScope;
    tool: string;
    machine: string;
    hostUser: string | null;
  }>,
): Promise<boolean> {
  const warning = describeMachineSignInScope(input);
  if (!warning) return true;
  return Modal.confirm(
    t('machinePresets.setup.tab.signInConfirmTitle', {
      machine: input.machine,
      tool: input.tool,
    }),
    warning,
    { confirmText: t('machinePresets.setup.tab.signInConfirmCta') },
  );
}
