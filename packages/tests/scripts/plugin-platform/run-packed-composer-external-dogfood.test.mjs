import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import * as composerDogfoodRunner from './run-packed-composer-external-dogfood.mjs';

import {
  assertComposerDogfoodPublicOnlySource,
  assertInstalledComposerFixture,
  buildComposerDogfoodSmokeSource,
  buildComposerDogfoodTypeScriptConfigs,
  buildComposerDogfoodConsumerPackageJson,
  buildComposerDogfoodViteEntryDocument,
  resolveComposerDogfoodSupportPackageVersions,
} from './run-packed-composer-external-dogfood.mjs';

test('Composer dogfood uses the shared exact-pair consumer shape plus one packed fixture archive', () => {
  const packageJson = buildComposerDogfoodConsumerPackageJson({
    sdkTarballPath: '/packed/sdk.tgz',
    pluginUiTarballPath: '/packed/plugin-ui.tgz',
    fixtureTarballPath: '/packed/composer-dogfood.tgz',
    supportPackageVersions: { react: '19.2.0' },
  });

  assert.equal(
    packageJson.dependencies['@happier-dev/plugin-sdk'],
    pathToFileURL('/packed/sdk.tgz').href,
  );
  assert.equal(
    packageJson.dependencies['@happier-dev/plugin-ui'],
    pathToFileURL('/packed/plugin-ui.tgz').href,
  );
  assert.equal(
    packageJson.dependencies['happier-composer-external-dogfood'],
    pathToFileURL('/packed/composer-dogfood.tgz').href,
  );
  assert.equal(packageJson.dependencies.react, '19.2.0');
});

test('Composer dogfood resolves its external support set only after an exact installed SDK pair exists', () => {
  assert.equal(typeof resolveComposerDogfoodSupportPackageVersions, 'function');
});

test('Composer dogfood Vite proof provides an entry document for its external module', () => {
  const document = buildComposerDogfoodViteEntryDocument();

  assert.match(document, /<!doctype html>/iu);
  assert.match(
    document,
    /<script type="module" src="\/composer-dogfood-browser-entry\.ts"><\/script>/u,
  );
});

test('Composer dogfood packed smoke proves public staged custody and rejects private package paths', () => {
  const source = buildComposerDogfoodSmokeSource();

  assert.match(source, /ComposerContentHandleV1Schema\.safeParse\(stagedHandle\)/u);
  assert.match(source, /ComposerTransactionV1Schema\.safeParse\(stagedTransaction\)/u);
  assert.match(source, /attachDaemonIssueMediaFromCurrentComposer/u);
  assert.match(source, /prepareForSend/u);
  assert.match(source, /attachIssueMediaFromCurrentComposer/u);
  assert.match(source, /inspectAndReleaseIssueMediaFromCurrentComposer/u);
  for (const privateField of ['path', 'uri', 'base64', 'bytes', 'credential', 'sessionId', 'transferSessionId']) {
    assert.match(source, new RegExp(`\\b${privateField}\\b`, 'u'));
  }
  assert.match(source, /@happier-dev\/plugin-sdk\/src\/definePlugin\.js/u);
  assert.match(source, /@happier-dev\/plugin-ui\/src\/composer\/service\.js/u);
  assert.match(source, /ERR_PACKAGE_PATH_NOT_EXPORTED/u);
  assert.doesNotMatch(source, /workspace:/u);
});

