import { writeLoggedJsonBin } from '../../scripts/testkit/core/fake_bin_harness.mjs';
import { resolveStackRootFromMeta } from '../../scripts/testkit/core/stack_root.mjs';
import { createSyncLoggedCommandHarness } from '../../scripts/testkit/core/sync_logged_command_harness.mjs';

const stackRoot = resolveStackRootFromMeta(import.meta.url);

function writeFakeHappier({ tmp }) {
  return writeLoggedJsonBin({
    root: tmp,
    name: 'happier',
    logEnvVar: 'REMOTE_SERVER_SETUP_LOG',
    body: 'process.exit(0);',
  });
}

export function createRemoteServerSetupHarness(t, { prefix }) {
  const harness = createSyncLoggedCommandHarness(t, {
    prefix,
    stackRoot,
    scriptName: 'remote_cmd.mjs',
    logEnvVar: 'REMOTE_SERVER_SETUP_LOG',
    setupBins: ({ tmp }) => {
      const { binDir: happierBinDir } = writeFakeHappier({ tmp });
      return { binDirs: [happierBinDir], nodeArgs: [] };
    },
  });

  return {
    readInvocationsLog: harness.readLog,
    runRemoteCommand: harness.runCommand,
  };
}
