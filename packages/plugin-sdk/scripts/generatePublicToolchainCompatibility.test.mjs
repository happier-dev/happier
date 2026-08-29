import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  derivePublicToolchainCompatibilityV1,
  renderPublicToolchainCompatibilityModule,
} from './generatePublicToolchainCompatibility.mjs';

const GENERATOR_PATH = fileURLToPath(new URL('./generatePublicToolchainCompatibility.mjs', import.meta.url));

test('consumes executable Protocol facts instead of parsing TypeScript source', async () => {
  const source = await readFile(GENERATOR_PATH, 'utf8');
  assert.doesNotMatch(source, /readProtocolNumber|readProtocolString|readBundlerDescriptor/u);
  assert.doesNotMatch(source, /protocol\/src\/(?:plugins|installables)/u);
  assert.match(source, /dist\/plugins\/publicToolchainFactsV1\.js/u);
});

async function writeJson(path, value) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeSource(path, source) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, source, 'utf8');
}

async function createFixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), 'happier-public-toolchain-'));
  await writeJson(join(root, 'package.json'), {
    devDependencies: {
      '@typescript/native': 'npm:typescript@7.0.2',
      typescript: '5.9.3',
    },
  });
  await writeJson(join(root, 'apps', 'cli', 'package.json'), {
    name: '@happier-dev/cli',
    version: '0.2.10',
  });
  await writeJson(join(root, 'apps', 'ui', 'package.json'), {
    dependencies: {
      expo: '^55.0.0',
      react: '19.2.0',
      'react-dom': '19.2.0',
      'react-native': '0.83.5',
      'react-native-web': '^0.21.0',
    },
  });
  await writeJson(join(root, 'packages', 'plugin-sdk', 'package.json'), {
    name: '@happier-dev/plugin-sdk',
    version: '0.2.10',
    dependencies: { '@types/node': '>=20' },
    devDependencies: {
      '@callstack/repack': '5.2.5',
      '@react-native-community/cli': '20.1.2',
      '@rspack/core': '2.1.3',
      '@swc/helpers': '0.5.23',
      '@types/react': '19.2.0',
      '@vitejs/plugin-react': '4.7.0',
      react: '19.2.0',
      'react-native': '0.83.5',
      'react-native-web': '0.21.2',
      vite: '7.3.1',
    },
    bin: { 'happier-plugin-build-ui': './dist/ui/build/bin.js' },
  });
  await writeJson(join(root, 'packages', 'plugin-ui', 'package.json'), {
    name: '@happier-dev/plugin-ui',
    version: '0.2.10',
    dependencies: { '@happier-dev/plugin-sdk': '0.2.10' },
    devDependencies: { 'react-native': '0.83.5' },
  });
  await writeJson(join(root, 'packages', 'tests', 'fixtures', 'plugin-platform', 'composer-external-dogfood', 'package.json'), {
    name: 'happier-composer-external-dogfood',
    version: '0.0.0',
    dependencies: {
      '@happier-dev/plugin-sdk': '0.0.0',
      '@happier-dev/plugin-ui': '0.0.0',
      react: '0.0.0',
      'react-dom': '0.0.0',
      'react-native': '0.0.0',
      'react-native-web': '0.0.0',
    },
    devDependencies: {
      '@callstack/repack': '0.0.0',
      '@react-native-community/cli': '0.0.0',
      '@rspack/core': '0.0.0',
      '@swc/helpers': '0.0.0',
      '@types/node': '0.0.0',
      '@types/react': '0.0.0',
      '@typescript/native': '0.0.0',
      '@vitejs/plugin-react': '0.0.0',
      vite: '0.0.0',
    },
  });
  await writeJson(join(root, 'packages', 'tests', 'fixtures', 'plugin-platform', 'packed-targeted-contribution-projection', 'contributor', 'package.json'), {
    name: 'packed-targeted-projection-contributor',
    devDependencies: {
      typescript: '0.0.0',
    },
  });
  await mkdir(join(root, 'packages', 'protocol', 'src', 'plugins', 'ui'), { recursive: true });
  await writeFile(join(root, 'packages', 'protocol', 'src', 'plugins', 'manifest', 'v2.ts'), "export const PLUGIN_RUNTIME_API_VERSION = 1 as const;\n", 'utf8').catch(async () => {
    await mkdir(join(root, 'packages', 'protocol', 'src', 'plugins', 'manifest'), { recursive: true });
    await writeFile(join(root, 'packages', 'protocol', 'src', 'plugins', 'manifest', 'v2.ts'), "export const PLUGIN_RUNTIME_API_VERSION = 1 as const;\n", 'utf8');
  });
  await writeFile(
    join(root, 'packages', 'protocol', 'src', 'plugins', 'ui', 'hostApiDefinition.ts'),
    "export const PLUGIN_UI_HOST_API_VERSION_V1 = '1.0.0' as const;\n",
    'utf8',
  );
  await writeFile(
    join(root, 'packages', 'protocol', 'src', 'plugins', 'ui', 'hostApi.ts'),
    "export * from './hostApiDefinition.js';\n",
    'utf8',
  );
  await writeFile(join(root, 'packages', 'protocol', 'src', 'plugins', 'ui', 'uiArtifactsManifest.ts'), 'export const PLUGIN_UI_ARTIFACT_GRAMMAR_VERSION_V1 = 1 as const;\n', 'utf8');
  await writeFile(join(root, 'packages', 'protocol', 'src', 'installables', 'definitions', 'pluginUiBundlers.ts'), [
    'export const PLUGIN_UI_BUNDLER_VITE_INSTALLABLE_DESCRIPTOR = {',
    "packageName: 'vite',",
    "commands: ['vite'],",
    '};',
    'export const PLUGIN_UI_BUNDLER_REPACK_INSTALLABLE_DESCRIPTOR = {',
    "packageName: '@callstack/repack',",
    "commands: ['react-native'],",
    '};',
    '',
  ].join('\n'), 'utf8').catch(async () => {
    await mkdir(join(root, 'packages', 'protocol', 'src', 'installables', 'definitions'), { recursive: true });
    await writeFile(join(root, 'packages', 'protocol', 'src', 'installables', 'definitions', 'pluginUiBundlers.ts'), [
      'export const PLUGIN_UI_BUNDLER_VITE_INSTALLABLE_DESCRIPTOR = {',
      "packageName: 'vite',",
      "commands: ['vite'],",
      '};',
      'export const PLUGIN_UI_BUNDLER_REPACK_INSTALLABLE_DESCRIPTOR = {',
      "packageName: '@callstack/repack',",
      "commands: ['react-native'],",
      '};',
      '',
    ].join('\n'), 'utf8');
  });
  await mkdir(join(root, 'packages', 'protocol', 'dist', 'plugins'), { recursive: true });
  await writeFile(
    join(root, 'packages', 'protocol', 'dist', 'plugins', 'publicToolchainFactsV1.js'),
    [
      'export const PUBLIC_TOOLCHAIN_PROTOCOL_FACTS_V1 = Object.freeze({',
      '  runtimeApiVersion: 1,',
      "  ui: Object.freeze({ artifactGrammarVersion: 1, hostApiVersion: '1.0.0' }),",
      "  bundlers: Object.freeze({ vite: Object.freeze({ packageName: 'vite', executable: 'vite' }), repack: Object.freeze({ packageName: '@callstack/repack', executable: 'react-native' }) }),",
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(join(root, 'yarn.lock'), [
    'react-native@0.83.5:',
    '  version "0.83.5"',
    'react-native-web@^0.21.0, react-native-web@0.21.2:',
    '  version "0.21.2"',
    'expo@^55.0.0:',
    '  version "55.0.11"',
    'vite@7.3.1:',
    '  version "7.3.1"',
    '"@callstack/repack@5.2.5":',
    '  version "5.2.5"',
    '"@react-native-community/cli@20.1.2":',
    '  version "20.1.2"',
    '"@rspack/core@2.1.3":',
    '  version "2.1.3"',
    '"@swc/helpers@0.5.23":',
    '  version "0.5.23"',
    '"@types/react@19.2.0":',
    '  version "19.2.0"',
    '"@types/node@>=20":',
    '  version "25.0.10"',
    '"@typescript/native@npm:typescript@7.0.2":',
    '  version "7.0.2"',
    'typescript@5.9.3:',
    '  version "5.9.3"',
    '"@vitejs/plugin-react@4.7.0":',
    '  version "4.7.0"',
    'react@19.2.0:',
    '  version "19.2.0"',
    'react-dom@19.2.0:',
    '  version "19.2.0"',
    '',
  ].join('\n'), 'utf8');
  await Promise.all([
    writeSource(
      join(root, 'apps', 'cli', 'src', 'plugins', 'scaffold', 'scaffold.ts'),
      'const binding = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1;\nvoid binding;\n',
    ),
    writeSource(
      join(root, 'packages', 'plugin-ui', 'fixtures', 'external-authoring', 'src', 'Surface.tsx'),
      'const binding = PUBLIC_TOOLCHAIN_COMPATIBILITY_V1;\nvoid binding;\n',
    ),
    writeSource(
      join(root, 'packages', 'plugin-ui', 'fixtures', 'external-authoring', 'src', 'runtime.tsx'),
      'const binding = PUBLIC_TOOLCHAIN_COMPATIBILITY_V1;\nvoid binding;\n',
    ),
    writeSource(
      join(root, 'packages', 'tests', 'pluginSdkConsumers', 'run-probes.mjs'),
      'const binding = PUBLIC_TOOLCHAIN_COMPATIBILITY_V1;\nvoid binding;\n',
    ),
    writeSource(
      join(root, 'packages', 'tests', 'fixtures', 'plugin-platform', 'composer-external-dogfood', 'src', 'index.mjs'),
      'const binding = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1;\nvoid binding;\n',
    ),
    writeSource(
      join(root, 'packages', 'tests', 'scripts', 'plugin-platform', 'run-packed-composer-external-dogfood.mjs'),
      'const binding = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1;\nvoid binding;\n',
    ),
    writeSource(
      join(root, 'packages', 'plugin-sdk', 'examples', 'advanced-package-root', 'index.ts'),
      'const binding = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1;\nvoid binding;\n',
    ),
    writeSource(
      join(root, 'packages', 'plugin-sdk', 'examples', 'code-defined', 'index.ts'),
      'const binding = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1;\nvoid binding;\n',
    ),
    writeSource(
      join(root, 'packages', 'plugin-sdk', 'examples', 'multi-mode-fallback', 'build', 'vite.panel-native.config.ts'),
      'const binding = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1;\nvoid binding;\n',
    ),
    writeSource(
      join(root, 'packages', 'plugin-sdk', 'examples', 'public-authoring', 'build', 'vite.review-native.config.mjs'),
      'const binding = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1;\nvoid binding;\n',
    ),
    writeSource(
      join(root, 'packages', 'plugin-sdk', 'examples', 'public-authoring', 'build', 'vite.voice-runtime-web.config.mjs'),
      'const binding = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1;\nvoid binding;\n',
    ),
    writeSource(
      join(root, 'packages', 'plugin-sdk', 'examples', 'react-native-dev-hot-reload', 'vite.config.mjs'),
      'const binding = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1;\nvoid binding;\n',
    ),
    writeSource(
      join(root, 'packages', 'plugin-sdk', 'examples', 'react-native-installed', 'vite.config.mjs'),
      'const binding = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1;\nvoid binding;\n',
    ),
    writeSource(
      join(root, 'apps', 'docs', 'content', 'docs', 'plugins', 'packaging', 'versioning-compat.mdx'),
      [
        '{/* public-toolchain-compatibility:versioning-facts:start */}',
        '{/* public-toolchain-compatibility:versioning-facts:end */}',
        '',
      ].join('\n'),
    ),
    writeSource(
      join(root, 'apps', 'docs', 'content', 'docs', 'plugins', 'manifest', 'index.mdx'),
      [
        '{/* public-toolchain-compatibility:manifest-example:start */}',
        '{/* public-toolchain-compatibility:manifest-example:end */}',
        '',
      ].join('\n'),
    ),
  ]);
  await mkdir(join(root, 'packages', 'plugin-sdk', 'src', 'ui', 'build'), { recursive: true });
  const generated = spawnSync(process.execPath, [GENERATOR_PATH, '--repo-root', root, '--write'], {
    encoding: 'utf8',
  });
  assert.equal(generated.status, 0, generated.stderr);
  return root;
}

test('derives the one public packet from manifests, lock facts, Protocol facts, and managed bundler descriptors', async () => {
  const root = await createFixtureRoot();
  const packet = await derivePublicToolchainCompatibilityV1({ repoRoot: root });

  assert.deepEqual(packet, {
    schemaVersion: 1,
    host: { buildIdentity: '@happier-dev/cli@0.2.10' },
    pluginSdk: { version: '0.2.10' },
    pluginUi: { version: '0.2.10', pluginSdkVersion: '0.2.10' },
    framework: {
      react: '19.2.0', reactNative: '0.83.5', reactNativeWeb: '0.21.2', vite: '7.3.1', repack: '5.2.5', expo: '55.0.11', runtime: '1',
    },
    ui: { artifactGrammarVersion: 1, hostApiVersion: '1.0.0' },
    authoringDependencies: {
      nodeTypes: { packageName: '@types/node', dependencySpec: '25.0.10', resolvedVersion: '25.0.10' },
      reactDom: { packageName: 'react-dom', dependencySpec: '19.2.0', resolvedVersion: '19.2.0' },
      reactTypes: { packageName: '@types/react', dependencySpec: '19.2.0', resolvedVersion: '19.2.0' },
      reactNativeCommunityCli: { packageName: '@react-native-community/cli', dependencySpec: '20.1.2', resolvedVersion: '20.1.2' },
      rspack: { packageName: '@rspack/core', dependencySpec: '2.1.3', resolvedVersion: '2.1.3' },
      swcHelpers: { packageName: '@swc/helpers', dependencySpec: '0.5.23', resolvedVersion: '0.5.23' },
      typescript: { packageName: 'typescript', dependencySpec: '5.9.3', resolvedVersion: '5.9.3' },
      typescriptNative: { packageName: '@typescript/native', dependencySpec: 'npm:typescript@7.0.2', resolvedVersion: '7.0.2' },
      viteReactPlugin: { packageName: '@vitejs/plugin-react', dependencySpec: '4.7.0', resolvedVersion: '4.7.0' },
    },
    buildTools: [
      { packageName: '@callstack/repack', packageVersion: '5.2.5', executable: 'react-native', executableVersion: '20.1.2' },
      { packageName: 'vite', packageVersion: '7.3.1', executable: 'vite', executableVersion: '7.3.1' },
    ],
  });
  const rendered = renderPublicToolchainCompatibilityModule(packet);
  assert.match(rendered, /PUBLIC_TOOLCHAIN_COMPATIBILITY_V1/u);
  assert.match(rendered, /0\.83\.5/u);
  assert.match(
    rendered,
    /import type \{ PublicToolchainCompatibilityV1 \} from '\.\/toolchainCompatibility\.js';/u,
  );
  assert.doesNotMatch(rendered, /@happier-dev\/protocol/u);
});

test('projects the current action authority keys into the generated minimal cold manifest', async () => {
  const root = await createFixtureRoot();
  const manifestDocumentation = await readFile(
    join(root, 'apps', 'docs', 'content', 'docs', 'plugins', 'manifest', 'index.mdx'),
    'utf8',
  );

  assert.match(manifestDocumentation, /"execution": \{ "target": "daemon" \}/u);
  assert.match(manifestDocumentation, /"placementBindings": \["commandPalette"\]/u);
  assert.doesNotMatch(manifestDocumentation, /"placement": "commandPalette"/u);
});

test('fails closed when a package manifest and the candidate host disagree about React Native', async () => {
  const root = await createFixtureRoot();
  const sdkPackagePath = join(root, 'packages', 'plugin-sdk', 'package.json');
  const sdk = JSON.parse(await readFile(sdkPackagePath, 'utf8'));
  sdk.devDependencies['react-native'] = '0.83.4';
  await writeJson(sdkPackagePath, sdk);
  const lockPath = join(root, 'yarn.lock');
  await writeFile(lockPath, `${await readFile(lockPath, 'utf8')}\nreact-native@0.83.4:\n  version "0.83.4"\n`, 'utf8');

  await assert.rejects(
    derivePublicToolchainCompatibilityV1({ repoRoot: root }),
    /React Native.*disagree/i,
  );
});

test('fails closed when Plugin UI local React Native development runtime disagrees with the host', async () => {
  const root = await createFixtureRoot();
  const uiPackagePath = join(root, 'packages', 'plugin-ui', 'package.json');
  const pluginUi = JSON.parse(await readFile(uiPackagePath, 'utf8'));
  pluginUi.devDependencies['react-native'] = '0.83.4';
  await writeJson(uiPackagePath, pluginUi);
  const lockPath = join(root, 'yarn.lock');
  await writeFile(lockPath, `${await readFile(lockPath, 'utf8')}\nreact-native@0.83.4:\n  version \"0.83.4\"\n`, 'utf8');

  await assert.rejects(
    derivePublicToolchainCompatibilityV1({ repoRoot: root }),
    /Plugin UI React Native.*disagree/i,
  );
});

test('fails closed rather than defaulting a required authoring dependency', async () => {
  const root = await createFixtureRoot();
  const sdkPackagePath = join(root, 'packages', 'plugin-sdk', 'package.json');
  const sdk = JSON.parse(await readFile(sdkPackagePath, 'utf8'));
  delete sdk.devDependencies['@vitejs/plugin-react'];
  await writeJson(sdkPackagePath, sdk);

  await assert.rejects(
    derivePublicToolchainCompatibilityV1({ repoRoot: root }),
    /must declare @vitejs\/plugin-react/i,
  );
});

test('checks the generated packet against source facts and rejects a stale public output', async () => {
  const root = await createFixtureRoot();
  const packet = await derivePublicToolchainCompatibilityV1({ repoRoot: root });
  const outputPath = join(root, 'packages', 'plugin-sdk', 'src', 'ui', 'build', 'publicToolchainCompatibility.generated.ts');
  await mkdir(join(outputPath, '..'), { recursive: true });
  await writeFile(outputPath, renderPublicToolchainCompatibilityModule(packet), 'utf8');

  const current = spawnSync(process.execPath, [GENERATOR_PATH, '--repo-root', root, '--check'], {
    encoding: 'utf8',
  });
  assert.equal(current.status, 0, current.stderr);

  await writeFile(outputPath, '// stale output\n', 'utf8');
  const stale = spawnSync(process.execPath, [GENERATOR_PATH, '--repo-root', root, '--check'], {
    encoding: 'utf8',
  });
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /output is stale/i);
});

