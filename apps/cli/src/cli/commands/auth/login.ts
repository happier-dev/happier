import os from 'node:os';

import { validateStoredAuthTokenAgainstActiveServer } from '@/auth/validateStoredAuthTokenAgainstActiveServer';
import { clearCredentials, clearMachineId, readCredentials, readSettings } from '@/persistence';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { stopDaemon } from '@/daemon/controlClient';
import { logger } from '@/ui/logger';
import { applyServerSelectionFromArgs } from '@/server/serverSelection';
import { createOutputBuilder, definitionList, errorFrame, ok, warn } from '@happier-dev/cli-common/output';

import { showAuthHelp } from './help';
import { resolveAuthMethodFlag } from './methodFlag';

export async function handleAuthLogin(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    showAuthHelp();
    return;
  }

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
    const out = createOutputBuilder();
    out.line(warn('Force authentication requested.'));
    out.blank();
    out.section('This will:', (section) => {
      section.bullets([
        'Clear existing credentials',
        'Clear machine ID',
        'Stop daemon if running',
        'Re-authenticate and register machine',
      ]);
    });
    console.log(out.render());

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
    let existingCreds = await readCredentials();
    const settings = await readSettings();

    if (existingCreds) {
      const authValidation = await validateStoredAuthTokenAgainstActiveServer(existingCreds.token);
      if (authValidation.state === 'invalid') {
        const out = createOutputBuilder();
        out.line(warn('Stored credentials were rejected by the selected server'));
        out.line('  Repairing local authentication state before logging in again...');
        out.blank();
        console.log(out.render());

        try {
          logger.debug('Stopping daemon before auth repair...');
          await stopDaemon();
          console.log(ok('Stopped daemon'));
        } catch (error) {
          logger.debug('Daemon was not running or failed to stop during auth repair:', error);
        }

        await clearCredentials();
        await clearMachineId();
        existingCreds = null;
      }
    }

    if (existingCreds && settings?.machineId) {
      const out = createOutputBuilder();
      out.line(ok('Already authenticated'));
      out.definitionList([
        { label: 'Machine ID', value: settings.machineId },
        { label: 'Host', value: os.hostname() },
      ], { indent: '  ' });
      out.line('  Use \'happier auth login --force\' to re-authenticate');
      console.log(out.render());
      return;
    }

    if (existingCreds && !settings?.machineId) {
      const out = createOutputBuilder();
      out.line(warn('Credentials exist but machine ID is missing'));
      out.line(`  This can happen if --auth flag was used previously`);
      out.line(`  Fixing by setting up machine...`);
      out.blank();
      console.log(out.render());
    }
  }

  try {
    const result = await authAndSetupMachineIfNeeded();
    const out = createOutputBuilder();
    out.blank();
    out.line(ok('Authentication successful'));
    out.definitionList([
      { label: 'Machine ID', value: result.machineId },
    ], { indent: '  ' });
    console.log(out.render());
  } catch (error) {
    console.error(errorFrame('Authentication failed:', [error instanceof Error ? error.message : 'Unknown error']));
    process.exit(1);
  }
}
