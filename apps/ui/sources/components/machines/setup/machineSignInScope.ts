import { isSharedAgentSignInScope } from '@happier-dev/protocol/daemon/agentSignIn';
import type { MachineCliSignInAuthentication, ReviewNativeSignInLaunch } from '@/agents/machineAgents/signIn/useAgentSignIn';
import { Modal } from '@/modal';
import { t } from '@/text';

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
  if (!isSharedAgentSignInScope(scope)) return null;
  if (scope === 'machineOwner' && input.hostUser)
    return t('machinePresets.setup.tab.signInSharedUser', { user: input.hostUser, account });
  return t('machinePresets.setup.tab.signInSharedUserUnnamed', { account });
}

/**
 * The app's review of a prepared native sign-in, run by the one start sequence before anything launches. The daemon's
 * Prepare reports where the login lands; a shared OS user is confirmed first, the requester's own user starts at once.
 * `onLaunch` runs once the sign-in may start (the entry opens its terminal there, never before the confirm).
 */
export function reviewMachineSignInLaunch(
  input: Readonly<{
    tool: string;
    account: string;
    machine: string;
    hostUser: string | null | undefined;
    onLaunch?: () => void;
  }>,
): ReviewNativeSignInLaunch {
  return async ({ signInScope, confirmationRequired }) => {
    const warning = confirmationRequired
      ? describeMachineSignInScope({ scope: signInScope ?? null, account: input.account, hostUser: input.hostUser }) : null;
    if (warning) {
      const confirmed = await Modal.confirm(
        t('machinePresets.setup.tab.signInConfirmTitle', { machine: input.machine, tool: input.tool }),
        warning,
        { confirmText: t('machinePresets.setup.tab.signInConfirmCta') },
      );
      if (!confirmed) return false;
    }
    input.onLaunch?.();
    return true;
  };
}
