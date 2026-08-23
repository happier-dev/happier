import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { validateSdkMethodRows } from './generateActions.ts';

test('consumes the built exported Action owner instead of Protocol source internals', async () => {
  const generatorPath = fileURLToPath(new URL('./generateActions.ts', import.meta.url));
  const source = await readFile(generatorPath, 'utf8');
  assert.doesNotMatch(source, /protocol\/src\/actions\/actionSpecs/u);
  assert.match(source, /protocol\/dist\/actions\/index\.js/u);
});

test('rejects reserved generated roots', () => {
  assert.throws(
    () => validateSdkMethodRows([{ actionId: 'safe.action', methodPath: 'execute.now' }]),
    /reserved SDK root/,
  );
});

test('rejects exact and namespace-prefix collisions', () => {
  assert.throws(
    () => validateSdkMethodRows([
      { actionId: 'first', methodPath: 'session.open' },
      { actionId: 'second', methodPath: 'session.open' },
    ]),
    /share SDK method path/,
  );
  assert.throws(
    () => validateSdkMethodRows([
      { actionId: 'first', methodPath: 'session.open' },
      { actionId: 'second', methodPath: 'session.open.now' },
    ]),
    /conflict at SDK namespace/,
  );
});
