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
const scriptPath = path.join(repoRoot, 'scripts', 'pipeline', 'tauri', 'validate-updater-pubkey.mjs');

function run(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

test('validate-updater-pubkey fails when config contains placeholder', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'happier-tauri-pubkey-'));
  const configPath = path.join(dir, 'tauri.conf.json');

  await writeFile(
    configPath,
    JSON.stringify(
      {
        plugins: {
          updater: {
            pubkey: 'REPLACE_WITH_TAURI_UPDATER_PUBLIC_KEY_PEM',
          },
        },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  const res = run(['--config-path', configPath]);
  assert.notEqual(res.status, 0, 'script should exit non-zero for placeholder pubkey');
  assert.match(
    String(res.stderr ?? '') + String(res.stdout ?? ''),
    /REPLACE_WITH_TAURI_UPDATER_PUBLIC_KEY_PEM/,
    'script should explain the placeholder pubkey is invalid',
  );
});

test('validate-updater-pubkey succeeds when config contains a real key', async () => {
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

  const res = run(['--config-path', configPath]);
  assert.equal(res.status, 0, `expected exit 0, got ${res.status} stderr=${res.stderr}`);
});