test('keeps every generated example and external-fixture package dependency on the one packet', async () => {
  const root = await createFixtureRoot();
  const packet = await derivePublicToolchainCompatibilityV1({ repoRoot: root });
  const outputPath = join(root, 'packages', 'plugin-sdk', 'src', 'ui', 'build', 'publicToolchainCompatibility.generated.ts');
  await mkdir(join(outputPath, '..'), { recursive: true });
  await writeFile(outputPath, renderPublicToolchainCompatibilityModule(packet), 'utf8');

  const staleExamplePath = join(root, 'packages', 'plugin-sdk', 'examples', 'react-native', 'package.json');
  const staleFixturePath = join(
    root,
    'packages',
    'plugin-ui',
    'fixtures',
    'external-authoring',
    'adversarial',
    'private-sdk-subpath',
    'package.json',
  );
  const stalePackedTargetPath = join(
    root,
    'packages',
    'tests',
    'fixtures',
    'plugin-platform',
    'packed-targeted-contribution-projection',
    'contributor',
    'package.json',
  );
  await writeJson(staleExamplePath, {
    name: '@example/stale-react-native',
    dependencies: {
      '@happier-dev/plugin-sdk': '0.2.9',
      '@happier-dev/plugin-ui': '0.2.9',
      react: '19.1.0',
      'react-native': '0.83.4',
    },
    devDependencies: { vite: '7.2.0' },
    peerDependencies: { react: '19.1.0' },
  });
  await writeJson(staleFixturePath, {
    name: '@example/stale-private-sdk-subpath',
    dependencies: { '@happier-dev/plugin-sdk': '0.2.9' },
  });
  await writeJson(stalePackedTargetPath, {
    name: 'packed-targeted-projection-contributor',
    devDependencies: { typescript: '0.0.0' },
  });

  const stale = spawnSync(process.execPath, [GENERATOR_PATH, '--repo-root', root, '--check'], {
    encoding: 'utf8',
  });
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /consumer package output is stale/i);

  const write = spawnSync(process.execPath, [GENERATOR_PATH, '--repo-root', root, '--write'], {
    encoding: 'utf8',
  });
  assert.equal(write.status, 0, write.stderr);
  const [examplePackage, fixturePackage, packedTargetPackage] = await Promise.all([
    readFile(staleExamplePath, 'utf8').then(JSON.parse),
    readFile(staleFixturePath, 'utf8').then(JSON.parse),
    readFile(stalePackedTargetPath, 'utf8').then(JSON.parse),
  ]);
  assert.equal(examplePackage.dependencies['@happier-dev/plugin-sdk'], packet.pluginSdk.version);
  assert.equal(examplePackage.dependencies['@happier-dev/plugin-ui'], packet.pluginUi.version);
  assert.equal(examplePackage.dependencies.react, packet.framework.react);
  assert.equal(examplePackage.dependencies['react-native'], packet.framework.reactNative);
  assert.equal(examplePackage.devDependencies.vite, packet.framework.vite);
  assert.equal(examplePackage.peerDependencies.react, packet.framework.react);
  assert.equal(fixturePackage.dependencies['@happier-dev/plugin-sdk'], packet.pluginSdk.version);
  assert.equal(packedTargetPackage.devDependencies.typescript, packet.authoringDependencies.typescript.dependencySpec);

  const current = spawnSync(process.execPath, [GENERATOR_PATH, '--repo-root', root, '--check'], {
    encoding: 'utf8',
  });
  assert.equal(current.status, 0, current.stderr);
});

