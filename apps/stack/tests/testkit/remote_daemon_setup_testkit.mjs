import { writeLoggedJsonBin } from '../../scripts/testkit/core/fake_bin_harness.mjs';
import { resolveStackRootFromMeta } from '../../scripts/testkit/core/stack_root.mjs';
import { createSyncLoggedCommandHarness } from '../../scripts/testkit/core/sync_logged_command_harness.mjs';

const stackRoot = resolveStackRootFromMeta(import.meta.url);

function writeFakeSsh({ tmp }) {
  return writeLoggedJsonBin({
    root: tmp,
    name: 'ssh',
    logEnvVar: 'REMOTE_DAEMON_SETUP_LOG',
    body: `
const cmd = process.argv.slice(2).join(' ');
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

export function createRemoteDaemonSetupHarness(t, { prefix }) {
  const harness = createSyncLoggedCommandHarness(t, {
    prefix,
    stackRoot,
    scriptName: 'remote_cmd.mjs',
    logEnvVar: 'REMOTE_DAEMON_SETUP_LOG',
    setupBins: ({ tmp }) => {
      const { binDir: sshBinDir } = writeFakeSsh({ tmp });
      const { binDir: happierBinDir } = writeFakeHappier({ tmp });
      return { binDirs: [sshBinDir, happierBinDir] };
    },
  });

  return {
    readInvocationsLog: harness.readLog,
    runRemoteCommand: harness.runCommand,
  };
}
