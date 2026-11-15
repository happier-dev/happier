import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  cp,
  copyFile,
  symlink,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';
import { resolveInstalledRuntimePackage } from '../../workspaceRuntimeDependencies.mjs';

import { createWindowsServiceLauncherPeFixture } from '../../../../scripts/testing/windowsServiceLauncherPeFixture.mjs';
import cliDistBuildManifest from '../../cliDistBuildManifest.cjs';
import { CLI_RUNTIME_SIDECAR_ENTRIES } from './cliRuntimeSidecars.js';
import { execOrThrow, resolveBunCommand } from './commands.js';
import { readCliNodeWorkspaceRuntimeIdentityFromRuntimeRoot } from './copyCliNodeRuntimePayload.js';
import {
  CLI_RUNTIME_EXTERNAL_PACKAGES,
  buildCliBinaryArtifactCodePayload,
  buildCliBinaryArtifactSupportPayload,
  buildCliBinaryArtifactPayload,
  readCliBinaryArtifactSupportIdentity,
} from './buildCliBinaryArtifactPayload.js';

const tempDirs: string[] = [];

async function makeTempRepo(): Promise<string> {
  const root = await mkdtemp(
    join(tmpdir(), 'daemon-runtime-support-identity-'),
  );
  tempDirs.push(root);
  return root;
}

async function writeFixtureFile(path: string, contents: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, contents, 'utf8');
}

function targetForHost() {
  const os = process.platform === 'win32' ? 'windows' : process.platform;
  return {
    os,
    arch: process.arch,
    bunTarget: `fixture-${os}-${process.arch}`,
    exeExt: process.platform === 'win32' ? '.exe' : '',
  };
}

async function createSupportIdentityFixture(root: string, { nativeSupport = true } = {}): Promise<void> {
  await writeFixtureFile(
    join(root, '.node-version'),
    await readFile(new URL('../../../../.node-version', import.meta.url), 'utf8'),
  );
  await writeFixtureFile(
    join(root, 'apps/stack/scripts/provision/.bun-version'),
    await readFile(new URL('../../../../apps/stack/scripts/provision/.bun-version', import.meta.url), 'utf8'),
  );
  await writeFixtureFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }),
  );
  await writeFixtureFile(join(root, 'pnpm-lock.yaml'), '');
  await writeFixtureFile(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
  await writeFixtureFile(
    join(root, 'apps', 'cli', 'src', 'index.ts'),
    'export const daemonCode = true;\n',
  );
  await writeFixtureFile(join(root, 'apps', 'cli', 'tsconfig.json'), '{}');
  await writeFixtureFile(
    join(root, 'apps', 'cli', 'package.json'),
    JSON.stringify({
      name: '@happier-dev/cli',
      bundledDependencies: ['@happier-dev/cli-common'],
      dependencies: Object.fromEntries(
        CLI_RUNTIME_EXTERNAL_PACKAGES.map((name) => [name, '1.0.0']),
      ),
    }),
  );
  await writeFixtureFile(
    join(root, 'packages', 'cli-common', 'package.json'),
    JSON.stringify({
      name: '@happier-dev/cli-common',
      version: '1.0.0',
      main: './dist/index.js',
    }),
  );
  await writeFixtureFile(
    join(root, 'packages', 'cli-common', 'dist', 'index.js'),
    'export {};\n',
  );
  await writeFixtureFile(
    join(
      root,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'cli-common',
      'package.json',
    ),
    JSON.stringify({
      name: '@happier-dev/cli-common',
      version: '1.0.0',
      main: './dist/index.js',
    }),
  );
  await writeFixtureFile(
    join(
      root,
      'apps',
      'cli',
      'node_modules',
      '@happier-dev',
      'cli-common',
      'dist',
      'index.js',
    ),
    'export {};\n',
  );
  const esbuildRoot = dirname(
    createRequire(
      new URL('../../../../apps/cli/package.json', import.meta.url),
    ).resolve('esbuild/package.json'),
  );
  await symlink(
    esbuildRoot,
    join(root, 'apps', 'cli', 'node_modules', 'esbuild'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  const sharp = resolveInstalledRuntimePackage({
    packageName: 'sharp',
    resolveFromPackageJsonPath: fileURLToPath(new URL('../../../../apps/cli/package.json', import.meta.url)),
  });
  const sharpMetadata: { optionalDependencies?: Record<string, string> } = JSON.parse(await readFile(sharp.packageJsonPath, 'utf8'));
  const sharpOptionals = Object.fromEntries(Object.keys(sharpMetadata.optionalDependencies ?? {}).map((name) => [name, '1.0.0']));
  for (const packageName of CLI_RUNTIME_EXTERNAL_PACKAGES) {
    const packageDir = join(
      root,
      'apps',
      'cli',
      'node_modules',
      ...packageName.split('/'),
    );
    await writeFixtureFile(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: packageName,
        version: '1.0.0',
        main: './index.js',
        ...(packageName === 'sharp' ? {
          // Preserve the installed native package boundary's real inventory;
          // finalization must still enforce the selected target's optionals.
          optionalDependencies: sharpOptionals,
        } : {}),
      }),
    );
    await writeFixtureFile(
      join(packageDir, 'index.js'),
      `export const packageName = ${JSON.stringify(packageName)};\n`,
    );
    if (packageName === 'sharp') {
      const metadata: { optionalDependencies: Record<string, string> } = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
      for (const name of Object.keys(metadata.optionalDependencies)) {
        await writeFixtureFile(join(root, 'apps/cli/node_modules', name, 'package.json'),
          JSON.stringify({ name, version: '1.0.0', main: './index.js' }));
        await writeFixtureFile(join(root, 'apps/cli/node_modules', name, 'index.js'), 'export {};');
      }
    }
  }

  for (const segments of CLI_RUNTIME_SIDECAR_ENTRIES) {
    const sourcePath = join(root, 'apps', 'cli', 'scripts', ...segments);
    if (segments.at(-1) === 'runtime' || segments.at(-1) === 'shims') {
      await writeFixtureFile(join(sourcePath, 'fixture.cjs'), 'sidecar\n');
      continue;
    }
    await writeFixtureFile(sourcePath, 'sidecar\n');
  }
  await writeFixtureFile(
    join(root, 'apps', 'cli', 'tools', 'archives', 'fixture-tool.tar.gz'),
    'tool-one\n',
  );
  await writeFixtureFile(
    join(root, 'apps', 'cli', 'scripts', 'unpack-tools.cjs'),
    `
const fs = require('node:fs');
const path = require('node:path');

async function unpackTools({ toolsDir }) {
  const unpacked = path.join(toolsDir, 'unpacked');
  fs.mkdirSync(unpacked, { recursive: true });
  fs.writeFileSync(path.join(unpacked, 'fixture-tool'), 'fixture tool');
}

module.exports = { unpackTools };
`,
  );
  if (nativeSupport) {
    await writeFixtureFile(
      join(root, 'packages', 'plugins', 'cliproxyapi', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/plugins-cliproxyapi',
        scripts: { 'managed-runtime:build': 'fixture' },
        happier: { pluginScaffold: { shipping: 'reservation_only' } },
      }),
    );
    await writeFixtureFile(
      join(
        root,
        'packages',
        'plugins',
        'cliproxyapi',
        'managed-runtime',
        'main.go',
      ),
      'package main\n',
    );
    await writeFixtureFile(
      join(
        root,
        'packages',
        'plugins',
        'cliproxyapi',
        'managed-runtime',
        'licenses',
        'CLIProxyAPI-LICENSE',
      ),
      'license\n',
    );
    await writeFixtureFile(
      join(
        root,
        'packages',
        'plugins',
        'cliproxyapi',
        'managed-runtime',
        'licenses',
        'THIRD-PARTY-NOTICES',
      ),
      'notices\n',
    );
  }
  await writeFixtureFile(
    join(root, 'apps', 'cli', 'native', 'processcustody', 'main.go'),
    'package main\n',
  );

  if (process.platform === 'win32') {
    const launcher = join(root, 'packages/cli-common/native/windows/bin/windows-x64/happier-service-launcher.exe');
    await mkdir(dirname(launcher), { recursive: true });
    await writeFile(launcher, createWindowsServiceLauncherPeFixture());
  }

  for (const relativePath of [
    'packages/cli-common/src/componentArtifacts/buildCliBinaryArtifactPayload.ts',
    'packages/cli-common/src/componentArtifacts/stageCliTargetRuntimeDependencies.ts',
    'packages/cli-common/src/componentArtifacts/copyCliNodeRuntimePayload.ts',
    'packages/cli-common/src/componentArtifacts/finalizeRuntimeArtifactPayload.ts',
    'packages/cli-common/src/componentArtifacts/targets.ts',
    'packages/cli-common/nodePtySpawnHelperPermissions.cjs',
    'packages/cli-common/src/componentArtifacts/stageCliProxyApiManagedRuntime.ts',
    'packages/cli-common/src/componentArtifacts/stageProcessCustodyRuntime.ts',
    'packages/cli-common/src/service/windowsLauncher.ts',
    'packages/cli-common/src/componentArtifacts/cliRuntimeSidecars.ts',
    'packages/cli-common/src/workspaces/index.ts',
    'packages/cli-common/workspaceRuntimeDependencies.mjs',
    'packages/cli-common/componentArtifactTarget.mjs',
  ]) {
    await writeFixtureFile(join(root, relativePath), 'owner input\n');
  }
}

