import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readTestflightBuildRequest } from './testflight-build-request.mjs';

test('reads the exact EAS build identity from native-build output', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-testflight-request-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'build.json');
  fs.writeFileSync(file, JSON.stringify([{ id: '123e4567-e89b-12d3-a456-426614174000', platform: 'IOS' }]));

  assert.deepEqual(readTestflightBuildRequest({ buildJsonPath: file }), {
    easBuildId: '123e4567-e89b-12d3-a456-426614174000',
    buildNumber: '',
    appVersion: '',
  });
});

test('preserves the native-build skipped result for the dispatch owner', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-testflight-request-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'build.json');
  fs.writeFileSync(file, JSON.stringify({ skipped: true, reason: 'fingerprint unchanged' }));

  assert.deepEqual(readTestflightBuildRequest({ buildJsonPath: file }), {
    skipped: true,
    easBuildId: '',
    buildNumber: '',
    appVersion: '',
  });
});
