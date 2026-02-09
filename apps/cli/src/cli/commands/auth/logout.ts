import chalk from 'chalk';
import { existsSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';

import {
  clearCredentials,
  clearDaemonState,
  readCredentials,
  updateSettings,
} from '@/persistence';
import { configuration } from '@/configuration';
import { stopDaemon } from '@/daemon/controlClient';
import { stopAllDaemonsBestEffort } from '@/daemon/multiDaemon';

export async function handleAuthLogout(args: string[]): Promise<void> {
  const logoutAll = args.includes('--all');
  const happyDir = configuration.happyHomeDir;
  const targetServerId = configuration.activeServerId;

  if (!logoutAll) {
    const credentials = await readCredentials();
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
      if (logoutAll) {
        try {
          await stopAllDaemonsBestEffort();
        } catch {
          // best-effort
        }
        if (existsSync(happyDir)) {
          rmSync(happyDir, { recursive: true, force: true });
        }
      } else {
        try {
          await stopDaemon();
          console.log(chalk.gray('Stopped daemon'));
        } catch {
          // ignore
        }

        await clearCredentials();
        await clearDaemonState().catch(() => {});

        await updateSettings((settings) => {
          const nextMachineIds = { ...(settings.machineIdByServerId ?? {}) };
          const nextMachineConfirmed = { ...(settings.machineIdConfirmedByServerByServerId ?? {}) };
          const nextCursors = { ...(settings.lastChangesCursorByServerIdByAccountId ?? {}) };

          if (targetServerId in nextMachineIds) delete nextMachineIds[targetServerId];
          if (targetServerId in nextMachineConfirmed) delete nextMachineConfirmed[targetServerId];
          if (targetServerId in nextCursors) delete nextCursors[targetServerId];

          return {
            ...settings,
            machineIdByServerId: Object.keys(nextMachineIds).length ? nextMachineIds : {},
            machineIdConfirmedByServerByServerId: Object.keys(nextMachineConfirmed).length ? nextMachineConfirmed : {},
            lastChangesCursorByServerIdByAccountId: Object.keys(nextCursors).length ? nextCursors : {},
          };
        });
      }

      console.log(chalk.green('✓ Successfully logged out'));
      console.log(chalk.gray('  Run "happier auth login" to authenticate again'));
    } catch (error) {
      throw new Error(`Failed to logout: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    return;
  }

  console.log(chalk.blue('Logout cancelled'));
}
