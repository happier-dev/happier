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

function writeFakeSsh({ tmp }) {
  return writeLoggedJsonBin({
    root: tmp,
    name: 'ssh',
    logEnvVar: 'REMOTE_SERVER_SETUP_LOG',
    body: `
const cmd = process.argv.slice(2).join(' ');
if (cmd.includes('uname -s') && cmd.includes('uname -m')) {
  process.stdout.write(JSON.stringify({ platform: 'linux', arch: 'x64' }) + "\\n");
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
    logEnvVar: 'REMOTE_SERVER_SETUP_LOG',
    body: 'process.exit(0);',
  });
}

function writeRemoteInstallLoader({ tmp, logPath }) {
  const loaderPath = join(tmp, 'remote-server-loader.mjs');
  const registerPath = join(tmp, 'remote-server-register-loader.mjs');
  const stubBySpecifier = {
    './utils/remote/install_remote_first_party_component.mjs': toDataUrl(`
import { appendFileSync } from 'node:fs';

function normalizeChannel(channel) {
  return channel === 'publicdev' ? 'dev' : channel === 'preview' ? 'preview' : 'stable';
}

function resolveBinaryPath(componentId, channel) {
  const suffix = normalizeChannel(channel);
  if (componentId === 'hstack') {
    return suffix === 'stable'
      ? '$HOME/.happier/stack/current/hstack'
      : '$HOME/.happier/stack-' + suffix + '/current/hstack';
  }
  return suffix === 'stable'
    ? '$HOME/.happier/cli/current/happier'
    : '$HOME/.happier/cli-' + suffix + '/current/happier';
}

export async function installRemoteFirstPartyComponent({ componentId, channel, target }) {
  const logPath = process.env.REMOTE_SERVER_SETUP_LOG;
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

export function createRemoteServerSetupHarness(t, { prefix }) {
  const harness = createSyncLoggedCommandHarness(t, {
    prefix,
    stackRoot,
    scriptName: 'remote_cmd.mjs',
    logEnvVar: 'REMOTE_SERVER_SETUP_LOG',
    setupBins: ({ tmp, logPath }) => {
      const { binDir: sshBinDir } = writeFakeSsh({ tmp });
      const { binDir: scpBinDir } = writeFakeScp({ tmp });
      const loader = writeRemoteInstallLoader({ tmp, logPath });
      return { binDirs: [sshBinDir, scpBinDir], nodeArgs: loader.nodeArgs };
    },
  });

  return {
    readInvocationsLog: harness.readLog,
    runRemoteCommand: harness.runCommand,
  };
}
