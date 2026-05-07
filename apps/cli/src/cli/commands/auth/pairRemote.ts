import spawn from 'cross-spawn';
import { createServerUrlComparableKey } from '@happier-dev/protocol';

import { approveTerminalAuthRequest } from '@/auth/terminalAuthApproval';
import { configuration } from '@/configuration';
import { promptForCurrentMachineReachableServerUrl } from '@/server/reachability/promptCurrentMachineReachableServerUrl';
import { applyServerSelectionFromArgs } from '@/server/serverSelection';
import { isLoopbackHttpServerUrl } from '@/server/serverUrlClassification';
import { isInteractiveTerminal } from '@/terminal/prompts/promptInput';

type JsonRecord = Record<string, unknown>;

type PairRemoteDeps = Readonly<{
  isInteractiveTerminal: () => boolean;
  promptForCurrentMachineReachableServerUrl: typeof promptForCurrentMachineReachableServerUrl;
}>;

type RemoteServerSelection = Readonly<{
  serverUrl: string;
  webappUrl: string;
  localServerUrl: string | null;
}>;

const DEFAULT_DEPS: PairRemoteDeps = {
  isInteractiveTerminal,
  promptForCurrentMachineReachableServerUrl,
};

function takeFlagValue(args: string[], name: string): { value: string | null; rest: string[] } {
  const rest: string[] = [];
  let value: string | null = null;

  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i] ?? '');
    if (a === name) {
      const next = String(args[i + 1] ?? '');
      if (!next || next.startsWith('--')) {
        throw new Error(`Missing value for ${name}`);
      }
      value = next;
      i += 1;
      continue;
    }
    if (a.startsWith(`${name}=`)) {
      const v = a.slice(`${name}=`.length);
      if (!v) throw new Error(`Missing value for ${name}`);
      value = v;
      continue;
    }
    rest.push(a);
  }

  return { value, rest };
}

function takeFlagBool(args: string[], name: string): { present: boolean; rest: string[] } {
  const rest = args.filter((arg) => arg !== name);
  return { present: rest.length !== args.length, rest };
}

function coalesceRemoteServerUrlFlag(params: Readonly<{
  remoteServerUrl: string | null;
  serverUrlForRemote: string | null;
}>): string | null {
  const legacy = params.remoteServerUrl?.trim() || null;
  const clearer = params.serverUrlForRemote?.trim() || null;
  if (legacy && clearer && legacy !== clearer) {
    fail('Use only one of --server-url-for-remote or --remote-server-url, or pass the same URL to both.', 2);
  }
  return clearer ?? legacy;
}

function fail(message: string, exitCode: 1 | 2 = 1): never {
  console.error(message);
  process.exit(exitCode);
}

function normalizeUrlOrFail(raw: string, label: string): string {
  const value = String(raw ?? '').trim();
  if (!value) fail(`Missing value for ${label}`, 2);
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      fail(`Invalid ${label} protocol: ${url.protocol} (expected http/https)`, 2);
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    fail(`Invalid ${label}: ${value}`, 2);
  }
}

function deriveDefaultWebappUrl(serverUrl: string): string {
  if (serverUrl.replace(/\/+$/, '') === 'https://api.happier.dev') {
    return 'https://app.happier.dev';
  }
  try {
    return new URL(serverUrl).origin;
  } catch {
    return serverUrl;
  }
}

function urlsReferToSameServer(leftRaw: string, rightRaw: string): boolean {
  const left = String(leftRaw ?? '').trim().replace(/\/+$/, '');
  const right = String(rightRaw ?? '').trim().replace(/\/+$/, '');
  if (!left || !right) return false;
  try {
    return createServerUrlComparableKey(left) === createServerUrlComparableKey(right);
  } catch {
    return left === right;
  }
}

