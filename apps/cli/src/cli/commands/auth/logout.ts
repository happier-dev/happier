import chalk from 'chalk';
import { existsSync, rmSync } from 'node:fs';

import { cmd, neutral, ok, warn } from '@happier-dev/cli-common/output';

import {
  clearCredentials,
  readStoredCredentials,
} from '@/persistence';
import { configuration } from '@/configuration';
import { isDaemonStopIncompleteError, stopDaemon } from '@/daemon/controlClient';
import { stopAllDaemonsBestEffort } from '@/daemon/multiDaemon';
import { clearActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { promptConfirmYesNo } from '@/terminal/prompts/promptConfirmYesNo';
import { clearServerScopedAuthState } from './clearServerScopedAuthState';

export async function handleAuthLogout(args: string[]): Promise<void> {
  const logoutAll = args.includes('--all');
  const happyDir = configuration.happyHomeDir;
  const targetServerId = configuration.activeServerId;

  if (!logoutAll) {
    const credentials = await readStoredCredentials();
    if (!credentials) {
      console.log(neutral('Not signed in'));
      return;
    }
  }

  if (logoutAll) {
    console.log(warn('This signs you out of Happier on all servers and removes local data'));
  } else {
    console.log(warn(`This signs you out of Happier for server ${targetServerId}`));
  }
  console.log(chalk.gray('  You will need to sign in again to use Happier.'));

  const confirmed = await promptConfirmYesNo(
    logoutAll ? 'Sign out everywhere and delete local data?' : 'Sign out?',
    { default: 'no' },
  );

  if (confirmed) {
    try {
      // Logout revokes this process's Account Settings incumbent even when a
      // best-effort daemon stop cannot complete. A later login publishes a
      // fresh lifecycle through the canonical snapshot owner.
      clearActiveAccountSettingsSnapshot();
      if (logoutAll) {
        await stopAllDaemonsBestEffort();
        if (existsSync(happyDir)) {
          rmSync(happyDir, { recursive: true, force: true });
        }
      } else {
        let daemonStopIncomplete: Error | null = null;
        try {
          const stopped = await stopDaemon();
          if (stopped.status === 'stopped') {
            console.log(ok('Stopped the daemon'));
          }
        } catch (error) {
          if (isDaemonStopIncompleteError(error)) {
            daemonStopIncomplete = error;
          } else {
            throw error;
          }
        }

        await clearCredentials();

        await clearServerScopedAuthState(targetServerId);

        // Credential removal is still authoritative for this CLI process, but
        // do not claim logout succeeded while a verified daemon may retain its
        // separate process-local Account custody.
        if (daemonStopIncomplete) throw daemonStopIncomplete;
      }

      console.log(ok('Signed out'));
      console.log(chalk.gray(`  Run ${cmd('happier auth login')} to sign in again.`));
    } catch (error) {
      if (isDaemonStopIncompleteError(error)) throw error;
      throw new Error(`Failed to logout: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    return;
  }

  console.log(neutral('Sign-out cancelled'));
}
