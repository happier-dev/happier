import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const stackRoot = fileURLToPath(new URL('../..', import.meta.url));

function writeFakeNpmBin({ tmp }) {
  const binDir = join(tmp, 'bin');
  const npmPath = join(binDir, 'npm');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    npmPath,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const logPath = process.env.NPM_ARGS_LOG;
if (logPath) appendFileSync(logPath, process.argv.slice(2).join(' ') + "\\n", 'utf-8');
const args = process.argv.slice(2);
if (args[0] === 'view') {
  process.stdout.write(String(process.env.NPM_VIEW_VERSION || '9.9.9') + "\\n");
  process.exit(0);
}
process.exit(0);
`,
    'utf-8',
  );
  chmodSync(npmPath, 0o755);
  return { binDir, npmPath };
}

export function createSelfUpdateHarness(t, { prefix }) {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  const { binDir } = writeFakeNpmBin({ tmp });
  const logPath = join(tmp, 'npm-args.log');
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function runSelfCommand(args, { extraEnv = {} } = {}) {
    const res = spawnSync(process.execPath, [join('scripts', 'self.mjs'), ...args], {
      cwd: stackRoot,
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
        NPM_ARGS_LOG: logPath,
        NPM_VIEW_VERSION: '9.9.9',
        HAPPIER_STACK_HOME_DIR: join(tmp, 'home'),
        ...extraEnv,
      },
      encoding: 'utf-8',
      timeout: 10000,
    });
    if (res.error) throw res.error;
    return res;
  }

  function readNpmArgsLog() {
    return readFileSync(logPath, 'utf-8');
  }

  return {
    readNpmArgsLog,
    runSelfCommand,
  };
}
