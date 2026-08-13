import chalk from 'chalk';
import os from 'node:os';

import { validateStoredAuthTokenAgainstActiveServer } from '@/auth/validateStoredAuthTokenAgainstActiveServer';
import { readCredentials, readSettings } from '@/persistence';
import { configuration } from '@/configuration';
import { checkIfDaemonRunningAndCleanupStaleState } from '@/daemon/controlClient';
import { printJsonEnvelope, wantsJson } from '@/cli/output/jsonEnvelope';
import { applyServerSelectionFromArgs } from '@/server/serverSelection';

export async function handleAuthStatus(argv: string[] = []): Promise<void> {
  const args = await applyServerSelectionFromArgs(argv);
  const json = wantsJson(args);
  const credentials = await readCredentials();
  const settings = await readSettings();

  if (json && !credentials) {
    await printJsonEnvelope({ ok: false, kind: 'auth_status', error: { code: 'not_authenticated' } });
    return;
  }

  if (!json) {
    console.log(chalk.bold('\nAuthentication Status\n'));
  }

  if (!credentials) {
    console.log(chalk.red('✗ Not authenticated'));
    console.log(chalk.gray('  Run "happier auth login" to authenticate'));
    return;
  }

  const authValidation = await validateStoredAuthTokenAgainstActiveServer(credentials.token);
  if (authValidation.state === 'invalid') {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'auth_status', error: { code: 'not_authenticated' } });
      return;
    }

    console.log(chalk.red('✗ Not authenticated'));
    console.log(chalk.gray('  Stored credentials were rejected by the selected relay'));
    console.log(chalk.gray('  Run "happier auth login --force" to authenticate again'));
    return;
  }

  const machineId = settings?.machineId;
  const machineRegistered = typeof machineId === 'string' && machineId.trim().length > 0;

  let daemonRunning = false;
  try {
    daemonRunning = await checkIfDaemonRunningAndCleanupStaleState();
  } catch {
    daemonRunning = false;
  }

  if (json) {
    await printJsonEnvelope({
      ok: true,
      kind: 'auth_status',
      data: {
        authenticated: true,
        encryption: { type: credentials.encryption.type },
        machineRegistered,
        ...(machineRegistered ? { machineId: machineId!.trim() } : {}),
        host: os.hostname(),
        happyHomeDir: configuration.happyHomeDir,
        daemonRunning,
      },
    });
    return;
  }

  console.log(chalk.green('✓ Authenticated'));

  if (machineRegistered) {
    console.log(chalk.green('✓ Machine registered'));
    console.log(chalk.gray(`  Machine ID: ${machineId!.trim()}`));
    console.log(chalk.gray(`  Host: ${os.hostname()}`));
  } else {
    console.log(chalk.yellow('⚠️  Machine not registered'));
    console.log(chalk.gray('  Run "happier auth login --force" to fix this'));
  }

  console.log(chalk.gray(`\n  Data directory: ${configuration.happyHomeDir}`));

  if (daemonRunning) {
    console.log(chalk.green('✓ Daemon running'));
  } else {
    console.log(chalk.gray('✗ Daemon not running'));
  }
}
