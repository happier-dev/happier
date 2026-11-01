import os from 'node:os';

import { resolveActiveServerAuthReadiness } from '@/auth/resolveActiveServerAuthReadiness';
import { clearCredentials, clearMachineId, readStoredCredentials } from '@/persistence';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { isDaemonStopIncompleteError, stopDaemon } from '@/daemon/controlClient';
import { logger } from '@/ui/logger';
import { applyServerSelectionFromArgs } from '@/server/serverSelection';
import { createOutputBuilder, definitionList, errorFrame, ok, warn } from '@happier-dev/cli-common/output';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';

import { showAuthHelp } from './help';
import { resolveAuthMethodFlag } from './methodFlag';
import { projectSafeAuthError } from './errorDiagnostic';

function readWaitTimeoutSecondsFlag(args: readonly string[]): number | null {
  const index = args.indexOf('--wait-timeout');
  if (index < 0) return null;
  const raw = String(args[index + 1] ?? '').trim();
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    console.error(errorFrame('Invalid --wait-timeout', ['It needs a positive number of seconds, for example --wait-timeout 300.']));
    process.exit(1);
  }
  return seconds;
}

export async function handleAuthLogin(args: string[], signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (args.includes('--help') || args.includes('-h')) {
    showAuthHelp();
    return;
  }

  args = await applyServerSelectionFromArgs(args);

  const callerIntent = args.includes('--no-daemon-start') ? 'setup-managed' : 'standalone';
  const requireAccountMaterial = args.includes('--recover-account-material');
  const forceAuth = args.includes('--force') || args.includes('-f');
  const noOpen = args.includes('--no-open') || args.includes('--no-browser') || args.includes('--no-browser-open');
  const printConfigureLinks = args.includes('--print-configure-links');
  const waitTimeoutSeconds = readWaitTimeoutSecondsFlag(args);
  let method: 'web' | 'mobile' | null = null;
  try {
    method = resolveAuthMethodFlag(args);
  } catch (error) {
    console.error(errorFrame('Invalid --method', [error instanceof Error ? error.message : 'Invalid --method flag']));
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
    console.log(chalk.gray(`Terminal wait timeout: ${waitTimeoutSeconds}s (this CLI will wait this long for approval)`));
    console.log(chalk.gray(`Note: The approval link's server-side expiry is separate and typically ~15 minutes.`));
  }

  if (forceAuth) {
    const replacementCredentials = await readStoredCredentials();
    const replacementAccountId = replacementCredentials ? readAccountIdFromToken(replacementCredentials.token) : null;
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
      const stopped = await stopDaemon();
      console.log(ok(stopped.status === 'stopped' ? 'Stopped daemon' : 'No daemon was running'));
    } catch (error) {
      if (isDaemonStopIncompleteError(error)) throw error;
      logger.debug('Daemon was not running or failed to stop:', projectSafeAuthError(error));
    }

    await clearCredentials();
    console.log(ok('Cleared credentials'));

    await clearMachineId({ preserveReplacementCandidate: true, replacementReason: 'reauth', replacementAccountId });
    console.log(ok('Cleared machine ID'));

    console.log('');
  }

  if (!forceAuth) {
    const readiness = await resolveActiveServerAuthReadiness({ ...(signal ? { signal } : {}) });
    let existingCreds = readiness.credentials;

    if (readiness.unusableReason === 'credentials-rejected' && existingCreds) {
        const replacementAccountId = readAccountIdFromToken(existingCreds.token);
        const out = createOutputBuilder();
        out.line(warn('Stored credentials were rejected by the selected server'));
        out.line('  Repairing local authentication state before logging in again...');
        out.blank();
        console.log(out.render());

        try {
          logger.debug('Stopping daemon before auth repair...');
          const stopped = await stopDaemon();
          console.log(ok(stopped.status === 'stopped' ? 'Stopped daemon' : 'No daemon was running'));
        } catch (error) {
          if (isDaemonStopIncompleteError(error)) throw error;
          logger.debug('Daemon was not running or failed to stop during auth repair:', projectSafeAuthError(error));
        }

        await clearCredentials();
        await clearMachineId({ preserveReplacementCandidate: true, replacementReason: 'reauth', replacementAccountId });
        existingCreds = null;
    }

    if (
      readiness.authenticated
      && existingCreds
      && readiness.machineRegistered
      && !requireAccountMaterial
    ) {
      const out = createOutputBuilder();
      out.line(ok('Already authenticated'));
      out.definitionList([
        { label: 'Machine ID', value: readiness.machineId ?? '' },
        { label: 'Host', value: os.hostname() },
      ], { indent: '  ' });
      out.line('  Use \'happier auth login --force\' to re-authenticate');
      console.log(out.render());
      return;
    }

    if (existingCreds && !readiness.machineRegistered) {
      const out = createOutputBuilder();
      out.line(warn('Credentials exist but machine ID is missing'));
      out.line(`  This can happen if --auth flag was used previously`);
      out.line(`  Fixing by setting up machine...`);
      out.blank();
      console.log(out.render());
    }
  }

  try {
    const result = await authAndSetupMachineIfNeeded({
      callerIntent,
      ...(requireAccountMaterial ? { requireAccountMaterial: true } : {}),
      ...(signal ? { signal } : {}),
    });
    const out = createOutputBuilder();
    out.blank();
    out.line(ok('Signed in'));
    out.definitionList([
      { label: 'Machine ID', value: result.machineId },
    ], { indent: '  ' });
    console.log(out.render());
  } catch (error) {
    console.error(errorFrame('Sign-in failed', [projectSafeAuthError(error).message]));
    process.exit(1);
  }
}
