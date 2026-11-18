import os from 'node:os';

import { formatRelayAccountIdentity } from '@/auth/formatRelayAccountIdentity';
import { resolveActiveServerAuthReadiness } from '@/auth/resolveActiveServerAuthReadiness';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { configuration } from '@/configuration';
import { checkIfDaemonRunningAndCleanupStaleState } from '@/daemon/controlClient';
import { printJsonEnvelope, wantsJson } from '@/cli/output/jsonEnvelope';
import { applyServerSelectionFromArgs } from '@/server/serverSelection';
import { cmd, definitionList, fail, gray, neutral, ok, sectionTitle, warn } from '@happier-dev/cli-common/output';

export async function handleAuthStatus(argv: string[] = [], signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const resolvedArgv = await applyServerSelectionFromArgs(argv);
  const json = wantsJson(resolvedArgv);
  const readiness = await resolveActiveServerAuthReadiness({ ...(signal ? { signal } : {}) });
  const credentials = readiness.credentials;

  if (json && !credentials) {
    await printJsonEnvelope({ ok: false, kind: 'auth_status', error: {
      code: 'not_authenticated', ...(readiness.credentialReason ? { reason: readiness.credentialReason } : {}),
    } });
    return;
  }

  if (!json) {
    console.log(sectionTitle('Authentication'));
  }

  if (!credentials) {
    console.log(fail('Not authenticated'));
    if (readiness.credentialReason) console.log(gray(`  Reason: ${readiness.credentialReason}`));
    console.log(gray(`  Run ${cmd('happier auth login')} to sign in.`));
    return;
  }

  if (!readiness.authenticated) {
    if (readiness.credentialState === 'unknown') {
      if (json) {
        await printJsonEnvelope({
          ok: false,
          kind: 'auth_status',
          error: {
            code: 'auth_status_unavailable',
            ...(readiness.credentialReason ? { reason: readiness.credentialReason } : {}),
            message: 'Stored credentials could not be verified against the selected server.',
          },
        });
        return;
      }

      console.log(warn('Stored credentials found, but server validation is unavailable'));
      if (readiness.credentialReason) console.log(gray(`  Reason: ${readiness.credentialReason}`));
      console.log('  Your local credentials were kept. Try again when the selected server is reachable.');
      return;
    }

    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'auth_status', error: { code: 'not_authenticated' } });
      return;
    }

    console.log(fail('Not authenticated'));
    console.log(gray('  The selected server rejected the stored credentials.'));
    console.log(gray(`  Run ${cmd('happier auth login --force')} to sign in again.`));
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
        serverId: configuration.activeServerId,
        authenticated: true,
        accountId: readAccountIdFromToken(credentials.token),
        credentialState: readiness.credentialState,
        encryption: { type: credentials.encryption?.type ?? 'none' },
        machineRegistered,
        machineRegistrationState: readiness.machineRegistrationState,
        accountLabel: readiness.accountLabel,
        ...(machineRegistered ? { machineId: machineId ?? '' } : {}),
        host: os.hostname(),
        happyHomeDir: configuration.happyHomeDir,
        daemonRunning,
      },
    });
    return;
  }

  console.log(ok(`Signed in to ${formatRelayAccountIdentity({
    serverUrl: configuration.publicServerUrl || configuration.serverUrl,
    accountLabel: readiness.accountLabel,
    accountId: readAccountIdFromToken(credentials.token),
  })}`));
  console.log(definitionList([{ label: 'Server ID', value: configuration.activeServerId }], { indent: '  ' }));

  if (machineRegistered) {
    console.log(ok('Machine registered'));
  } else {
    console.log(warn('Machine not registered'));
    console.log(gray(`  Run ${cmd('happier auth login --force')} to fix this.`));
  }
  console.log(daemonRunning ? ok('Daemon running') : neutral('Daemon not running'));
  console.log(definitionList([
    ...(machineRegistered ? [{ label: 'Machine ID', value: machineId ?? '' }, { label: 'Host', value: os.hostname() }] : []),
    { label: 'Data directory', value: configuration.happyHomeDir },
  ], { indent: '  ' }));
}
