import os from 'node:os';

import { validateStoredAuthTokenAgainstActiveServer } from '@/auth/validateStoredAuthTokenAgainstActiveServer';
import { readCredentials, readSettings } from '@/persistence';
import { configuration } from '@/configuration';
import { checkIfDaemonRunningAndCleanupStaleState } from '@/daemon/controlClient';
import { printJsonEnvelope, wantsJson } from '@/cli/output/jsonEnvelope';
import { applyServerSelectionFromArgs } from '@/server/serverSelection';
import { definitionList, fail, ok, sectionTitle, warn } from '@happier-dev/cli-common/output';

export async function handleAuthStatus(argv: string[] = []): Promise<void> {
  const resolvedArgv = await applyServerSelectionFromArgs(argv);
  const json = wantsJson(resolvedArgv);
  const credentials = await readCredentials();
  const settings = await readSettings();

  if (json && !credentials) {
    printJsonEnvelope({ ok: false, kind: 'auth_status', error: { code: 'not_authenticated' } });
    return;
  }

  if (!json) {
    console.log(`\n${sectionTitle('Authentication Status')}\n`);
  }

  if (!credentials) {
    console.log(fail('Not authenticated'));
    console.log('  Run "happier auth login" to authenticate');
    return;
  }

  const authValidation = await validateStoredAuthTokenAgainstActiveServer(credentials.token);
  if (authValidation.state === 'invalid') {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'auth_status', error: { code: 'not_authenticated' } });
      return;
    }

    console.log(fail('Not authenticated'));
    console.log('  Stored credentials were rejected by the selected server');
    console.log('  Run "happier auth login --force" to authenticate again');
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
    printJsonEnvelope({
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

  console.log(ok('Authenticated'));

  if (machineRegistered) {
    console.log(ok('Machine registered'));
    console.log(definitionList([
      { label: 'Machine ID', value: machineId!.trim() },
      { label: 'Host', value: os.hostname() },
    ], { indent: '  ' }));
  } else {
    console.log(warn('Machine not registered'));
    console.log('  Run "happier auth login --force" to fix this');
  }

  console.log(`\n  Data directory: ${configuration.happyHomeDir}`);

  if (daemonRunning) {
    console.log(ok('Daemon running'));
  } else {
    console.log(fail('Daemon not running'));
  }
}
