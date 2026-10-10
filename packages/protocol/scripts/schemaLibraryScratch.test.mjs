import assert from 'node:assert/strict';
import { rmSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

import { createExternalScratch, requireExternalScratch } from './schemaLibraryScratch.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));

test('rejects checkout directories and outside symlinks back into the checkout', () => {
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
    process.env[variable] = repo;
    assert.throws(() => createExternalScratch(repo, 'happier-schema-forbidden-'), /outside the checkout/);
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  }
});
