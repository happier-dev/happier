import chalk from 'chalk';
import { cmd, definitionList, errorFrame, fail, ok, warn } from '@happier-dev/cli-common/output';
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
    console.error(fail(`--wait-timeout needs a positive number of seconds, for example ${cmd('--wait-timeout 300')}.`));
    process.exit(1);
  }
  return seconds;
}

export async function handleAuthLogin(args: string[]): Promise<void> {
  args = await applyServerSelectionFromArgs(args);

  const callerIntent = args.includes('--no-daemon-start') ? 'setup-managed' : 'standalone';
  const forceAuth = args.includes('--force') || args.includes('-f');
  const noOpen = args.includes('--no-open') || args.includes('--no-browser') || args.includes('--no-browser-open');
  const printConfigureLinks = args.includes('--print-configure-links');
  const waitTimeoutSeconds = readWaitTimeoutSecondsFlag(args);
  let method: 'web' | 'mobile' | null = null;
  try {
    method = resolveAuthMethodFlag(args);
  } catch (error) {
    console.error(fail(error instanceof Error ? error.message : 'Invalid --method flag'));
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
    // Clarify which timeout applies: --wait-timeout is how long THIS terminal waits,
    // the approval link expiry (shown separately) is when the relay invalidates the link.
    console.log(chalk.gray(`This terminal will wait up to ${waitTimeoutSeconds} seconds for approval (--wait-timeout ${waitTimeoutSeconds}).`));
    console.log(chalk.gray('The approval link itself has a separate expiry (shown below).\n'));
  }

  if (forceAuth) {
    console.log(warn('Signing in again from scratch'));
    console.log(chalk.gray('  Clears the stored credentials and machine ID, stops the daemon, then signs in and registers this computer again.\n'));

    logger.debug('Stopping daemon for force auth...');
    const stopped = await stopDaemon();
    console.log(ok(stopped.status === 'stopped' ? 'Stopped the daemon' : 'No daemon was running'));

    await clearCredentials();
    console.log(ok('Cleared credentials'));

    await clearMachineId({ preserveReplacementCandidate: true, replacementReason: 'reauth' });
    console.log(ok('Cleared machine ID'));

    console.log('');
  }

  if (!forceAuth) {
    // Same readiness question `auth status` answers, asked through the same
    // owner: stored bytes alone cannot tell a usable sign-in from a rejected one.
    const readiness = await resolveActiveServerAuthReadiness();
    let existingCreds = readiness.credentials;

    if (readiness.unusableReason === 'credentials-rejected') {
      console.log(warn('The selected relay rejected the stored credentials'));
      console.log(chalk.gray('  Clearing them before signing in again.\n'));
      logger.debug('Stopping daemon before auth repair...');
      const stopped = await stopDaemon();
      console.log(ok(stopped.status === 'stopped' ? 'Stopped the daemon' : 'No daemon was running'));
      await clearCredentials();
      await clearMachineId({ preserveReplacementCandidate: true, replacementReason: 'reauth' });
      existingCreds = null;
    }

    if (existingCreds && readiness.credentialState === 'unknown') {
      console.log(warn('The selected relay did not answer, so the stored sign-in could not be verified'));
      console.log(chalk.gray('  Stored credentials were kept unchanged.'));
      if (readiness.machineRegistered && callerIntent === 'standalone') {
        console.log(chalk.gray('  Retry this command when the relay is available.'));
        return;
      }
      console.log(chalk.gray('  Machine registration will be retried with the stored credential.\n'));
    }

    if (
      existingCreds
      && readiness.credentialState === 'valid'
      && readiness.machineRegistered
      && callerIntent === 'standalone'
    ) {
      console.log(ok('Already signed in'));
      console.log(definitionList([
        { label: 'Machine ID', value: String(readiness.machineId) },
        { label: 'Host', value: os.hostname() },
      ], { indent: '  ' }));
      console.log(chalk.gray(`  Use ${cmd('happier auth login --force')} to sign in again.`));
      return;
    }

    if (existingCreds && !readiness.machineRegistered) {
      console.log(warn('Signed in, but this computer is not registered yet'));
      console.log(chalk.gray('  This can happen if the --auth flag was used previously. Registering it now.\n'));
    }

    if (!existingCreds && !method && isLoopbackServerHost(configuration.serverUrl)) {
      process.env.HAPPIER_AUTH_METHOD = 'web';
      console.log(warn(`The selected relay (${configuration.serverUrl}) is only reachable from this computer.`));
      console.log(chalk.gray("Using this computer's browser for the new sign-in request.\n"));
    }
  } else if (!method && isLoopbackServerHost(configuration.serverUrl)) {
    process.env.HAPPIER_AUTH_METHOD = 'web';
    console.log(warn(`The selected relay (${configuration.serverUrl}) is only reachable from this computer.`));
    console.log(chalk.gray("Using this computer's browser for the new sign-in request.\n"));
  }

  try {
    const result = await authAndSetupMachineIfNeeded({ callerIntent });
    console.log(ok('Signed in'));
    console.log(definitionList([{ label: 'Machine ID', value: result.machineId }], { indent: '  ' }));
    const backgroundServiceReady = await reconcileDefaultFollowingBackgroundServicesAfterAuthentication();
    if (!backgroundServiceReady && callerIntent === 'setup-managed') {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(errorFrame('Sign-in failed', [error instanceof Error ? error.message : 'Unknown error']));
    process.exit(1);
  }
}