async function installCanonicalProjectionGenerator(root: string): Promise<string> {
  const sourceRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  for (const manifestPath of [join(root, 'package.json'), join(root, 'apps/cli/package.json')]) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFixtureFile(manifestPath, JSON.stringify({ ...manifest, type: 'module' }));
  }
  // Only the private input root is supplied here; projection logic stays real.
  await writeFixtureFile(join(root, 'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts'),
    `import { main } from ${JSON.stringify(pathToFileURL(join(sourceRoot, 'apps/cli/scripts/build-owned/generateBundledPluginEntries.ts')).href)};
await main(['--root', ${JSON.stringify(root)}, ...process.argv.slice(2)]);`);
  return sourceRoot;
}

describe('daemon runtime support identity', () => {
  it('emits Latin-1 source chunks and sidecars while preserving Unicode values, legal notices and stack frames', async () => {
    const root = await makeTempRepo();
    await createSupportIdentityFixture(root, { nativeSupport: false });
    const license = '/*! @license Fixture 日本語 © 2026 */';
    await writeFixtureFile(join(root, 'packages/cli-common/package.json'), JSON.stringify({
      name: '@happier-dev/cli-common',
      exports: { '.': { 'happier-source': './src/雪.ts', default: './dist/index.js' } },
    }));
    await writeFixtureFile(join(root, 'packages/cli-common/src/雪.ts'), `${license}
export const unicode = { literal: '雪 😀', raw: String.raw\`雪\\n\`, pattern: /\\u96ea/u.test('雪') };
export function namedUnicodeFailure() { throw new Error('雪 😀'); }
`);
    await writeFixtureFile(join(root, 'apps/cli/src/index.ts'), `
export { unicode, namedUnicodeFailure } from '@happier-dev/cli-common';
export const readLazy = () => import('./lazy');
`);
    await writeFixtureFile(join(root, 'apps/cli/src/lazy.ts'), "export { unicode } from '@happier-dev/cli-common';");
    await writeFixtureFile(join(root, 'apps/cli/scripts/process_tree.cjs'), "exports.read = async () => (await import('@happier-dev/cli-common')).unicode;");
    await writeFixtureFile(join(root, 'apps/cli/scripts/statusline_forwarder.cjs'), `${license}\nexports.read = () => String.raw\`雪\\n\`;`);
    const payloadDir = join(root, 'payload');
    await buildCliBinaryArtifactCodePayload({
      repoRoot: root, payloadDir,
      commandProbe: command => command === 'bun',
      // The compiler process is the external boundary; exercise the real emitted graph in Node below.
      compileBinary: async ({ outfile }) => writeFixtureFile(outfile, 'external native compiler'),
    });
    const emitted = await import(pathToFileURL(join(payloadDir, 'package-dist/index.mjs')).href);
    expect(emitted.unicode).toEqual({ literal: '雪 😀', raw: '雪\\n', pattern: true });
    expect((await emitted.readLazy()).unicode).toBe(emitted.unicode);
    expect(await createRequire(import.meta.url)(join(payloadDir, 'scripts/process_tree.cjs')).read()).toEqual(emitted.unicode);
    const standaloneSidecar = join(payloadDir, 'scripts/statusline_forwarder.cjs');
    expect(createRequire(import.meta.url)(standaloneSidecar).read()).toBe('雪\\n');
    expect(await readFile(standaloneSidecar, 'utf8')).not.toMatch(/[^\x00-\xFF]/u);
    try {
      emitted.namedUnicodeFailure();
      expect.unreachable('the named fixture must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('雪 😀');
      expect((error as Error).stack).toMatch(/namedUnicodeFailure .*\.js:\d+:\d+/);
    }
    const metadata = JSON.parse(await readFile(join(payloadDir, 'package-dist/metafile.json'), 'utf8'));
    const outputs = Object.keys(metadata.outputs).map(path => resolve(root, path));
    for (const path of outputs.filter(path => /\.[cm]?js$/.test(path))) {
      expect(await readFile(path, 'utf8'), path).not.toMatch(/[^\x00-\xFF]/u);
    }
    const notices = await Promise.all(outputs.filter(path => path.endsWith('.LEGAL.txt')).map(path => readFile(path, 'utf8')));
    expect(notices.some(text => text.includes(license))).toBe(true);
  });

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map(async (path) => {
        await rm(path, { recursive: true, force: true });
      }),
    );
  });

  it('bundles async ESM and password KDF dependencies into daemon code without adjacent node_modules', async () => {
    const root = await makeTempRepo();
    await createSupportIdentityFixture(root, { nativeSupport: false });
    const bun = resolveBunCommand();
    if (!bun)
      throw new Error('Bun is required for the daemon dependency bundle check');
    const cliRequire = createRequire(
      new URL('../../../../apps/cli/package.json', import.meta.url),
    );
    // Real installed third-party bytes: 0.7.16's public import export references
    // an unshipped sibling, while its public require export is complete.
    for (const name of ['libsodium-wrappers-sumo', 'libsodium-sumo']) {
      const packageDir = dirname(dirname(dirname(cliRequire.resolve(name))));
      await cp(packageDir, join(root, 'node_modules', name), {
        recursive: true,
      });
    }
    const cliRoot = join(root, 'apps', 'cli');
    const manifestPath = join(cliRoot, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(
      manifestPath,
      JSON.stringify({
        ...manifest,
        main: './dist/index.cjs',
        module: './dist/index.mjs',
        bundledDependencies: [
          ...manifest.bundledDependencies,
          'libsodium-wrappers-sumo',
        ],
        dependencies: {
          ...manifest.dependencies,
          'libsodium-wrappers-sumo': '0.7.16',
          'async-ink-fixture': '1.0.0',
        },
      }),
    );
    await writeFixtureFile(
      join(root, 'node_modules', 'async-ink-fixture', 'package.json'),
      JSON.stringify({
        name: 'async-ink-fixture',
        version: '1.0.0',
        type: 'module',
        exports: './index.js',
      }),
    );
    await writeFixtureFile(
      join(root, 'node_modules', 'async-ink-fixture', 'index.js'),
      'export const asyncReady = await Promise.resolve("async-ready");\n',
    );
    await copyFile(
      new URL(
        '../../../../apps/cli/src/auth/passwordSodium.cjs',
        import.meta.url,
      ),
      join(cliRoot, 'src', 'passwordSodium.cjs'),
    );
    await writeFixtureFile(join(cliRoot, 'tsconfig.json'), '{}');
    const payloadDir = join(root, 'payload');
    const operation = `sodium.libsodium.useBackupModule = () => { throw new Error('password_kdf_unavailable'); };
    sodium.ready.then(() => {
      if (asyncReady !== 'async-ready') throw new Error('async dependency unavailable');
      const key = sodium.crypto_pwhash(32, 'a password with spaces 🗝', new Uint8Array(16),
        3, 64 * 1024 * 1024, sodium.crypto_pwhash_ALG_ARGON2ID13);
      if (key.length !== 32) throw new Error('password KDF unavailable');
      key.fill(0);
      console.log('password-kdf-ready');
    });`;
    await writeFixtureFile(
      join(cliRoot, 'src', 'index.ts'),
      `import sodium from './passwordSodium.cjs';\nimport { asyncReady } from 'async-ink-fixture';\n${operation}`,
    );
    const built = await buildCliBinaryArtifactCodePayload({
      repoRoot: root,
      payloadDir,
      // The artifact must consume authored entries directly. The package
      // manager/compiler boundary fails if native construction asks for dist.
      runCommand: async (command, args, options) => {
        if (args.includes('build:prepared'))
          throw new Error(
            'native construction requested intermediate CLI dist',
          );
        return await execOrThrow(command, args, options);
      },
    });
    const isolatedRoot = await makeTempRepo();
    const isolatedPayload = join(isolatedRoot, 'payload');
    await cp(payloadDir, isolatedPayload, { recursive: true });
    await rm(join(isolatedPayload, 'node_modules'), { recursive: true, force: true });
    const executable = join(isolatedPayload, built.entrypoint);
    const result = spawnSync(executable, [], {
      cwd: isolatedRoot,
      env: { ...process.env, NODE_PATH: '' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe('password-kdf-ready');
    // Native compilation and the real Argon2 workload use the existing composed
    // compiler-test allowance.
  }, 20_000);

  it.each([false, true])('loads source-only Session, Run, MCP, voice, plugin and factory entries with one shared module instance (native=%s)', async (native) => {
    const root = await makeTempRepo();
    await createSupportIdentityFixture(root, { nativeSupport: false });
    const cliRoot = join(root, 'apps/cli');
    const pluginName = '@happier-dev/plugins-fixture';
    const pluginRoot = join(root, 'packages/plugins/fixture');
    await writeFixtureFile(
      join(root, 'packages/shared/package.json'),
      JSON.stringify({
        name: '@happier-dev/shared',
        type: 'module',
        exports: {
          '.': {
            'happier-source': './src/index.ts',
            import: './dist/index.js',
            default: './dist/index.js',
          },
        },
      }),
    );
    await writeFixtureFile(
      join(root, 'packages/shared/src/index.ts'),
      'export const identity = {};',
    );
    await writeFixtureFile(
      join(root, 'packages/shared/dist/index.js'),
      'throw new Error("private dist consumed");',
    );
    await writeFixtureFile(
      join(pluginRoot, 'package.json'),
      JSON.stringify({
        name: pluginName,
        files: ['.happier-plugin-build', '.happier-plugin-assets'],
        version: '0.0.0',
        type: 'module',
        exports: {
          '.': {
            'happier-source': './src/index.ts',
            import: './dist/index.js',
            default: './dist/index.js',
          },
        },
      }),
    );
    await writeFixtureFile(
      join(pluginRoot, 'src/index.ts'),
      `export {identity} from "../../../shared/src/index.ts";
export { PLUGIN_MANIFEST as manifest } from './manifest.ts';
import { createFixture } from './agent/runner.ts';
export function activate(api) { api.agents.register('custom-acp', createFixture, {
  sessionRunnerFactory: { module: './agent/runner', export: 'createFixture', runtimeApiVersion: 1 },
}); }`,
    );
    await writeFixtureFile(
      join(pluginRoot, 'src/agent/runner.ts'),
      'export {identity} from "../../../../shared/src/index.ts"; export function createFixture() {}',
    );
    await writeFixtureFile(join(pluginRoot, '.happier-plugin-build/stale.js'), 'throw new Error("stale generated bytes");');
    await writeFixtureFile(join(pluginRoot, '.happier-plugin-assets/kept.txt'), 'authored asset');
    const sourceManifest = ingestPluginManifestV2({
      schemaVersion: 2, id: 'happier.fixture', version: '0.0.0', displayName: 'Fixture Agent',
      engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
      entrypoints: { daemon: '.happier-plugin-build/daemon/index.js' },
      contributes: { agents: [{
        id: 'custom-acp', title: 'Fixture Agent', runtime: { kind: 'custom' }, primary: 'sessions',
        capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
      }] },
    });
    if (!sourceManifest.ok) throw new Error('Source fixture must pass canonical manifest ingress');
    await writeFixtureFile(join(pluginRoot, 'src/manifest.ts'),
      `export const PLUGIN_MANIFEST = ${JSON.stringify(sourceManifest.manifest)};`);
    const sourceRoot = await installCanonicalProjectionGenerator(root);
    await writeFixtureFile(join(root, 'apps/ui/package.json'), JSON.stringify({
      name: '@happier-dev/app', type: 'module', dependencies: { [pluginName]: '0.0.0' },
    }));
    await mkdir(join(root, 'apps/ui/scripts'), { recursive: true });
    await writeFixtureFile(join(root, 'apps/ui/scripts/prepareSourcePluginUiArtifacts.mjs'),
      `import { prepareSourcePluginUiArtifacts } from ${JSON.stringify(pathToFileURL(join(sourceRoot, 'apps/ui/scripts/prepareSourcePluginUiArtifacts.mjs')).href)};
let input = ''; for await (const chunk of process.stdin) input += chunk;
await prepareSourcePluginUiArtifacts(JSON.parse(input));`);
    await symlink(join(sourceRoot, 'packages/cli-common/registerSourceRuntime.mjs'),
      join(root, 'packages/cli-common/registerSourceRuntime.mjs'));
    await writeFixtureFile(join(root, 'packages/plugins/broken/package.json'), JSON.stringify({
      name: '@happier-dev/plugins-broken', version: '0.0.0',
    }));
    await writeFixtureFile(join(root, 'packages/plugins/broken/src/manifest.ts'),
      'export const PLUGIN_MANIFEST = { schemaVersion: 2, id: "happier.broken" };');
    const staleAsset = join(cliRoot, 'assets/bundled-plugin-manifests/fixture.json');
    await writeFixtureFile(staleAsset, '{"stale":true}');
    const exports = {
      '.': { 'happier-source': './src/index.ts' },
      ...Object.fromEntries(
        ['session', 'run', 'mcp'].map((name) => [
          `./${name}`,
          { 'happier-source': `./src/${name}.ts` },
        ]),
      ),
    };
    const manifest = JSON.parse(
      await readFile(join(cliRoot, 'package.json'), 'utf8'),
    );
    await writeFixtureFile(
      join(cliRoot, 'package.json'),
      JSON.stringify({
        ...manifest,
        type: 'module',
        exports,
        imports: {
          '#voice-inference-runtime': { 'happier-source': './src/voice.ts' },
        },
      }),
    );
    await writeFixtureFile(
      join(cliRoot, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true, alwaysStrict: true } }),
    );
    await writeFixtureFile(
      join(root, 'node_modules/legacy-cjs/package.json'),
      JSON.stringify({ name: 'legacy-cjs', main: './index.js' }),
    );
    await writeFixtureFile(
      join(root, 'node_modules/legacy-cjs/index.js'),
      'module.exports="\\033[40m";',
    );
    for (const name of ['session', 'run', 'mcp', 'voice'])
      await writeFixtureFile(
        join(cliRoot, `src/${name}.ts`),
        'export {identity} from "@happier-dev/shared";',
      );
    await writeFixtureFile(
      join(cliRoot, 'scripts/process_tree.cjs'),
      "import('@happier-dev/shared').then(module=>console.log(typeof module.identity));",
    );
    await writeFixtureFile(
      join(cliRoot, 'src/index.ts'),
      `
      import {BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS} from './plugins/projection/registry/sources/generatedBundledPluginManifests';
      if(BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.length!==1) throw new Error('source locators unavailable');
      import {identity} from '@happier-dev/shared';
      import legacy from 'legacy-cjs';
      if(legacy.charCodeAt(0)!==27) throw new Error('legacy CJS parsing changed');
      const names=process.versions.bun
        ? ['./session.mjs','./run.mjs','./mcp.mjs','./voice.mjs','../node_modules/${pluginName}/.happier-plugin-build/daemon/index.js']
        : ['@happier-dev/cli/session','@happier-dev/cli/run','@happier-dev/cli/mcp','#voice-inference-runtime','${pluginName}'];
      for(const name of names) if((await import(name)).identity!==identity) throw new Error('split shared instance: '+name);
      const factory='../node_modules/${pluginName}/.happier-plugin-build/daemon/agent/runner.js';
      if((await import(factory)).identity!==identity) throw new Error('split factory instance');
      console.log('source-children-ready');
    `,
    );
    const payloadDir = join(root, 'payload');
    const built = await buildCliBinaryArtifactCodePayload({
      repoRoot: root,
      payloadDir,
      ...(!native ? {
        commandProbe: (command: string) => command === 'bun',
        // The compiler is the external boundary; the source generator and
        // emitted Node graph remain real in the compiler-independent case.
        compileBinary: async ({ outfile }: { outfile: string }) =>
          writeFixtureFile(outfile, 'native compiler boundary'),
      } : {}),
    });
    const payloadPlugin = join(payloadDir, 'node_modules', pluginName);
    expect(existsSync(join(payloadPlugin, '.happier-plugin-build/stale.js'))).toBe(false);
    expect(await readFile(join(payloadPlugin, '.happier-plugin-assets/kept.txt'), 'utf8')).toBe('authored asset');
    const locatorPath = join(cliRoot, 'src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts');
    expect(existsSync(locatorPath)).toBe(false);
    expect(await readFile(staleAsset, 'utf8')).toBe('{"stale":true}');
    const failures = JSON.parse(await readFile(join(payloadDir, '.project/tmp/bundled-plugin-publication/failures.json'), 'utf8'));
    expect(failures).toEqual([expect.objectContaining({ packageName: '@happier-dev/plugins-broken' })]);
    const projected = JSON.parse(await readFile(join(payloadDir, 'assets/bundled-plugin-manifests/fixture.json'), 'utf8'));
    expect(projected.runtime.agentFactories[0].locator.module).toBe('./agent/runner');
    const isolatedRoot = await makeTempRepo();
    const isolatedPayload = join(isolatedRoot, 'payload');
    await cp(payloadDir, isolatedPayload, { recursive: true });
    if (native) {
      const compiled = spawnSync(join(isolatedPayload, built.entrypoint), [], {
        cwd: isolatedRoot,
        env: { ...process.env, NODE_PATH: '' },
        encoding: 'utf8',
      });
      expect(compiled.stderr).toBe('');
      expect(compiled.status).toBe(0);
      expect(compiled.stdout.trim()).toBe('source-children-ready');
    }
    const result = spawnSync(
      process.execPath,
      [
        '--conditions=happier-source',
        join(payloadDir, 'package-dist/index.mjs'),
      ],
      {
        cwd: payloadDir,
        env: { ...process.env, NODE_PATH: '' },
        encoding: 'utf8',
      },
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('source-children-ready');
    expect(built.workspaceRuntimeIdentity).toBe(
      readCliNodeWorkspaceRuntimeIdentityFromRuntimeRoot({
        runtimeRoot: payloadDir,
        packageNames: [pluginName],
      }).fingerprint,
    );
    expect(
      JSON.parse(await readFile(join(payloadDir, 'package.json'), 'utf8'))
        .bundledDependencies,
    ).toEqual([pluginName]);
    const sidecar = spawnSync(
      process.execPath,
      [join(payloadDir, 'scripts/process_tree.cjs')],
      {
        cwd: payloadDir,
        env: { ...process.env, NODE_PATH: '' },
        encoding: 'utf8',
      },
    );
    expect(sidecar.status).toBe(0);
    expect(sidecar.stdout.trim()).toBe('object');
    const metadata = JSON.parse(
      await readFile(join(payloadDir, 'package-dist/metafile.json'), 'utf8'),
    );
    expect(
      Object.keys(metadata.inputs).some((path) =>
        /packages\/shared\/dist\//.test(path),
      ),
    ).toBe(false);
    // Match the canonical daemon-projection composed suite's allowance: this
    // fixture now executes its real generator and UI-preparation child tools.
  }, 240_000);

  it('constructs current native plugin UI artifacts from the canonical authored compiler', async () => {
    const payloadDir = join(await makeTempRepo(), 'payload');
    await buildCliBinaryArtifactCodePayload({
      repoRoot: fileURLToPath(new URL('../../../../', import.meta.url)),
      payloadDir,
      commandProbe: (command) => command === 'bun',
      compileBinary: async ({ outfile }) =>
        writeFixtureFile(outfile, 'native compiler boundary'),
    });
    const artifactRoot = join(
      payloadDir,
      'node_modules/@happier-dev/plugins-channels/dist/happier-plugin-ui',
    );
    const manifest = JSON.parse(
      await readFile(join(artifactRoot, 'ui-artifacts.json'), 'utf8'),
    );
    expect(manifest.entries.length).toBeGreaterThan(0);
    for (const entry of manifest.entries)
      expect(
        (await readFile(join(artifactRoot, entry.entry))).length,
      ).toBeGreaterThan(0);
  }, 240_000);

  it('changes for support dependencies and tools, while code-owned scripts remain independent', async () => {
    const root = await makeTempRepo();
    await createSupportIdentityFixture(root);
    const input = {
      repoRoot: root,
      target: targetForHost(),
      goVersion: 'go version go1.fixture',
    };

    const initial = readCliBinaryArtifactSupportIdentity(input);
    await writeFixtureFile(
      join(root, 'apps', 'cli', 'src', 'code-only-change.ts'),
      'export const codeOnlyChange = true;\n',
    );
    const changedCodeOnly = readCliBinaryArtifactSupportIdentity(input);
    const changedGoToolchain = readCliBinaryArtifactSupportIdentity({
      ...input,
      goVersion: 'go version go1.fixture-changed',
    });
    await writeFixtureFile(
      join(root, 'apps', 'cli', 'node_modules', 'ffmpeg-static', 'index.js'),
      'export const runtime = "changed";\n',
    );
    const changedRuntimeDependency =
      readCliBinaryArtifactSupportIdentity(input);
    await writeFixtureFile(
      join(root, 'apps', 'cli', 'tools', 'archives', 'fixture-tool.tar.gz'),
      'tool-two\n',
    );
    const changedTool = readCliBinaryArtifactSupportIdentity(input);
    await writeFixtureFile(
      join(root, 'apps', 'cli', 'scripts', 'ripgrep_launcher.cjs'),
      'changed-sidecar\n',
    );
    const changedSidecar = readCliBinaryArtifactSupportIdentity(input);

    expect(changedCodeOnly.fingerprint).toBe(initial.fingerprint);
    expect(changedGoToolchain.fingerprint).not.toBe(initial.fingerprint);
    expect(changedRuntimeDependency.fingerprint).not.toBe(
      changedGoToolchain.fingerprint,
    );
    expect(changedTool.fingerprint).not.toBe(
      changedRuntimeDependency.fingerprint,
    );
    expect(changedSidecar.fingerprint).toBe(changedTool.fingerprint);
    expect(changedSidecar.workspaceRuntimeIdentity).toBe(
      initial.workspaceRuntimeIdentity,
    );
  });

  it('describes a foreign target without requiring the identity reader to run on that target', async () => {
    const root = await makeTempRepo();
    await createSupportIdentityFixture(root);
    const nativeTarget = targetForHost();
    const input = { repoRoot: root, goVersion: 'go version go1.fixture' };
    const native = readCliBinaryArtifactSupportIdentity({
      ...input,
      target: nativeTarget,
    });
    const foreign = readCliBinaryArtifactSupportIdentity({
      ...input,
      target: {
        ...nativeTarget,
        arch: nativeTarget.arch === 'arm64' ? 'x64' : 'arm64',
      },
    });
    expect(foreign.fingerprint).not.toBe(native.fingerprint);
  });

  it('reuses native support across runtime source edits and changes it for native resources', async () => {
    const root = await makeTempRepo();
    await createSupportIdentityFixture(root);
    const sourcePackage = join(root, 'packages/cli-common');
    await writeFixtureFile(
      join(sourcePackage, 'package.json'),
      JSON.stringify({
        name: '@happier-dev/cli-common',
        files: ['src', 'dist', 'native/*.node'],
      }),
    );
    await writeFixtureFile(
      join(sourcePackage, 'src/index.ts'),
      'export const runtime=1;',
    );
    const input = {
      repoRoot: root,
      target: targetForHost(),
      goVersion: 'go version go1.fixture',
    };
    expect(() => readCliBinaryArtifactSupportIdentity(input)).not.toThrow();
    await writeFixtureFile(
      join(sourcePackage, 'native/binding.node'),
      'first native asset',
    );
    const initial = readCliBinaryArtifactSupportIdentity(input);
    await writeFixtureFile(
      join(sourcePackage, 'src/index.ts'),
      'export const runtime=2;',
    );
    expect(readCliBinaryArtifactSupportIdentity(input).fingerprint).toBe(
      initial.fingerprint,
    );
    await writeFixtureFile(
      join(sourcePackage, 'native/binding.node'),
      'second native asset',
    );
    expect(readCliBinaryArtifactSupportIdentity(input).fingerprint).not.toBe(
      initial.fingerprint,
    );
  });

  it('keeps source support independent of checkout bundled-plugin failure diagnostics', async () => {
    const root = await makeTempRepo();
    await createSupportIdentityFixture(root);
    const input = {
      repoRoot: root,
      target: targetForHost(),
      goVersion: 'go version go1.fixture',
    };
    const before = readCliBinaryArtifactSupportIdentity(input);
    await writeFixtureFile(
      join(
        root,
        'apps',
        'cli',
        '.project',
        'tmp',
        'bundled-plugin-publication',
        'failures.json',
      ),
      '[]\n',
    );
    const empty = readCliBinaryArtifactSupportIdentity(input);
    await writeFixtureFile(
      join(
        root,
        'apps',
        'cli',
        '.project',
        'tmp',
        'bundled-plugin-publication',
        'failures.json',
      ),
      '[{"pluginId":"happier.inspector"}]\n',
    );
    const failed = readCliBinaryArtifactSupportIdentity(input);
    expect(empty.fingerprint).toBe(before.fingerprint);
    expect(failed.fingerprint).toBe(empty.fingerprint);
  });

  it('binds native custody provisioning so a helper-less payload cannot share a fingerprint', async () => {
    const root = await makeTempRepo();
    await createSupportIdentityFixture(root);
    const prebuiltCustodyPath = join(
      root,
      'prebuilt',
      'happier-process-custody',
    );
    await writeFixtureFile(prebuiltCustodyPath, 'prebuilt custody\n');

    const absent = readCliBinaryArtifactSupportIdentity({
      repoRoot: root,
      target: targetForHost(),
      goVersion: 'go version go1.fixture',
    });
    const present = readCliBinaryArtifactSupportIdentity({
      repoRoot: root,
      target: targetForHost(),
      goVersion: 'go version go1.fixture',
      processCustodyRuntimeExecutablePath: prebuiltCustodyPath,
    });
    expect(present.fingerprint).not.toBe(absent.fingerprint);

    await writeFixtureFile(prebuiltCustodyPath, 'changed custody bytes\n');
    const changedBytes = readCliBinaryArtifactSupportIdentity({
      repoRoot: root,
      target: targetForHost(),
      goVersion: 'go version go1.fixture',
      processCustodyRuntimeExecutablePath: prebuiltCustodyPath,
    });
    expect(changedBytes.fingerprint).not.toBe(present.fingerprint);

    await writeFixtureFile(
      join(root, 'apps', 'cli', 'native', 'processcustody', 'main.go'),
      'package main // changed\n',
    );
    expect(
      readCliBinaryArtifactSupportIdentity({
        repoRoot: root,
        target: targetForHost(),
        goVersion: 'go version go1.fixture',
      }).fingerprint,
    ).not.toBe(absent.fingerprint);
  });

  it('uses a root-hoisted workspace package when the CLI-local copy is absent', async () => {
    const root = await makeTempRepo();
    await createSupportIdentityFixture(root);
    await rm(
      join(root, 'apps', 'cli', 'node_modules', '@happier-dev', 'cli-common'),
      {
        recursive: true,
        force: true,
      },
    );
    await writeFixtureFile(
      join(root, 'node_modules', '@happier-dev', 'cli-common', 'package.json'),
      JSON.stringify({
        name: '@happier-dev/cli-common',
        version: '1.0.0',
        main: './dist/index.js',
      }),
    );
    await writeFixtureFile(
      join(
        root,
        'node_modules',
        '@happier-dev',
        'cli-common',
        'dist',
        'index.js',
      ),
      'export const packageLocation = "hoisted";\n',
    );

    const identity = readCliBinaryArtifactSupportIdentity({
      repoRoot: root,
      target: targetForHost(),
      goVersion: 'go version go1.fixture',
    });

    expect(identity.workspaceRuntimeIdentity).toBeNull();
  });

  it('stages only daemon support entries and verifies the same owner-local identity', async () => {
    const root = await makeTempRepo();
    await createSupportIdentityFixture(root);
    const nativePackage = join(root, 'packages/cli-common');
    await writeFixtureFile(join(nativePackage, 'package.json'), JSON.stringify({
      name: '@happier-dev/cli-common', version: '1.0.0', files: ['native/*.node'],
    }));
    await writeFixtureFile(join(nativePackage, 'native/binding.node'), 'shippable native bytes');
    await writeFixtureFile(join(nativePackage, 'native/.private-staging/scripts/build.mjs'), 'in-progress source');
    await symlink(root, join(nativePackage, 'native/.private-staging/escaping'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeFixtureFile(
      join(
        root,
        'apps',
        'cli',
        'node_modules',
        '@happier-dev',
        'cli-common',
        'dist',
        'index.d.ts.map',
      ),
      '{"version":3}\n',
    );
    const prebuiltRuntimePath = join(
      root,
      'prebuilt',
      'happier-cliproxyapi-managed',
    );
    const prebuiltCustodyPath = join(
      root,
      'prebuilt',
      'happier-process-custody',
    );
    await writeFixtureFile(prebuiltRuntimePath, 'prebuilt runtime\n');
    await writeFixtureFile(prebuiltCustodyPath, 'prebuilt custody\n');
    const identityInput = {
      repoRoot: root,
      target: targetForHost(),
      goVersion: 'go version go1.fixture',
      cliProxyApiManagedRuntimeExecutablePath: prebuiltRuntimePath,
      processCustodyRuntimeExecutablePath: prebuiltCustodyPath,
    };
    const identity = readCliBinaryArtifactSupportIdentity(identityInput);
    await writeFixtureFile(join(nativePackage, 'native/.private-staging/scripts/build.mjs'), 'changed private input');
    expect(readCliBinaryArtifactSupportIdentity(identityInput).fingerprint).toBe(identity.fingerprint);
    await writeFixtureFile(join(root, 'apps/cli/.project/tmp/bundled-plugin-publication/failures.json'), JSON.stringify([{
      packageName: '@happier-dev/plugins-cliproxyapi', pluginId: 'happier.cliproxyapi',
      diagnostic: { code: 'plugin_manifest_invalid', message: 'Stale checkout declaration failed' },
    }]));
    const payloadDir = join(
      root,
      'artifacts',
      'daemon-support',
      'support-fingerprint',
      'payload',
    );

    const built = await buildCliBinaryArtifactSupportPayload({
      ...identityInput,
      payloadDir,
      supportArtifactFingerprint: identity.fingerprint,
      commandProbe: (command) => command === 'pnpm',
    });

    expect(built.entrypoint).toBe('.happier-daemon-support.json');
    expect(built.workspaceRuntimeIdentity).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      readFile(join(payloadDir, built.entrypoint), 'utf8'),
    ).resolves.toContain(identity.fingerprint);
    expect(existsSync(join(payloadDir, 'node_modules'))).toBe(true);
    expect(
      existsSync(
        join(payloadDir, 'tools', 'unpacked', 'happier-cliproxyapi-managed'),
      ),
    ).toBe(true);
    expect(existsSync(join(payloadDir, 'scripts'))).toBe(false);
    expect(existsSync(join(payloadDir, 'package-dist'))).toBe(false);
    expect(existsSync(join(payloadDir, '.project'))).toBe(false);
    const stagedNative = join(payloadDir, 'node_modules/@happier-dev/cli-common/native');
    expect(await readFile(join(stagedNative, 'binding.node'), 'utf8')).toBe('shippable native bytes');
    expect(existsSync(join(stagedNative, '.private-staging'))).toBe(false);
    expect(
      existsSync(
        join(payloadDir, 'node_modules', '@happier-dev', 'cli-common', 'dist'),
      ),
    ).toBe(false);
  });

  it('stages immutable daemon support without waiting for the mutable CLI dist lock', async () => {
    const root = await makeTempRepo();
    await createSupportIdentityFixture(root);
    const target = targetForHost();
    const identityInput = {
      repoRoot: root,
      target,
      goVersion: 'go version go1.fixture',
    };
    const identity = readCliBinaryArtifactSupportIdentity(identityInput);
    const payloadDir = join(
      root,
      'artifacts',
      'daemon-support',
      identity.fingerprint,
      'payload',
    );
    const cliDistLockPath = join(
      root,
      '.project',
      'tmp',
      'cli-dist-build.lock',
    );
    await writeFixtureFile(
      cliDistLockPath,
      JSON.stringify({
        pid: process.pid,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      }),
    );

    let commandObservedWhileCliDistLocked = false;
    let commandObservedWhileSharedDepsLocked = false;
    let markCommandStarted!: () => void;
    const commandStarted = new Promise<void>((resolvePromise) => {
      markCommandStarted = resolvePromise;
    });
    const build = buildCliBinaryArtifactSupportPayload({
      ...identityInput,
      payloadDir,
      supportArtifactFingerprint: identity.fingerprint,
      commandProbe: (command) => command === 'pnpm',
      runCommand: async (command, args) => {
        commandObservedWhileCliDistLocked ||= existsSync(cliDistLockPath);
        commandObservedWhileSharedDepsLocked ||= existsSync(
          join(root, '.project', 'tmp', 'cli-shared-deps.lock'),
        );
        const outputIndex = args.indexOf(command === 'go' ? '-o' : '--output');
        const outputPath = args[outputIndex + 1];
        if (outputIndex < 0 || !outputPath)
          throw new Error('fixture managed-runtime output path missing');
        await writeFixtureFile(outputPath, 'managed runtime\n');
        markCommandStarted();
      },
    });

    const startedBeforeRelease = await Promise.race([
      commandStarted.then(() => true),
      new Promise<false>((resolvePromise) =>
        setTimeout(() => resolvePromise(false), 1_000),
      ),
    ]);
    await rm(cliDistLockPath, { force: true });
    await build;

    expect(startedBeforeRelease).toBe(true);
    expect(commandObservedWhileCliDistLocked).toBe(true);
    expect(commandObservedWhileSharedDepsLocked).toBe(false);
  });

  it.each(['native', 'foreign'])(
    'builds %s-target daemon code without recopying its stable runtime support closure',
    async (targetKind) => {
      const root = await makeTempRepo();
      await createSupportIdentityFixture(root, { nativeSupport: false });
      const payloadDir = join(
        root,
        'artifacts',
        'daemon',
        'code-only',
        'payload',
      );
      const hostTarget = targetForHost();
      const target =
        targetKind === 'native'
          ? hostTarget
          : {
              ...hostTarget,
              arch: hostTarget.arch === 'arm64' ? 'x64' : 'arm64',
              bunTarget: `bun-${hostTarget.os}-${hostTarget.arch === 'arm64' ? 'x64' : 'arm64'}`,
            };

      const built = await buildCliBinaryArtifactCodePayload({
        repoRoot: root,
        payloadDir,
        target,
        commandProbe: (command) => command === 'pnpm',
        compileBinary: async ({ outfile, target: compiledTarget }) => {
          expect(compiledTarget).toEqual(target);
          await writeFixtureFile(outfile, 'compiled daemon binary\n');
        },
      });

      expect(built.entrypoint).toBe('happier');
      await expect(readFile(join(payloadDir, 'happier'), 'utf8')).resolves.toBe(
        'compiled daemon binary\n',
      );
      await expect(
        readFile(join(payloadDir, 'package.json'), 'utf8'),
      ).resolves.toContain('"name":"@happier-dev/cli"');
      await expect(
        readFile(join(payloadDir, 'package-dist', 'index.mjs'), 'utf8'),
      ).resolves.toContain('index.js');
      expect(existsSync(join(payloadDir, 'node_modules'))).toBe(false);
      expect(existsSync(join(payloadDir, 'tools'))).toBe(false);
      expect(existsSync(join(payloadDir, 'scripts'))).toBe(true);
    },
  );

  it('rejects a full cross-target payload before copying host-native support', async () => {
    const root = await makeTempRepo();
    const target =
      process.platform === 'win32'
        ? {
            bunTarget: 'bun-linux-x64-baseline',
            os: 'linux',
            arch: 'x64',
            exeExt: '',
          }
        : {
            bunTarget: 'bun-windows-x64',
            os: 'windows',
            arch: 'x64',
            exeExt: '.exe',
          };
    await expect(
      buildCliBinaryArtifactPayload({
        repoRoot: root,
        payloadDir: join(root, 'payload'),
        target,
        commandProbe: (command) => command === 'bun',
      }),
    ).rejects.toThrow(
      /host-native runtime packages require a matching host target/i,
    );
  });

  it('retains one flattened self-contained daemon payload for release packaging', async () => {
    const root = await makeTempRepo();
    await createSupportIdentityFixture(root);
    const sourceRoot = await installCanonicalProjectionGenerator(root);
    await symlink(join(sourceRoot, 'packages/cli-common/registerSourceRuntime.mjs'),
      join(root, 'packages/cli-common/registerSourceRuntime.mjs'));
    const payloadDir = join(root, 'release-payload');
    const target = targetForHost();
    const prebuiltRuntimePath = join(
      root,
      'prebuilt',
      `happier-cliproxyapi-managed${target.exeExt}`,
    );
    const prebuiltCustodyPath = join(
      root,
      'prebuilt',
      `happier-process-custody${target.exeExt}`,
    );
    await writeFixtureFile(prebuiltRuntimePath, 'prebuilt release runtime\n');
    await writeFixtureFile(prebuiltCustodyPath, 'prebuilt release custody\n');

    const build = () => buildCliBinaryArtifactPayload({
      repoRoot: root,
      payloadDir,
      target,
      cliProxyApiManagedRuntimeExecutablePath: prebuiltRuntimePath,
      processCustodyRuntimeExecutablePath: prebuiltCustodyPath,
      commandProbe: (command) => command === 'bun' || command === 'pnpm',
      compileBinary: async ({ outfile }) => {
        await writeFixtureFile(outfile, 'compiled release daemon binary\n');
      },
    });
    const failuresPath = join(root, 'apps/cli/.project/tmp/bundled-plugin-publication/failures.json');
    await writeFixtureFile(failuresPath, JSON.stringify([{
      packageName: '@happier-dev/plugins-cliproxyapi', pluginId: 'happier.cliproxyapi',
      diagnostic: { code: 'plugin_manifest_invalid', message: 'Publication is incomplete' },
    }]));
    // The checkout record describes an earlier publication, while the real
    // generator evaluates the current source into a private output root.
    const staleFailures = await readFile(failuresPath, 'utf8');
    await build();
    expect(await readFile(failuresPath, 'utf8')).toBe(staleFailures);
    expect(JSON.parse(await readFile(join(payloadDir, '.project/tmp/bundled-plugin-publication/failures.json'), 'utf8'))).toEqual([]);
    if (process.platform === 'win32') {
      expect(await readFile(join(payloadDir, 'happier-service-launcher.exe'))).toEqual(createWindowsServiceLauncherPeFixture());
      for (const relativePath of ['happier-service-launcher.exe', 'tools/unpacked/happier-cliproxyapi-managed.exe']) {
        expect(cliDistBuildManifest.readCliRuntimeAssetIntegrity({ runtimeRoot: payloadDir, relativePath }).ok).toBe(true);
      }
    }


    await expect(readFile(join(payloadDir, 'happier'), 'utf8')).resolves.toBe(
      'compiled release daemon binary\n',
    );
    await expect(
      readFile(join(payloadDir, 'package-dist', 'index.mjs'), 'utf8'),
    ).resolves.toContain('index.js');
    expect(
      existsSync(
        join(
          payloadDir,
          'node_modules',
          '@happier-dev',
          'cli-common',
          'dist',
          'index.js',
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        join(
          payloadDir,
          'tools',
          'unpacked',
          `happier-cliproxyapi-managed${target.exeExt}`,
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(join(payloadDir, 'scripts', 'ripgrep_launcher.cjs')),
    ).toBe(true);
    expect(
      (await lstat(join(payloadDir, 'node_modules'))).isSymbolicLink(),
    ).toBe(false);
    expect((await lstat(join(payloadDir, 'tools'))).isSymbolicLink()).toBe(
      false,
    );
    expect((await lstat(join(payloadDir, 'scripts'))).isSymbolicLink()).toBe(
      false,
    );

    // STACK-PAYLOAD-FIX-1109: optional failures remain diagnosable and excluded,
    // while the self-contained payload still publishes its healthy code.
    await writeFixtureFile(failuresPath, '[]\n');
    await writeFixtureFile(join(root, 'packages/plugins/broken/package.json'), JSON.stringify({
      name: '@happier-dev/plugins-broken', version: '0.0.0',
    }));
    await writeFixtureFile(join(root, 'packages/plugins/broken/src/manifest.ts'),
      'export const PLUGIN_MANIFEST = { schemaVersion: 2, id: "happier.broken" };');
    await build();
    expect(JSON.parse(await readFile(join(payloadDir, '.project/tmp/bundled-plugin-publication/failures.json'), 'utf8')))
      .toMatchObject([{ packageName: '@happier-dev/plugins-broken', diagnostic: { code: 'plugin_manifest_invalid' } }]);
    expect(existsSync(join(payloadDir, 'node_modules/@happier-dev/plugins-broken'))).toBe(false);
    expect(await readFile(join(payloadDir, 'happier'), 'utf8')).toBe('compiled release daemon binary\n');
  }, 240_000);

  it('refuses a required plugin publication failure before compiling the native payload', async () => {
    const root = await makeTempRepo();
    await createSupportIdentityFixture(root, { nativeSupport: false });
    const sourceRoot = await installCanonicalProjectionGenerator(root);
    await symlink(join(sourceRoot, 'packages/cli-common/registerSourceRuntime.mjs'),
      join(root, 'packages/cli-common/registerSourceRuntime.mjs'));
    await writeFixtureFile(join(root, 'packages/plugins/codex/package.json'), JSON.stringify({
      name: '@happier-dev/plugins-codex', version: '0.0.0',
    }));
    await writeFixtureFile(join(root, 'packages/plugins/codex/src/manifest.ts'),
      'export const PLUGIN_MANIFEST = { schemaVersion: 2, id: "happier.codex" };');
    let nativeCompilations = 0;
    await expect(buildCliBinaryArtifactPayload({
      repoRoot: root,
      payloadDir: join(root, 'release-payload'),
      target: targetForHost(),
      commandProbe: (command) => command === 'bun' || command === 'pnpm',
      runCommand: (command, args, options) => execOrThrow(command, args, { ...options, stdio: 'pipe' }),
      compileBinary: async ({ outfile }) => {
        nativeCompilations += 1;
        await writeFixtureFile(outfile, 'compiled release daemon binary\n');
      },
    })).rejects.toThrow(/@happier-dev\/plugins-codex/);
    expect(nativeCompilations).toBe(0);
  }, 240_000);
});
