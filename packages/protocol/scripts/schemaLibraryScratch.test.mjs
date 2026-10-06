import assert from 'node:assert/strict';
import { rmSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { createExternalScratch, requireExternalScratch } from './schemaLibraryScratch.mjs';

test('rejects checkout directories and outside symlinks back into the checkout', () => {
  const repo = process.cwd();
  const scratch = createExternalScratch(repo, 'happier-schema-guard-test-');
  try {
    assert.equal(requireExternalScratch(repo, scratch), scratch);
    assert.throws(() => requireExternalScratch(repo, repo), /outside the checkout/);
    assert.throws(() => requireExternalScratch(repo, resolve(repo, 'packages/protocol/scripts')), /outside the checkout/);
    const alias = resolve(scratch, 'checkout-alias');
    symlinkSync(repo, alias, 'junction');
    assert.throws(() => requireExternalScratch(repo, alias), /outside the checkout/);
    assert.throws(() => requireExternalScratch(repo, 'relative-scratch'), /absolute/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('rejects an in-checkout temporary-directory override before creating a scratch directory', () => {
  const variable = process.platform === 'win32' ? 'TEMP' : 'TMPDIR';
  const previous = process.env[variable];
  try {
    process.env[variable] = process.cwd();
    assert.throws(() => createExternalScratch(process.cwd(), 'happier-schema-forbidden-'), /outside the checkout/);
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  }
});
