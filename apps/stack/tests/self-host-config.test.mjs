import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

function parseJsonLinesBestEffort(stdout) {
  const out = String(stdout ?? '');
  try {
    return JSON.parse(out);
  } catch {
    // fall through
  }
  const lines = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {
      continue;
    }
  }
  return null;
}

function runSelfHost(args, { homeDir }) {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const stackRoot = resolve(testDir, '..');
  const res = spawnSync(process.execPath, [join('scripts', 'self_host.mjs'), ...args], {
    cwd: stackRoot,
    env: {
      ...process.env,
      HOME: homeDir,
    },
    encoding: 'utf-8',
    timeout: 15000,
  });
  if (res.error) throw res.error;
  return res;
}

test('self-host config view prints effective config', (t) => {
  const homeDir = mkdtempSync(join(tmpdir(), 'hstack-selfhost-config-view-'));
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));

  const res = runSelfHost(['config', 'view', '--json'], { homeDir });
  assert.equal(res.status, 0, res.stderr);
  const parsed = parseJsonLinesBestEffort(res.stdout);
  assert.equal(parsed?.ok, true);
  assert.equal(typeof parsed?.paths?.statePath, 'string');
  assert.equal(typeof parsed?.autoUpdate?.enabled, 'boolean');
});

test('self-host config set updates auto-update schedule and env overrides', (t) => {
  const homeDir = mkdtempSync(join(tmpdir(), 'hstack-selfhost-config-set-'));
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));

  const setRes = runSelfHost(
    ['config', 'set', '--no-apply', '--auto-update', '--auto-update-at', '03:15', '--env', 'PORT=3999', '--json'],
    { homeDir },
  );
  assert.equal(setRes.status, 0, setRes.stderr);

  const viewRes = runSelfHost(['config', 'view', '--json'], { homeDir });
  assert.equal(viewRes.status, 0, viewRes.stderr);
  const parsed = parseJsonLinesBestEffort(viewRes.stdout);
  assert.equal(parsed?.autoUpdate?.enabled, true);
  assert.equal(parsed?.autoUpdate?.at, '03:15');
  assert.equal(parsed?.env?.PORT, '3999');
});
