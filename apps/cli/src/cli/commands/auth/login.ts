import os from 'node:os';

import { resolveActiveServerAuthReadiness } from '@/auth/resolveActiveServerAuthReadiness';
import { clearCredentials, clearMachineId, readStoredCredentials } from '@/persistence';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { isDaemonStopIncompleteError, stopDaemon } from '@/daemon/controlClient';
import { logger } from '@/ui/logger';
import { applyServerSelectionFromArgs } from '@/server/serverSelection';
import { createOutputBuilder, definitionList, errorFrame, ok, warn } from '@happier-dev/cli-common/output';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';

import { showAuthHelp } from './help';
import { resolveAuthMethodFlag } from './methodFlag';

function readWaitTimeoutSecondsFlag(args: readonly string[]): number | null {
  const index = args.indexOf('--wait-timeout');
  if (index < 0) return null;
  const raw = String(args[index + 1] ?? '').trim();
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    console.error(errorFrame('Error:', ['--wait-timeout needs a positive number of seconds, for example `--wait-timeout 300`.']));
    process.exit(1);
  }
  return seconds;
}

function readAccountIdFromCredentials(credentials: Awaited<ReturnType<typeof readStoredCredentials>>): string | null {
  const token = typeof credentials?.token === 'string' ? credentials.token : '';
  if (!token) return null;
  const payload = decodeJwtPayload(token);
  const subject = typeof payload?.sub === 'string' ? payload.sub.trim() : '';
  return subject || null;
}

export async function handleAuthLogin(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    showAuthHelp();
    return;
  }

  args = await applyServerSelectionFromArgs(args);

  const forceAuth = args.includes('--force') || args.includes('-f');
  const noOpen = args.includes('--no-open') || args.includes('--no-browser') || args.includes('--no-browser-open');
  const printConfigureLinks = args.includes('--print-configure-links');
  const waitTimeoutSeconds = readWaitTimeoutSecondsFlag(args);
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

  if (waitTimeoutSeconds !== null) {
    process.env.HAPPIER_AUTH_WAIT_TIMEOUT_MS = String(waitTimeoutSeconds * 1000);
  }

  if (forceAuth) {
    const replacementAccountId = readAccountIdFromCredentials(await readStoredCredentials());
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
      if (isDaemonStopIncompleteError(error)) throw error;
      logger.debug('Daemon was not running or failed to stop:', error);
    }

    await clearCredentials();
    console.log(ok('Cleared credentials'));

    await clearMachineId({ preserveReplacementCandidate: true, replacementReason: 'reauth', replacementAccountId });
    console.log(ok('Cleared machine ID'));

    console.log('');
  }

  if (!forceAuth) {
    const readiness = await resolveActiveServerAuthReadiness();
    let existingCreds = readiness.credentials;

    if (readiness.unusableReason === 'credentials-rejected' && existingCreds) {
        const replacementAccountId = readAccountIdFromCredentials(existingCreds);
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
          if (isDaemonStopIncompleteError(error)) throw error;
          logger.debug('Daemon was not running or failed to stop during auth repair:', error);
        }

        await clearCredentials();
        await clearMachineId({ preserveReplacementCandidate: true, replacementReason: 'reauth', replacementAccountId });
        existingCreds = null;
    }

    if (existingCreds && readiness.machineRegistered) {
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
