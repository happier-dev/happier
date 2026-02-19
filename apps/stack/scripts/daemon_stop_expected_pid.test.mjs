import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { stopLocalDaemon } from './daemon.mjs';
import { resolvePreferredStackDaemonStatePaths } from './utils/auth/credentials_paths.mjs';

async function writeStubHappyCli({ cliDir }) {
  await mkdir(join(cliDir, 'bin'), { recursive: true });
  await mkdir(join(cliDir, 'dist'), { recursive: true });
  await writeFile(join(cliDir, 'package.json'), '{}\n', 'utf-8');

  // Ensure stopLocalDaemon launches via dist entrypoint (preferred).
  await writeFile(join(cliDir, 'bin', 'happier.mjs'), 'process.exit(0);\n', 'utf-8');

  const script = `
import { writeFileSync } from 'node:fs';

const markerPath = process.env.MARKER_PATH || '';
const args = process.argv.slice(2);
if (args[0] === 'daemon' && args[1] === 'stop') {
  if (markerPath) {
    writeFileSync(markerPath, 'stopped\\n', 'utf8');
  }
  process.exit(0);
}
process.exit(0);
`.trimStart();

  await writeFile(join(cliDir, 'dist', 'index.mjs'), script, 'utf-8');
  return join(cliDir, 'bin', 'happier.mjs');
}

test('stopLocalDaemon skips stop when expectedPid does not match current daemon state pid', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-stop-daemon-expected-pid-'));
  try {
    const cliDir = join(tmp, 'apps', 'cli');
    const cliHomeDir = join(tmp, 'cli-home');
    const markerPath = join(tmp, 'marker.txt');
    const cliBin = await writeStubHappyCli({ cliDir });

    const internalServerUrl = 'http://127.0.0.1:3005';
    const { statePath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl: internalServerUrl, env: {} });
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({ pid: 222, httpPort: 0 }) + '\n', 'utf-8');

    await stopLocalDaemon({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      expectedPid: 111,
      env: { ...process.env, MARKER_PATH: markerPath },
    });
    assert.equal(existsSync(markerPath), false);

    await stopLocalDaemon({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      expectedPid: 222,
      env: { ...process.env, MARKER_PATH: markerPath },
    });
    assert.equal(existsSync(markerPath), true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