test('leaves materialized dependencies and managed build operations outside the generated package owner', async () => {
  const root = await createFixtureRoot();
  const packet = await derivePublicToolchainCompatibilityV1({ repoRoot: root });
  const outputPath = join(root, 'packages', 'plugin-sdk', 'src', 'ui', 'build', 'publicToolchainCompatibility.generated.ts');
  await mkdir(join(outputPath, '..'), { recursive: true });
  await writeFile(outputPath, renderPublicToolchainCompatibilityModule(packet), 'utf8');

  const installedPackagePath = join(
    root,
    'packages',
    'plugin-sdk',
    'examples',
    'current-source',
    'node_modules',
    'zod',
    'locales',
    'package.json',
  );
  const installedBytes = `${JSON.stringify({
    name: 'zod-locales-installed-copy',
    dependencies: { react: 'materialized-owner-version' },
  }, null, 2)}\n`;
  await mkdir(join(installedPackagePath, '..'), { recursive: true });
  await writeFile(installedPackagePath, installedBytes, 'utf8');
  const operationPackagePath = join(
    root,
    'packages',
    'plugin-sdk',
    'examples',
    'current-source',
    '.happier-plugin-ui-build-operation',
    'package.json',
  );
  const operationBytes = `${JSON.stringify({
    private: true,
    name: 'happier-plugin-ui-build-operation',
  }, null, 2)}\n`;
  await mkdir(join(operationPackagePath, '..'), { recursive: true });
  await writeFile(operationPackagePath, operationBytes, 'utf8');

  const write = spawnSync(process.execPath, [GENERATOR_PATH, '--repo-root', root, '--write'], {
    encoding: 'utf8',
  });
  assert.equal(write.status, 0, write.stderr);
  assert.equal(await readFile(installedPackagePath, 'utf8'), installedBytes);
  assert.equal(await readFile(operationPackagePath, 'utf8'), operationBytes);

  const current = spawnSync(process.execPath, [GENERATOR_PATH, '--repo-root', root, '--check'], {
    encoding: 'utf8',
  });
  assert.equal(current.status, 0, current.stderr);
});

