import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { classifyChangedPaths, deriveVersionedComponentChanges } from '../pipeline/release/component-registry.mjs';

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(`../../${relativePath}`, import.meta.url), 'utf8'));
}

test('privacy-kit is an attributed private workspace consumed by server and compatibility tests', async () => {
  const [rootPackage, privacyKitPackage, serverPackage, testsPackage, upstreamNotice] = await Promise.all([
    readJson('package.json'),
    readJson('packages/privacy-kit/package.json'),
    readJson('apps/server/package.json'),
    readJson('packages/tests/package.json'),
    readFile(new URL('../../packages/privacy-kit/UPSTREAM.md', import.meta.url), 'utf8'),
  ]);

  assert.ok(rootPackage.workspaces.packages.includes('packages/privacy-kit'));
  assert.equal(privacyKitPackage.name, 'privacy-kit');
  assert.equal(privacyKitPackage.private, true);
  assert.equal(privacyKitPackage.license, 'MIT');
  assert.equal(serverPackage.dependencies['privacy-kit'], '^0.0.25');
  assert.equal(testsPackage.dependencies['privacy-kit'], '^0.0.25');
  assert.match(upstreamNotice, /476fd33b16bb930fec5b52b13303fb919f30f6f3/);
  assert.match(upstreamNotice, /https:\/\/github\.com\/ex3ndr\/privacy-kit/);
});

test('privacy-kit changes trigger only the server release component', () => {
  const classified = classifyChangedPaths(['packages/privacy-kit/src/modules/tokens/persistent.ts']);
  const versioned = deriveVersionedComponentChanges(classified);

  assert.equal(classified.server, true);
  assert.equal(classified.shared, false);
  assert.equal(versioned.server, true);
  assert.equal(versioned.app, false);
  assert.equal(versioned.cli, false);
  assert.equal(versioned.stack, false);
});
