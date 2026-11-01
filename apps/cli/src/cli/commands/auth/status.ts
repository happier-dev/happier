import chalk from 'chalk';
import { cmd, definitionList, fail, neutral, ok, sectionTitle, warn } from '@happier-dev/cli-common/output';
import os from 'node:os';

import { formatAccountIdentity, formatRelayHost } from '@/auth/describeSignedInIdentity';
import { resolveActiveServerAuthReadiness } from '@/auth/resolveActiveServerAuthReadiness';
import { configuration } from '@/configuration';
import { checkIfDaemonRunningAndCleanupStaleState } from '@/daemon/controlClient';
import { printJsonEnvelope, wantsJson } from '@/cli/output/jsonEnvelope';
import { applyServerSelectionFromArgs } from '@/server/serverSelection';

export async function handleAuthStatus(argv: string[] = []): Promise<void> {
  const args = await applyServerSelectionFromArgs(argv);
  const json = wantsJson(args);
  const readiness = await resolveActiveServerAuthReadiness();
  const credentials = readiness.credentials;
  const relayHost = formatRelayHost(configuration.serverUrl);

  if (json && !credentials) {
    await printJsonEnvelope({ ok: false, kind: 'auth_status', error: { code: 'not_authenticated', serverId: configuration.activeServerId } });
    return;
  }

  if (!json) {
    console.log(sectionTitle('Authentication'));
    console.log(chalk.gray(`Server profile: ${configuration.activeServerId}`));
  }

  if (!credentials) {
    console.log(fail(`Not authenticated on ${relayHost}`));
    console.log(chalk.gray(`  Run ${cmd('happier auth login')} to sign in.`));
    return;
  }

  if (readiness.unusableReason === 'credentials-rejected') {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'auth_status', error: { code: 'not_authenticated', serverId: configuration.activeServerId } });
      return;
    }

    console.log(fail(`Not authenticated on ${relayHost}`));
    console.log(chalk.gray('  The selected relay rejected the stored credentials.'));
    console.log(chalk.gray(`  Run ${cmd('happier auth login --force')} to sign in again.`));
    return;
  }

  if (readiness.credentialState === 'unknown') {
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'auth_status',
        error: {
          code: 'auth_unavailable',
          serverId: configuration.activeServerId,
          message: 'The selected relay did not answer; stored credentials were kept.',
          machineRegistered: readiness.machineRegistered,
          ...(readiness.machineRegistered && readiness.machineId ? { machineId: readiness.machineId } : {}),
        },
      });
      return;
    }

    console.log(warn(`Authentication could not be verified because ${relayHost} did not answer`));
    console.log(chalk.gray('  Stored credentials were kept unchanged. Retry when the relay is available.'));
    return;
  }

  const { machineId, machineRegistered, validatedAccountId, validatedAccountLabel } = readiness;
  const accountIdentity = formatAccountIdentity({ accountLabel: validatedAccountLabel, accountId: validatedAccountId });

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
        serverId: configuration.activeServerId,
        ...(validatedAccountId ? { accountId: validatedAccountId } : {}),
        accountLabel: validatedAccountLabel,
        relayHost,
        encryption: { type: credentials.encryption?.type ?? 'tokenOnly' },
        machineRegistered,
        ...(machineRegistered && machineId ? { machineId } : {}),
        host: os.hostname(),
        happyHomeDir: configuration.happyHomeDir,
        daemonRunning,
      },
    });
    return;
  }

  console.log(ok(accountIdentity ? `Authenticated as ${accountIdentity} on ${relayHost}` : `Authenticated on ${relayHost}`));

  if (machineRegistered) {
    console.log(ok('Machine registered'));
  } else {
    console.log(warn('Machine not registered'));
    console.log(chalk.gray(`  Run ${cmd('happier auth login --force')} to fix this.`));
  }
  console.log(daemonRunning ? ok('Daemon running') : neutral('Daemon not running'));
  console.log(definitionList([
    ...(machineRegistered ? [{ label: 'Machine ID', value: String(machineId) }, { label: 'Host', value: os.hostname() }] : []),
    { label: 'Data directory', value: configuration.happyHomeDir },
  ], { indent: '  ' }));
}