test('adds project-local TypeScript for every package using the managed Plugin UI builder', async () => {
  const root = await createFixtureRoot();
  const packet = await derivePublicToolchainCompatibilityV1({ repoRoot: root });
  const outputPath = join(root, 'packages', 'plugin-sdk', 'src', 'ui', 'build', 'publicToolchainCompatibility.generated.ts');
  const uiBuildPackagePath = join(root, 'packages', 'plugin-sdk', 'examples', 'typescript-ui-build', 'package.json');
  const nonUiPackagePath = join(root, 'packages', 'plugin-sdk', 'examples', 'no-ui-build', 'package.json');
  await writeFile(outputPath, renderPublicToolchainCompatibilityModule(packet), 'utf8');
  await writeJson(uiBuildPackagePath, {
    name: '@example/typescript-ui-build',
    scripts: { 'build:ui': 'happier-plugin-build-ui --project-root .' },
    devDependencies: { '@typescript/native': 'npm:typescript@7.0.2' },
  });
  await writeSource(
    join(root, 'packages', 'plugin-sdk', 'examples', 'typescript-ui-build', 'pluginUiBuild.ts'),
    "import { defineBuildConfig } from '@happier-dev/plugin-sdk/ui/build';\nexport default defineBuildConfig({});\n",
  );
  await writeJson(nonUiPackagePath, {
    name: '@example/no-ui-build',
    devDependencies: { '@typescript/native': 'npm:typescript@7.0.2' },
  });
  await writeSource(
    join(root, 'packages', 'plugin-sdk', 'examples', 'no-ui-build', 'src', 'index.ts'),
    'export {};\n',
  );

  const missingTypeScript = spawnSync(process.execPath, [GENERATOR_PATH, '--repo-root', root, '--check'], {
    encoding: 'utf8',
  });
  assert.notEqual(missingTypeScript.status, 0);
  assert.match(missingTypeScript.stderr, /consumer package output is stale/i);

  const write = spawnSync(process.execPath, [GENERATOR_PATH, '--repo-root', root, '--write'], {
    encoding: 'utf8',
  });
  assert.equal(write.status, 0, write.stderr);
  const [uiBuildPackage, nonUiPackage] = await Promise.all([
    readFile(uiBuildPackagePath, 'utf8').then(JSON.parse),
    readFile(nonUiPackagePath, 'utf8').then(JSON.parse),
  ]);
  assert.equal(uiBuildPackage.devDependencies.typescript, packet.authoringDependencies.typescript.dependencySpec);
  assert.equal(nonUiPackage.devDependencies.typescript, undefined);

  const current = spawnSync(process.execPath, [GENERATOR_PATH, '--repo-root', root, '--check'], {
    encoding: 'utf8',
  });
  assert.equal(current.status, 0, current.stderr);
});

