import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyEnvOverridesToEnvText,
  mergeSelfHostServerRuntimeEnvText,
  parseEnvOverridesFromArgv,
} from '../scripts/self_host_runtime.mjs';

test('self-host env overrides parse --env and apply overrides to rendered env text', () => {
  const base = [
    'PORT=3005',
    'HAPPIER_DB_PROVIDER=sqlite',
    'DATABASE_URL=file:/tmp/happier.sqlite',
    '',
  ].join('\n');

  const parsed = parseEnvOverridesFromArgv([
    '--env',
    'HAPPIER_DB_PROVIDER=postgres',
    '--env=DATABASE_URL=postgresql://user:pass@db:5432/happier',
  ]);

  assert.deepEqual(parsed.overrides, [
    { key: 'HAPPIER_DB_PROVIDER', value: 'postgres' },
    { key: 'DATABASE_URL', value: 'postgresql://user:pass@db:5432/happier' },
  ]);

  const next = applyEnvOverridesToEnvText(base, parsed.overrides);
  assert.match(next, /HAPPIER_DB_PROVIDER=postgres/);
  assert.match(next, /DATABASE_URL=postgresql:\/\/user:pass@db:5432\/happier/);
  assert.ok(!next.includes('HAPPIER_DB_PROVIDER=sqlite'));
});

test('self-host env overrides reject invalid keys', () => {
  assert.throws(
    () => parseEnvOverridesFromArgv(['--env', 'bad-key=value']),
    /invalid env key/i,
  );
});

test('self-host runtime updates preserve operator-owned database configuration', () => {
  const merged = mergeSelfHostServerRuntimeEnvText({
    baseEnvText: 'HAPPIER_DB_PROVIDER=sqlite\nDATABASE_URL=file:/managed.sqlite\nHAPPIER_FILES_BACKEND=local\n',
    existingEnvText: [
      'HAPPIER_DB_PROVIDER=postgres',
      'DATABASE_URL=postgresql://operator:secret@db.example.test/happier',
      'HAPPIER_FILES_BACKEND=s3',
      '',
    ].join('\n'),
  });

  assert.match(merged, /^HAPPIER_DB_PROVIDER=postgres$/m);
  assert.match(merged, /^DATABASE_URL=postgresql:\/\/operator:secret@db\.example\.test\/happier$/m);
  assert.match(merged, /^HAPPIER_FILES_BACKEND=s3$/m);
});
