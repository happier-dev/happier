import chalk from 'chalk';
import os from 'node:os';

import { clearCredentials, clearMachineId, readCredentials, readSettings } from '@/persistence';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { stopDaemon } from '@/daemon/controlClient';
import { logger } from '@/ui/logger';
import { applyServerSelectionFromArgs } from '@/server/serverSelection';
import { bullets, definitionList, errorFrame, ok, sectionTitle, warn } from '@happier-dev/cli-common/output';

import { resolveAuthMethodFlag } from './methodFlag';

export async function handleAuthLogin(args: string[]): Promise<void> {
  args = await applyServerSelectionFromArgs(args);

  const forceAuth = args.includes('--force') || args.includes('-f');
  const noOpen = args.includes('--no-open') || args.includes('--no-browser') || args.includes('--no-browser-open');
  const printConfigureLinks = args.includes('--print-configure-links');
  let method: 'web' | 'mobile' | null = null;
  try {
    method = resolveAuthMethodFlag(args);
  } catch (error) {
    console.error(errorFrame('Error:', [error instanceof Error ? error.message : 'Invalid --method flag']));
    process.exit(1);
  }
  if (method) process.env.HAPPIER_AUTH_METHOD = method;

  if (noOpen) {
    process.env.HAPPIER_NO_BROWSER_OPEN = '1';
  }

  if (printConfigureLinks) {
    process.env.HAPPIER_AUTH_PRINT_CONFIGURE_LINKS = '1';
  }

  if (forceAuth) {
    console.log(warn('Force authentication requested.'));
    console.log(sectionTitle('This will:'));
    console.log(bullets([
      'Clear existing credentials',
      'Clear machine ID',
      'Stop daemon if running',
      'Re-authenticate and register machine',
    ]));
    console.log('');

    try {
      logger.debug('Stopping daemon for force auth...');
      await stopDaemon();
      console.log(ok('Stopped daemon'));
    } catch (error) {
      logger.debug('Daemon was not running or failed to stop:', error);
    }

    await clearCredentials();
    console.log(ok('Cleared credentials'));

    await clearMachineId();
    console.log(ok('Cleared machine ID'));

    console.log('');
  }

  if (!forceAuth) {
    const existingCreds = await readCredentials();
    const settings = await readSettings();

    if (existingCreds && settings?.machineId) {
      console.log(ok('Already authenticated'));
      console.log(definitionList([
        { label: 'Machine ID', value: settings.machineId },
        { label: 'Host', value: os.hostname() },
      ], { indent: '  ' }));
      console.log('  Use \'happier auth login --force\' to re-authenticate');
      return;
    }

    if (existingCreds && !settings?.machineId) {
      console.log(warn('Credentials exist but machine ID is missing'));
      console.log(`  This can happen if --auth flag was used previously`);
      console.log(`  Fixing by setting up machine...\n`);
    }
  }

  try {
    const result = await authAndSetupMachineIfNeeded();
    console.log(`\n${ok('Authentication successful')}`);
    console.log(definitionList([
      { label: 'Machine ID', value: result.machineId },
    ], { indent: '  ' }));
  } catch (error) {
    console.error(errorFrame('Authentication failed:', [error instanceof Error ? error.message : 'Unknown error']));
    process.exit(1);
  }
}