test('adds project-local TypeScript from managed Plugin UI config and build-script signals', async () => {
  const root = await createFixtureRoot();
  const packet = await derivePublicToolchainCompatibilityV1({ repoRoot: root });
  const outputPath = join(root, 'packages', 'plugin-sdk', 'src', 'ui', 'build', 'publicToolchainCompatibility.generated.ts');
  const configPackagePath = join(root, 'packages', 'plugin-sdk', 'examples', 'javascript-ui-build', 'package.json');
  const scriptPackagePath = join(root, 'packages', 'plugin-sdk', 'examples', 'scripted-ui-build', 'package.json');
  await writeFile(outputPath, renderPublicToolchainCompatibilityModule(packet), 'utf8');
  await writeJson(configPackagePath, {
    name: '@example/javascript-ui-build',
    devDependencies: { '@typescript/native': 'npm:typescript@7.0.2' },
  });
  await writeSource(
    join(root, 'packages', 'plugin-sdk', 'examples', 'javascript-ui-build', 'happier-plugin-ui.config.mjs'),
    "import { defineBuildConfig } from '@happier-dev/plugin-sdk/ui/build';\nexport default defineBuildConfig({});\n",
  );
  await writeJson(scriptPackagePath, {
    name: '@example/scripted-ui-build',
    scripts: { 'build:ui': 'happier-plugin-build-ui --project-root .' },
    devDependencies: { '@typescript/native': 'npm:typescript@7.0.2' },
  });
  await writeSource(
    join(root, 'packages', 'plugin-sdk', 'examples', 'scripted-ui-build', 'src', 'index.mjs'),
    'export {};\n',
  );

  const missingTypeScript = spawnSync(process.execPath, [GENERATOR_PATH, '--repo-root', root, '--check'], {
    encoding: 'utf8',
  });
  assert.notEqual(missingTypeScript.status, 0);
  assert.match(missingTypeScript.stderr, /consumer package output is stale/i);

  const write = spawnSync(process.execPath, [GENERATOR_PATH, '--repo-root', root, '--write'], {
    encoding: 'utf8',
  });
  assert.equal(write.status, 0, write.stderr);
  const [configPackage, scriptPackage] = await Promise.all([
    readFile(configPackagePath, 'utf8').then(JSON.parse),
    readFile(scriptPackagePath, 'utf8').then(JSON.parse),
  ]);
  assert.equal(configPackage.devDependencies.typescript, packet.authoringDependencies.typescript.dependencySpec);
  assert.equal(scriptPackage.devDependencies.typescript, packet.authoringDependencies.typescript.dependencySpec);
});

