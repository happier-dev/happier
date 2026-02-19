import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('apps/ui eas.json configures submit.preview (iOS)', () => {
  const raw = fs.readFileSync(path.join(repoRoot, 'apps', 'ui', 'eas.json'), 'utf8');
  const parsed = JSON.parse(raw);

  const ios = parsed?.submit?.preview?.ios;
  assert.ok(ios, 'expected submit.preview.ios to exist');
  assert.ok(String(ios.appleId ?? '').includes('@'), 'expected submit.preview.ios.appleId');
  assert.match(String(ios.ascAppId ?? ''), /^\d+$/, 'expected submit.preview.ios.ascAppId');
  assert.match(String(ios.appleTeamId ?? ''), /^[A-Z0-9]+$/, 'expected submit.preview.ios.appleTeamId');
});

