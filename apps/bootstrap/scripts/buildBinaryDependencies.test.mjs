import assert from 'node:assert/strict';
import test from 'node:test';

import { renderHsetupBundleEntrypoint, resolveHsetupRuntimeDependencyNames } from './buildBinaryDependencies.mjs';

test('hsetup compile closure includes runtime dependencies of its workspace packages', async () => {
  const dependencies = await resolveHsetupRuntimeDependencyNames(new URL('../../..', import.meta.url).pathname);

  assert.ok(dependencies.includes('proper-lockfile'));
  assert.match(renderHsetupBundleEntrypoint({
    dependencyNames: dependencies,
    hsetupEntrypoint: 'file:///repo/apps/bootstrap/src/bin/hsetup.ts',
  }), /import "proper-lockfile";/u);
});
