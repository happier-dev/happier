import os from 'node:os';

import { resolveActiveServerAuthReadiness } from '@/auth/resolveActiveServerAuthReadiness';
import { configuration } from '@/configuration';
import { checkIfDaemonRunningAndCleanupStaleState } from '@/daemon/controlClient';
import { printJsonEnvelope, wantsJson } from '@/cli/output/jsonEnvelope';
import { applyServerSelectionFromArgs } from '@/server/serverSelection';
import { definitionList, fail, ok, sectionTitle, warn } from '@happier-dev/cli-common/output';

export async function handleAuthStatus(argv: string[] = []): Promise<void> {
  const resolvedArgv = await applyServerSelectionFromArgs(argv);
  const json = wantsJson(resolvedArgv);
  const readiness = await resolveActiveServerAuthReadiness();
  const credentials = readiness.credentials;

  if (json && !credentials) {
    await printJsonEnvelope({ ok: false, kind: 'auth_status', error: { code: 'not_authenticated' } });
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

  if (!readiness.authenticated) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'auth_status', error: { code: 'not_authenticated' } });
      return;
    }

    console.log(fail('Not authenticated'));
    console.log('  Stored credentials were rejected by the selected server');
    console.log('  Run "happier auth login --force" to authenticate again');
    return;
  }

  const machineId = readiness.machineId;
  const machineRegistered = readiness.machineRegistered;

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
        encryption: { type: credentials.encryption?.type ?? 'none' },
        machineRegistered,
        ...(machineRegistered ? { machineId: machineId ?? '' } : {}),
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
      { label: 'Machine ID', value: machineId ?? '' },
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
