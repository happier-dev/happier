import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getFirstPartyComponentCatalogEntry,
  listFirstPartyComponentCatalogEntries,
  resolveFirstPartyComponentPublicReleaseVariant,
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

test('cli public release variants resolve rolling tags and side-by-side install metadata', () => {
  const preview = resolveFirstPartyComponentPublicReleaseVariant({
    componentId: 'happier-cli',
    channel: 'preview',
  });
  const publicdev = resolveFirstPartyComponentPublicReleaseVariant({
    componentId: 'happier-cli',
    channel: 'publicdev',
  });

  assert.equal(preview.releaseTag, 'cli-preview');
  assert.equal(preview.installRootName, 'cli-preview');
  assert.deepEqual(preview.installShims, ['hprev']);

  assert.equal(publicdev.releaseTag, 'cli-dev');
  assert.equal(publicdev.installRootName, 'cli-dev');
  assert.deepEqual(publicdev.installShims, ['hdev']);
});
