import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function resolveRepoRoot() {
  const testDir = resolve(fileURLToPath(import.meta.url), '..');
  return resolve(testDir, '..', '..', '..');
}

function resolveHstackBin(repoRoot) {
  return resolve(repoRoot, 'apps', 'stack', 'bin', 'hstack.mjs');
}

function runHstack(repoRoot, args, extraEnv = {}) {
  const hstackBin = resolveHstackBin(repoRoot);
  return spawnSync(process.execPath, [hstackBin, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
      HAPPIER_STACK_UPDATE_CHECK: '0',
      ...extraEnv,
    },
    encoding: 'utf8',
  });
}

async function writeHappierStub({ dir, logPath }) {
  const binDir = join(dir, 'bin');
  await mkdir(binDir, { recursive: true });
  const stubPath = join(binDir, 'happier');

  const stubSource = [
    '#!/usr/bin/env node',
    "import { appendFileSync } from 'node:fs';",
    '',
    'const logPath = process.env.HAPPIER_STUB_LOG_PATH;',
    'if (logPath) {',
    "  appendFileSync(logPath, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n', 'utf8');",
    '}',
    '',
    'const argv = process.argv.slice(2);',
    "const isRelayHostHelp = argv.length === 3 && argv[0] === 'relay' && argv[1] === 'host' && argv[2] === '--help';",
    'if (isRelayHostHelp) {',
    '  process.exit(0);',
    '}',
    '',
    "const isRelayHostStatusJson = argv.length === 4 && argv[0] === 'relay' && argv[1] === 'host' && argv[2] === 'status' && argv[3] === '--json';",
    'if (isRelayHostStatusJson) {',
    "  process.stdout.write('{\"ok\":true}\\n');",
    '  process.exit(0);',
    '}',
    '',
    'process.exit(0);',
    '',
  ].join('\n');

  await writeFile(stubPath, stubSource, 'utf8');
  await chmod(stubPath, 0o755);

  return { binDir, stubPath };
}

test('hstack self-host forwards to happier relay host when supported', async (t) => {
  const repoRoot = resolveRepoRoot();
  const tempRoot = await mkdtemp(join(tmpdir(), 'hstack-self-host-forward-'));
  t.after(async () => {
    // best-effort cleanup; avoid throwing in after hook
    await import('node:fs/promises').then(({ rm }) => rm(tempRoot, { recursive: true, force: true })).catch(() => {});
  });

  const logPath = join(tempRoot, 'invocations.jsonl');
  const stub = await writeHappierStub({ dir: tempRoot, logPath });

  const res = runHstack(repoRoot, ['self-host', 'status', '--json'], {
    PATH: `${stub.binDir}:${process.env.PATH ?? ''}`,
    HAPPIER_STUB_LOG_PATH: logPath,
  });

  assert.equal(res.status, 0, res.stderr);
  assert.equal(String(res.stdout ?? '').trim(), '{"ok":true}');

  const log = await readFile(logPath, 'utf8');
  assert.match(log, /"argv":\["relay","host","status","--json"\]/);
});

