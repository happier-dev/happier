import {
  assertResolvedHomeTargetIdentity,
  createTransferableHomeTargetInput,
  parseHomeTargetInput,
  type ResolvedHomeTarget,
} from '@happier-dev/cli-common/homeTarget';
import {
  runRemoteHomeEnrollmentFlow,
  type HappierJsonExecutor,
} from '@happier-dev/cli-common/systemTasks';
import { redactBugReportSensitiveText } from '@happier-dev/protocol/bugs/reports/redaction';

import { approveTerminalAuthRequest } from '@/auth/terminalAuthApproval';
import { readTerminalAuthHomeIdentity } from '@/auth/terminalAuthEnrollmentClient';
import { writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { resolveCliHomeTarget, resolveCurrentCliHomeTarget } from '@/server/homeTarget';
import { parseCliHomeTargetArgs } from '@/server/homeTargetCliArgs';
import { createLiveRemoteEnrollmentExecutor } from '@/capabilities/systemTasks/ssh/liveRemoteSshBootstrap';

type JsonRecord = Record<string, unknown>;

type PairRemoteDeps = Readonly<{
  resolveHomeTarget: () => Promise<ResolvedHomeTarget>;
  fetchServerFeaturesSnapshot: typeof fetchServerFeaturesSnapshot;
  createEnrollmentExecutor: (params: Readonly<{
    target: string;
    happierCommand: string;
    signal?: AbortSignal;
  }>) => HappierJsonExecutor;
  signal?: AbortSignal;
  parseHomeTargetArgs: typeof parseCliHomeTargetArgs;
}>;

const DEFAULT_DEPS: PairRemoteDeps = {
  resolveHomeTarget: resolveCurrentCliHomeTarget,
  fetchServerFeaturesSnapshot,
  createEnrollmentExecutor: ({ target, happierCommand, signal }) => createLiveRemoteEnrollmentExecutor({
    ssh: { target, auth: 'agent' },
    auth: { mode: 'agent' },
    knownHostsMode: 'system',
    happierCommand,
    signal,
  }),
  parseHomeTargetArgs: parseCliHomeTargetArgs,
};

function takeFlagValue(args: string[], name: string): { value: string | null; rest: string[] } {
  const rest: string[] = [];
  let value: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const current = String(args[index] ?? '');
    if (current === name) {
      const next = String(args[index + 1] ?? '');
      if (!next || next.startsWith('--')) throw new Error(`Missing value for ${name}`);
      value = next;
      index += 1;
      continue;
    }
    if (current.startsWith(`${name}=`)) {
      const next = current.slice(`${name}=`.length);
      if (!next) throw new Error(`Missing value for ${name}`);
      value = next;
      continue;
    }
    rest.push(current);
  }
  return { value, rest };
}

function takeFlag(args: string[], name: string): { present: boolean; rest: string[] } {
  const rest = args.filter((arg) => arg !== name);
  return { present: rest.length !== args.length, rest };
}

function fail(message: string, exitCode: 1 | 2 = 1): never {
  console.error(message);
  process.exit(exitCode);
}

function readExplicitRemoteUrl(args: string[]): Readonly<{ url: string | null; rest: string[] }> {
  const legacy = takeFlagValue(args, '--remote-server-url');
  const current = takeFlagValue(legacy.rest, '--server-url-for-remote');
  const legacyUrl = legacy.value?.trim() || null;
  const currentUrl = current.value?.trim() || null;
  if (legacyUrl && currentUrl && legacyUrl !== currentUrl) {
    fail('Use only one of --server-url-for-remote or --remote-server-url, or pass the same URL to both.', 2);
  }
  return { url: currentUrl ?? legacyUrl, rest: current.rest };
}

async function readHomeIdentity(target: ResolvedHomeTarget, deps: PairRemoteDeps): Promise<string | null> {
  if (target.homeServerIdentityId) return target.homeServerIdentityId;
  const snapshot = await deps.fetchServerFeaturesSnapshot({
    serverUrl: target.applicationUrl,
    signal: deps.signal,
  });
  return readTerminalAuthHomeIdentity(snapshot);
}

