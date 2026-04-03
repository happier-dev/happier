// @ts-check

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('dagger expoAndroidLocalBuild must not use Secret default values (breaks dagger secret resolution)', () => {
  const repoRoot = path.resolve(process.cwd());
  const filePath = path.join(repoRoot, 'dagger', 'src', 'index.ts');
  const src = fs.readFileSync(filePath, 'utf8');

  // Dagger does not support `Secret = dag.setSecret(...)` defaults. It produces a schema warning and
  // can lead to secret arguments resolving as "Missing" even when env vars are present.
  assert.doesNotMatch(
    src,
    /sentryAuthToken:\s*Secret\s*=\s*dag\.setSecret\(/,
  );
});

