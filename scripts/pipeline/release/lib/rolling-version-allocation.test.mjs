import assert from 'node:assert/strict';
import test from 'node:test';

import { isBuildCompleteForPublishSurface } from './rolling-version-allocation.mjs';

const candidate = { run: 4, attempt: 1, version: '0.1.0-preview.4' };

test('requires the final npm dist-tag even for a single-package product', () => {
  const product = { npmPackage: '@happier-dev/sdk' };
  const builds = [{ ...candidate, surface: 'npm', target: '@happier-dev/sdk' }];
  const completion = {
    npmDistTagsByPackage: new Map([
      ['@happier-dev/sdk', { next: '0.1.0-preview.3' }],
    ]),
    finalNpmDistTag: 'next',
  };

  assert.equal(
    isBuildCompleteForPublishSurface(product, builds, candidate, 'npm', completion),
    false,
  );
  completion.npmDistTagsByPackage.set('@happier-dev/sdk', { next: candidate.version });
  assert.equal(
    isBuildCompleteForPublishSurface(product, builds, candidate, 'npm', completion),
    true,
  );
});