test('fails closed when a source consumer replaces its packet value with a literal', async () => {
  const root = await createFixtureRoot();
  const packet = await derivePublicToolchainCompatibilityV1({ repoRoot: root });
  const outputPath = join(root, 'packages', 'plugin-sdk', 'src', 'ui', 'build', 'publicToolchainCompatibility.generated.ts');
  await mkdir(join(outputPath, '..'), { recursive: true });
  await writeFile(outputPath, renderPublicToolchainCompatibilityModule(packet), 'utf8');

  await writeSource(
    join(root, 'packages', 'tests', 'pluginSdkConsumers', 'run-probes.mjs'),
    'const hostUiApiVersion = "manually-copied";\nvoid hostUiApiVersion;\n',
  );
  const copiedFact = spawnSync(process.execPath, [GENERATOR_PATH, '--repo-root', root, '--check'], {
    encoding: 'utf8',
  });
  assert.notEqual(copiedFact.status, 0);
  assert.match(copiedFact.stderr, /source consumer copies public toolchain fact hostUiApiVersion/i);
});

test('fails closed when a source consumer leaves an unused packet binding beside a copied toolchain fact', async () => {
  const root = await createFixtureRoot();
  const packet = await derivePublicToolchainCompatibilityV1({ repoRoot: root });
  const outputPath = join(root, 'packages', 'plugin-sdk', 'src', 'ui', 'build', 'publicToolchainCompatibility.generated.ts');
  await mkdir(join(outputPath, '..'), { recursive: true });
  await writeFile(outputPath, renderPublicToolchainCompatibilityModule(packet), 'utf8');

  await writeSource(
    join(root, 'packages', 'tests', 'pluginSdkConsumers', 'run-probes.mjs'),
    [
      'const binding = PUBLIC_TOOLCHAIN_COMPATIBILITY_V1;',
      'const probe = {',
      '  hostUiApiVersion: "1.0.0",',
      '  reactVersion: "19.2.0",',
      '};',
      'void binding;',
      'void probe;',
      '',
    ].join('\n'),
  );

  const copiedFact = spawnSync(process.execPath, [GENERATOR_PATH, '--repo-root', root, '--check'], {
    encoding: 'utf8',
  });
  assert.notEqual(copiedFact.status, 0);
  assert.match(copiedFact.stderr, /source consumer copies public toolchain fact/i);
});

