import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildStackHarnessEnv } from './fake_bin_harness.mjs';
import { runNodeCaptureSync } from './run_node_capture.mjs';
import { resolveStackScriptPath } from './stack_root.mjs';
import { createTempFixtureSync } from './temp_fixture.mjs';

export function createSyncLoggedCommandHarness(t, {
  prefix,
  stackRoot,
  scriptName,
  logEnvVar,
  logFileName = 'invocations.log',
  timeout = 15000,
  extraEnv = {},
  setupBins = () => ({ binDirs: [] }),
} = {}) {
  const tmp = createTempFixtureSync(t, { prefix }).root;
  const logPath = join(tmp, logFileName);
  writeFileSync(logPath, '', 'utf-8');

  const setup = setupBins({ tmp, logPath }) ?? {};
  const binDirs = Array.from(new Set((setup.binDirs ?? []).filter(Boolean)));
  const nodeArgs = Array.isArray(setup.nodeArgs) ? setup.nodeArgs.map(String) : [];

  function runCommand(args, { extraEnv: localExtraEnv = {} } = {}) {
    const env = buildStackHarnessEnv({
      baseEnv: process.env,
      binDirs,
      extraEnv: {
        [logEnvVar]: logPath,
        ...extraEnv,
        ...localExtraEnv,
      },
    });
    return runNodeCaptureSync([...nodeArgs, resolveStackScriptPath(stackRoot, scriptName), ...args], {
      cwd: stackRoot,
      env,
      timeout,
    });
  }

  function readLog() {
    return readFileSync(logPath, 'utf-8');
  }

  return { logPath, readLog, runCommand, tmp };
}
