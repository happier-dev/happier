import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRollingAssetPlan } from '../pipeline/github/rolling-release-asset-plan.mjs';

const version = '0.2.11-preview.2';
const products = [
  ['cli', `happier-v${version}-linux-x64.tar.gz`, 'happier-linux-x64.tar.gz'],
  ['stack', `hstack-v${version}-darwin-arm64.tar.gz`, 'hstack-darwin-arm64.tar.gz'],
  ['server', `happier-server-v${version}-windows-x64.tar.gz`, 'happier-server-windows-x64.tar.gz'],
  ['UI web', `happier-ui-web-v${version}-web-any.tar.gz`, 'happier-ui-web-web-any.tar.gz'],
  ['UI desktop installer', `happier-ui-desktop-windows-x86_64-v${version}.exe`, 'happier-ui-desktop-windows-x86_64.exe'],
];

for (const [label, versionedName, stableName] of products) {
  test(`rolling ${label} payload keeps its immutable name and adds a versionless channel alias`, () => {
    const checksumsName = `checksums-product-v${version}.txt`;
    const metadataName = 'latest.json';
    const plan = buildRollingAssetPlan({
      immutableNames: [versionedName, checksumsName, `${checksumsName}.minisig`, metadataName],
      payloadNames: [versionedName, metadataName],
      version,
      rollingTag: 'product-preview',
    });

    assert.deepEqual(
      plan.filter((entry) => entry.sourceName === versionedName).sort((left, right) => left.name.localeCompare(right.name)),
      [
        { name: stableName, sourceName: versionedName },
        { name: versionedName, sourceName: versionedName },
      ].sort((left, right) => left.name.localeCompare(right.name)),
    );
    assert.equal(plan.some((entry) => entry.name === 'checksums-product.txt'), false);
    assert.equal(plan.filter((entry) => entry.name === metadataName).length, 1);
  });
}

test('dev rolling releases retain only immutable filenames', () => {
  const versionedName = `happier-v${version}-linux-x64.tar.gz`;
  assert.deepEqual(buildRollingAssetPlan({
    immutableNames: [versionedName],
    payloadNames: [versionedName],
    version,
    rollingTag: 'cli-dev',
  }), [{ name: versionedName, sourceName: versionedName }]);
});

test('rolling aliases leave signed manifests, signatures, checksum sidecars, and updater metadata canonical', () => {
  const names = [
    `checksums-happier-ui-desktop-v${version}.txt`,
    `checksums-happier-ui-desktop-v${version}.txt.minisig`,
    `happier-ui-desktop-darwin-aarch64-v${version}.app.tar.gz.sig`,
    `happier-ui-desktop-linux-x86_64-v${version}.deb.sha256`,
    'latest.json',
  ];
  const plan = buildRollingAssetPlan({
    immutableNames: names,
    payloadNames: names.slice(2),
    version,
    rollingTag: 'ui-desktop-stable',
  });

  assert.deepEqual(plan, names.map((name) => ({ name, sourceName: name })));
});

test('rolling alias derivation fails closed on a filename collision', () => {
  const versionedName = `happier-v${version}-linux-x64.tar.gz`;
  assert.throws(() => buildRollingAssetPlan({
    immutableNames: [versionedName, 'happier-linux-x64.tar.gz'],
    payloadNames: [versionedName],
    version,
    rollingTag: 'cli-stable',
  }), /collides/i);
});