test('Composer dogfood typechecks the installed canonical source in every public resolver mode', () => {
  const configs = buildComposerDogfoodTypeScriptConfigs();
  const expectedFiles = [
    'node_modules/happier-composer-external-dogfood/src/index.mjs',
    'node_modules/happier-composer-external-dogfood/src/issueComposer.mjs',
    'node_modules/happier-composer-external-dogfood/src/issueSurface.mjs',
    'node_modules/happier-composer-external-dogfood/src/uiBuildIdentity.mjs',
  ];

  for (const config of Object.values(configs)) {
    assert.deepEqual(config.files, expectedFiles);
    assert.equal(config.compilerOptions.allowJs, true);
    assert.equal(config.compilerOptions.checkJs, true);
    assert.deepEqual(config.compilerOptions.types, ['react']);
    assert.equal(config.compilerOptions.paths, undefined);
    assert.equal(config.compilerOptions.typeRoots, undefined);
  }
  assert.equal(configs['tsconfig.nodenext.json'].compilerOptions.moduleResolution, 'NodeNext');
  assert.equal(configs['tsconfig.vite.json'].compilerOptions.moduleResolution, 'Bundler');
  assert.deepEqual(
    configs['tsconfig.metro.json'].compilerOptions.customConditions,
    ['react-native'],
  );
});

test('Composer dogfood consumes the one external-author direct tarball validation before any pack work', async () => {
  await assert.rejects(
    composerDogfoodRunner.runPackedComposerExternalDogfood({
      sdkTarballPath: 'relative-sdk.tgz',
      pluginUiTarballPath: '/packed/plugin-ui.tgz',
    }),
    /tarball paths must be absolute/u,
  );
  await assert.rejects(
    composerDogfoodRunner.runPackedComposerExternalDogfood({
      sdkTarballPath: '/packed/same.tgz',
      pluginUiTarballPath: '/packed/same.tgz',
    }),
    /must be distinct files/u,
  );
  await assert.rejects(
    composerDogfoodRunner.runPackedComposerExternalDogfood({
      candidateManifestPath: '/packed/candidate.json',
    }),
    /does not accept a candidate manifest/u,
  );
  await assert.rejects(
    composerDogfoodRunner.runPackedComposerExternalDogfood({
      sdkTarballPath: '/packed/sdk.tgz',
      pluginUiTarballPath: '/packed/plugin-ui.tgz',
      artifactSource: { kind: 'legacy-candidate-adapter' },
    }),
    /does not accept an artifact source/u,
  );
});

