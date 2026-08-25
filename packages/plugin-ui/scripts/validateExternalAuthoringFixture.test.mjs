import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { resolveTypeScriptCliInvocation } from '../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';
import * as fixtureHarness from './validateExternalAuthoringFixture.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '../..');
const requireFromPluginUi = createRequire(resolve(packageRoot, 'package.json'));
const requireFromPluginSdk = createRequire(resolve(repositoryRoot, 'packages/plugin-sdk/package.json'));

async function installPackedExternalAuthoringSemanticSurfaceStub(consumerRoot) {
  const packageRoot = join(
    consumerRoot,
    'node_modules',
    '@happier-fixture',
    'external-authoring',
  );
  const entryPath = join(packageRoot, 'dist-node', 'semanticSurface.js');
  await mkdir(dirname(entryPath), { recursive: true });
  await Promise.all([
    writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@happier-fixture/external-authoring',
      version: '0.1.0',
      type: 'module',
      exports: {
        './semantic-surface': './dist-node/semanticSurface.js',
      },
    })),
    writeFile(entryPath, 'export {};\n'),
  ]);
  return entryPath;
}

test('external author fixture bootstraps exact tarballs before its packable author manifest and packed host', () => {
  assert.equal(typeof fixtureHarness.buildExternalAuthoringBootstrapPackageJson, 'function');
  assert.equal(typeof fixtureHarness.buildExternalAuthoringFixturePackageJson, 'function');
  assert.equal(typeof fixtureHarness.buildExternalAuthoringPackedHostPackageJson, 'function');
  assert.equal(typeof fixtureHarness.resolveExternalAuthoringSupportPackageVersions, 'function');

  const bootstrapPackageJson = fixtureHarness.buildExternalAuthoringBootstrapPackageJson({
    sdkTarballPath: '/candidate/happier-dev-plugin-sdk-0.0.0.tgz',
    pluginUiTarballPath: '/candidate/happier-dev-plugin-ui-0.0.0.tgz',
  });
  assert.deepEqual(bootstrapPackageJson.dependencies, {
    '@happier-dev/plugin-sdk': pathToFileURL(resolve('/candidate/happier-dev-plugin-sdk-0.0.0.tgz')).href,
    '@happier-dev/plugin-ui': pathToFileURL(resolve('/candidate/happier-dev-plugin-ui-0.0.0.tgz')).href,
  });
  assert.equal(Object.hasOwn(bootstrapPackageJson, 'devDependencies'), false);

  const authorPackageJson = fixtureHarness.buildExternalAuthoringFixturePackageJson({
    sdkVersion: '0.0.0',
    pluginUiVersion: '0.0.0',
    supportPackageVersions: {
      react: '19.2.0',
    },
  });

  assert.equal(authorPackageJson.name, '@happier-fixture/external-authoring');
  assert.equal(authorPackageJson.private, true);
  assert.equal(authorPackageJson.type, 'module');
  assert.equal(
    authorPackageJson.dependencies['@happier-dev/plugin-sdk'],
    '0.0.0',
  );
  assert.equal(
    authorPackageJson.dependencies['@happier-dev/plugin-ui'],
    '0.0.0',
  );
  assert.equal(
    authorPackageJson.devDependencies.react,
    '19.2.0',
  );
  assert.deepEqual(authorPackageJson.files, ['dist-node', 'dist-vite', 'dist-browser', 'package.json']);
  assert.equal(Object.hasOwn(authorPackageJson, 'src'), false);

  const packedHostPackageJson = fixtureHarness.buildExternalAuthoringPackedHostPackageJson({
    sdkTarballPath: '/candidate/happier-dev-plugin-sdk-0.0.0.tgz',
    pluginUiTarballPath: '/candidate/happier-dev-plugin-ui-0.0.0.tgz',
    authorTarballPath: '/candidate/happier-fixture-external-authoring-0.1.0.tgz',
    supportPackageVersions: {
      react: '19.2.0',
    },
  });
  assert.equal(
    packedHostPackageJson.dependencies['@happier-fixture/external-authoring'],
    pathToFileURL(resolve('/candidate/happier-fixture-external-authoring-0.1.0.tgz')).href,
  );
  assert.equal(
    packedHostPackageJson.dependencies['@happier-dev/plugin-sdk'],
    pathToFileURL(resolve('/candidate/happier-dev-plugin-sdk-0.0.0.tgz')).href,
  );
  assert.equal(packedHostPackageJson.dependencies.react, '19.2.0');
  assert.equal(Object.hasOwn(packedHostPackageJson.dependencies, 'react-test-renderer'), false);
});

test('external author proof accepts only one direct absolute SDK and Plugin UI tarball pair', () => {
  assert.equal(typeof fixtureHarness.parseExternalAuthoringFixtureArgs, 'function');

  assert.deepEqual(
    fixtureHarness.parseExternalAuthoringFixtureArgs([
      '--sdk-tarball',
      '/packed/sdk.tgz',
      '--plugin-ui-tarball',
      '/packed/plugin-ui.tgz',
    ]),
    {
      sdkTarballPath: '/packed/sdk.tgz',
      pluginUiTarballPath: '/packed/plugin-ui.tgz',
    },
  );
  assert.throws(
    () => fixtureHarness.parseExternalAuthoringFixtureArgs(['--sdk-tarball', '/packed/sdk.tgz']),
    /Missing --plugin-ui-tarball/u,
  );
  assert.throws(
    () => fixtureHarness.parseExternalAuthoringFixtureArgs([
      '--sdk-tarball',
      'relative-sdk.tgz',
      '--plugin-ui-tarball',
      '/packed/plugin-ui.tgz',
    ]),
    /must be absolute/u,
  );
  assert.throws(
    () => fixtureHarness.parseExternalAuthoringFixtureArgs([
      '--sdk-tarball',
      '/packed/same.tgz',
      '--plugin-ui-tarball',
      '/packed/same.tgz',
    ]),
    /must be distinct/u,
  );
  assert.throws(
    () => fixtureHarness.parseExternalAuthoringFixtureArgs([
      '--candidate',
      '/packed/candidate.json',
      '--sdk-tarball',
      '/packed/sdk.tgz',
      '--plugin-ui-tarball',
      '/packed/plugin-ui.tgz',
    ]),
    /does not accept --candidate/u,
  );
  assert.throws(
    () => fixtureHarness.parseExternalAuthoringFixtureArgs([
      '--artifact-source',
      'workspace-pack',
      '--sdk-tarball',
      '/packed/sdk.tgz',
      '--plugin-ui-tarball',
      '/packed/plugin-ui.tgz',
    ]),
    /does not accept --artifact-source/u,
  );
});

