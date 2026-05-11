import test from 'node:test';
import assert from 'node:assert/strict';

import { withPatchedProcessEnv } from './env_scope.mjs';

test('withPatchedProcessEnv maps PATH overrides to Path on Windows', (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(descriptor);
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
  t.after(() => {
    Object.defineProperty(process, 'platform', descriptor);
  });

  const previousPath = process.env.Path;
  const restore = withPatchedProcessEnv(null, { PATH: 'C:\\Tools\\bin' });
  t.after(restore);

  assert.equal(process.env.Path, 'C:\\Tools\\bin');

  restore();
  assert.equal(process.env.Path, previousPath);
});