test('fails closed when the scaffold copies the runtime API fact beside its packet binding', async () => {
  const root = await createFixtureRoot();
  const packet = await derivePublicToolchainCompatibilityV1({ repoRoot: root });
  const outputPath = join(root, 'packages', 'plugin-sdk', 'src', 'ui', 'build', 'publicToolchainCompatibility.generated.ts');
  await mkdir(join(outputPath, '..'), { recursive: true });
  await writeFile(outputPath, renderPublicToolchainCompatibilityModule(packet), 'utf8');

  await writeSource(
    join(root, 'apps', 'cli', 'src', 'plugins', 'scaffold', 'scaffold.ts'),
    [
      'const binding = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1;',
      'const manifest = { runtime: { apiVersion: 1 } };',
      'void binding;',
      'void manifest;',
      '',
    ].join('\n'),
  );

  const copiedRuntime = spawnSync(process.execPath, [GENERATOR_PATH, '--repo-root', root, '--check'], {
    encoding: 'utf8',
  });
  assert.notEqual(copiedRuntime.status, 0);
  assert.match(copiedRuntime.stderr, /source consumer copies public toolchain fact apiVersion/i);
});

test('fails closed when conformance copies the runtime API fact beside its packet binding', async () => {
  const root = await createFixtureRoot();
  const packet = await derivePublicToolchainCompatibilityV1({ repoRoot: root });
  const outputPath = join(root, 'packages', 'plugin-sdk', 'src', 'ui', 'build', 'publicToolchainCompatibility.generated.ts');
  await mkdir(join(outputPath, '..'), { recursive: true });
  await writeFile(outputPath, renderPublicToolchainCompatibilityModule(packet), 'utf8');

  await writeSource(
    join(root, 'packages', 'tests', 'pluginSdkConsumers', 'run-probes.mjs'),
    [
      'const binding = PUBLIC_TOOLCHAIN_COMPATIBILITY_V1;',
      'const manifest = { runtime: { apiVersion: 1 } };',
      'void binding;',
      'void manifest;',
      '',
    ].join('\n'),
  );

  const copiedRuntime = spawnSync(process.execPath, [GENERATOR_PATH, '--repo-root', root, '--check'], {
    encoding: 'utf8',
  });
  assert.notEqual(copiedRuntime.status, 0);
  assert.match(copiedRuntime.stderr, /source consumer copies public toolchain fact apiVersion/i);
});

test('fails closed when generated documentation facts drift from the packet', async () => {
  const root = await createFixtureRoot();
  const packet = await derivePublicToolchainCompatibilityV1({ repoRoot: root });
  const outputPath = join(root, 'packages', 'plugin-sdk', 'src', 'ui', 'build', 'publicToolchainCompatibility.generated.ts');
  await mkdir(join(outputPath, '..'), { recursive: true });
  await writeFile(outputPath, renderPublicToolchainCompatibilityModule(packet), 'utf8');

  await writeSource(
    join(root, 'apps', 'docs', 'content', 'docs', 'plugins', 'packaging', 'versioning-compat.mdx'),
    [
      '{/* public-toolchain-compatibility:versioning-facts:start */}',
      'Current runtime API is `1`.',
      '{/* public-toolchain-compatibility:versioning-facts:end */}',
      '',
    ].join('\n'),
  );
  await writeSource(
    join(root, 'apps', 'docs', 'content', 'docs', 'plugins', 'manifest', 'index.mdx'),
    [
      '{/* public-toolchain-compatibility:manifest-example:start */}',
      '{ "engines": { "happier": "^0.2.0" }, "runtime": { "apiVersion": 1 } }',
      '{/* public-toolchain-compatibility:manifest-example:end */}',
      '',
    ].join('\n'),
  );

  const staleDocs = spawnSync(process.execPath, [GENERATOR_PATH, '--repo-root', root, '--check'], {
    encoding: 'utf8',
  });
  assert.notEqual(staleDocs.status, 0);
  assert.match(staleDocs.stderr, /generated documentation output is stale/i);
});

