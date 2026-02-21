import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('ui-mobile-release rejects environment/profile mismatches (production env with preview profile)', () => {
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          path.join(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
          'ui-mobile-release',
          '--environment',
          'production',
          '--action',
          'native',
          '--platform',
          'ios',
          '--profile',
          'preview',
          '--native-build-mode',
          'local',
          '--dry-run',
          '--secrets-source',
          'env',
        ],
        {
          cwd: repoRoot,
          env: { ...process.env, EXPO_TOKEN: '' },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30_000,
        },
      ),
    (err) => {
      assert.equal(typeof err, 'object');
      const stderr = /** @type {any} */ (err).stderr?.toString?.() ?? '';
      assert.match(stderr, /--profile/i);
      assert.match(stderr, /production/i);
      assert.match(stderr, /preview/i);
      return true;
    },
  );
});

