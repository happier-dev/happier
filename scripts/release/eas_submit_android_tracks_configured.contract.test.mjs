import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('apps/ui eas.json configures submit.preview.android track without requiring a local key file', () => {
  const raw = fs.readFileSync(path.join(repoRoot, 'apps', 'ui', 'eas.json'), 'utf8');
  const parsed = JSON.parse(raw);
  const android = parsed?.submit?.preview?.android;
  assert.ok(android, 'expected submit.preview.android to exist');
  assert.ok(String(android.track ?? ''), 'expected submit.preview.android.track');
  assert.equal(android.serviceAccountKeyPath ?? undefined, undefined, 'expected no submit.preview.android.serviceAccountKeyPath');
});

test('apps/ui eas.json configures submit.production.android track without requiring a local key file', () => {
  const raw = fs.readFileSync(path.join(repoRoot, 'apps', 'ui', 'eas.json'), 'utf8');
  const parsed = JSON.parse(raw);
  const android = parsed?.submit?.production?.android;
  assert.ok(android, 'expected submit.production.android to exist');
  assert.ok(String(android.track ?? ''), 'expected submit.production.android.track');
  assert.equal(
    android.serviceAccountKeyPath ?? undefined,
    undefined,
    'expected no submit.production.android.serviceAccountKeyPath',
  );
});

