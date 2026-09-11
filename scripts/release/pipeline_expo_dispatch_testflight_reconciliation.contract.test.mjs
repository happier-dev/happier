import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('dispatches the canonical TestFlight recovery workflow with exact source and EAS build identity', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-testflight-dispatch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const buildJson = path.join(dir, 'build.json');
  fs.writeFileSync(buildJson, JSON.stringify({ id: '123e4567-e89b-12d3-a456-426614174000', platform: 'ios' }));

  const output = execFileSync(process.execPath, [
    path.join(repoRoot, 'scripts/pipeline/expo/dispatch-testflight-reconciliation.mjs'),
    '--repository', 'happier-dev/happier',
    '--workflow-ref', 'dev',
    '--source-sha', 'a'.repeat(40),
    '--environment', 'dev',
    '--profile', 'dev',
    '--build-json', buildJson,
    '--dry-run',
  ], { cwd: repoRoot, encoding: 'utf8' });

  assert.match(output, /gh\s+"workflow"\s+"run"\s+"build-ui-mobile-local\.yml"/);
  assert.match(output, /action=retry_testflight_distribution/);
  assert.match(output, /profile=dev/);
  assert.doesNotMatch(output, /profile=publicdev/);
  assert.match(output, /source_ref=/);
  assert.match(output, /retry_testflight_eas_build_id=123e4567-e89b-12d3-a456-426614174000/);
});