test('fails closed when documentation copies a toolchain fact outside its generated block', async () => {
  const root = await createFixtureRoot();
  const packet = await derivePublicToolchainCompatibilityV1({ repoRoot: root });
  const outputPath = join(root, 'packages', 'plugin-sdk', 'src', 'ui', 'build', 'publicToolchainCompatibility.generated.ts');
  await mkdir(join(outputPath, '..'), { recursive: true });
  await writeFile(outputPath, renderPublicToolchainCompatibilityModule(packet), 'utf8');

  const versioningPath = join(
    root,
    'apps',
    'docs',
    'content',
    'docs',
    'plugins',
    'packaging',
    'versioning-compat.mdx',
  );
  await writeFile(
    versioningPath,
    `${await readFile(versioningPath, 'utf8')}The \`runtime.apiVersion\` is \`1\`.\n`,
    'utf8',
  );

  const copiedFact = spawnSync(process.execPath, [GENERATOR_PATH, '--repo-root', root, '--check'], {
    encoding: 'utf8',
  });
  assert.notEqual(copiedFact.status, 0);
  assert.match(copiedFact.stderr, /documentation copies public toolchain fact runtime\.apiVersion/i);
});

test('discovers a new authoring consumer and rejects its omitted public SDK dependency', async () => {
  const root = await createFixtureRoot();
  const packet = await derivePublicToolchainCompatibilityV1({ repoRoot: root });
  const outputPath = join(root, 'packages', 'plugin-sdk', 'src', 'ui', 'build', 'publicToolchainCompatibility.generated.ts');
  await mkdir(join(outputPath, '..'), { recursive: true });
  await writeFile(outputPath, renderPublicToolchainCompatibilityModule(packet), 'utf8');

  await writeJson(join(root, 'packages', 'plugin-sdk', 'examples', 'new-authoring-consumer', 'package.json'), {
    name: '@example/new-authoring-consumer',
  });
  await writeSource(
    join(root, 'packages', 'plugin-sdk', 'examples', 'new-authoring-consumer', 'src', 'index.ts'),
    "import { definePlugin } from '@happier-dev/plugin-sdk';\nvoid definePlugin;\n",
  );

  const omittedDependency = spawnSync(process.execPath, [GENERATOR_PATH, '--repo-root', root, '--check'], {
    encoding: 'utf8',
  });
  assert.notEqual(omittedDependency.status, 0);
  assert.match(omittedDependency.stderr, /consumer package output is stale/i);
});

test('validates the generated packet for an isolated SDK prepack without sibling source checkouts', async () => {
  const sdkPackage = JSON.parse(await readFile(
    new URL('../package.json', import.meta.url),
    'utf8',
  ));
  assert.match(
    sdkPackage.scripts?.['prepack:prepared'] ?? '',
    /yarn -s check:public-toolchain:generated/u,
    'the isolated SDK prepack must validate its emitted packet',
  );
  assert.doesNotMatch(
    sdkPackage.scripts?.['prepack:prepared'] ?? '',
    /yarn -s check:public-toolchain:prepared/u,
    'the isolated SDK prepack must not re-read unavailable source-only sibling inputs',
  );

  const root = await createFixtureRoot();
  const packet = await derivePublicToolchainCompatibilityV1({ repoRoot: root });
  const outputPath = join(root, 'packages', 'plugin-sdk', 'src', 'ui', 'build', 'publicToolchainCompatibility.generated.ts');
  await mkdir(join(outputPath, '..'), { recursive: true });
  await writeFile(outputPath, renderPublicToolchainCompatibilityModule(packet), 'utf8');

  await rm(join(root, 'apps'), { recursive: true, force: true });
  await rm(join(root, 'packages', 'plugin-ui'), { recursive: true, force: true });

  const isolated = spawnSync(process.execPath, [GENERATOR_PATH, '--repo-root', root, '--check-generated'], {
    encoding: 'utf8',
  });
  assert.equal(isolated.status, 0, isolated.stderr);

  // The generated module is a public strict-schema value, not merely a
  // TypeScript-shaped object. Prepack must reject an unknown field before a
  // tarball can carry a packet that throws only when an author imports it.
  await writeFile(outputPath, renderPublicToolchainCompatibilityModule({
    ...packet,
    unsupportedToolchainFact: true,
  }), 'utf8');
  const unknownField = spawnSync(process.execPath, [GENERATOR_PATH, '--repo-root', root, '--check-generated'], {
    encoding: 'utf8',
  });
  assert.notEqual(unknownField.status, 0);
  assert.match(unknownField.stderr, /unrecognized key/i);

  await writeFile(outputPath, renderPublicToolchainCompatibilityModule({
    ...packet,
    pluginSdk: { version: '0.2.9' },
    pluginUi: {
      ...packet.pluginUi,
      pluginSdkVersion: '0.2.9',
    },
  }), 'utf8');
  const localMismatch = spawnSync(process.execPath, [GENERATOR_PATH, '--repo-root', root, '--check-generated'], {
    encoding: 'utf8',
  });
  assert.notEqual(localMismatch.status, 0);
  assert.match(localMismatch.stderr, /Plugin SDK package version/i);

  await writeFile(outputPath, '// stale output\n', 'utf8');
  const stale = spawnSync(process.execPath, [GENERATOR_PATH, '--repo-root', root, '--check-generated'], {
    encoding: 'utf8',
  });
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /generated public toolchain packet/i);
});
