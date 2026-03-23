import './utils/env/env.mjs';

import { pathToFileURL } from 'node:url';
import { run, runCapture } from './utils/proc/proc.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';

function takeFlagValue(args, name) {
  const rest = [];
  let value = null;

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

function safeBashSingleQuote(s) {
  const raw = String(s ?? '');
  if (raw === '') return "''";
  // Wrap in single quotes and escape embedded single quotes safely.
  // bash: 'foo'\''bar'
  return `'${raw.replaceAll("'", `'\"'\"'`)}'`;
}

function parseJsonLinesBestEffort(stdout) {
  const out = String(stdout ?? '');
  const lines = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {
      continue;
    }
  }
  return null;
}

async function runSsh({ target, command }) {
  await run('ssh', [target, 'bash', '-lc', safeBashSingleQuote(command)], { env: process.env });
}

async function runSshJson({ target, command }) {
  const out = await runCapture('ssh', [target, 'bash', '-lc', safeBashSingleQuote(command)], { env: process.env });
  const parsed = parseJsonLinesBestEffort(out);
  if (!parsed) {
    throw new Error('Remote command did not return valid JSON');
  }
  return parsed;
}

async function runLocalJson({ args }) {
  const out = await runCapture('happier', args, { env: process.env });
  const parsed = parseJsonLinesBestEffort(out);
  if (!parsed) {
    throw new Error('Local command did not return valid JSON');
  }
  return parsed;
}

function usageText() {
  return [
    '[remote] usage:',
    '  hstack remote daemon setup --ssh <user@host> [--preview|--stable] [--channel <stable|preview>]',
    '    [--service <user|none>]',
    '    [--server-url=<url>] [--webapp-url=<url>] [--public-server-url=<url>]',
    '    [--json]',
    '',
    '  hstack remote server setup --ssh <user@host> [--preview|--stable] [--channel <stable|preview>]',
    '    [--mode <user|system>]',
    '    [--self-host-server-binary <path>]',
    '    [--env KEY=VALUE]...',
    '    [--json]',
    '',
    'notes:',
    '  - This command runs remote operations over ssh.',
    '  - It installs the Happier CLI on the remote host, pairs credentials, and optionally installs/starts the daemon service.',
    '  - Default service mode is user; set --service none to skip daemon service setup.',
    '  - Remote server setup installs the self-host runtime as a service (default: user mode).',
  ].join('\n');
}

export function splitRemoteServerSetupEnvValues(envValues) {
  const values = Array.isArray(envValues) ? envValues : [];
  const serviceEnvValues = [];
  let selfHostServerBinary = '';

  for (const raw of values) {
    const entry = String(raw ?? '').trim();
    if (!entry) continue;
    const eq = entry.indexOf('=');
    const key = (eq >= 0 ? entry.slice(0, eq) : entry).trim();
    const value = eq >= 0 ? entry.slice(eq + 1) : '';

    if (key === 'HAPPIER_SELF_HOST_SERVER_BINARY') {
      selfHostServerBinary = value.trim();
      continue;
    }

    serviceEnvValues.push(entry);
  }

  return { serviceEnvValues, selfHostServerBinary };
}

export function buildRemoteSelfHostInstallCommand({ channel, mode, envValues }) {
  const installUrl = 'https://happier.dev/install';
  const remoteHstack = '$HOME/.happier/bin/hstack';

  // Always disable auto-service setup in the installer so this command controls remote service behavior.
  const installCmd = [
    `curl -fsSL ${installUrl} |`,
    `HAPPIER_CHANNEL=${channel} HAPPIER_WITH_DAEMON=0 HAPPIER_WITH_CLI=0 HAPPIER_NONINTERACTIVE=1 bash`,
  ].join(' ');

  const split = splitRemoteServerSetupEnvValues(envValues);
  const envArgs = split.serviceEnvValues.map((value) => `--env ${safeBashSingleQuote(value)}`).join(' ');

  // `hstack self-host install` only reads this override from process.env (not from --env),
  // so forward it via `env VAR=...` and do not persist it into the installed service env file.
  const installEnvParts = [];
  if (split.selfHostServerBinary) {
    installEnvParts.push(`HAPPIER_SELF_HOST_SERVER_BINARY=${safeBashSingleQuote(split.selfHostServerBinary)}`);
  }
  const installEnvPrefix = installEnvParts.length ? `env ${installEnvParts.join(' ')} ` : '';

  const baseSelfHostCmd = [
    remoteHstack,
    'self-host',
    'install',
    `--channel=${channel}`,
    `--mode=${mode}`,
    '--without-cli',
    '--non-interactive',
    '--json',
  ].join(' ');
  const sudoPrefix = mode === 'system' ? 'sudo -E ' : '';
  const selfHostCmd = `${sudoPrefix}${installEnvPrefix}${baseSelfHostCmd}${envArgs ? ` ${envArgs}` : ''}`;

  return { installCmd, selfHostCmd };
}

