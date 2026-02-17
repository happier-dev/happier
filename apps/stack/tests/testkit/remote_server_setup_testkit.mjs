import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const stackRoot = fileURLToPath(new URL('../..', import.meta.url));

function writeFakeBin({ tmp, name, content }) {
  const binDir = join(tmp, 'bin');
  const binPath = join(binDir, name);
  mkdirSync(binDir, { recursive: true });
  writeFileSync(binPath, content, 'utf-8');
  chmodSync(binPath, 0o755);
  return { binDir, binPath };
}

function writeFakeSsh({ tmp }) {
  return writeFakeBin({
    tmp,
    name: 'ssh',
    content: `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const log = process.env.REMOTE_SERVER_SETUP_LOG || '';
if (log) appendFileSync(log, JSON.stringify({ bin: 'ssh', argv: process.argv.slice(2) }) + "\\n", 'utf-8');
process.exit(0);
`,
  });
}

export function createRemoteServerSetupHarness(t, { prefix }) {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  const logPath = join(tmp, 'invocations.log');
  writeFileSync(logPath, '', 'utf-8');
  const { binDir } = writeFakeSsh({ tmp });

  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function runRemoteCommand(args, { extraEnv = {} } = {}) {
    const nodeBinDir = dirname(process.execPath);
    const want = [
      nodeBinDir,
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
    ];
    const injectedPath = `${binDir}${delimiter}${want.join(delimiter)}${delimiter}${process.env.PATH ?? ''}`;

    const res = spawnSync(process.execPath, [join('scripts', 'remote_cmd.mjs'), ...args], {
      cwd: stackRoot,
      env: {
        ...process.env,
        PATH: injectedPath,
        REMOTE_SERVER_SETUP_LOG: logPath,
        ...extraEnv,
      },
      encoding: 'utf-8',
      timeout: 15000,
    });
    if (res.error) throw res.error;
    return res;
  }

  function readInvocationsLog() {
    return readFileSync(logPath, 'utf-8');
  }

  return { runRemoteCommand, readInvocationsLog };
}