test('Composer dogfood installs its exact pair and declared external dependencies before copying and packing source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'composer-dogfood-prepack-pair-'));
  const destinationDir = join(root, 'destination');
  const fixtureBuildRoot = join(root, 'external-fixture');
  const calls = [];
  let exactPrepackPairInstalled = false;
  let exactPrepackPairVerified = false;
  let externalDependenciesInstalled = false;
  try {
    await mkdir(destinationDir, { recursive: true });
    const exactInstalledSupportPackageVersions = {
      react: '77.1.0',
      'react-dom': '77.1.1',
      'react-native': '77.2.0',
      'react-native-web': '77.3.0',
      vite: '77.4.0',
      '@vitejs/plugin-react': '77.5.0',
      '@types/react': '77.6.0',
      '@types/node': '77.7.0',
      '@typescript/native': 'npm:typescript@77.8.0',
      '@callstack/repack': '77.9.0',
      '@react-native-community/cli': '77.10.0',
      '@rspack/core': '77.11.0',
      '@swc/helpers': '77.12.0',
      '@types/react-dom': '77.13.0',
      csstype: '77.14.0',
      zod: '77.15.0',
      'undici-types': '77.16.0',
    };
    const sourcePackageJson = JSON.parse(await readFile(new URL(
      '../../fixtures/plugin-platform/composer-external-dogfood/package.json',
      import.meta.url,
    ), 'utf8'));
    const expectedExternalDependencies = Object.keys({
      ...sourcePackageJson.dependencies,
      ...sourcePackageJson.devDependencies,
    })
      .filter((packageName) => (
        packageName !== '@happier-dev/plugin-sdk'
        && packageName !== '@happier-dev/plugin-ui'
      ))
      .map((packageName) => `${packageName}@${exactInstalledSupportPackageVersions[packageName]}`);

    const fixture = await composerDogfoodRunner.packComposerDogfoodFixture({
      destinationDir,
      fixtureBuildRoot,
      sdkTarballPath: '/packed/sdk.tgz',
      pluginUiTarballPath: '/packed/plugin-ui.tgz',
      createPackSandboxImpl: async () => {
        throw new Error('Composer dogfood must not invoke the repository pack sandbox');
      },
      assertPackedTargetInstallationsImpl: async ({ consumerRoot, expectedPackages }) => {
        assert.equal(exactPrepackPairInstalled, true);
        assert.equal(consumerRoot, fixtureBuildRoot);
        assert.deepEqual(expectedPackages, [
          { packageName: '@happier-dev/plugin-sdk' },
          { packageName: '@happier-dev/plugin-ui' },
        ]);
        exactPrepackPairVerified = true;
        return [
          { packageName: '@happier-dev/plugin-sdk', version: '77.0.0' },
          { packageName: '@happier-dev/plugin-ui', version: '77.0.0' },
        ];
      },
      resolveExternalAuthoringSupportPackageVersionsImpl: async ({ consumerRoot }) => {
        assert.equal(consumerRoot, fixtureBuildRoot);
        assert.equal(exactPrepackPairVerified, true);
        return exactInstalledSupportPackageVersions;
      },
      runNpmImpl: async (args, options) => {
        calls.push({ args, options });
        if (args[0] === 'install') {
          assert.equal(options.cwd, fixtureBuildRoot);
          const packageJson = JSON.parse(await readFile(join(fixtureBuildRoot, 'package.json'), 'utf8'));
          assert.equal(
            packageJson.name,
            'happier-plugin-ui-external-author-bootstrap',
            'fixture source must not be copied until the exact pair and external dependencies are installed',
          );
          if (args.includes('/packed/sdk.tgz')) {
            assert.equal(exactPrepackPairInstalled, false);
            exactPrepackPairInstalled = true;
            return;
          }
          assert.equal(exactPrepackPairInstalled, true);
          assert.equal(exactPrepackPairVerified, true);
          externalDependenciesInstalled = true;
          return;
        }
        assert.equal(
          externalDependenciesInstalled,
          true,
          'fixture prepack must wait for the exact pair and declared external dependencies',
        );
        assert.equal(
          JSON.parse(await readFile(join(fixtureBuildRoot, 'package.json'), 'utf8')).name,
          'happier-composer-external-dogfood',
          'fixture source must be copied only after its external dependencies are installed',
        );
        const materializedManifest = JSON.parse(await readFile(join(fixtureBuildRoot, 'package.json'), 'utf8'));
        for (const [packageName, version] of Object.entries(exactInstalledSupportPackageVersions).filter(
          ([packageName]) => (
            Object.hasOwn(materializedManifest.dependencies ?? {}, packageName)
            || Object.hasOwn(materializedManifest.devDependencies ?? {}, packageName)
          ),
        )) {
          assert.equal(
            materializedManifest.dependencies?.[packageName] ?? materializedManifest.devDependencies?.[packageName],
            version,
            packageName,
          );
        }
        if (args.join(' ') === 'pack') {
          return writeFile(
            join(options.cwd, 'happier-composer-external-dogfood-0.0.0.tgz'),
            'packed fixture bytes',
          );
        }
        return undefined;
      },
    });

    assert.deepEqual(calls.map((call) => call.args), [
      [
        'install',
        '--ignore-scripts',
        '--install-links=true',
        '--omit=peer',
        '--no-audit',
        '--no-fund',
        '--no-package-lock',
        '--no-save',
        '/packed/sdk.tgz',
        '/packed/plugin-ui.tgz',
      ],
      [
        'install',
        '--ignore-scripts',
        '--install-links=true',
        '--omit=peer',
        '--no-audit',
        '--no-fund',
        '--no-package-lock',
        '--no-save',
        ...expectedExternalDependencies,
      ],
      ['pack', '--dry-run'],
      ['pack'],
    ]);
    assert.equal(calls.every((call) => call.options.cwd === fixtureBuildRoot), true);
    assert.equal(fixture.tarballPath, join(destinationDir, 'happier-composer-external-dogfood-0.0.0.tgz'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('installed fixture must resolve SDK and Plugin UI from the exact top-level pair', async () => {
  const root = await mkdtemp(join(tmpdir(), 'composer-dogfood-resolution-'));
  try {
    const consumerRoot = join(root, 'consumer');
    const fixtureRoot = join(consumerRoot, 'node_modules', 'happier-composer-external-dogfood');
    const artifactRoot = join(fixtureRoot, 'dist', 'happier-plugin-ui');
    const artifactManifestPath = join(artifactRoot, 'ui-artifacts.json');
    const artifactEntries = [
      ['web', 'react-native-web/issue-surface-native/entry.mjs.bundle'],
      ['ios', 'react-native/issue-surface-native/ios/ios.bundle'],
      ['android', 'react-native/issue-surface-native/android/android.bundle'],
    ];
    const packageRoots = [
      join(consumerRoot, 'node_modules', '@happier-dev', 'plugin-sdk'),
      join(consumerRoot, 'node_modules', '@happier-dev', 'plugin-ui'),
    ];
    await Promise.all([
      mkdir(fixtureRoot, { recursive: true }),
      mkdir(artifactRoot, { recursive: true }),
      ...packageRoots.map((packageRoot) => mkdir(packageRoot, { recursive: true })),
    ]);
    await Promise.all(packageRoots.map(async (packageRoot) => {
      const name = packageRoot.endsWith('plugin-ui')
        ? '@happier-dev/plugin-ui'
        : '@happier-dev/plugin-sdk';
      await Promise.all([
        writeFile(join(packageRoot, 'package.json'), `${JSON.stringify({
          name,
          version: '0.0.0',
          type: 'module',
          exports: './index.mjs',
        })}\n`),
        writeFile(join(packageRoot, 'index.mjs'), 'export {};\n'),
      ]);
    }));
    await writeFile(join(fixtureRoot, 'package.json'), `${JSON.stringify({
      name: 'happier-composer-external-dogfood',
      version: '0.0.0',
      type: 'module',
      exports: {
        '.': './src/index.mjs',
        './composer': './src/issueComposer.mjs',
        './ui': './src/issueSurface.mjs',
      },
    })}\n`);
    for (const [, relativePath] of artifactEntries) {
      const artifactPath = join(artifactRoot, relativePath);
      await mkdir(join(artifactPath, '..'), { recursive: true });
      await writeFile(artifactPath, 'fixture artifact\n');
    }
    const artifactManifest = {
      version: 1,
      entries: artifactEntries.map(([platform, entry]) => ({
        contributionId: 'issue-surface-native',
        tier: 'reactNative',
        platform,
        entry,
        files: [{ relativePath: entry }],
      })),
    };
    await writeFile(artifactManifestPath, `${JSON.stringify(artifactManifest)}\n`);

    assert.equal(
      await assertInstalledComposerFixture({
        consumerRoot,
        fixtureArtifact: {
          packageName: 'happier-composer-external-dogfood',
          version: '0.0.0',
        },
      }),
      await realpath(fixtureRoot),
    );

    await rm(artifactManifestPath);
    await assert.rejects(
      assertInstalledComposerFixture({
        consumerRoot,
        fixtureArtifact: {
          packageName: 'happier-composer-external-dogfood',
          version: '0.0.0',
        },
      }),
      /generated React Native artifact manifest/u,
    );
    await writeFile(artifactManifestPath, `${JSON.stringify(artifactManifest)}\n`);

    const installedWebArtifactRoot = join(artifactRoot, 'react-native-web');
    const escapedWebArtifactRoot = join(root, 'escaped-react-native-web');
    await mkdir(join(escapedWebArtifactRoot, 'issue-surface-native'), { recursive: true });
    await writeFile(
      join(escapedWebArtifactRoot, 'issue-surface-native', 'entry.mjs.bundle'),
      'escaped fixture artifact\n',
    );
    await rm(installedWebArtifactRoot, { recursive: true, force: true });
    await symlink(escapedWebArtifactRoot, installedWebArtifactRoot, 'dir');
    await assert.rejects(
      assertInstalledComposerFixture({
        consumerRoot,
        fixtureArtifact: {
          packageName: 'happier-composer-external-dogfood',
          version: '0.0.0',
        },
      }),
      /artifact file escapes its generated root/u,
    );
    await rm(installedWebArtifactRoot);
    const restoredWebArtifactPath = join(
      artifactRoot,
      'react-native-web/issue-surface-native/entry.mjs.bundle',
    );
    await mkdir(join(restoredWebArtifactPath, '..'), { recursive: true });
    await writeFile(restoredWebArtifactPath, 'fixture artifact\n');

    const nestedSdkRoot = join(fixtureRoot, 'node_modules', '@happier-dev', 'plugin-sdk');
    await mkdir(nestedSdkRoot, { recursive: true });
    await Promise.all([
      writeFile(join(nestedSdkRoot, 'package.json'), `${JSON.stringify({
        name: '@happier-dev/plugin-sdk',
        version: '0.0.0',
        type: 'module',
        exports: './index.mjs',
      })}\n`),
      writeFile(join(nestedSdkRoot, 'index.mjs'), 'export {};\n'),
    ]);

    await assert.rejects(
      assertInstalledComposerFixture({
        consumerRoot,
        fixtureArtifact: {
          packageName: 'happier-composer-external-dogfood',
          version: '0.0.0',
        },
      }),
      /must resolve .* from the exact top-level tarball installation/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('public-only source boundary admits the published SDK protocol and contribution entrypoints', async () => {
  const root = await mkdtemp(join(tmpdir(), 'composer-dogfood-source-'));
  try {
    const sourceRoot = join(root, 'src');
    await mkdir(sourceRoot);
    await writeFile(join(sourceRoot, 'index.mjs'), [
      "import '@happier-dev/plugin-sdk';",
      "import '@happier-dev/plugin-sdk/protocol';",
      "import '@happier-dev/plugin-sdk/contributions';",
      '',
    ].join('\n'));
    assert.deepEqual(
      await assertComposerDogfoodPublicOnlySource(root),
      { sourceFileCount: 1 },
    );

    await rm(join(sourceRoot, 'index.mjs'));
    await assert.rejects(
      assertComposerDogfoodPublicOnlySource(root),
      /has no source files/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('public-only source boundary confines relative modules to the controlled fixture package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'composer-dogfood-relative-import-'));
  const escapeRoot = await mkdtemp(join(tmpdir(), 'composer-dogfood-relative-escape-'));
  try {
    const sourceRoot = join(root, 'src');
    const sourcePath = join(sourceRoot, 'index.mjs');
    await mkdir(join(sourceRoot, 'nested'), { recursive: true });
    await Promise.all([
      writeFile(sourcePath, 'export const publicValue = true;\n'),
      writeFile(join(sourceRoot, 'nested', 'entry.mjs'), "import '../index.mjs';\n"),
    ]);

    assert.deepEqual(
      await assertComposerDogfoodPublicOnlySource(root),
      { sourceFileCount: 2 },
    );

    await writeFile(
      sourcePath,
      "import '../../@happier-dev/plugin-sdk/dist/private.js';\n",
    );
    await assert.rejects(
      assertComposerDogfoodPublicOnlySource(root),
      /relative module escapes its controlled package root: \.\.\/\.\.\/@happier-dev\/plugin-sdk\/dist\/private\.js/u,
    );

    await Promise.all([
      writeFile(sourcePath, "import '../shared/private.mjs';\n"),
      writeFile(join(escapeRoot, 'private.mjs'), 'export const privateValue = true;\n'),
    ]);
    await symlink(escapeRoot, join(root, 'shared'));
    await assert.rejects(
      assertComposerDogfoodPublicOnlySource(root),
      /relative module escapes its controlled package root: \.\.\/shared\/private\.mjs/u,
    );
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(escapeRoot, { recursive: true, force: true }),
    ]);
  }
});

test('public-only source boundary resolves relative modules with Node ESM URL semantics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'composer-dogfood-encoded-relative-import-'));
  try {
    const sourceRoot = join(root, 'src');
    await mkdir(sourceRoot);
    await writeFile(
      join(sourceRoot, 'index.mjs'),
      "import './%2e%2e/%2e%2e/private.mjs';\n",
    );

    await assert.rejects(
      assertComposerDogfoodPublicOnlySource(root),
      /relative module escapes its controlled package root: \.\/%2e%2e\/%2e%2e\/private\.mjs/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('public-only source boundary resolves a missing relative target through its nearest existing ancestor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'composer-dogfood-missing-relative-import-'));
  const escapeRoot = await mkdtemp(join(tmpdir(), 'composer-dogfood-missing-relative-escape-'));
  try {
    const sourceRoot = join(root, 'src');
    const sourcePath = join(sourceRoot, 'index.mjs');
    await mkdir(sourceRoot);
    await writeFile(sourcePath, "import '../missing/not-created.mjs';\n");

    assert.deepEqual(
      await assertComposerDogfoodPublicOnlySource(root),
      { sourceFileCount: 1 },
    );

    await writeFile(sourcePath, "import '../shared/not-created.mjs';\n");
    await symlink(escapeRoot, join(root, 'shared'));
    await assert.rejects(
      assertComposerDogfoodPublicOnlySource(root),
      /relative module escapes its controlled package root: \.\.\/shared\/not-created\.mjs/u,
    );
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(escapeRoot, { recursive: true, force: true }),
    ]);
  }
});

test('public-only source boundary rejects retired and private SDK entrypoints', async () => {
  const root = await mkdtemp(join(tmpdir(), 'composer-dogfood-private-import-'));
  try {
    const sourceRoot = join(root, 'src');
    await mkdir(sourceRoot);
    const sourcePath = join(sourceRoot, 'index.mjs');
    await writeFile(
      sourcePath,
      [
        "import '@happier-dev/plugin-sdk/protocol-authoring';",
        '',
      ].join('\n'),
    );

    await assert.rejects(
      assertComposerDogfoodPublicOnlySource(root),
      /must use only relative modules and public Plugin SDK\/Plugin UI imports/u,
    );

    await writeFile(sourcePath, "import '@happier-dev/plugin-sdk/src/manifest.js';\n");
    await assert.rejects(
      assertComposerDogfoodPublicOnlySource(root),
      /must use only relative modules and public Plugin SDK\/Plugin UI imports/u,
    );

    await writeFile(sourcePath, "import '@happier-dev/protocol';\n");
    await assert.rejects(
      assertComposerDogfoodPublicOnlySource(root),
      /must use only relative modules and public Plugin SDK\/Plugin UI imports/u,
    );

    await writeFile(sourcePath, "import '@happier-dev/plugin-ui/src/composer/service.js';\n");
    await assert.rejects(
      assertComposerDogfoodPublicOnlySource(root),
      /must use only relative modules and public Plugin SDK\/Plugin UI imports/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Composer dogfood source checks and exact-pair journey are discoverable from packages/tests', async () => {
  const packageManifest = JSON.parse(await readFile(
    new URL('../../package.json', import.meta.url),
    'utf8',
  ));

  assert.equal(
    packageManifest.scripts['test:plugin-platform:packed-composer'],
    'node scripts/plugin-platform/run-packed-composer-external-dogfood.mjs',
  );

  const selfTest = String(packageManifest.scripts['test:scripts:self'] ?? '');
  for (const testPath of [
    'scripts/plugin-platform/run-packed-composer-external-dogfood.test.mjs',
    'fixtures/plugin-platform/composer-external-dogfood/test/public-only.test.mjs',
    'fixtures/plugin-platform/composer-external-dogfood/test/external-semantic.test.mjs',
    'fixtures/plugin-platform/composer-external-dogfood/test/pack-fixture.test.mjs',
  ]) {
    assert.match(selfTest, new RegExp(`\\b${testPath.replaceAll('.', '\\.')}\\b`, 'u'));
  }
});