function resolveChannel(argv) {
  if (argv.includes('--preview')) return 'preview';
  if (argv.includes('--stable')) return 'stable';
  const picked = argv.find((a) => a === '--channel' || a.startsWith('--channel='));
  if (!picked) return 'stable';
  if (picked === '--channel') {
    const idx = argv.indexOf('--channel');
    const v = String(argv[idx + 1] ?? '').trim();
    return v || 'stable';
  }
  const v = String(picked.slice('--channel='.length)).trim();
  return v || 'stable';
}

function resolveService(argv) {
  const picked = argv.find((a) => a === '--service' || a.startsWith('--service='));
  if (!picked) return 'user';
  if (picked === '--service') {
    const idx = argv.indexOf('--service');
    const v = String(argv[idx + 1] ?? '').trim().toLowerCase();
    return v || 'user';
  }
  const v = String(picked.slice('--service='.length)).trim().toLowerCase();
  return v || 'user';
}

function resolveMode(argv) {
  if (argv.includes('--system')) return 'system';
  if (argv.includes('--user')) return 'user';
  const picked = argv.find((a) => a === '--mode' || a.startsWith('--mode='));
  if (!picked) return 'user';
  if (picked === '--mode') {
    const idx = argv.indexOf('--mode');
    const v = String(argv[idx + 1] ?? '').trim().toLowerCase();
    return v || 'user';
  }
  const v = String(picked.slice('--mode='.length)).trim().toLowerCase();
  return v || 'user';
}

function collectEnvValues(argv) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? '';
    if (a === '--env') {
      const next = args[i + 1] ?? '';
      if (!next || next.startsWith('--')) {
        throw new Error('[remote] missing value for --env (expected KEY=VALUE)');
      }
      values.push(String(next));
      i += 1;
      continue;
    }
    if (a.startsWith('--env=')) {
      const raw = a.slice('--env='.length);
      if (!raw) throw new Error('[remote] missing value for --env (expected KEY=VALUE)');
      values.push(String(raw));
    }
  }
  return values;
}

async function runRemoteDaemonSetup(argvRaw) {
  const argv0 = argvRaw.slice();
  const json = wantsJson(argv0);

  let args = argv0.slice();
  const ssh = takeFlagValue(args, '--ssh');
  args = ssh.rest;
  if (!ssh.value) {
    process.stderr.write('Missing required flag: --ssh <user@host>\n');
    process.exit(2);
  }

  const channel = resolveChannel(argv0);
  if (channel !== 'stable' && channel !== 'preview') {
    throw new Error(`[remote] invalid --channel value: ${channel}`);
  }

  const service = resolveService(argv0);
  if (service !== 'user' && service !== 'none') {
    throw new Error(`[remote] invalid --service value: ${service} (expected user or none)`);
  }

  const serverUrlFlag = takeFlagValue(args, '--server-url');
  args = serverUrlFlag.rest;
  const webappUrlFlag = takeFlagValue(args, '--webapp-url');
  args = webappUrlFlag.rest;
  const publicServerUrlFlag = takeFlagValue(args, '--public-server-url');
  args = publicServerUrlFlag.rest;

  const serverFlags = {
    serverUrl: serverUrlFlag.value,
    webappUrl: webappUrlFlag.value,
    publicServerUrl: publicServerUrlFlag.value,
    localArgs: [
      ...(serverUrlFlag.value ? [`--server-url=${serverUrlFlag.value}`] : []),
      ...(webappUrlFlag.value ? [`--webapp-url=${webappUrlFlag.value}`] : []),
      ...(publicServerUrlFlag.value ? [`--public-server-url=${publicServerUrlFlag.value}`] : []),
    ],
  };

  const installUrl = 'https://happier.dev/install';
  const remoteBin = '$HOME/.happier/bin/happier';

  // Always disable auto-service setup in the installer so this command controls service behavior.
  const installCmd = [
    `curl -fsSL ${installUrl} |`,
    `HAPPIER_CHANNEL=${channel} HAPPIER_WITH_DAEMON=0 HAPPIER_NONINTERACTIVE=1 bash`,
  ].join(' ');

  await runSsh({ target: ssh.value, command: installCmd });

  if (serverFlags.serverUrl) {
    const serverUrl = safeBashSingleQuote(serverFlags.serverUrl);
    const webappUrl = safeBashSingleQuote(serverFlags.webappUrl || serverFlags.serverUrl);
    // Persist server targeting on the remote host so future `happier daemon start` uses the same server.
    await runSsh({
      target: ssh.value,
      command: `${remoteBin} server set --server-url ${serverUrl} --webapp-url ${webappUrl} --json`,
    });
  }

  const request = await runSshJson({ target: ssh.value, command: `${remoteBin} auth request --json` });
  const publicKey = typeof request?.publicKey === 'string' ? request.publicKey : '';
  if (!publicKey) {
    throw new Error('Remote auth request did not include "publicKey"');
  }

  await runLocalJson({
    args: [...serverFlags.localArgs, 'auth', 'approve', '--public-key', publicKey, '--json'],
  });

  await runSshJson({
    target: ssh.value,
    command: `${remoteBin} auth wait --public-key ${safeBashSingleQuote(publicKey)} --json`,
  });

  if (service === 'user') {
    const envParts = [];
    if (serverFlags.serverUrl) envParts.push(`HAPPIER_DAEMON_SERVICE_SERVER_URL=${safeBashSingleQuote(serverFlags.serverUrl)}`);
    if (serverFlags.webappUrl) envParts.push(`HAPPIER_DAEMON_SERVICE_WEBAPP_URL=${safeBashSingleQuote(serverFlags.webappUrl)}`);
    if (serverFlags.publicServerUrl) envParts.push(`HAPPIER_DAEMON_SERVICE_PUBLIC_SERVER_URL=${safeBashSingleQuote(serverFlags.publicServerUrl)}`);
    const envPrefix = envParts.length ? `${envParts.join(' ')} ` : '';

    await runSsh({ target: ssh.value, command: `${envPrefix}${remoteBin} daemon service install` });
    await runSsh({ target: ssh.value, command: `${envPrefix}${remoteBin} daemon service start` });
  }

  printResult({
    json,
    data: { ok: true, ssh: ssh.value, channel, service, publicKey },
    text: json
      ? null
      : [
          '✓ Remote daemon setup complete',
          `- ssh: ${ssh.value}`,
          `- channel: ${channel}`,
          `- service: ${service}`,
          `- publicKey: ${publicKey}`,
        ].join('\n'),
  });
}

