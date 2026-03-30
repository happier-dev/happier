import { join } from 'node:path';
import { writeFakeBin } from '../../scripts/testkit/core/fake_bin_harness.mjs';
import { resolveStackRootFromMeta } from '../../scripts/testkit/core/stack_root.mjs';
import { createSyncLoggedCommandHarness } from '../../scripts/testkit/core/sync_logged_command_harness.mjs';

const stackRoot = resolveStackRootFromMeta(import.meta.url);

function writeFakeNpmBin({
  tmp,
  viewVersion = '9.9.9',
  installExitCode = 0,
  installStderr = '',
}) {
  return writeFakeBin({
    root: tmp,
    name: 'npm',
    content: `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const logPath = process.env.NPM_ARGS_LOG;
if (logPath) appendFileSync(logPath, process.argv.slice(2).join(' ') + "\\n", 'utf-8');
const args = process.argv.slice(2);
if (args[0] === 'view') {
  process.stdout.write(String(process.env.NPM_VIEW_VERSION || ${JSON.stringify(viewVersion)}) + "\\n");
  process.exit(0);
}
if (args[0] === 'install') {
  const stderr = process.env.NPM_INSTALL_STDERR;
  if (stderr) process.stderr.write(stderr);
  const exitCode = Number(process.env.NPM_INSTALL_EXIT_CODE || ${JSON.stringify(String(installExitCode))});
  process.exit(Number.isFinite(exitCode) ? exitCode : 0);
}
process.exit(0);
`,
  });
}

export function createSelfUpdateHarness(
  t,
  { prefix, viewVersion = '9.9.9', installExitCode = 0, installStderr = '' }
) {
  const harness = createSyncLoggedCommandHarness(t, {
    prefix,
    stackRoot,
    scriptName: 'self.mjs',
    logEnvVar: 'NPM_ARGS_LOG',
    logFileName: 'npm-args.log',
    timeout: 10000,
    setupBins: ({ tmp }) => {
      const { binDir } = writeFakeNpmBin({ tmp, viewVersion, installExitCode, installStderr });
      return { binDirs: [binDir] };
    },
    extraEnv: {
      NPM_VIEW_VERSION: viewVersion,
      NPM_INSTALL_EXIT_CODE: String(installExitCode),
      NPM_INSTALL_STDERR: installStderr,
    },
  });

  return {
    readNpmArgsLog: harness.readLog,
    runSelfCommand(args, { extraEnv = {} } = {}) {
      return harness.runCommand(args, {
        extraEnv: {
          HAPPIER_STACK_HOME_DIR: join(harness.tmp, 'home'),
          ...extraEnv,
        },
      });
    },
  };
}
