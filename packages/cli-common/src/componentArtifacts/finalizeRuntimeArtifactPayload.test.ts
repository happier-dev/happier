import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { finalizeRuntimeArtifactPayload } from './finalizeRuntimeArtifactPayload.js';
import { CLI_BINARY_TARGETS } from './targets.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), 'runtime-native-projection-'));
  roots.push(root);
  return root;
}

async function put(root: string, path: string, content: string | Uint8Array = path) {
  const destination = join(root, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content);
}

async function putPackage(root: string, path: string, name: string, marker: Uint8Array) {
  await put(root, `${path}/package.json`, JSON.stringify({ name, main: 'index.js' }));
  await put(root, `${path}/index.js`, `module.exports = ${JSON.stringify(name)};\n`);
  await put(root, `${path}/assets/runtime.bin`, marker);
}

describe('finalizeRuntimeArtifactPayload native target projection', () => {
  it.each(CLI_BINARY_TARGETS)('keeps rg and projects unused base tools for $os-$arch', async (target) => {
    const root = await fixtureRoot();
    const rgName = target.os === 'windows' ? 'rg.exe' : 'rg';
    await put(root, `tools/unpacked/${rgName}`, 'rg');
    await put(root, 'tools/unpacked/ripgrep.node', 'addon');
    await put(root, `tools/unpacked/${target.os === 'windows' ? 'zellij.exe' : 'zellij'}`, 'zellij');
    await put(root, 'tools/unpacked/ripgrep-LICENSE', 'rg license');
    await put(root, 'tools/unpacked/zellij-LICENSE', 'zellij license');

    await finalizeRuntimeArtifactPayload(root, target);

    await expect(readFile(join(root, 'tools', 'unpacked', rgName), 'utf8')).resolves.toBe('rg');
    await expect(readFile(join(root, 'tools', 'unpacked', 'ripgrep-LICENSE'), 'utf8')).resolves.toBe('rg license');
    await expect(stat(join(root, 'tools', 'unpacked', 'ripgrep.node'))).rejects.toMatchObject({ code: 'ENOENT' });
    if (target.os === 'windows') {
      await expect(stat(join(root, 'tools', 'unpacked', 'zellij.exe'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(join(root, 'tools', 'unpacked', 'zellij-LICENSE'))).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
      await expect(readFile(join(root, 'tools', 'unpacked', 'zellij'), 'utf8')).resolves.toBe('zellij');
      await expect(readFile(join(root, 'tools', 'unpacked', 'zellij-LICENSE'), 'utf8')).resolves.toBe('zellij license');
    }
  });

  it.each(CLI_BINARY_TARGETS)('projects only binary runtime formats and foreign ps-list helpers for $os-$arch', async (target) => {
    const root = await fixtureRoot();
    const removedFormats = ['index.cjs', 'mcp/bridge.cjs', 'index.d.ts', 'index.d.mts', 'index.d.cts', 'index.d.ts.map', 'worker/entry.d.mts.map', 'cache.tsbuildinfo'];
    const removedRuntimeMetadata = [
      'node_modules/library/dist/index.d.ts.map',
      'node_modules/library/dist/index.d.mts.map',
      'node_modules/library/dist/index.d.cts.map',
      'node_modules/library/dist/cache.tsbuildinfo',
    ];
    const retained = ['package-dist/index.mjs', 'package-dist/mcp/bridge.mjs', 'package-dist/index.js.map', 'package-dist/index.mjs.map', 'package-dist/index.cjs.map',
      'scripts/relay.cjs', 'node_modules/library/package-dist/index.cjs', 'node_modules/library/dist/index.js',
      'node_modules/library/dist/index.js.map', 'node_modules/library/dist/index.d.ts',
      'node_modules/library/dist/index.d.mts', 'node_modules/library/dist/index.d.cts',
      'node_modules/library/LICENSE', 'node_modules/library/README.md'];
    for (const file of removedFormats) await put(root, `package-dist/${file}`);
    for (const file of removedRuntimeMetadata) await put(root, file);
    for (const file of retained) await put(root, file);
    const psPackages = ['node_modules/ps-list', 'node_modules/consumer/node_modules/ps-list'];
    for (const pkg of psPackages) {
      for (const file of ['vendor/fastlist-0.3.0-x64.exe', 'vendor/fastlist-0.3.0-x86.exe', 'vendor/LICENSE', 'index.js', 'index.d.ts']) {
        await put(root, `${pkg}/${file}`);
      }
    }
    await put(root, 'node_modules/unrelated/vendor/helper.exe');

    await finalizeRuntimeArtifactPayload(root, target);

    for (const file of removedFormats) await expect(stat(join(root, 'package-dist', file))).rejects.toMatchObject({ code: 'ENOENT' });
    for (const file of removedRuntimeMetadata) await expect(stat(join(root, file))).rejects.toMatchObject({ code: 'ENOENT' });
    for (const file of [...retained, 'node_modules/unrelated/vendor/helper.exe']) await expect(readFile(join(root, file), 'utf8')).resolves.toBe(file);
    for (const pkg of psPackages) {
      expect(await readdir(join(root, pkg, 'vendor'))).toEqual(target.os === 'windows'
        ? ['LICENSE', 'fastlist-0.3.0-x64.exe', 'fastlist-0.3.0-x86.exe'] : ['LICENSE']);
      await expect(readFile(join(root, pkg, 'index.js'), 'utf8')).resolves.toContain('index.js');
      await expect(readFile(join(root, pkg, 'index.d.ts'), 'utf8')).resolves.toContain('index.d.ts');
    }
  });

  it.each(CLI_BINARY_TARGETS)('retains complete native assets for $os-$arch including nested packages', async (target) => {
    const root = await fixtureRoot();
    const platform = target.os === 'windows' ? 'win32' : target.os;
    const targetKey = `${platform}-${target.arch}`;
    const nativeTargets = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64'];
    const onnxPackages = ['node_modules/onnxruntime-node', 'node_modules/consumer/node_modules/onnxruntime-node'];
    const ptyPackages = ['node_modules/node-pty', 'node_modules/@homebridge/node-pty-prebuilt-multiarch'];
    const conptyVersions = ['1.23.251008001', '1.22.250204002'];
    const windowsModules = [
      'windowsConoutConnection', 'windowsPtyAgent', 'windowsPtyAgent.test',
      'windowsTerminal', 'windowsTerminal.test', 'conpty_console_list_agent',
      'shared/conout', 'worker/conoutSocketWorker',
    ];
    const unixModules = ['unixTerminal', 'unixTerminal.test', 'prebuild-loader'];
    const sharedModules = ['index', 'terminal', 'utils', 'eventEmitter2', 'interfaces', 'types',
      'prebuild-file-path', 'shared/retain', 'worker/retain'];
    const barePackages = ['bare-fs', 'bare-os', 'bare-url'];
    const bareTargets = [...nativeTargets, 'android-arm64', 'ios-arm64', 'ios-arm64-simulator'];
    for (const packagePath of [...onnxPackages, ...ptyPackages]) {
      await put(root, `${packagePath}/LICENSE`);
      await put(root, `${packagePath}/dist/index.js`);
      await put(root, `${packagePath}/dist/index.js.map`);
    }
    for (const [index, packagePath] of ptyPackages.entries()) {
      const version = conptyVersions[index];
      await put(root, `${packagePath}/package.json`, '{}');
      for (const module of [...windowsModules, ...unixModules, ...sharedModules]) {
        await put(root, `${packagePath}/lib/${module}.js`);
        await put(root, `${packagePath}/src/${module}.ts`);
      }
      await put(root, `${packagePath}/deps/winpty/src/agent/Agent.cc`);
      await put(root, `${packagePath}/src/win/conpty.cc`);
      await put(root, `${packagePath}/src/unix/pty.cc`);
      await put(root, `${packagePath}/third_party/conpty/NOTICE`);
      await put(root, `${packagePath}/third_party/conpty/${version}/metadata.json`);
      for (const arch of ['arm64', 'x64']) {
        await put(root, `${packagePath}/third_party/conpty/${version}/win10-${arch}/OpenConsole.exe`);
        await put(root, `${packagePath}/third_party/conpty/${version}/win10-${arch}/conpty.dll`);
      }
    }
    for (const key of nativeTargets) {
      const [os, arch] = key.split('-');
      for (const packagePath of onnxPackages) {
        for (const napi of ['napi-v3', 'napi-v6']) {
          for (const file of ['onnxruntime_binding.node', 'libonnxruntime.so', 'onnxruntime.dll', 'NOTICE']) {
            await put(root, `${packagePath}/bin/${napi}/${os}/${arch}/${file}`);
          }
        }
      }
      for (const packagePath of ptyPackages) {
        await put(root, `${packagePath}/prebuilds/${key}/pty.node`);
        await put(root, `${packagePath}/prebuilds/${key}/spawn-helper`);
        await put(root, `${packagePath}/prebuilds/${key}/conpty/OpenConsole.exe`);
      }
    }
    for (const packageName of barePackages) {
      await put(root, `node_modules/${packageName}/LICENSE`);
      for (const key of bareTargets) {
        await put(root, `node_modules/${packageName}/prebuilds/${key}/runtime.node`);
      }
    }
    await put(root, 'node_modules/node-pty/build/Release/pty.node');
    await put(root, 'node_modules/@homebridge/node-pty-prebuilt-multiarch/build/Release/pty.node');
    await put(root, 'node_modules/unrelated/prebuilds/linux-x64/keep.node');
    await put(root, 'node_modules/unrelated/lib/windowsTerminal.js');
    await put(root, 'scripts/node_pty_relay.cjs');
    await put(root, 'package-dist/index.mjs');
    await put(root, 'node_modules/.bin/unused');

    await finalizeRuntimeArtifactPayload(root, target);

    for (const packagePath of onnxPackages) {
      for (const napi of ['napi-v3', 'napi-v6']) {
        expect(await readdir(join(root, packagePath, 'bin', napi))).toEqual([platform]);
        expect(await readdir(join(root, packagePath, 'bin', napi, platform))).toEqual([target.arch]);
        expect(await readdir(join(root, packagePath, 'bin', napi, platform, target.arch))).toEqual([
          'NOTICE', 'libonnxruntime.so', 'onnxruntime.dll', 'onnxruntime_binding.node',
        ]);
      }
    }
    for (const packagePath of ptyPackages) {
      expect(await readdir(join(root, packagePath, 'prebuilds'))).toEqual([targetKey]);
      await expect(readFile(join(root, packagePath, 'prebuilds', targetKey, 'conpty', 'OpenConsole.exe'), 'utf8')).resolves.toContain('OpenConsole.exe');
      await expect(readFile(join(root, packagePath, 'build/Release/pty.node'), 'utf8')).resolves.toContain('pty.node');
    }
    for (const [index, packagePath] of ptyPackages.entries()) {
      const conptyDir = join(root, packagePath, 'third_party/conpty');
      if (target.os === 'windows') {
        expect(await readdir(conptyDir)).toEqual(['NOTICE', conptyVersions[index]].sort());
        expect(await readdir(join(conptyDir, conptyVersions[index]))).toEqual(['metadata.json', `win10-${target.arch}`].sort());
        await expect(readFile(join(conptyDir, conptyVersions[index], `win10-${target.arch}`, 'OpenConsole.exe'), 'utf8'))
          .resolves.toContain('OpenConsole.exe');
      } else {
        await expect(stat(conptyDir)).rejects.toMatchObject({ code: 'ENOENT' });
      }
      const retainedPaths = target.os === 'windows'
        ? ['package.json', 'lib/windowsTerminal.js', 'deps/winpty/src/agent/Agent.cc', 'src/win/conpty.cc']
        : ['package.json', 'lib/unixTerminal.js', 'src/unix/pty.cc'];
      for (const retainedPath of retainedPaths) {
        await expect(readFile(join(root, packagePath, retainedPath), 'utf8')).resolves.toBeTruthy();
      }
      if (target.os !== 'windows') {
        for (const removedPath of ['deps/winpty', 'src/win']) {
          await expect(stat(join(root, packagePath, removedPath))).rejects.toMatchObject({ code: 'ENOENT' });
        }
      } else {
        await expect(stat(join(root, packagePath, 'src/unix'))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      const removedModules = target.os === 'windows' ? unixModules : windowsModules;
      const retainedModules = [...sharedModules, ...(target.os === 'windows' ? windowsModules : unixModules)];
      for (const module of removedModules) {
        for (const path of [`lib/${module}.js`, `src/${module}.ts`]) {
          await expect(stat(join(root, packagePath, path))).rejects.toMatchObject({ code: 'ENOENT' });
        }
      }
      for (const module of retainedModules) {
        for (const path of [`lib/${module}.js`, `src/${module}.ts`]) {
          await expect(readFile(join(root, packagePath, path), 'utf8')).resolves.toContain(module);
        }
      }
    }
    for (const packagePath of [...onnxPackages, ...ptyPackages]) {
      await expect(readFile(join(root, packagePath, 'LICENSE'), 'utf8')).resolves.toContain('LICENSE');
      await expect(readFile(join(root, packagePath, 'dist/index.js.map'), 'utf8')).resolves.toContain('index.js.map');
    }
    for (const packageName of barePackages) {
      expect(await readdir(join(root, 'node_modules', packageName, 'prebuilds'))).toEqual([targetKey]);
      await expect(readFile(join(root, 'node_modules', packageName, 'prebuilds', targetKey, 'runtime.node'), 'utf8'))
        .resolves.toContain('runtime.node');
      await expect(readFile(join(root, 'node_modules', packageName, 'LICENSE'), 'utf8')).resolves.toContain('LICENSE');
    }
    await expect(readFile(join(root, 'node_modules/unrelated/prebuilds/linux-x64/keep.node'), 'utf8')).resolves.toContain('keep.node');
    await expect(readFile(join(root, 'node_modules/unrelated/lib/windowsTerminal.js'), 'utf8')).resolves.toContain('windowsTerminal.js');
    await expect(readFile(join(root, 'scripts/node_pty_relay.cjs'), 'utf8')).resolves.toContain('node_pty_relay.cjs');
    await expect(stat(join(root, 'node_modules/.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(CLI_BINARY_TARGETS)('keeps target sharp packages but removes unused Claude SDK native packages for $os-$arch', async (target) => {
    const root = await fixtureRoot();
    const sharpRoot = 'node_modules/sharp/node_modules/@img';
    const claudeRoot = 'node_modules/@anthropic-ai/claude-agent-sdk/node_modules/@anthropic-ai';
    const sharpPackages = [
      'sharp-darwin-arm64', 'sharp-darwin-x64',
      'sharp-libvips-darwin-arm64', 'sharp-libvips-darwin-x64',
      'sharp-linux-arm64', 'sharp-linux-x64',
      'sharp-libvips-linux-arm64', 'sharp-libvips-linux-x64',
      'sharp-linuxmusl-arm64', 'sharp-linuxmusl-x64',
      'sharp-libvips-linuxmusl-arm64', 'sharp-libvips-linuxmusl-x64',
      'sharp-win32-arm64', 'sharp-win32-x64',
      'sharp-wasm32',
      'sharp-freebsd-wasm32', 'sharp-webcontainers-wasm32',
    ];
    const claudePackages = [
      'claude-agent-sdk-darwin-arm64', 'claude-agent-sdk-darwin-x64',
      'claude-agent-sdk-linux-arm64', 'claude-agent-sdk-linux-x64',
      'claude-agent-sdk-linux-arm64-musl', 'claude-agent-sdk-linux-x64-musl',
      'claude-agent-sdk-win32-arm64', 'claude-agent-sdk-win32-x64',
    ];
    for (const packageName of sharpPackages) await put(root, `${sharpRoot}/${packageName}/package.json`, '{}');
    for (const packageName of claudePackages) await put(root, `${claudeRoot}/${packageName}/package.json`, '{}');
    await put(root, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs', 'export const query = () => {};');
    await put(root, 'node_modules/@anthropic-ai/claude-agent-sdk/LICENSE.md', 'Anthropic SDK license');
    await put(root, 'node_modules/@anthropic-ai/claude-agent-sdk/node_modules/@anthropic-ai/sdk/index.mjs', 'export {};');
    await put(root, `${sharpRoot}/colour/package.json`, '{}');
    await put(root, 'package-dist/index.mjs');

    await finalizeRuntimeArtifactPayload(root, target);

    const platform = target.os === 'windows' ? 'win32' : target.os;
    const expectedSharp = target.os === 'linux'
      ? [
          `sharp-libvips-linux-${target.arch}`,
          `sharp-libvips-linuxmusl-${target.arch}`,
          `sharp-linux-${target.arch}`,
          `sharp-linuxmusl-${target.arch}`,
        ]
      : [
          ...(target.os === 'darwin' ? [`sharp-libvips-darwin-${target.arch}`] : []),
          `sharp-${platform}-${target.arch}`,
        ];
    expect(await readdir(join(root, sharpRoot))).toEqual(['colour', ...expectedSharp].sort());
    expect(await readdir(join(root, claudeRoot))).toEqual(['sdk']);
    await expect(readFile(join(root, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'), 'utf8'))
      .resolves.toContain('query');
    await expect(readFile(join(root, 'node_modules/@anthropic-ai/claude-agent-sdk/LICENSE.md'), 'utf8'))
      .resolves.toContain('license');
    await expect(readFile(join(root, 'node_modules/@anthropic-ai/claude-agent-sdk/node_modules/@anthropic-ai/sdk/index.mjs'), 'utf8'))
      .resolves.toContain('export');
  });

  it.each(CLI_BINARY_TARGETS)('removes only audited byte-identical nested dependency copies with reachable ancestors for $os-$arch', async (target) => {
    const root = await fixtureRoot();
    const marker = new Uint8Array([0, 255, 17, 0, 128]);
    const pairs = [
      {
        duplicate: 'node_modules/@happier-dev/agents/node_modules/zod',
        survivor: 'node_modules/zod',
        packageName: 'zod',
      },
      {
        duplicate: 'node_modules/@happier-dev/protocol/node_modules/zod',
        survivor: 'node_modules/zod',
        packageName: 'zod',
      },
      {
        duplicate: 'node_modules/@happier-dev/protocol/node_modules/zod-to-json-schema/node_modules/zod',
        survivor: 'node_modules/zod',
        packageName: 'zod',
      },
      {
        duplicate: 'node_modules/@modelcontextprotocol/sdk/node_modules/zod',
        survivor: 'node_modules/zod',
        packageName: 'zod',
      },
      {
        duplicate: 'node_modules/@happier-dev/release-runtime/node_modules/tar',
        survivor: 'node_modules/tar',
        packageName: 'tar',
      },
      {
        duplicate: 'node_modules/archiver/node_modules/zip-stream/node_modules/archiver-utils',
        survivor: 'node_modules/archiver/node_modules/archiver-utils',
        packageName: 'archiver-utils',
      },
      {
        duplicate: 'node_modules/@modelcontextprotocol/sdk/node_modules/express/node_modules/body-parser/node_modules/qs',
        survivor: 'node_modules/@modelcontextprotocol/sdk/node_modules/express/node_modules/qs',
        packageName: 'qs',
      },
      ...(target.os === 'linux' ? ['linux', 'linuxmusl'] : target.os === 'darwin' ? ['darwin'] : []).map((platform) => ({
        duplicate: `node_modules/sharp/node_modules/@img/sharp-${platform}-${target.arch}/node_modules/@img/sharp-libvips-${platform}-${target.arch}`,
        survivor: `node_modules/sharp/node_modules/@img/sharp-libvips-${platform}-${target.arch}`,
        packageName: `@img/sharp-libvips-${platform}-${target.arch}`,
      })),
    ] as const;
    for (const pair of pairs) {
      await putPackage(root, pair.survivor, pair.packageName, marker);
      await putPackage(root, pair.duplicate, pair.packageName, marker);
    }
    for (const platform of target.os === 'linux' ? ['linux', 'linuxmusl'] : [target.os === 'windows' ? 'win32' : 'darwin']) {
      await put(root, `node_modules/sharp/node_modules/@img/sharp-${platform}-${target.arch}/package.json`, '{}');
    }

    const mcpSurvivor = 'node_modules/@modelcontextprotocol/sdk';
    const mcpDuplicate = 'node_modules/@anthropic-ai/claude-agent-sdk/node_modules/@modelcontextprotocol/sdk';
    await putPackage(root, mcpSurvivor, '@modelcontextprotocol/sdk', marker);
    await put(root, `${mcpSurvivor}/package.json`, JSON.stringify({
      name: '@modelcontextprotocol/sdk', main: 'index.js',
      peerDependencies: { '@cfworker/json-schema': '^4.1.1', zod: '^3.25 || ^4.0' },
      peerDependenciesMeta: { '@cfworker/json-schema': { optional: true } },
    }));
    await mkdir(dirname(join(root, mcpDuplicate)), { recursive: true });
    await cp(join(root, mcpSurvivor), join(root, mcpDuplicate), { recursive: true });
    const allPairs = [
      { duplicate: mcpDuplicate, survivor: mcpSurvivor, packageName: '@modelcontextprotocol/sdk' },
      ...pairs,
    ];
    await putPackage(root, 'node_modules/unlisted-consumer/node_modules/zod', 'zod', marker);
    await put(root, 'package-dist/index.mjs');

    await finalizeRuntimeArtifactPayload(root, target);

    for (const pair of allPairs) {
      await expect(stat(join(root, pair.duplicate))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(root, pair.survivor, 'assets/runtime.bin'))).resolves.toEqual(Buffer.from(marker));
      const resolver = createRequire(join(root, dirname(pair.duplicate), 'resolver.cjs'));
      expect(resolver.resolve(pair.packageName)).toBe(join(root, pair.survivor, 'index.js'));
    }
    await expect(readFile(join(root, 'node_modules/unlisted-consumer/node_modules/zod/assets/runtime.bin')))
      .resolves.toEqual(Buffer.from(marker));
  });

  it('retains an equal nested copy when a divergent intermediate ancestor shadows the audited survivor', async () => {
    const root = await fixtureRoot();
    const duplicate = 'node_modules/@happier-dev/protocol/node_modules/zod-to-json-schema/node_modules/zod';
    const intermediate = 'node_modules/@happier-dev/protocol/node_modules/zod';
    await putPackage(root, 'node_modules/zod', 'zod', new Uint8Array([1]));
    await putPackage(root, duplicate, 'zod', new Uint8Array([1]));
    await putPackage(root, intermediate, 'zod', new Uint8Array([2]));

    await finalizeRuntimeArtifactPayload(root, CLI_BINARY_TARGETS[0]);

    await expect(readFile(join(root, duplicate, 'assets/runtime.bin'))).resolves.toEqual(Buffer.from([1]));
    const resolver = createRequire(join(root, 'node_modules/@happier-dev/protocol/node_modules/zod-to-json-schema/index.js'));
    expect(resolver.resolve('zod')).toBe(join(root, duplicate, 'index.js'));
  });

  it('preserves the MCP SDK optional peer selected by its original package location', async () => {
    const root = await fixtureRoot();
    const sdkRoot = 'node_modules/@anthropic-ai/claude-agent-sdk';
    const duplicate = `${sdkRoot}/node_modules/@modelcontextprotocol/sdk`;
    const survivor = 'node_modules/@modelcontextprotocol/sdk';
    // MCP 1.29 declares @cfworker/json-schema as an optional peer. Unlike its
    // dependencies, peers are not copied into each package by the vendor owner.
    for (const path of [duplicate, survivor]) {
      await put(root, `${path}/package.json`, JSON.stringify({
        name: '@modelcontextprotocol/sdk', main: 'index.js',
        peerDependencies: { '@cfworker/json-schema': '^4.1.1' },
        peerDependenciesMeta: { '@cfworker/json-schema': { optional: true } },
      }));
      await put(root, `${path}/index.js`, "module.exports = require('@cfworker/json-schema');");
    }
    for (const [path, value] of [
      [`${sdkRoot}/node_modules/@cfworker/json-schema`, 'consumer peer'],
      ['node_modules/@cfworker/json-schema', 'root peer'],
    ]) {
      await put(root, `${path}/package.json`, JSON.stringify({ name: '@cfworker/json-schema', main: 'index.js' }));
      await put(root, `${path}/index.js`, `module.exports = ${JSON.stringify(value)};`);
    }

    await finalizeRuntimeArtifactPayload(root, CLI_BINARY_TARGETS[0]);

    const consumer = createRequire(join(root, sdkRoot, 'sdk.js'));
    expect(consumer('@modelcontextprotocol/sdk')).toBe('consumer peer');
  });

  it.skipIf(process.platform === 'win32')('retains equal link text when the nested and ancestor links resolve to different bytes', async () => {
    const root = await fixtureRoot();
    const duplicate = 'node_modules/@happier-dev/agents/node_modules/zod';
    const survivor = 'node_modules/zod';
    for (const path of [duplicate, survivor]) {
      await putPackage(root, path, 'zod', new Uint8Array([1]));
      await symlink('../runtime.bin', join(root, path, 'external.bin'));
    }
    await put(root, 'node_modules/runtime.bin', new Uint8Array([1]));
    await put(root, 'node_modules/@happier-dev/agents/node_modules/runtime.bin', new Uint8Array([2]));

    await finalizeRuntimeArtifactPayload(root, CLI_BINARY_TARGETS[0]);

    await expect(readFile(join(root, duplicate, 'external.bin'))).resolves.toEqual(Buffer.from([2]));
  });

  it.skipIf(process.platform === 'win32')('retains nested copies with different executable permissions', async () => {
    const root = await fixtureRoot();
    const duplicate = 'node_modules/@happier-dev/agents/node_modules/zod';
    for (const path of [duplicate, 'node_modules/zod']) {
      await putPackage(root, path, 'zod', new Uint8Array([1]));
    }
    await chmod(join(root, duplicate, 'index.js'), 0o755);
    await chmod(join(root, 'node_modules/zod/index.js'), 0o644);

    await finalizeRuntimeArtifactPayload(root, CLI_BINARY_TARGETS[0]);

    expect((await stat(join(root, duplicate, 'index.js'))).mode & 0o777).toBe(0o755);
  });

  it('retains audited nested dependencies when the survivor is absent or recursively differs', async () => {
    const root = await fixtureRoot();
    const marker = new Uint8Array([0, 255, 17, 0, 128]);
    const changedMarker = new Uint8Array([0, 255, 17, 0, 129]);
    const missingSurvivor = 'node_modules/@happier-dev/release-runtime/node_modules/tar';
    await putPackage(root, missingSurvivor, 'tar', marker);

    const divergentZod = 'node_modules/@happier-dev/agents/node_modules/zod';
    await putPackage(root, 'node_modules/zod', 'zod', marker);
    await putPackage(root, divergentZod, 'zod', changedMarker);

    const divergentSharp = 'node_modules/sharp/node_modules/@img/sharp-linux-arm64/node_modules/@img/sharp-libvips-linux-arm64';
    await putPackage(root, 'node_modules/sharp/node_modules/@img/sharp-libvips-linux-arm64', '@img/sharp-libvips-linux-arm64', marker);
    await putPackage(root, divergentSharp, '@img/sharp-libvips-linux-arm64', changedMarker);
    await put(root, 'node_modules/sharp/node_modules/@img/sharp-linux-arm64/package.json', '{}');
    await putPackage(root, 'node_modules/sharp/node_modules/@img/sharp-libvips-linuxmusl-arm64', '@img/sharp-libvips-linuxmusl-arm64', marker);
    await put(root, 'node_modules/sharp/node_modules/@img/sharp-linuxmusl-arm64/package.json', '{}');
    await put(root, 'package-dist/index.mjs');

    await finalizeRuntimeArtifactPayload(root, {
      os: 'linux', arch: 'arm64', bunTarget: 'bun-linux-arm64', exeExt: '',
    });

    for (const retained of [missingSurvivor, divergentZod, divergentSharp]) {
      await expect(readFile(join(root, retained, 'assets/runtime.bin'))).resolves.toBeTruthy();
    }
  });

  it.each([
    {
      packageRoot: 'node_modules/sharp',
      installedPackage: 'node_modules/sharp/node_modules/@img/sharp-linux-arm64',
      expectedMissing: '@img/sharp-darwin-arm64',
    },
  ])('rejects an incomplete cross-target closure for $packageRoot', async ({ packageRoot, installedPackage, expectedMissing }) => {
    const parent = await fixtureRoot();
    const root = join(parent, 'payload');
    for (const packageName of ['sharp-darwin-arm64', 'sharp-libvips-darwin-arm64']) {
      await put(parent, `node_modules/@img/${packageName}/package.json`, '{}');
    }
    await put(root, `${packageRoot}/package.json`, '{}');
    await put(root, `${installedPackage}/package.json`, '{}');
    await put(root, 'package-dist/index.mjs');

    await expect(finalizeRuntimeArtifactPayload(root, {
      os: 'darwin', arch: 'arm64', bunTarget: 'bun-darwin-arm64', exeExt: '',
    })).rejects.toThrow(expectedMissing);
  });

  it.each([
    'node_modules/onnxruntime-node',
    'node_modules/@huggingface/transformers/node_modules/onnxruntime-node',
  ])('rejects an ONNX payload missing its target binding in %s', async (packageRoot) => {
    const root = await fixtureRoot();
    await put(root, `${packageRoot}/package.json`, JSON.stringify({ name: 'onnxruntime-node', version: '1.21.0' }));
    await put(root, `${packageRoot}/bin/napi-v3/linux/arm64/onnxruntime_binding.node`);
    // A target directory or a different N-API binding cannot satisfy the
    // installed 1.21.0 loader's fixed napi-v3 require path.
    await put(root, `${packageRoot}/bin/napi-v3/darwin/arm64/libonnxruntime.1.21.0.dylib`);
    await put(root, `${packageRoot}/bin/napi-v6/darwin/arm64/onnxruntime_binding.node`);

    await expect(finalizeRuntimeArtifactPayload(root, {
      os: 'darwin', arch: 'arm64', bunTarget: 'bun-darwin-arm64', exeExt: '',
    })).rejects.toThrow('bin/napi-v3/darwin/arm64/onnxruntime_binding.node');
  });

  it.skipIf(process.platform === 'win32')('repairs the retained prebuild helper mode in a cross-target payload', async () => {
    const root = await fixtureRoot();
    const path = 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper';
    await put(root, path, '#!/bin/sh\nexit 0\n');
    await chmod(join(root, path), 0o644);

    await finalizeRuntimeArtifactPayload(root, { os: 'darwin', arch: 'arm64', bunTarget: 'bun-darwin-arm64', exeExt: '' });

    expect((await stat(join(root, path))).mode & 0o777).toBe(0o755);
  });

  it('does not prune native assets when no artifact target is requested', async () => {
    const root = await fixtureRoot();
    await put(root, 'node_modules/node-pty/prebuilds/darwin-arm64/pty.node');
    await put(root, 'node_modules/node-pty/prebuilds/win32-x64/pty.node');
    await finalizeRuntimeArtifactPayload(root);
    expect(await readdir(join(root, 'node_modules/node-pty/prebuilds'))).toEqual(['darwin-arm64', 'win32-x64']);
  });

  it.skipIf(process.platform === 'win32')('removes package-manager bin links before checking surviving links', async () => {
    const root = await fixtureRoot();
    await mkdir(join(root, 'node_modules/.bin'), { recursive: true });
    await symlink('/outside-payload/tool', join(root, 'node_modules/.bin/tool'));
    await finalizeRuntimeArtifactPayload(root);
    await expect(stat(join(root, 'node_modules/.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform === 'win32')('rejects an escaping helper link without changing its target permissions', async () => {
    const root = await fixtureRoot();
    const outside = await fixtureRoot();
    await put(outside, 'helper', '#!/bin/sh\nexit 0\n');
    await chmod(join(outside, 'helper'), 0o644);
    const prebuild = join(root, 'node_modules/node-pty/prebuilds/darwin-arm64');
    await mkdir(prebuild, { recursive: true });
    await symlink(join(outside, 'helper'), join(prebuild, 'spawn-helper'));
    await expect(finalizeRuntimeArtifactPayload(root, { os: 'darwin', arch: 'arm64', bunTarget: 'bun-darwin-arm64', exeExt: '' }))
      .rejects.toThrow('runtime payload symlink escapes');
    expect((await stat(join(outside, 'helper'))).mode & 0o777).toBe(0o644);
  });
});
