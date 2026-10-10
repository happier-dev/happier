import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('production dispatches App Store publication without optional TestFlight groups or binary submission', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-dispatch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const buildJson = path.join(dir, 'build.json');
  fs.writeFileSync(buildJson, JSON.stringify({ id: '123e4567-e89b-12d3-a456-426614174000', platform: 'IOS' }));
  const result = spawnSync(process.execPath, ['scripts/pipeline/expo/dispatch-testflight-reconciliation.mjs',
    '--repository', 'happier-dev/happier', '--workflow-ref', 'dev', '--source-sha', 'a'.repeat(40),
    '--environment', 'production', '--profile', 'production', '--build-json', buildJson, '--release-id', '2026-10-07.1', '--dry-run'],
    { cwd: path.resolve(import.meta.dirname, '../../..'), encoding: 'utf8', env: { ...process.env, APP_STORE_CONNECT_PRODUCTION_EXTERNAL_GROUPS: '' } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /action=retry_store_publication/);
  assert.match(result.stdout, /release_notes_id=2026-10-07.1/);
  assert.match(result.stdout, /retry_testflight_eas_build_id=123e4567-e89b-12d3-a456-426614174000/);
  assert.doesNotMatch(result.stdout, /action=build_and_submit/);
});

test('configured production TestFlight distribution stays independent of App Store publication', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-dispatch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const buildJson = path.join(dir, 'build.json');
  fs.writeFileSync(buildJson, JSON.stringify({ id: '123e4567-e89b-12d3-a456-426614174000', platform: 'IOS' }));
  const result = spawnSync(process.execPath, ['scripts/pipeline/expo/dispatch-testflight-reconciliation.mjs',
    '--repository', 'happier-dev/happier', '--workflow-ref', 'dev', '--source-sha', 'a'.repeat(40),
    '--environment', 'production', '--profile', 'production', '--build-json', buildJson, '--release-id', '2026-10-07.1', '--dry-run'],
    { cwd: path.resolve(import.meta.dirname, '../../..'), encoding: 'utf8', env: { ...process.env, APP_STORE_CONNECT_PRODUCTION_EXTERNAL_GROUPS: 'external-testers' } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /action=retry_store_publication/);
  assert.match(result.stdout, /action=retry_testflight_distribution/);
});