export async function handleAuthPairRemote(
  argsRaw: string[],
  signalOrDeps: AbortSignal | Partial<PairRemoteDeps> = {},
  injectedDeps: Partial<PairRemoteDeps> = {},
): Promise<void> {
  const signal = 'aborted' in signalOrDeps ? signalOrDeps : signalOrDeps.signal;
  const deps = 'aborted' in signalOrDeps ? injectedDeps : signalOrDeps;
  const effectiveDeps: PairRemoteDeps = { ...DEFAULT_DEPS, ...(signal ? { signal } : {}), ...deps };
  effectiveDeps.signal?.throwIfAborted();
  const parsedTargetArgs = await effectiveDeps.parseHomeTargetArgs(argsRaw);
  let args = parsedTargetArgs.rest;
  const json = takeFlag(args, '--json');
  args = json.rest;
  const noPostCheck = takeFlag(args, '--no-post-check');
  args = noPostCheck.rest;
  const authorizeUnattendedTeamAccess = takeFlag(args, '--authorize-unattended-team-access');
  args = authorizeUnattendedTeamAccess.rest;

  const ssh = takeFlagValue(args, '--ssh');
  args = ssh.rest;
  if (!ssh.value) fail('Missing required flag: --ssh <user@host>', 2);
  const remoteCommand = takeFlagValue(args, '--remote-command');
  args = remoteCommand.rest;
  const remoteUrl = readExplicitRemoteUrl(args);
  args = remoteUrl.rest;

  // Released URL-only flags remain thin compatibility adapters. They no
  // longer decide the remote auth protocol or force a loopback Home to invent
  // a public URL.
  const remoteLocalUrl = takeFlagValue(args, '--remote-local-server-url');
  args = remoteLocalUrl.rest;
  const remoteWebappUrl = takeFlagValue(args, '--remote-webapp-url');
  args = remoteWebappUrl.rest;
  if ((remoteLocalUrl.value || remoteWebappUrl.value) && !remoteUrl.url) {
    fail('--remote-local-server-url and --remote-webapp-url require --server-url-for-remote.', 2);
  }
  if (parsedTargetArgs.target && remoteUrl.url) {
    fail('Do not combine a Home target with --server-url-for-remote.', 2);
  }
  if (args.length > 0) fail('Unknown auth pair-remote arguments. Run `happier auth help` for supported flags.', 2);

  const selectedHomeTarget = parsedTargetArgs.target
    ? await resolveCliHomeTarget(parsedTargetArgs.target)
    : await effectiveDeps.resolveHomeTarget();
  const resolvedHomeTarget = remoteUrl.url
    ? await resolveCliHomeTarget({ kind: 'https_url', url: remoteUrl.url })
    : selectedHomeTarget;
  effectiveDeps.signal?.throwIfAborted();
  const executor = effectiveDeps.createEnrollmentExecutor({
    target: ssh.value,
    happierCommand: remoteCommand.value?.trim() || 'happier',
    signal: effectiveDeps.signal,
  });
  let publicKey: string | null = null;
  const transferableTarget = createTransferableHomeTargetInput(resolvedHomeTarget);
  const remoteHomeTargetInput = transferableTarget.kind === 'https_url'
    ? parseHomeTargetInput({
        ...transferableTarget,
        ...(remoteLocalUrl.value ? { localUrl: remoteLocalUrl.value } : {}),
        ...(remoteWebappUrl.value ? { webappUrl: remoteWebappUrl.value } : {}),
      })
    : transferableTarget;

  if (!json.present) console.log(`Requesting remote authentication on ${ssh.value}...`);
  const result = await runRemoteHomeEnrollmentFlow({
    executor,
    homeTargetInput: remoteHomeTargetInput,
    signal: effectiveDeps.signal,
    approvePairingRequest: async (request) => {
      publicKey = request.publicKey;
      const selectedIdentity = await readHomeIdentity(selectedHomeTarget, effectiveDeps);
      if (!selectedIdentity) {
        throw new Error('Unable to verify the selected Home identity. No approval was sent.');
      }
      const routeIdentity = await readHomeIdentity(resolvedHomeTarget, effectiveDeps);
      if (!routeIdentity) {
        throw new Error('Unable to verify the remote Home route identity. No approval was sent.');
      }
      assertResolvedHomeTargetIdentity(selectedHomeTarget, selectedIdentity);
      assertResolvedHomeTargetIdentity(resolvedHomeTarget, routeIdentity);
      if (routeIdentity !== selectedIdentity) {
        throw new Error(
          `The remote Home route resolves to ${routeIdentity}, but the selected Home is ${selectedIdentity}. `
          + 'No approval was sent.',
        );
      }
      if (request.homeServerIdentityId !== selectedIdentity) {
        throw new Error(
          `Remote authentication targets Home ${request.homeServerIdentityId}, but the selected Home is `
          + `${selectedIdentity}. No approval was sent.`,
        );
      }
      await approveTerminalAuthRequest({
        publicKey: request.publicKey,
        pairing: request.pairing,
        supportsTokenOnly: true,
        target: resolvedHomeTarget,
        ...(effectiveDeps.signal ? { signal: effectiveDeps.signal } : {}),
        ...(authorizeUnattendedTeamAccess.present
          ? { authorizeUnattendedTeamAccess: true }
          : {}),
      });
    },
  });
  effectiveDeps.signal?.throwIfAborted();

  const remoteServerId = result.remoteProfileId;
  let postCheck: JsonRecord | null = null;
  if (!noPostCheck.present && remoteServerId) {
    const checked = await executor.runHappierText([
      'doctor', 'repair', '--report-only', '--json', '--server', remoteServerId,
    ], { signal: effectiveDeps.signal, includeStdoutInError: false });
    const diagnosticStdout = redactBugReportSensitiveText(checked.stdout);
    const diagnosticStderr = redactBugReportSensitiveText(checked.stderr);
    let report: unknown = null;
    try {
      report = diagnosticStdout.trim() ? JSON.parse(diagnosticStdout.trim()) : null;
    } catch {
      report = null;
    }
    postCheck = {
      ranWithServerId: remoteServerId,
      exitCode: checked.status,
      report,
      ...(report === null && diagnosticStdout ? { rawStdout: diagnosticStdout } : {}),
      ...(diagnosticStderr ? { stderr: diagnosticStderr } : {}),
    };
  } else if (!noPostCheck.present) {
    postCheck = { skipped: true, reason: 'remote-server-id-unavailable' };
  }

  if (json.present) {
    const envelope: JsonRecord = {
      success: true,
      ssh: ssh.value,
      ...(publicKey ? { publicKey } : {}),
      homeServerIdentityId: result.homeServerIdentityId,
      machineId: result.machineId,
      remoteServerUrl: resolvedHomeTarget.canonicalAuthUrl,
      remoteServerId,
      ...(!noPostCheck.present ? { postCheck } : {}),
    };
    await writeJsonStdout(envelope);
    return;
  }
  console.log(`Remote machine paired: ${ssh.value}`);
  if (!noPostCheck.present) {
    if (!remoteServerId) {
      console.log('Skipping post-pair diagnostics because the remote CLI did not report the paired Home profile id.');
    } else if ((postCheck?.exitCode as number | undefined) !== 0) {
      console.error(`Post-pair diagnostics exited with code ${String(postCheck?.exitCode ?? 1)}.`);
    }
  }
}
