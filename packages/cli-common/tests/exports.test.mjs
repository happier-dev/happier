import test from 'node:test';
import assert from 'node:assert/strict';

test('package export entrypoints load in Node ESM', async () => {
  const links = await import('../dist/links.js');
  assert.equal(typeof links.buildTerminalConnectLinks, 'function');
  assert.equal(typeof links.buildConfigureServerLinks, 'function');

  const root = await import('../dist/index.js');
  assert.equal(typeof root.links.buildTerminalConnectLinks, 'function');
});

