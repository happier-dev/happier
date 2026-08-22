import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { computePluginUiArtifactFileSetSha256DigestV1 } from '@happier-dev/protocol/plugins/ui';

import {
  comparePackedCliArtifactGraphsToAppSource,
} from './audit-packed-plugin-ui-artifact-graphs.mjs';

const TARGETS = Object.freeze([
  Object.freeze({
    packageName: '@happier-dev/plugins-channels',
    packageDirectoryName: 'channels',
    pluginId: 'happier.channels',
    contributionId: 'channels-app-native',
  }),
  Object.freeze({
    packageName: '@happier-dev/plugins-inspector',
    packageDirectoryName: 'inspector',
    pluginId: 'happier.inspector',
    contributionId: 'inspector-app-native',
  }),
]);

async function writeBytes(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

function renderInventorySource(entries) {
  const assetDeclarations = [];
  const artifactBlocks = [];
  let assetIndex = 0;
  for (const entry of entries) {
    const files = [];
    for (const file of entry.files) {
      const assetName = `BUNDLED_PLUGIN_UI_APP_ASSET_${assetIndex++}`;
      assetDeclarations.push(`const ${assetName} = require(${JSON.stringify(`${entry.packageName}/happier-plugin-ui/${file.relativePath}`)});`);
      files.push([
        '      Object.freeze({',
        `        relativePath: ${JSON.stringify(file.relativePath)},`,
        `        asset: ${assetName},`,
        '      }),',
      ].join('\n'));
    }
    artifactBlocks.push([
      '  Object.freeze({',
      `    pluginId: ${JSON.stringify(entry.pluginId)},`,
      `    contributionId: ${JSON.stringify(entry.contributionId)},`,
      '    tier: "reactNative",',
      `    platform: ${JSON.stringify(entry.platform)},`,
      `    digest: ${JSON.stringify(entry.digest)},`,
      '    releaseVersion: "0.0.0",',
      '    files: Object.freeze([',
      ...files,
      '    ]),',
      '  }),',
    ].join('\n'));
  }
  return `${assetDeclarations.join('\n')}\n\nexport const BUNDLED_PLUGIN_UI_APP_ARTIFACTS = Object.freeze([\n${artifactBlocks.join('\n')}\n]);\n`;
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'plugin-ui-artifact-audit-test-'));
  const repositoryRoot = join(root, 'repo');
  const cliPackageRoot = join(root, 'cli', 'package');
  const entriesByPlatform = new Map();

  for (const platform of ['web', 'ios', 'android']) {
    entriesByPlatform.set(platform, []);
  }
  for (const target of TARGETS) {
    const manifestEntries = [];
    for (const platform of ['web', 'ios', 'android']) {
      const base = platform === 'web'
        ? `react-native-web/${target.contributionId}`
        : `react-native/${target.contributionId}/${platform}`;
      const emitted = platform === 'web'
        ? [{ relativePath: `${base}/entry.mjs.bundle`, bytes: Buffer.from(`${target.pluginId}-${platform}`) }]
        : [
            { relativePath: `${base}/${platform}.bundle`, bytes: Buffer.from(`${target.pluginId}-${platform}-bundle`) },
            { relativePath: `${base}/${platform}.bundle.map`, bytes: Buffer.from(JSON.stringify({ version: 3, sources: [`webpack://${target.pluginId}/src/index.ts`] })) },
          ];
      const files = emitted.map(({ relativePath, bytes }) => ({
        relativePath,
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        byteSize: bytes.byteLength,
      }));
      const entry = {
        contributionId: target.contributionId,
        tier: 'reactNative',
        platform,
        entry: emitted[0].relativePath,
        digest: computePluginUiArtifactFileSetSha256DigestV1(emitted),
        files,
        builtWith: {
          bundler: platform === 'web' ? 'vite' : 'repack',
          version: '1.0.0',
        },
        ...(platform === 'web' ? {} : {
          repack: {
            containerName: target.contributionId.replaceAll('-', '_'),
            modulePath: './renderSurface',
            exportName: 'renderSurface',
          },
        }),
        hostUiApiVersion: '1.0.0',
        compat: {
          react: '19.2.0',
          reactNative: '0.83.5',
        },
      };
      manifestEntries.push(entry);
      entriesByPlatform.get(platform).push({ ...target, platform, digest: entry.digest, files });
      for (const { relativePath, bytes } of emitted) {
        await Promise.all([
          writeBytes(join(repositoryRoot, 'packages', 'plugins', target.packageDirectoryName, 'dist', 'happier-plugin-ui', relativePath), bytes),
          writeBytes(join(cliPackageRoot, 'node_modules', ...target.packageName.split('/'), 'dist', 'happier-plugin-ui', relativePath), bytes),
        ]);
      }
    }
    const manifest = Buffer.from(`${JSON.stringify({ version: 1, entries: manifestEntries }, null, 2)}\n`);
    await Promise.all([
      writeBytes(join(repositoryRoot, 'packages', 'plugins', target.packageDirectoryName, 'dist', 'happier-plugin-ui', 'ui-artifacts.json'), manifest),
      writeBytes(join(cliPackageRoot, 'node_modules', ...target.packageName.split('/'), 'dist', 'happier-plugin-ui', 'ui-artifacts.json'), manifest),
    ]);
  }
  for (const [platform, entries] of entriesByPlatform) {
    await writeBytes(
      join(repositoryRoot, 'apps', 'ui', 'sources', 'sync', 'domains', 'plugins', 'availability', `generatedBundledPluginUiArtifacts.${platform}.ts`),
      renderInventorySource(entries),
    );
  }
  return { root, repositoryRoot, cliPackageRoot };
}