async function runRemoteServerSetup(argvRaw) {
  const argv0 = argvRaw.slice();
  const json = wantsJson(argv0);

  let args = argv0.slice();
  const ssh = takeFlagValue(args, '--ssh');
  args = ssh.rest;
  if (!ssh.value) {
    process.stderr.write('Missing required flag: --ssh <user@host>\n');
    process.exit(2);
  }

  const channel = resolveChannel(argv0);
  if (channel !== 'stable' && channel !== 'preview') {
    throw new Error(`[remote] invalid --channel value: ${channel}`);
  }

  const mode = resolveMode(argv0);
  if (mode !== 'user' && mode !== 'system') {
    throw new Error(`[remote] invalid --mode value: ${mode} (expected user or system)`);
  }

  const selfHostServerBinaryFlag = takeFlagValue(args, '--self-host-server-binary');
  args = selfHostServerBinaryFlag.rest;

  const envValues = collectEnvValues(argv0);
  if (selfHostServerBinaryFlag.value) {
    // Forward this override to `hstack self-host install` via process.env, without persisting it
    // in the installed service env file.
    envValues.push(`HAPPIER_SELF_HOST_SERVER_BINARY=${selfHostServerBinaryFlag.value}`);
  }
  const built = buildRemoteSelfHostInstallCommand({ channel, mode, envValues });

  await runSsh({ target: ssh.value, command: built.installCmd });
  await runSsh({ target: ssh.value, command: built.selfHostCmd });

  printResult({
    json,
    data: { ok: true, ssh: ssh.value, channel, mode, env: envValues, selfHostServerBinary: selfHostServerBinaryFlag.value || null },
    text: json
      ? null
      : [
          '✓ Remote server setup complete',
          `- ssh: ${ssh.value}`,
          `- channel: ${channel}`,
          `- mode: ${mode}`,
          `- env: ${envValues.length ? envValues.join(', ') : '(none)'}`,
        ].join('\n'),
  });
}

async function main() {
  const argvRaw = process.argv.slice(2);
  if (argvRaw.length === 0 || wantsHelp(argvRaw)) {
    printResult({ json: wantsJson(argvRaw), data: { usage: usageText() }, text: usageText() });
    return;
  }

  const positionals = argvRaw.filter((a) => a && a !== '--' && !a.startsWith('-'));
  const top = String(positionals[0] ?? '').trim();
  const sub = String(positionals[1] ?? '').trim();

  if (top === 'daemon' && sub === 'setup') {
    await runRemoteDaemonSetup(argvRaw);
    return;
  }
  if (top === 'server' && sub === 'setup') {
    await runRemoteServerSetup(argvRaw);
    return;
  }

  printResult({
    json: wantsJson(argvRaw),
    data: { usage: usageText() },
    text: usageText(),
  });
  process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${msg}\n`);
    process.exit(1);
  });
}