test('external authoring support versions are projected from the exact installed SDK toolchain packet', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-ui-installed-toolchain-packet-'));
  const consumerRoot = join(root, 'consumer');
  const sdkRoot = join(consumerRoot, 'node_modules', '@happier-dev', 'plugin-sdk');
  const bindings = {
    dependencies: {
      '@happier-dev/plugin-sdk': '77.0.0',
      '@happier-dev/plugin-ui': '77.0.0',
      react: '77.1.0',
      'react-dom': '77.1.1',
      'react-native': '77.2.0',
      'react-native-web': '77.3.0',
    },
    devDependencies: {
      '@callstack/repack': '77.4.0',
      '@react-native-community/cli': '77.5.0',
      '@rspack/core': '77.6.0',
      '@swc/helpers': '77.7.0',
      '@types/node': '77.8.0',
      '@types/react': '77.9.0',
      '@typescript/native': 'npm:typescript@77.10.0',
      '@vitejs/plugin-react': '77.11.0',
      vite: '77.12.0',
    },
    reactNativeCompatibility: {
      hostUiApiVersion: '77.13.0',
      reactVersion: '77.1.0',
      reactNativeVersion: '77.2.0',
      viteVersion: '77.12.0',
    },
    toolchain: { expo: '77.14.0', repack: '77.4.0', runtime: '77' },
  };
  try {
    await mkdir(join(sdkRoot, 'dist', 'ui', 'build'), { recursive: true });
    await Promise.all([
      writeFile(join(consumerRoot, 'package.json'), JSON.stringify({
        name: 'external-authoring-installed-toolchain-consumer',
        private: true,
        type: 'module',
      })),
      writeFile(join(sdkRoot, 'package.json'), JSON.stringify({
        name: '@happier-dev/plugin-sdk',
        version: '77.0.0',
        type: 'module',
        exports: { './ui/build': './dist/ui/build/index.js' },
      })),
      writeFile(
        join(sdkRoot, 'dist', 'ui', 'build', 'index.js'),
        `export const PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1 = ${JSON.stringify(bindings)};\n`,
      ),
    ]);

    const supportPackageVersions = await fixtureHarness.resolveExternalAuthoringSupportPackageVersions({
      consumerRoot,
    });

    for (const [packageName, version] of Object.entries({
      ...bindings.dependencies,
      ...bindings.devDependencies,
    })) {
      if (packageName === '@happier-dev/plugin-sdk' || packageName === '@happier-dev/plugin-ui') continue;
      assert.equal(supportPackageVersions[packageName], version, packageName);
    }
    assert.equal(Object.hasOwn(supportPackageVersions, '@happier-dev/plugin-sdk'), false);
    assert.equal(Object.hasOwn(supportPackageVersions, '@happier-dev/plugin-ui'), false);
    // The only support package the fixture may own is the React DOM declaration set its own
    // browser entry needs. Its spec is the importing package's declared devDependency, never a
    // version resolved out of some other workspace install.
    assert.equal(
      supportPackageVersions['@types/react-dom'],
      JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
        .devDependencies?.['@types/react-dom'],
      'the browser entry must typecheck against the importing package\'s declared React DOM types',
    );
    // `zod`, `undici-types`, and `csstype` belong to the exact candidate's own dependency
    // closure. Installing repository copies of them would let a candidate that fails to declare
    // or ship them still compile in the clean consumer, which is the one defect this fixture
    // exists to catch.
    for (const candidateClosureDependency of ['zod', 'undici-types', 'csstype']) {
      assert.equal(
        Object.hasOwn(supportPackageVersions, candidateClosureDependency),
        false,
        `${candidateClosureDependency} must come from the installed candidate, not the checkout`,
      );
    }
    for (const retiredDependency of [
      'jsdom',
      'react-test-renderer',
      'react-is',
      'scheduler',
      '@types/react-test-renderer',
    ]) {
      assert.equal(Object.hasOwn(supportPackageVersions, retiredDependency), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('external author proof fails closed before install unless both direct tarballs are regular files', async () => {
  assert.equal(typeof fixtureHarness.resolveExternalAuthoringFixtureTarballPaths, 'function');
  const root = await mkdtemp(join(tmpdir(), 'plugin-ui-direct-tarballs-'));
  try {
    const sdkTarballPath = join(root, 'sdk.tgz');
    const pluginUiTarballPath = join(root, 'plugin-ui.tgz');
    await Promise.all([
      writeFile(sdkTarballPath, 'sdk'),
      writeFile(pluginUiTarballPath, 'plugin-ui'),
    ]);
    assert.deepEqual(
      await fixtureHarness.resolveExternalAuthoringFixtureTarballPaths({
        sdkTarballPath,
        pluginUiTarballPath,
      }),
      { sdkTarballPath, pluginUiTarballPath },
    );

    await rm(sdkTarballPath);
    await assert.rejects(
      fixtureHarness.resolveExternalAuthoringFixtureTarballPaths({
        sdkTarballPath,
        pluginUiTarballPath,
      }),
      /SDK tarball does not exist/u,
    );

    await writeFile(sdkTarballPath, 'sdk');
    const linkedPluginUiTarballPath = join(root, 'linked-plugin-ui.tgz');
    await symlink(pluginUiTarballPath, linkedPluginUiTarballPath, 'file');
    await assert.rejects(
      fixtureHarness.resolveExternalAuthoringFixtureTarballPaths({
        sdkTarballPath,
        pluginUiTarballPath: linkedPluginUiTarballPath,
      }),
      /must be an exact regular file/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('external targeted package boundary accepts public SDK/UI imports and rejects private source paths', async () => {
  assert.equal(typeof fixtureHarness.assertExternalTargetedPackagePublicBoundary, 'function');
  const root = await mkdtemp(join(tmpdir(), 'plugin-ui-external-target-boundary-'));
  try {
    const sourceRoot = join(root, 'src');
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: '@happier-fixture/physical-target',
      dependencies: {
        '@happier-dev/plugin-sdk': '0.0.0',
        '@happier-dev/plugin-ui': '0.0.0',
      },
      peerDependencies: { react: '19.2.0' },
    }));
    await writeFile(join(sourceRoot, 'selection.ts'), [
      "import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';",
      "import type { SurfaceContext } from '@happier-dev/plugin-sdk/ui';",
      "import { TargetedSurface } from '@happier-dev/plugin-ui';",
      "export { localValue } from './value.js';",
      'export type FixtureContext = SurfaceContext;',
      'export const parseFixtureManifest = parsePluginManifest;',
      'export const FixtureSurface = TargetedSurface;',
    ].join('\n'));
    await writeFile(join(sourceRoot, 'value.ts'), 'export const localValue = true;\n');

    const acceptedFiles = await fixtureHarness.assertExternalTargetedPackagePublicBoundary({ targetRoot: root });
    assert.equal(acceptedFiles.length, 2);

    await writeFile(
      join(sourceRoot, 'private.ts'),
      "import { definePlugin } from '@happier-dev/plugin-sdk/src/definePlugin.js';\nexport { definePlugin };\n",
    );
    await assert.rejects(
      fixtureHarness.assertExternalTargetedPackagePublicBoundary({ targetRoot: root }),
      /non-public dependency/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('plugin-ui owns the React DOM declarations required by its external author compiler fixture', () => {
  const pluginUiPackage = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const workspaceBrowserPackage = JSON.parse(
    readFileSync(join(repositoryRoot, 'apps/ui/package.json'), 'utf8'),
  );

  assert.equal(
    pluginUiPackage.devDependencies?.['@types/react-dom'],
    workspaceBrowserPackage.devDependencies?.['@types/react-dom'],
    'the importing package, rather than a fixture declaration or sibling typeRoot, owns React DOM types',
  );
  assert.equal(pluginUiPackage.dependencies?.['@types/react-dom'], undefined);
  assert.equal(pluginUiPackage.peerDependencies?.['@types/react-dom'], undefined);
});

test('bounded adversarial packages target the installed public export owners', async () => {
  const adversarialRoot = join(packageRoot, 'fixtures/external-authoring/adversarial');
  const adversaries = [
    {
      directory: 'private-plugin-ui-subpath',
      packageName: '@happier-dev/adversarial-private-plugin-ui-subpath',
      dependencyName: '@happier-dev/plugin-ui',
      privateImport: '@happier-dev/plugin-ui/testing/rnwSemanticAdapter.js',
    },
    {
      directory: 'private-sdk-subpath',
      packageName: '@happier-dev/adversarial-private-sdk-subpath',
      dependencyName: '@happier-dev/plugin-sdk',
      privateImport: '@happier-dev/plugin-sdk/src/manifest.js',
    },
  ];

  for (const adversary of adversaries) {
    const root = join(adversarialRoot, adversary.directory);
    const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const source = await readFile(join(root, 'src/assert-public-export-boundary.mjs'), 'utf8');

    assert.equal(packageJson.name, adversary.packageName);
    assert.equal(packageJson.private, true);
    assert.equal(packageJson.type, 'module');
    assert.equal(packageJson.scripts['test:negative'], 'node ./src/assert-public-export-boundary.mjs');
    assert.equal(packageJson.dependencies[adversary.dependencyName], '0.0.0');
    assert.match(source, new RegExp(adversary.privateImport.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    assert.match(source, /ERR_PACKAGE_PATH_NOT_EXPORTED/u);
  }
});

test('external author compiler lanes do not depend on harness ambient modules or Node globals', () => {
  const fixtureRoot = resolve(packageRoot, 'fixtures/external-authoring');
  const baseConfig = JSON.parse(
    readFileSync(join(fixtureRoot, 'tsconfig.base.json'), 'utf8'),
  );

  assert.deepEqual(
    baseConfig.compilerOptions.types,
    [],
    'automatic @types discovery must not admit Node globals into browser/native author source',
  );
  assert.equal(baseConfig.exclude, undefined);
  assert.equal(
    existsSync(join(fixtureRoot, 'src/jsdom.d.ts')),
    false,
    'the semantic harness must not supply a fake ambient jsdom module',
  );
});

test('external author source compile boundary keeps the complete public Host API seam', () => {
  const fixtureRoot = resolve(packageRoot, 'fixtures/external-authoring');
  const browserSource = readFileSync(join(fixtureRoot, 'src/browser.tsx'), 'utf8');
  const runtimeSource = readFileSync(join(fixtureRoot, 'src/runtime.tsx'), 'utf8');
  const semanticSurfaceSource = readFileSync(join(fixtureRoot, 'src/semanticSurface.tsx'), 'utf8');
  const authoringSource = readFileSync(join(fixtureRoot, 'src/index.ts'), 'utf8');

  for (const publicComposerHostMethod of [
    'activeComposer',
    'readComposer',
    'watchComposer',
    'applyComposer',
    'focusComposer',
    'setComposerDecorations',
    'acquireComposerInputLock',
    'pickComposerMedia',
    'inspectComposerContent',
    'releaseComposerContent',
    'replacePageLocation',
  ]) {
    assert.match(
      browserSource,
      new RegExp(`\\b${publicComposerHostMethod}:\\s*async\\b`, 'u'),
      `the browser fixture must typecheck against PluginUiHostApi.${publicComposerHostMethod}`,
    );
  }

  assert.match(
    browserSource,
    /\bpublishCurrentUiContext:\s*\(\)\s*=>\s*undefined,/u,
    'the browser fixture must model the required synchronous current-UI publication seam without inventing host authority',
  );

  assert.match(runtimeSource, /from '@happier-dev\/plugin-sdk\/manifest'/u);
  assert.match(runtimeSource, /parsePluginManifest\(externalAuthoringManifest\)/u);
  assert.doesNotMatch(runtimeSource, /@happier-dev\/(?:protocol|plugin-sdk\/src|plugin-ui\/src)/u);
  assert.match(semanticSurfaceSource, /\buseComposer\b/u);
  assert.match(semanticSurfaceSource, /\buseComposerView\b/u);
  assert.match(authoringSource, /kind:\s*'composerApply'/u);
  assert.match(authoringSource, /operations:\s*\[\{ kind:\s*'text\.set'/u);
  assert.doesNotMatch(authoringSource, /\bdefineSchema\b/u);
});

test('external author browser fixture remains a public-only Vite surface', () => {
  const fixtureRoot = resolve(packageRoot, 'fixtures/external-authoring');
  const browserEntryPath = join(fixtureRoot, 'src/browser.tsx');
  const browserConfigPath = join(fixtureRoot, 'vite.browser.config.ts');
  const htmlPath = join(fixtureRoot, 'index.html');

  assert.equal(existsSync(browserEntryPath), true, 'the packed browser lane needs an author-owned entry');
  assert.equal(existsSync(browserConfigPath), true, 'the packed browser lane needs its RNW Vite config');
  assert.equal(existsSync(htmlPath), true, 'the packed browser lane needs a browser document entry');

  const browserEntry = readFileSync(browserEntryPath, 'utf8');
  const browserConfig = readFileSync(browserConfigPath, 'utf8');
  const html = readFileSync(htmlPath, 'utf8');

  for (const expectedPublicCapability of [
    'PluginUiProvider',
    'Form',
    'List',
    'Spinner',
    'Tabs',
  ]) {
    assert.match(browserEntry, new RegExp(`\\b${expectedPublicCapability}\\b`, 'u'));
  }
  for (const forbiddenPrivateCapability of [
    'PluginUiProviderInternal',
    'presentationHost',
    '@happier-dev/plugin-ui/src/',
    '@happier-dev/plugin-ui/presentationHost',
  ]) {
    assert.equal(
      browserEntry.includes(forbiddenPrivateCapability),
      false,
      `external browser fixture must not install a private host capability: ${forbiddenPrivateCapability}`,
    );
  }
  assert.match(browserConfig, /react-native-web\/dist\/index\.js/u);
  assert.doesNotMatch(browserConfig, /HAPPIER_PLUGIN_UI_FIXTURE_SOURCE_ALIAS/u);
  assert.doesNotMatch(browserConfig, /workspaceRoot/u);
  assert.match(html, /src="\/src\/browser\.tsx"/u);
  assert.match(
    html,
    /#root\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center/u,
    'the responsive browser shell must center its bounded surface at desktop widths',
  );
});

test('external semantic proof resolves only installed package entries, never workspace source mode', () => {
  const semanticConfig = readFileSync(
    join(packageRoot, 'scripts/externalAuthoringSemanticProof.vitest.config.ts'),
    'utf8',
  );

  assert.doesNotMatch(semanticConfig, /HAPPIER_PLUGIN_UI_EXTERNAL_AUTHORING_SOURCE_MODE/u);
  assert.doesNotMatch(semanticConfig, /packages\/plugin-(?:sdk|ui)\/src/u);
});

test('external semantic proof resolves framework aliases from the clean consumer installation', async () => {
  const consumerRoot = await mkdtemp(join(tmpdir(), 'plugin-ui-semantic-config-'));
  const priorConsumerRoot = process.env.HAPPIER_PLUGIN_UI_EXTERNAL_AUTHORING_ROOT;
  const priorTargetRoot = process.env.HAPPIER_PLUGIN_UI_EXTERNAL_TARGET_ROOT;
  const priorContributorRoot = process.env.HAPPIER_PLUGIN_UI_EXTERNAL_CONTRIBUTOR_ROOT;
  try {
    const packedAuthoringEntry = await installPackedExternalAuthoringSemanticSurfaceStub(consumerRoot);
    process.env.HAPPIER_PLUGIN_UI_EXTERNAL_AUTHORING_ROOT = consumerRoot;
    process.env.HAPPIER_PLUGIN_UI_EXTERNAL_TARGET_ROOT = consumerRoot;
    process.env.HAPPIER_PLUGIN_UI_EXTERNAL_CONTRIBUTOR_ROOT = consumerRoot;
    const { loadConfigFromFile } = await import(requireFromPluginUi.resolve('vite'));
    const loaded = await loadConfigFromFile(
      { command: 'serve', mode: 'test' },
      join(packageRoot, 'scripts/externalAuthoringSemanticProof.vitest.config.ts'),
    );
    const aliases = loaded?.config.resolve?.alias;
    assert.ok(Array.isArray(aliases));
    assert.doesNotMatch(
      readFileSync(join(packageRoot, 'scripts/externalAuthoringSemanticProof.vitest.config.ts'), 'utf8'),
      /apps\/ui\/node_modules/u,
      'the external semantic runner must not borrow framework modules from the repository UI app',
    );

    const frameworkAliases = [
      ['react', resolve(consumerRoot, 'node_modules/react/index.js')],
      ['react/jsx-runtime', resolve(consumerRoot, 'node_modules/react/jsx-runtime.js')],
      ['react/jsx-dev-runtime', resolve(consumerRoot, 'node_modules/react/jsx-dev-runtime.js')],
      ['react-dom/client', resolve(consumerRoot, 'node_modules/react-dom/client.js')],
      ['react-dom', resolve(consumerRoot, 'node_modules/react-dom/index.js')],
      ['react-native', resolve(consumerRoot, 'node_modules/react-native-web/dist/index.js')],
    ];
    for (const [specifier, replacement] of frameworkAliases) {
      const alias = aliases.find((candidate) => (
        candidate.find instanceof RegExp
        && candidate.find.test(specifier)
      ));
      assert.ok(alias, `the semantic proof must alias ${specifier}`);
      assert.equal(
        alias.replacement,
        replacement,
        `the semantic proof must load ${specifier} from the clean consumer installation`,
      );
    }

    const pluginUiAlias = aliases.find((alias) => (
      alias.find instanceof RegExp
      && alias.find.test('@happier-dev/plugin-ui')
    ));
    assert.ok(pluginUiAlias);
    assert.equal(typeof pluginUiAlias.replacement, 'string');

    const pluginUiTestingAlias = aliases.find((alias) => (
      alias.find instanceof RegExp
      && alias.find.test('@happier-dev/plugin-ui/testing')
    ));
    assert.ok(pluginUiTestingAlias);
    assert.equal(
      pluginUiTestingAlias.replacement,
      resolve(consumerRoot, 'node_modules/@happier-dev/plugin-ui/dist/testing/index.js'),
      'the semantic proof must resolve its RNW adapter from the exact installed public entry',
    );

    const externalAuthoringAlias = aliases.find((alias) => alias.find === '@external-authoring/semantic-surface');
    assert.ok(externalAuthoringAlias);
    assert.equal(
      externalAuthoringAlias.replacement,
      await realpath(packedAuthoringEntry),
      'the semantic proof must load the packed author surface through its public export',
    );
    const externalTargetAlias = aliases.find((alias) => alias.find === '@external-authoring/targeted-surface');
    assert.ok(externalTargetAlias);
    assert.equal(
      externalTargetAlias.replacement,
      resolve(consumerRoot, 'dist/surface.js'),
      'the semantic proof must load the physically copied external target build',
    );
    const externalContributorAlias = aliases.find((alias) => (
      alias.find === '@external-authoring/targeted-contributor'
    ));
    assert.ok(externalContributorAlias);
    assert.equal(
      externalContributorAlias.replacement,
      resolve(consumerRoot, 'dist/index.js'),
      'the semantic proof must load the physically copied external contributor build',
    );

    const inline = loaded?.config.test?.server?.deps?.inline;
    assert.equal(inline, true, 'the installed RNW semantic graph must remain in Vite transform scope');
  } finally {
    if (priorConsumerRoot === undefined) {
      delete process.env.HAPPIER_PLUGIN_UI_EXTERNAL_AUTHORING_ROOT;
    } else {
      process.env.HAPPIER_PLUGIN_UI_EXTERNAL_AUTHORING_ROOT = priorConsumerRoot;
    }
    if (priorTargetRoot === undefined) {
      delete process.env.HAPPIER_PLUGIN_UI_EXTERNAL_TARGET_ROOT;
    } else {
      process.env.HAPPIER_PLUGIN_UI_EXTERNAL_TARGET_ROOT = priorTargetRoot;
    }
    if (priorContributorRoot === undefined) {
      delete process.env.HAPPIER_PLUGIN_UI_EXTERNAL_CONTRIBUTOR_ROOT;
    } else {
      process.env.HAPPIER_PLUGIN_UI_EXTERNAL_CONTRIBUTOR_ROOT = priorContributorRoot;
    }
    await rm(consumerRoot, { recursive: true, force: true });
  }
});

test('external semantic framework dependencies resolve physically inside the clean consumer root', async () => {
  assert.equal(typeof fixtureHarness.assertExternalSemanticFrameworkDependencies, 'function');
  const root = await mkdtemp(join(tmpdir(), 'plugin-ui-semantic-framework-'));
  const consumerRoot = join(root, 'consumer');
  const frameworkEntries = [
    'node_modules/react/index.js',
    'node_modules/react/jsx-runtime.js',
    'node_modules/react/jsx-dev-runtime.js',
    'node_modules/react-dom/index.js',
    'node_modules/react-dom/client.js',
    'node_modules/react-native-web/dist/index.js',
  ];
  try {
    for (const entry of frameworkEntries) {
      const target = join(consumerRoot, entry);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, 'export {};');
    }

    await assert.doesNotReject(
      fixtureHarness.assertExternalSemanticFrameworkDependencies({ consumerRoot }),
    );

    const outsideEntry = join(root, 'outside-react.js');
    const consumerReactEntry = join(consumerRoot, 'node_modules/react/index.js');
    await writeFile(outsideEntry, 'export {};');
    await rm(consumerReactEntry);
    await symlink(outsideEntry, consumerReactEntry, 'file');
    await assert.rejects(
      fixtureHarness.assertExternalSemanticFrameworkDependencies({ consumerRoot }),
      /React resolved outside the clean external consumer root/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('external semantic proof honors the external author automatic JSX contract', async () => {
  const consumerRoot = await mkdtemp(join(tmpdir(), 'plugin-ui-semantic-jsx-'));
  const priorConsumerRoot = process.env.HAPPIER_PLUGIN_UI_EXTERNAL_AUTHORING_ROOT;
  const priorTargetRoot = process.env.HAPPIER_PLUGIN_UI_EXTERNAL_TARGET_ROOT;
  const priorContributorRoot = process.env.HAPPIER_PLUGIN_UI_EXTERNAL_CONTRIBUTOR_ROOT;
  try {
    await installPackedExternalAuthoringSemanticSurfaceStub(consumerRoot);
    process.env.HAPPIER_PLUGIN_UI_EXTERNAL_AUTHORING_ROOT = consumerRoot;
    process.env.HAPPIER_PLUGIN_UI_EXTERNAL_TARGET_ROOT = consumerRoot;
    process.env.HAPPIER_PLUGIN_UI_EXTERNAL_CONTRIBUTOR_ROOT = consumerRoot;
    const { loadConfigFromFile } = await import(requireFromPluginUi.resolve('vite'));
    const loaded = await loadConfigFromFile(
      { command: 'serve', mode: 'test' },
      join(packageRoot, 'scripts/externalAuthoringSemanticProof.vitest.config.ts'),
    );
    assert.equal(
      loaded?.config.esbuild?.jsx,
      'automatic',
      'the semantic harness must use the fixture’s react-jsx transform rather than require a global React binding',
    );
  } finally {
    if (priorConsumerRoot === undefined) {
      delete process.env.HAPPIER_PLUGIN_UI_EXTERNAL_AUTHORING_ROOT;
    } else {
      process.env.HAPPIER_PLUGIN_UI_EXTERNAL_AUTHORING_ROOT = priorConsumerRoot;
    }
    if (priorTargetRoot === undefined) {
      delete process.env.HAPPIER_PLUGIN_UI_EXTERNAL_TARGET_ROOT;
    } else {
      process.env.HAPPIER_PLUGIN_UI_EXTERNAL_TARGET_ROOT = priorTargetRoot;
    }
    if (priorContributorRoot === undefined) {
      delete process.env.HAPPIER_PLUGIN_UI_EXTERNAL_CONTRIBUTOR_ROOT;
    } else {
      process.env.HAPPIER_PLUGIN_UI_EXTERNAL_CONTRIBUTOR_ROOT = priorContributorRoot;
    }
    await rm(consumerRoot, { recursive: true, force: true });
  }
});

test('external author browser build requires an entry document and emitted script asset', async () => {
  assert.equal(typeof fixtureHarness.assertExternalAuthoringBrowserOutput, 'function');

  const root = await mkdtemp(join(tmpdir(), 'plugin-ui-browser-output-'));
  try {
    await assert.rejects(
      () => fixtureHarness.assertExternalAuthoringBrowserOutput(root),
      /missing its entry document/u,
    );

    await writeFile(join(root, 'index.html'), '<!doctype html>');
    await mkdir(join(root, 'assets'));
    await assert.rejects(
      () => fixtureHarness.assertExternalAuthoringBrowserOutput(root),
      /emitted script asset/u,
    );

    await writeFile(join(root, 'assets', 'browser-entry.js'), 'export {};');
    await assert.doesNotReject(() => fixtureHarness.assertExternalAuthoringBrowserOutput(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('external author fixture starts a bounded Vite dev server and transforms every public author entry', async () => {
  assert.equal(typeof fixtureHarness.assertExternalAuthoringViteDevServer, 'function');

  const root = await mkdtemp(join(tmpdir(), 'plugin-ui-vite-dev-server-'));
  try {
    await mkdir(join(root, 'src'));
    await Promise.all([
      writeFile(join(root, 'index.html'), '<!doctype html><script type="module" src="/src/entry.ts"></script>\n'),
      writeFile(join(root, 'vite.config.ts'), 'export default {};\n'),
      writeFile(join(root, 'src/entry.ts'), "export const publicValue = 'consumer';\n"),
      writeFile(join(root, 'src/advanced.ts'), "export const trustedTier = 'advanced';\n"),
    ]);

    const proof = await fixtureHarness.assertExternalAuthoringViteDevServer({
      consumerRoot: root,
      configPath: join(root, 'vite.config.ts'),
      entryPaths: ['/src/entry.ts', '/src/advanced.ts'],
      viteModulePath: requireFromPluginUi.resolve('vite'),
    });
    assert.deepEqual(proof.entryPaths, ['/src/entry.ts', '/src/advanced.ts']);
    assert.equal(proof.htmlStatus, 200);
    assert.equal(proof.entriesTransformed, true);

    await writeFile(join(root, 'src/advanced.ts'), "import 'not-an-installed-public-package';\n");
    await assert.rejects(
      () => fixtureHarness.assertExternalAuthoringViteDevServer({
        consumerRoot: root,
        configPath: join(root, 'vite.config.ts'),
        entryPaths: ['/src/entry.ts', '/src/advanced.ts'],
        viteModulePath: requireFromPluginUi.resolve('vite'),
      }),
      /Failed to resolve import|Could not resolve/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('installed target packages must be real out-of-workspace tarball extractions', async () => {
  assert.equal(typeof fixtureHarness.assertPackedTargetInstallations, 'function');

  const root = await mkdtemp(join(tmpdir(), 'plugin-ui-installed-targets-'));
  const consumerRoot = join(root, 'consumer');
  const sdkRoot = join(consumerRoot, 'node_modules/@happier-dev/plugin-sdk');
  const pluginUiRoot = join(consumerRoot, 'node_modules/@happier-dev/plugin-ui');
  try {
    for (const [packageRoot, name] of [
      [sdkRoot, '@happier-dev/plugin-sdk'],
      [pluginUiRoot, '@happier-dev/plugin-ui'],
    ]) {
      await mkdir(packageRoot, { recursive: true });
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name, version: '0.0.0' }));
    }
    await writeFile(
      join(sdkRoot, 'API.md'),
      '# Plugin SDK API surface\n\n> Generated from `api-surface.json`. Do not hand-edit.\n',
    );

    await assert.doesNotReject(() => fixtureHarness.assertPackedTargetInstallations({
      consumerRoot,
      repositoryRoot: '/repo',
      expectedPackages: [
        { packageName: '@happier-dev/plugin-sdk', version: '0.0.0' },
        { packageName: '@happier-dev/plugin-ui', version: '0.0.0' },
      ],
    }));

    const linkedPluginUiRoot = join(root, 'linked-plugin-ui');
    await mkdir(linkedPluginUiRoot);
    await writeFile(
      join(linkedPluginUiRoot, 'package.json'),
      JSON.stringify({ name: '@happier-dev/plugin-ui', version: '0.0.0' }),
    );
    await rm(pluginUiRoot, { recursive: true, force: true });
    await symlink(linkedPluginUiRoot, pluginUiRoot, 'junction');
    await assert.rejects(
      () => fixtureHarness.assertPackedTargetInstallations({
        consumerRoot,
        repositoryRoot: '/repo',
        expectedPackages: [
          { packageName: '@happier-dev/plugin-sdk', version: '0.0.0' },
          { packageName: '@happier-dev/plugin-ui', version: '0.0.0' },
        ],
      }),
      /workspace source/u,
    );
    await rm(pluginUiRoot, { recursive: true, force: true });
    await mkdir(pluginUiRoot, { recursive: true });
    await writeFile(
      join(pluginUiRoot, 'package.json'),
      JSON.stringify({ name: '@happier-dev/plugin-ui', version: '0.0.0' }),
    );

    await mkdir(join(sdkRoot, 'src'));
    await assert.rejects(
      () => fixtureHarness.assertPackedTargetInstallations({
        consumerRoot,
        repositoryRoot: '/repo',
        expectedPackages: [
          { packageName: '@happier-dev/plugin-sdk', version: '0.0.0' },
          { packageName: '@happier-dev/plugin-ui', version: '0.0.0' },
        ],
      }),
      /unexpectedly contains workspace source/u,
    );
    await rm(join(sdkRoot, 'src'), { recursive: true, force: true });

    await assert.rejects(
      () => fixtureHarness.assertPackedTargetInstallations({
        consumerRoot,
        repositoryRoot: root,
        expectedPackages: [
          { packageName: '@happier-dev/plugin-sdk', version: '0.0.0' },
          { packageName: '@happier-dev/plugin-ui', version: '0.0.0' },
        ],
      }),
      /workspace source/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('packed Form declarations keep curated author props independent from SDK Action schemas', async () => {
  assert.equal(typeof fixtureHarness.assertPublicFormPropsAreCurated, 'function');

  const root = await mkdtemp(join(tmpdir(), 'plugin-ui-curated-form-declaration-'));
  const consumerRoot = join(root, 'consumer');
  const pluginUiRoot = join(consumerRoot, 'node_modules/@happier-dev/plugin-ui');
  const componentsRoot = join(pluginUiRoot, 'dist/components');
  const formDeclarationPath = join(componentsRoot, 'Form.d.ts');
  try {
    await mkdir(componentsRoot, { recursive: true });
    await Promise.all([
      writeFile(join(pluginUiRoot, 'package.json'), JSON.stringify({
        name: '@happier-dev/plugin-ui',
        version: '0.0.0',
        exports: {
          './components': {
            types: './dist/components/index.d.ts',
          },
        },
      })),
      writeFile(join(componentsRoot, 'index.d.ts'), "export * from './Form.js';\n"),
      writeFile(formDeclarationPath, [
        '/** Documentation may name optionsSourceId without publishing it. */',
        'type FormOptionValue = string | { service: { pluginId: string; localId: string }; accountId: string };',
        'export type SelectProps = { value?: FormOptionValue };',
        '',
      ].join('\n')),
    ]);

    await assert.doesNotReject(() => fixtureHarness.assertPublicFormPropsAreCurated(consumerRoot));

    await writeFile(formDeclarationPath, [
      "import type { ActionInputOptionValue } from '@happier-dev/plugin-sdk/actions';",
      'export type SelectProps = { value?: ActionInputOptionValue };',
      '',
    ].join('\n'));
    await assert.rejects(
      () => fixtureHarness.assertPublicFormPropsAreCurated(consumerRoot),
      /leaks @happier-dev\/plugin-sdk/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the exact installed SDK package retains the generated author API inventory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-sdk-author-inventory-'));
  const consumerRoot = join(root, 'consumer');
  const sdkRoot = join(consumerRoot, 'node_modules/@happier-dev/plugin-sdk');
  const pluginUiRoot = join(consumerRoot, 'node_modules/@happier-dev/plugin-ui');
  try {
    await Promise.all([
      mkdir(sdkRoot, { recursive: true }),
      mkdir(pluginUiRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(sdkRoot, 'package.json'), JSON.stringify({
        name: '@happier-dev/plugin-sdk',
        version: '0.0.0',
      })),
      writeFile(join(pluginUiRoot, 'package.json'), JSON.stringify({
        name: '@happier-dev/plugin-ui',
        version: '0.0.0',
      })),
    ]);

    await assert.rejects(
      () => fixtureHarness.assertPackedTargetInstallations({
        consumerRoot,
        repositoryRoot: '/repo',
        expectedPackages: [
          { packageName: '@happier-dev/plugin-sdk', version: '0.0.0' },
          { packageName: '@happier-dev/plugin-ui', version: '0.0.0' },
        ],
      }),
      /generated author API inventory/u,
    );

    const sdkPackage = JSON.parse(await readFile(
      join(repositoryRoot, 'packages/plugin-sdk/package.json'),
      'utf8',
    ));
    assert.ok(sdkPackage.files.includes('API.md'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('temporary external fixture state is removed after a failed proof', async () => {
  assert.equal(typeof fixtureHarness.withTemporaryExternalAuthoringRoot, 'function');

  let allocatedRoot = '';
  await assert.rejects(
    () => fixtureHarness.withTemporaryExternalAuthoringRoot(async (root) => {
      allocatedRoot = resolve(root);
      await writeFile(join(root, 'sentinel'), 'temporary');
      throw new Error('fixture failure');
    }),
    /fixture failure/u,
  );
  assert.equal(existsSync(allocatedRoot), false);
});

test('a caller-retained external fixture root must already be empty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-ui-retained-fixture-root-'));
  try {
    const sdkTarballPath = join(root, 'sdk.tgz');
    const pluginUiTarballPath = join(root, 'plugin-ui.tgz');
    await writeFile(join(root, 'unrelated-sentinel'), 'preserve me');
    await Promise.all([
      writeFile(sdkTarballPath, 'sdk'),
      writeFile(pluginUiTarballPath, 'plugin-ui'),
    ]);
    await assert.rejects(
      () => fixtureHarness.runExternalAuthoringFixture({
        sdkTarballPath,
        pluginUiTarballPath,
        temporaryRoot: root,
      }),
      /must be an empty owned directory/u,
    );
    assert.equal(existsSync(join(root, 'unrelated-sentinel')), true);
    assert.equal(existsSync(join(root, 'consumer')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a caller-retained external fixture root cannot resolve into the workspace through a symlink', async () => {
  const externalParent = await mkdtemp(join(tmpdir(), 'plugin-ui-retained-fixture-symlink-'));
  const workspaceRoot = await mkdtemp(join(repositoryRoot, '.plugin-ui-fixture-workspace-root-'));
  const linkedRoot = join(externalParent, 'workspace-root');
  try {
    const sdkTarballPath = join(externalParent, 'sdk.tgz');
    const pluginUiTarballPath = join(externalParent, 'plugin-ui.tgz');
    await Promise.all([
      writeFile(sdkTarballPath, 'sdk'),
      writeFile(pluginUiTarballPath, 'plugin-ui'),
    ]);
    await symlink(workspaceRoot, linkedRoot, 'junction');
    await assert.rejects(
      () => fixtureHarness.runExternalAuthoringFixture({
        sdkTarballPath,
        pluginUiTarballPath,
        temporaryRoot: linkedRoot,
      }),
      /must run outside the workspace/u,
    );
    assert.deepEqual(await readdir(workspaceRoot), []);
  } finally {
    await rm(externalParent, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('public SDK declarations compile for a clean external author without Node ambient types', async () => {
  await fixtureHarness.withTemporaryExternalAuthoringRoot(async (consumerRoot) => {
    await mkdir(join(consumerRoot, 'src'));
    const nodeModulesRoot = join(consumerRoot, 'node_modules');
    for (const packageName of ['plugin-sdk', 'agents', 'protocol']) {
      const sourceRoot = resolve(repositoryRoot, `packages/${packageName}`);
      const installedRoot = join(nodeModulesRoot, '@happier-dev', packageName);
      await mkdir(installedRoot, { recursive: true });
      await cp(join(sourceRoot, 'package.json'), join(installedRoot, 'package.json'));
      await cp(join(sourceRoot, 'dist'), join(installedRoot, 'dist'), {
        recursive: true,
        filter: (source) => lstatSync(source).isDirectory() || source.endsWith('.d.ts'),
      });
    }
    await symlink(
      resolve(repositoryRoot, 'packages/plugin-sdk/node_modules/@happier-dev/protocol/node_modules'),
      join(nodeModulesRoot, '@happier-dev/protocol/node_modules'),
      'dir',
    );
    await symlink(
      dirname(requireFromPluginSdk.resolve('zod/package.json')),
      join(nodeModulesRoot, 'zod'),
      'dir',
    );
    await writeFile(join(consumerRoot, 'package.json'), JSON.stringify({
      name: 'clean-plugin-sdk-declaration-consumer',
      private: true,
      type: 'module',
    }));
    await writeFile(join(consumerRoot, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2022', 'DOM'],
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        skipLibCheck: false,
        noEmit: true,
      },
      include: ['src/**/*.ts'],
    }));
    await writeFile(join(consumerRoot, 'src/index.ts'), [
      "import type { PluginApi } from '@happier-dev/plugin-sdk';",
      'declare const api: PluginApi;',
      'void api;',
      '// @ts-expect-error This clean author intentionally has no ambient Node.js declarations.',
      'type AmbientNodeMustStayUnavailable = NodeJS.ProcessEnv;',
      '',
    ].join('\n'));

    const invocation = resolveTypeScriptCliInvocation({
      repoRoot: repositoryRoot,
      workspaceDir: consumerRoot,
      processExecPath: process.execPath,
    });
    try {
      execFileSync(invocation.command, [
        ...invocation.argsPrefix,
        '--noEmit',
        '-p',
        'tsconfig.json',
      ], {
        cwd: consumerRoot,
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (error) {
      assert.fail([
        'Clean external TypeScript consumer failed to compile the public SDK declaration closure.',
        String(error?.stdout ?? ''),
        String(error?.stderr ?? ''),
      ].filter(Boolean).join('\n'));
    }
  });
});