test('compares the packed CLI graph to the canonical generated app identities and bytes', async () => {
  const fixture = await createFixture();
  try {
    const result = await comparePackedCliArtifactGraphsToAppSource({
      repositoryRoot: fixture.repositoryRoot,
      cliPackageRoot: fixture.cliPackageRoot,
    });

    assert.equal(result.ok, true);
    assert.equal(result.rows.length, 6);
    for (const row of result.rows) {
      assert.equal(row.manifestEqual, true);
      assert.equal(row.fileEqual, true);
      assert.equal(row.mapEqual, true);
      assert.equal(row.digestEqual, true);
      assert.deepEqual(row.pathLeakFindings, []);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('reports map divergence and an absolute source-map path without weakening other rows', async () => {
  const fixture = await createFixture();
  try {
    const cliMap = join(
      fixture.cliPackageRoot,
      'node_modules',
      '@happier-dev',
      'plugins-channels',
      'dist',
      'happier-plugin-ui',
      'react-native',
      'channels-app-native',
      'ios',
      'ios.bundle.map',
    );
    await writeFile(cliMap, JSON.stringify({ version: 3, sources: ['/private/build/root/src/index.ts'] }));

    const result = await comparePackedCliArtifactGraphsToAppSource({
      repositoryRoot: fixture.repositoryRoot,
      cliPackageRoot: fixture.cliPackageRoot,
    });
    const failed = result.rows.filter((row) => !row.ok);

    assert.equal(result.ok, false);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].target, 'channels');
    assert.equal(failed[0].platform, 'ios');
    assert.equal(failed[0].mapEqual, false);
    assert.equal(failed[0].digestEqual, false);
    assert.deepEqual(failed[0].pathLeakFindings, [{
      representation: 'packedCli',
      relativePath: 'react-native/channels-app-native/ios/ios.bundle.map',
      value: '/private/build/root/src/index.ts',
    }]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects a differently formatted duplicate-first app entry with a wrong loaded asset', async () => {
  const fixture = await createFixture();
  try {
    const inventoryPath = join(
      fixture.repositoryRoot,
      'apps',
      'ui',
      'sources',
      'sync',
      'domains',
      'plugins',
      'availability',
      'generatedBundledPluginUiArtifacts.web.ts',
    );
    const original = await import('node:fs/promises').then(({ readFile }) => readFile(inventoryPath, 'utf8'));
    const duplicateDigest = computePluginUiArtifactFileSetSha256DigestV1([{
      relativePath: 'react-native-web/channels-app-native/entry.mjs.bundle',
      bytes: Buffer.from('happier.channels-web'),
    }]);
    const duplicate = [
      'Object.freeze({ pluginId: "happier.channels", contributionId: "channels-app-native", tier: "reactNative", platform: "web",',
      `  digest: ${JSON.stringify(duplicateDigest)}, releaseVersion: "0.0.0",`,
      '  files: Object.freeze([Object.freeze({ relativePath: "react-native-web/channels-app-native/entry.mjs.bundle", asset: require("@happier-dev/plugins-channels/happier-plugin-ui/wrong-first-entry.mjs.bundle") })]) }),',
    ].join('\n');
    await writeFile(
      inventoryPath,
      original.replace('export const BUNDLED_PLUGIN_UI_APP_ARTIFACTS = Object.freeze([\n', `export const BUNDLED_PLUGIN_UI_APP_ARTIFACTS = Object.freeze([\n${duplicate}\n`),
    );

    await assert.rejects(
      comparePackedCliArtifactGraphsToAppSource({
        repositoryRoot: fixture.repositoryRoot,
        cliPackageRoot: fixture.cliPackageRoot,
      }),
      /exactly one evaluated app inventory entry for channels\/web; received 2/i,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects an undeclared regular file in the packed Plugin UI tree', async () => {
  const fixture = await createFixture();
  try {
    await writeBytes(join(
      fixture.cliPackageRoot,
      'node_modules',
      '@happier-dev',
      'plugins-channels',
      'dist',
      'happier-plugin-ui',
      'react-native-web',
      'channels-app-native',
      'undeclared.js',
    ), Buffer.from('export const undeclared = true;'));

    const result = await comparePackedCliArtifactGraphsToAppSource({
      repositoryRoot: fixture.repositoryRoot,
      cliPackageRoot: fixture.cliPackageRoot,
    });
    const channelsRows = result.rows.filter((row) => row.target === 'channels');

    assert.equal(result.ok, false);
    assert.equal(channelsRows.length, 3);
    for (const row of channelsRows) {
      assert.equal(row.packedTreeCensusEqual, false);
      assert.deepEqual(row.packedTreeUnexpectedFiles, [
        'react-native-web/channels-app-native/undeclared.js',
      ]);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('scans every declared file for a forbidden absolute checkout/build-root string', async () => {
  const fixture = await createFixture();
  try {
    const relativePath = 'react-native-web/channels-app-native/entry.mjs.bundle';
    await writeFile(join(
      fixture.cliPackageRoot,
      'node_modules',
      '@happier-dev',
      'plugins-channels',
      'dist',
      'happier-plugin-ui',
      relativePath,
    ), `export const leakedBuildRoot = ${JSON.stringify(fixture.repositoryRoot)};\n`);

    const result = await comparePackedCliArtifactGraphsToAppSource({
      repositoryRoot: fixture.repositoryRoot,
      cliPackageRoot: fixture.cliPackageRoot,
    });
    const row = result.rows.find((candidate) => (
      candidate.target === 'channels' && candidate.platform === 'web'
    ));

    assert.equal(result.ok, false);
    assert.deepEqual(row.pathLeakFindings, [{
      representation: 'packedCli',
      relativePath,
      value: fixture.repositoryRoot,
    }]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects a source-forged object that imitates the evaluator asset marker', async () => {
  const fixture = await createFixture();
  try {
    const inventoryPath = join(
      fixture.repositoryRoot,
      'apps',
      'ui',
      'sources',
      'sync',
      'domains',
      'plugins',
      'availability',
      'generatedBundledPluginUiArtifacts.web.ts',
    );
    const { readFile } = await import('node:fs/promises');
    const original = await readFile(inventoryPath, 'utf8');
    const forgedSpecifier = '@happier-dev/plugins-channels/happier-plugin-ui/react-native-web/channels-app-native/entry.mjs.bundle';
    await writeFile(
      inventoryPath,
      original.replace(
        'asset: BUNDLED_PLUGIN_UI_APP_ASSET_0,',
        `asset: Object.freeze({ __happierAssetSpecifier: ${JSON.stringify(forgedSpecifier)} }),`,
      ),
    );

    await assert.rejects(
      comparePackedCliArtifactGraphsToAppSource({
        repositoryRoot: fixture.repositoryRoot,
        cliPackageRoot: fixture.cliPackageRoot,
      }),
      /asset marker was not issued by the static evaluator/i,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects a wrong binding re-exported under the inventory export name', async () => {
  const fixture = await createFixture();
  try {
    const inventoryPath = join(
      fixture.repositoryRoot,
      'apps',
      'ui',
      'sources',
      'sync',
      'domains',
      'plugins',
      'availability',
      'generatedBundledPluginUiArtifacts.web.ts',
    );
    const { readFile } = await import('node:fs/promises');
    const original = await readFile(inventoryPath, 'utf8');
    await writeFile(
      inventoryPath,
      original
        .replace(
          'export const BUNDLED_PLUGIN_UI_APP_ARTIFACTS =',
          'const BUNDLED_PLUGIN_UI_APP_ARTIFACTS =',
        )
        .concat('\nconst wrongInventoryBinding = BUNDLED_PLUGIN_UI_APP_ARTIFACTS;\n')
        .concat('export { wrongInventoryBinding as BUNDLED_PLUGIN_UI_APP_ARTIFACTS };\n'),
    );

    await assert.rejects(
      comparePackedCliArtifactGraphsToAppSource({
        repositoryRoot: fixture.repositoryRoot,
        cliPackageRoot: fixture.cliPackageRoot,
      }),
      /unsupported top-level export declaration|must be the directly exported const binding/i,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects a source binding that shadows the require intrinsic spelling', async () => {
  const fixture = await createFixture();
  try {
    const inventoryPath = join(
      fixture.repositoryRoot,
      'apps',
      'ui',
      'sources',
      'sync',
      'domains',
      'plugins',
      'availability',
      'generatedBundledPluginUiArtifacts.web.ts',
    );
    const { readFile } = await import('node:fs/promises');
    const original = await readFile(inventoryPath, 'utf8');
    const firstAssetDeclaration = 'const BUNDLED_PLUGIN_UI_APP_ASSET_0 =';
    await writeFile(
      inventoryPath,
      original.replace(
        firstAssetDeclaration,
        `const require = Object.freeze({});\n${firstAssetDeclaration}`,
      ),
    );

    await assert.rejects(
      comparePackedCliArtifactGraphsToAppSource({
        repositoryRoot: fixture.repositoryRoot,
        cliPackageRoot: fixture.cliPackageRoot,
      }),
      /binding shadows reserved evaluator intrinsic require/i,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects an ambient exported inventory declaration that has no runtime binding', async () => {
  const fixture = await createFixture();
  try {
    const inventoryPath = join(
      fixture.repositoryRoot,
      'apps',
      'ui',
      'sources',
      'sync',
      'domains',
      'plugins',
      'availability',
      'generatedBundledPluginUiArtifacts.web.ts',
    );
    const { readFile } = await import('node:fs/promises');
    const original = await readFile(inventoryPath, 'utf8');
    await writeFile(
      inventoryPath,
      original.replace(
        'export const BUNDLED_PLUGIN_UI_APP_ARTIFACTS =',
        'export declare const BUNDLED_PLUGIN_UI_APP_ARTIFACTS =',
      ),
    );

    await assert.rejects(
      comparePackedCliArtifactGraphsToAppSource({
        repositoryRoot: fixture.repositoryRoot,
        cliPackageRoot: fixture.cliPackageRoot,
      }),
      /inventory declaration must have exactly the export modifier/i,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