async function resolveRemoteServerSelection(params: Readonly<{
  remoteServerUrl: string | null;
  remoteLocalServerUrl: string | null;
  remoteWebappUrl: string | null;
  json: boolean;
  deps: PairRemoteDeps;
}>): Promise<RemoteServerSelection> {
  const explicitRemoteServerUrl = params.remoteServerUrl
    ? normalizeUrlOrFail(params.remoteServerUrl, '--server-url-for-remote')
    : null;
  const explicitRemoteLocalServerUrl = params.remoteLocalServerUrl
    ? normalizeUrlOrFail(params.remoteLocalServerUrl, '--remote-local-server-url')
    : null;

  if (!explicitRemoteServerUrl && isLoopbackHttpServerUrl(configuration.serverUrl)) {
    if (params.json || !params.deps.isInteractiveTerminal()) {
      fail(
        `The selected relay is only reachable from this computer (${configuration.serverUrl}). ` +
          'Provide --server-url-for-remote <url> (or --remote-server-url <url>) with an address the remote machine can use to reach this computer.',
      );
    }

    const answer = (await params.deps.promptForCurrentMachineReachableServerUrl({
      localServerUrl: configuration.serverUrl,
      remoteDescription: 'the remote machine',
    })).trim();
    const promptedRemoteServerUrl = normalizeUrlOrFail(answer, '--server-url-for-remote');
    const promptedRemoteWebappUrl = params.remoteWebappUrl
      ? normalizeUrlOrFail(params.remoteWebappUrl, '--remote-webapp-url')
      : deriveDefaultWebappUrl(promptedRemoteServerUrl);
    return {
      serverUrl: promptedRemoteServerUrl,
      webappUrl: promptedRemoteWebappUrl,
      localServerUrl: null,
    };
  }

  const serverUrl = explicitRemoteServerUrl ?? configuration.serverUrl;
  const webappUrl = params.remoteWebappUrl
    ? normalizeUrlOrFail(params.remoteWebappUrl, '--remote-webapp-url')
    : explicitRemoteServerUrl
      ? deriveDefaultWebappUrl(serverUrl)
      : configuration.webappUrl;

  return {
    serverUrl,
    webappUrl,
    localServerUrl: explicitRemoteLocalServerUrl,
  };
}

function buildRemoteServerArgs(selection: RemoteServerSelection): string[] {
  return [
    '--server-url',
    selection.serverUrl,
    '--webapp-url',
    selection.webappUrl,
    ...(selection.localServerUrl && !urlsReferToSameServer(selection.localServerUrl, selection.serverUrl)
      ? ['--local-server-url', selection.localServerUrl]
      : []),
  ];
}

function assertRemoteRequestUsedExpectedRelay(request: JsonRecord, selection: RemoteServerSelection): void {
  const requestServerUrl = typeof request.serverUrl === 'string' ? request.serverUrl.trim() : '';
  if (!requestServerUrl) return;
  if (urlsReferToSameServer(requestServerUrl, selection.serverUrl)) return;

  fail(
    `Remote auth request was created against a different relay (${requestServerUrl}) than pair-remote is using (${selection.serverUrl}). ` +
      'Configure the remote with --server-url-for-remote or select the matching local relay with --server.',
  );
}

function runSshJson(params: Readonly<{ target: string; remoteArgs: string[] }>): JsonRecord {
  const result = spawn.sync('ssh', [params.target, ...params.remoteArgs], { stdio: 'pipe' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : String(result.stderr ?? '');
    throw new Error(`ssh exited with code ${result.status}: ${stderr}`.trim());
  }
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf8') : String(result.stdout ?? '');
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as JsonRecord;
      }
    } catch {
      continue;
    }
  }
  throw new Error('Remote command did not return valid JSON');
}

/**
 * Run an interactive remote command over SSH with a forced TTY (`-t`) so the
 * remote `doctor repair` can prompt the user. Streams stdio live to this
 * process — no buffering, no JSON parsing. Returns the remote exit code so
 * the caller can decide whether the post-pair check succeeded.
 */
