import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findUnmatchedSourcePaths,
  resolveWorkspaceSourceImpacts,
} from './classify-source-ci-paths.mjs';

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

test('workspace dependency closure selects only product consumers of changed packages', () => {
  const manifests = [
    { directory: 'packages/protocol', name: '@happier-dev/protocol', dependencies: [] },
    { directory: 'packages/ui-only', name: '@happier-dev/ui-only', dependencies: ['@happier-dev/protocol'] },
    { directory: 'packages/cli-only', name: '@happier-dev/cli-only', dependencies: [] },
    { directory: 'apps/ui', name: '@happier-dev/app', dependencies: ['@happier-dev/ui-only'] },
    { directory: 'apps/server', name: '@happier-dev/server', dependencies: ['@happier-dev/protocol'] },
    { directory: 'apps/cli', name: '@happier-dev/cli', dependencies: ['@happier-dev/cli-only'] },
    { directory: 'apps/stack', name: '@happier-dev/stack', dependencies: ['@happier-dev/cli-only'] },
  ];

  assert.deepEqual(resolveWorkspaceSourceImpacts({
    changedPaths: ['packages/ui-only/src/render.ts'],
    manifests,
  }), {
    ui: true,
    server: false,
    cli: false,
    stack: false,
    sharedPackages: true,
    unknownWorkspacePaths: [],
  });

  assert.deepEqual(resolveWorkspaceSourceImpacts({
    changedPaths: ['packages/protocol/src/message.ts'],
    manifests,
  }), {
    ui: true,
    server: true,
    cli: false,
    stack: false,
    sharedPackages: true,
    unknownWorkspacePaths: [],
  });
});

test('workspace dependency closure fails closed for a new unmapped package directory', () => {
  assert.deepEqual(resolveWorkspaceSourceImpacts({
    changedPaths: ['packages/new-runtime/src/index.ts'],
    manifests: [
      { directory: 'apps/ui', name: '@happier-dev/app', dependencies: [] },
      { directory: 'apps/server', name: '@happier-dev/server', dependencies: [] },
      { directory: 'apps/cli', name: '@happier-dev/cli', dependencies: [] },
      { directory: 'apps/stack', name: '@happier-dev/stack', dependencies: [] },
    ],
  }), {
    ui: false,
    server: false,
    cli: false,
    stack: false,
    sharedPackages: false,
    unknownWorkspacePaths: ['packages/new-runtime/src/index.ts'],
  });
});
