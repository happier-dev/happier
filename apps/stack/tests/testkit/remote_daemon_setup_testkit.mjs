import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { writeLoggedJsonBin } from '../../scripts/testkit/core/fake_bin_harness.mjs';
import { resolveStackRootFromMeta } from '../../scripts/testkit/core/stack_root.mjs';
import { createSyncLoggedCommandHarness } from '../../scripts/testkit/core/sync_logged_command_harness.mjs';

const stackRoot = resolveStackRootFromMeta(import.meta.url);

function toDataUrl(source) {
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

function writeFakeSsh({ tmp, authStatusResponse }) {
  return writeLoggedJsonBin({
    root: tmp,
    name: 'ssh',
    logEnvVar: 'REMOTE_DAEMON_SETUP_LOG',
    body: `
const cmd = process.argv.slice(2).join(' ');
if (cmd.includes('uname -s') && cmd.includes('uname -m')) {
  process.stdout.write(JSON.stringify({ platform: 'linux', arch: 'x64' }) + "\\n");
  process.exit(0);
}
if (cmd.includes('auth status')) {
  process.stdout.write(JSON.stringify(${JSON.stringify(authStatusResponse)}) + "\\n");
  process.exit(0);
}
if (cmd.includes('auth request')) {
  process.stdout.write(JSON.stringify({ publicKey: 'pk_test_123' }) + "\\n");
  process.exit(0);
}
if (cmd.includes('auth wait')) {
  process.stdout.write(JSON.stringify({ ok: true }) + "\\n");
  process.exit(0);
}
process.exit(0);
`,
  });
}

function writeFakeScp({ tmp }) {
  return writeLoggedJsonBin({
    root: tmp,
    name: 'scp',
    logEnvVar: 'REMOTE_DAEMON_SETUP_LOG',
    body: 'process.exit(0);',
  });
}

function writeRemoteInstallLoader({ tmp }) {
  const loaderPath = join(tmp, 'remote-daemon-loader.mjs');
  const registerPath = join(tmp, 'remote-daemon-register-loader.mjs');
  const stubBySpecifier = {
    './utils/remote/install_remote_first_party_component.mjs': toDataUrl(`
import { appendFileSync } from 'node:fs';

function normalizeChannel(channel) {
  return channel === 'publicdev' ? 'dev' : channel === 'preview' ? 'preview' : 'stable';
}

function resolveBinaryPath(componentId, channel) {
  const suffix = normalizeChannel(channel);
  if (componentId === 'happier-cli') {
    return suffix === 'stable'
      ? '$HOME/.happier/cli/current/happier'
      : '$HOME/.happier/cli-' + suffix + '/current/happier';
  }
  return suffix === 'stable'
    ? '$HOME/.happier/stack/current/hstack'
    : '$HOME/.happier/stack-' + suffix + '/current/hstack';
}

export async function installRemoteFirstPartyComponent({ componentId, channel, target }) {
  const logPath = process.env.REMOTE_DAEMON_SETUP_LOG;
  if (logPath) {
    appendFileSync(logPath, JSON.stringify({ kind: 'installRemoteFirstPartyComponent', componentId, channel, target }) + '\\n', 'utf-8');
  }
  return { binaryPath: resolveBinaryPath(componentId, channel), versionId: '1.2.3', source: 'https://example.test/payload.tgz' };
}

export function resolveRemoteInstalledFirstPartyBinaryPath({ componentId, channel }) {
  return resolveBinaryPath(componentId, channel);
}
`),
  };

  writeFileSync(
    loaderPath,
    `const stubBySpecifier = ${JSON.stringify(stubBySpecifier)};\nexport async function resolve(specifier, context, defaultResolve) {\n  const stub = stubBySpecifier[specifier];\n  if (stub) return { url: stub, shortCircuit: true };\n  return defaultResolve(specifier, context, defaultResolve);\n}\n`,
    'utf-8',
  );
  writeFileSync(
    registerPath,
    [
      `import { register } from 'node:module';`,
      `register(${JSON.stringify(pathToFileURL(loaderPath).href)}, import.meta.url);`,
      '',
    ].join('\n'),
    'utf-8',
  );
  return { nodeArgs: ['--import', registerPath] };
}

function writeFakeHappier({ tmp }) {
  return writeLoggedJsonBin({
    root: tmp,
    name: 'happier',
    logEnvVar: 'REMOTE_DAEMON_SETUP_LOG',
    body: `
const args = process.argv.slice(2);
const authIdx = args.indexOf('auth');
if (authIdx >= 0 && args[authIdx + 1] === 'approve') {
  process.stdout.write(JSON.stringify({ ok: true }) + "\\n");
  process.exit(0);
}
process.exit(0);
`,
  });
}

export function createRemoteDaemonSetupHarness(t, { prefix, authStatusResponse = { authenticated: false } } = {}) {
  const harness = createSyncLoggedCommandHarness(t, {
    prefix,
    stackRoot,
    scriptName: 'remote_cmd.mjs',
    logEnvVar: 'REMOTE_DAEMON_SETUP_LOG',
    setupBins: ({ tmp }) => {
      const { binDir: sshBinDir } = writeFakeSsh({ tmp, authStatusResponse });
      const { binDir: scpBinDir } = writeFakeScp({ tmp });
      const { binDir: happierBinDir } = writeFakeHappier({ tmp });
      const loader = writeRemoteInstallLoader({ tmp });
      return { binDirs: [sshBinDir, scpBinDir, happierBinDir], nodeArgs: loader.nodeArgs };
    },
  });

  return {
    readInvocationsLog: harness.readLog,
    runRemoteCommand: harness.runCommand,
  };
}
