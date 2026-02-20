import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

function run(args) {
  return spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'pipeline', 'run.mjs'), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

test('pipeline run exposes tauri-validate-updater-pubkey', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'happier-tauri-pubkey-'));
  const configPath = path.join(dir, 'tauri.conf.json');

  await writeFile(
    configPath,
    JSON.stringify(
      {
        plugins: {
          updater: {
            pubkey: '-----BEGIN PUBLIC KEY-----\\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAr\\n-----END PUBLIC KEY-----',
          },
        },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  const res = run(['tauri-validate-updater-pubkey', '--config-path', configPath]);
  assert.equal(res.status, 0, `expected exit 0, got ${res.status} stderr=${res.stderr}`);
});