function runSshInteractive(params: Readonly<{ target: string; remoteArgs: string[] }>): number {
  const result = spawn.sync(
    'ssh',
    ['-t', params.target, ...params.remoteArgs],
    { stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/**
 * Run a non-interactive remote command over SSH, returning stdout. Used for
 * the JSON post-pair check so we can append the report to our own JSON output.
 */
function runSshCapture(params: Readonly<{ target: string; remoteArgs: string[] }>): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawn.sync('ssh', [params.target, ...params.remoteArgs], { stdio: 'pipe' });
  if (result.error) throw result.error;
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf8') : String(result.stdout ?? '');
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : String(result.stderr ?? '');
  return { status: result.status ?? 1, stdout, stderr };
}

export async function handleAuthPairRemote(argsRaw: string[], deps: Partial<PairRemoteDeps> = {}): Promise<void> {
  const effectiveDeps: PairRemoteDeps = { ...DEFAULT_DEPS, ...deps };
  let args = await applyServerSelectionFromArgs(argsRaw);

  const jsonFlag = takeFlagBool(args, '--json');
  args = jsonFlag.rest;
  const json = jsonFlag.present;

  const noPostCheck = takeFlagBool(args, '--no-post-check');
  args = noPostCheck.rest;
  const postCheckEnabled = !noPostCheck.present;

  const ssh = takeFlagValue(args, '--ssh');
  args = ssh.rest;
  if (!ssh.value) {
    console.error('Missing required flag: --ssh <user@host>');
    process.exit(2);
  }

  const remoteCommand = takeFlagValue(args, '--remote-command');
  args = remoteCommand.rest;
  const remoteServerUrl = takeFlagValue(args, '--remote-server-url');
  args = remoteServerUrl.rest;
  const serverUrlForRemote = takeFlagValue(args, '--server-url-for-remote');
  args = serverUrlForRemote.rest;
  const remoteLocalServerUrl = takeFlagValue(args, '--remote-local-server-url');
  args = remoteLocalServerUrl.rest;
  const remoteWebappUrl = takeFlagValue(args, '--remote-webapp-url');
  args = remoteWebappUrl.rest;
  if (args.length > 0) {
    fail(`Unknown auth pair-remote arguments: ${args.join(' ')}`, 2);
  }

  const remoteSelection = await resolveRemoteServerSelection({
    remoteServerUrl: coalesceRemoteServerUrlFlag({
      remoteServerUrl: remoteServerUrl.value,
      serverUrlForRemote: serverUrlForRemote.value,
    }),
    remoteLocalServerUrl: remoteLocalServerUrl.value,
    remoteWebappUrl: remoteWebappUrl.value,
    json,
    deps: effectiveDeps,
  });
  const remoteExecutable = remoteCommand.value?.trim() || 'happier';
  const remoteServerArgs = buildRemoteServerArgs(remoteSelection);

  if (!json) {
    console.log(`Requesting remote authentication on ${ssh.value}...`);
  }
  const request = runSshJson({
    target: ssh.value,
    remoteArgs: [remoteExecutable, 'auth', 'request', '--json', '--persist', ...remoteServerArgs],
  });
  assertRemoteRequestUsedExpectedRelay(request, remoteSelection);
  const publicKey = typeof request?.publicKey === 'string' ? request.publicKey : '';
  if (!publicKey) {
    console.error('Remote `happier auth request --json` output did not include "publicKey".');
    process.exit(1);
  }

  try {
    if (!json) {
      console.log('Approving remote authentication request...');
    }
    await approveTerminalAuthRequest({ publicKey });
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Failed to approve auth request.');
    process.exit(1);
  }

  if (!json) {
    console.log('Waiting for the remote machine to claim credentials...');
  }
  runSshJson({
    target: ssh.value,
    remoteArgs: [remoteExecutable, 'auth', 'wait', '--public-key', publicKey, '--json', '--persist', ...remoteServerArgs],
  });

  // Capture the remote-side serverId from the request envelope so the
  // post-pair `doctor repair` can scope to that specific server profile and
  // surface absence-findings (e.g. "server profile missing") if the remote's
  // settings haven't refreshed yet between the wait and the doctor invocation.
  const remoteServerId = typeof request.serverId === 'string' && request.serverId.trim()
    ? request.serverId.trim()
    : null;

  if (json) {
    const envelope: JsonRecord = {
      success: true,
      ssh: ssh.value,
      publicKey,
      remoteServerUrl: remoteSelection.serverUrl,
      remoteServerId,
    };
    if (postCheckEnabled) {
      if (!remoteServerId) {
        envelope.postCheck = {
          skipped: true,
          reason: 'remote-server-id-unavailable',
        };
      } else {
        const postCheckArgs = [
          remoteExecutable, 'doctor', 'repair', '--report-only', '--json',
          '--server', remoteServerId,
        ];
        const captured = runSshCapture({ target: ssh.value, remoteArgs: postCheckArgs });
        const trimmed = captured.stdout.trim();
        let parsed: unknown = null;
        if (trimmed) {
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            parsed = null;
          }
        }
        envelope.postCheck = {
          ranWithServerId: remoteServerId,
          exitCode: captured.status,
          report: parsed,
          rawStdout: parsed === null ? captured.stdout : undefined,
          stderr: captured.stderr || undefined,
        };
      }
    }
    console.log(JSON.stringify(envelope));
    return;
  }

  console.log(`Remote machine paired: ${ssh.value}`);

  if (postCheckEnabled) {
    if (!remoteServerId) {
      console.log('');
      console.log('Skipping post-pair diagnostics because the remote CLI did not report the paired server profile id.');
      console.log(`Upgrade the remote CLI, then run \`${remoteExecutable} doctor repair\` on the remote if it needs service repair.`);
      return;
    }
    console.log('');
    console.log('Running post-pair diagnostics on the remote machine...');
    console.log('');
    const postCheckArgs = [
      remoteExecutable, 'doctor', 'repair',
      '--server', remoteServerId,
    ];
    const exitCode = runSshInteractive({ target: ssh.value, remoteArgs: postCheckArgs });
    if (exitCode !== 0) {
      console.error(`Post-pair doctor repair exited with code ${exitCode}.`);
      console.error(`Re-run on the remote: \`${remoteExecutable} doctor repair${remoteServerId ? ` --server ${remoteServerId}` : ''}\`.`);
    }
  }
}
