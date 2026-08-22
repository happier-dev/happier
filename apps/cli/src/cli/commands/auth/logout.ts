import chalk from 'chalk';
import { existsSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';

import {
  clearCredentials,
  readStoredCredentials,
  updateSettings,
} from '@/persistence';
import { configuration } from '@/configuration';
import { isDaemonStopIncompleteError, stopDaemon } from '@/daemon/controlClient';
import { stopAllDaemonsBestEffort } from '@/daemon/multiDaemon';
import { clearActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { clearServerScopedAuthStateInSettings } from './clearServerScopedAuthState';

export async function handleAuthLogout(args: string[]): Promise<void> {
  const logoutAll = args.includes('--all');
  const happyDir = configuration.happyHomeDir;
  const targetServerId = configuration.activeServerId;

  if (!logoutAll) {
    const credentials = await readStoredCredentials();
    if (!credentials) {
      console.log(chalk.yellow('Not currently authenticated'));
      return;
    }
  }

  if (logoutAll) {
    console.log(chalk.blue('This will log you out of Happier on all servers and remove local data'));
  } else {
    console.log(chalk.blue(`This will log you out of Happier for server: ${targetServerId}`));
  }
  console.log(chalk.yellow('⚠️  You will need to re-authenticate to use Happier again'));

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise<string>((resolve) => {
    rl.question(
      chalk.yellow(logoutAll
        ? 'Are you sure you want to log out everywhere and delete local data? (y/N): '
        : 'Are you sure you want to log out? (y/N): '),
      resolve,
    );
  });

  rl.close();

  if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
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
            console.log(chalk.gray('Stopped daemon'));
          }
        } catch (error) {
          if (isDaemonStopIncompleteError(error)) {
            daemonStopIncomplete = error;
          } else {
            throw error;
          }
        }

        await clearCredentials();

        await updateSettings((settings) => {
          return clearServerScopedAuthStateInSettings(settings, targetServerId);
        });

        // Credential removal is still authoritative for this CLI process, but
        // do not claim logout succeeded while a verified daemon may retain its
        // separate process-local Account custody.
        if (daemonStopIncomplete) throw daemonStopIncomplete;
      }

      console.log(chalk.green('✓ Successfully logged out'));
      console.log(chalk.gray('  Run "happier auth login" to authenticate again'));
    } catch (error) {
      if (isDaemonStopIncompleteError(error)) throw error;
      throw new Error(`Failed to logout: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    return;
  }

  console.log(chalk.blue('Logout cancelled'));
}
