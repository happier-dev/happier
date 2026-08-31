import test from 'node:test';
import assert from 'node:assert/strict';

import { findUnmatchedSourcePaths } from './classify-source-ci-paths.mjs';

test('unknown executable source fails closed while known source and documentation stay selective', () => {
  assert.deepEqual(findUnmatchedSourcePaths({
    changedPaths: [
      'apps/ui/sources/example.ts',
      'scripts/postinstall/shouldRunPostinstall.cjs',
      'docs/ci.md',
    ],
    classifiedPaths: ['apps/ui/sources/example.ts'],
    documentationPaths: ['docs/ci.md'],
  }), ['scripts/postinstall/shouldRunPostinstall.cjs']);

  assert.deepEqual(findUnmatchedSourcePaths({
    changedPaths: ['apps/ui/sources/example.ts', 'docs/ci.md'],
    classifiedPaths: ['apps/ui/sources/example.ts'],
    documentationPaths: ['docs/ci.md'],
  }), []);

  assert.deepEqual(findUnmatchedSourcePaths({
    changedPaths: ['README.md', 'docs/ci.md'],
    classifiedPaths: [],
    documentationPaths: ['README.md', 'docs/ci.md'],
  }), []);
});
