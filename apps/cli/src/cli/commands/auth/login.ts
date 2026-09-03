import chalk from 'chalk';
import os from 'node:os';

import { clearCredentials, clearMachineId } from '@/persistence';
import { resolveActiveServerAuthReadiness } from '@/auth/resolveActiveServerAuthReadiness';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { stopDaemon } from '@/daemon/controlClient';
import { logger } from '@/ui/logger';
import { applyServerSelectionFromArgs } from '@/server/serverSelection';
import { configuration } from '@/configuration';
import { isLoopbackServerHost } from '@/server/serverUrlClassification';
import { reconcileDefaultFollowingBackgroundServicesAfterAuthentication } from '../backgroundServiceFollowUp';

import { resolveAuthMethodFlag } from './methodFlag';

/**
 * `--wait-timeout <seconds>`: how long to keep this terminal waiting for the
 * sign-in to be approved.
 *
 * For callers that have to give the terminal back — `happier setup` runs this
 * command with inherited stdio — an unbounded wait is a terminal nobody can
 * reclaim. Omitted, the wait stays unbounded, which is right for someone sitting
 * in front of a QR code.
 */
function readWaitTimeoutSecondsFlag(args: readonly string[]): number | null {
  const index = args.indexOf('--wait-timeout');
  if (index < 0) return null;
  const raw = String(args[index + 1] ?? '').trim();
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    console.error(chalk.red('--wait-timeout needs a positive number of seconds, for example `--wait-timeout 300`.'));
    process.exit(1);
  }
  return seconds;
}

export async function handleAuthLogin(args: string[]): Promise<void> {
  args = await applyServerSelectionFromArgs(args);

  const forceAuth = args.includes('--force') || args.includes('-f');
  const noOpen = args.includes('--no-open') || args.includes('--no-browser') || args.includes('--no-browser-open');
  const printConfigureLinks = args.includes('--print-configure-links');
  const waitTimeoutSeconds = readWaitTimeoutSecondsFlag(args);
  let method: 'web' | 'mobile' | null = null;
  try {
    method = resolveAuthMethodFlag(args);
  } catch (error) {
    console.error(chalk.red(error instanceof Error ? error.message : 'Invalid --method flag'));
    process.exit(1);
  }
  if (method) process.env.HAPPIER_AUTH_METHOD = method;

  if (noOpen) {
    process.env.HAPPIER_NO_BROWSER_OPEN = '1';
  }

  if (printConfigureLinks) {
    process.env.HAPPIER_AUTH_PRINT_CONFIGURE_LINKS = '1';
  }

  if (waitTimeoutSeconds !== null) {
    process.env.HAPPIER_AUTH_WAIT_TIMEOUT_MS = String(waitTimeoutSeconds * 1000);
  }

  if (forceAuth) {
    console.log(chalk.yellow('Force authentication requested.'));
    console.log(chalk.gray('This will:'));
    console.log(chalk.gray('  • Clear existing credentials'));
    console.log(chalk.gray('  • Clear machine ID'));
    console.log(chalk.gray('  • Stop daemon if running'));
    console.log(chalk.gray('  • Re-authenticate and register machine\n'));

    try {
      logger.debug('Stopping daemon for force auth...');
      await stopDaemon();
      console.log(chalk.gray('✓ Stopped daemon'));
    } catch (error) {
      logger.debug('Daemon was not running or failed to stop:', error);
    }

    await clearCredentials();
    console.log(chalk.gray('✓ Cleared credentials'));

    await clearMachineId({ preserveReplacementCandidate: true, replacementReason: 'reauth' });
    console.log(chalk.gray('✓ Cleared machine ID'));

    console.log('');
  }

  if (!forceAuth) {
    // Same readiness question `auth status` answers, asked through the same
    // owner: stored bytes alone cannot tell a usable sign-in from a rejected one.
    const readiness = await resolveActiveServerAuthReadiness();
    let existingCreds = readiness.credentials;

    if (readiness.unusableReason === 'credentials-rejected') {
      console.log(chalk.yellow('⚠️  Stored credentials were rejected by the selected relay'));
      console.log(chalk.gray('  Repairing local authentication state before logging in again...\n'));
      try {
        logger.debug('Stopping daemon before auth repair...');
        await stopDaemon();
        console.log(chalk.gray('✓ Stopped daemon'));
      } catch (error) {
        logger.debug('Daemon was not running or failed to stop during auth repair:', error);
      }
      await clearCredentials();
      await clearMachineId({ preserveReplacementCandidate: true, replacementReason: 'reauth' });
      existingCreds = null;
    }

    if (existingCreds && readiness.credentialState === 'unknown') {
      console.log(chalk.yellow('⚠️  The selected relay did not answer, so the stored sign-in could not be verified'));
      console.log(chalk.gray('  Stored credentials were kept unchanged.'));
      if (readiness.machineRegistered) {
        console.log(chalk.gray('  Retry this command when the relay is available.'));
        return;
      }
      console.log(chalk.gray('  Machine registration will be retried with the stored credential.\n'));
    }

    if (existingCreds && readiness.credentialState === 'valid' && readiness.machineRegistered) {
      console.log(chalk.green('✓ Already authenticated'));
      console.log(chalk.gray(`  Machine ID: ${readiness.machineId}`));
      console.log(chalk.gray(`  Host: ${os.hostname()}`));
      console.log(chalk.gray(`  Use 'happier auth login --force' to re-authenticate`));
      return;
    }

    if (existingCreds && !readiness.machineRegistered) {
      console.log(chalk.yellow('⚠️  Credentials exist but machine ID is missing'));
      console.log(chalk.gray('  This can happen if --auth flag was used previously'));
      console.log(chalk.gray('  Fixing by setting up machine...\n'));
    }

    if (!existingCreds && !method && isLoopbackServerHost(configuration.serverUrl)) {
      process.env.HAPPIER_AUTH_METHOD = 'web';
      console.log(chalk.yellow(`The selected relay (${configuration.serverUrl}) is only reachable from this computer.`));
      console.log(chalk.gray("Using this computer's browser for the new sign-in request.\n"));
    }
  } else if (!method && isLoopbackServerHost(configuration.serverUrl)) {
    process.env.HAPPIER_AUTH_METHOD = 'web';
    console.log(chalk.yellow(`The selected relay (${configuration.serverUrl}) is only reachable from this computer.`));
    console.log(chalk.gray("Using this computer's browser for the new sign-in request.\n"));
  }

  try {
    const result = await authAndSetupMachineIfNeeded();
    console.log(chalk.green('\n✓ Authentication successful'));
    console.log(chalk.gray(`  Machine ID: ${result.machineId}`));
    await reconcileDefaultFollowingBackgroundServicesAfterAuthentication();
  } catch (error) {
    console.error(chalk.red('Authentication failed:'), error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}
