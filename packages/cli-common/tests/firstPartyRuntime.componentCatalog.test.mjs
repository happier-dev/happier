import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getFirstPartyComponentCatalogEntry,
  listFirstPartyComponentCatalogEntries,
} from '../dist/firstPartyRuntime/index.js';

test('first-party runtime catalog exposes the expected component identities', () => {
  const ids = listFirstPartyComponentCatalogEntries().map((entry) => entry.id);
  assert.deepEqual(ids, ['happier-cli', 'happier-daemon', 'happier-server', 'hstack']);
});

test('happier daemon shares the cli install root but uses node-runtime-payload', () => {
  const cli = getFirstPartyComponentCatalogEntry('happier-cli');
  const daemon = getFirstPartyComponentCatalogEntry('happier-daemon');

  assert.equal(cli.installRootName, 'cli');
  assert.equal(daemon.installRootName, 'cli');
  assert.equal(cli.runtimeKind, 'binary');
  assert.equal(daemon.runtimeKind, 'node-runtime-payload');
  assert.equal(daemon.nodeEntrypointRelativePath, 'package-dist/index.mjs');
});

test('catalog rejects unknown component ids', () => {
  assert.throws(
    // @ts-expect-error intentional unknown id contract check in runtime JS test
    () => getFirstPartyComponentCatalogEntry('unknown-component'),
    /Unknown first-party component/i,
  );
});
