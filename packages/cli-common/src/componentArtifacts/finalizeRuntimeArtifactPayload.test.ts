import { execFile } from 'node:child_process';
import { cp, chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { extractArchivePayloadToDirectory, inspectTarArchiveEntries } from '@happier-dev/release-runtime/archiveExtraction';
import * as tar from 'tar';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { materializePrepublicationWorkspacePackageRoots } from '../workspaces/index.js';
import { finalizeRuntimeArtifactPayload } from './finalizeRuntimeArtifactPayload.js';
import { CLI_BINARY_TARGETS } from './targets.js';

const execFileAsync = promisify(execFile);

const fsFailurePlan = vi.hoisted(() => ({
    failCopy: false,
    failStagedRename: false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return {
        ...actual,
        cp: async (
            source: Parameters<typeof actual.cp>[0],
            destination: Parameters<typeof actual.cp>[1],
            options: Parameters<typeof actual.cp>[2],
        ) => {
            if (fsFailurePlan.failCopy) throw new Error('injected payload copy failure');
            return await actual.cp(source, destination, options);
        },
        rename: async (
            oldPath: Parameters<typeof actual.rename>[0],
            newPath: Parameters<typeof actual.rename>[1],
        ) => {
            if (fsFailurePlan.failStagedRename && basename(String(oldPath)) === 'entry') {
                throw new Error('injected staged rename failure');
            }
            return await actual.rename(oldPath, newPath);
        },
    };
});

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'finalize-runtime-artifact-payload-'));
    tempDirs.push(directory);
    return directory;
}

describe('finalizeRuntimeArtifactPayload', () => {
    afterEach(async () => {
        fsFailurePlan.failCopy = false;
        fsFailurePlan.failStagedRename = false;
        await Promise.all(tempDirs.splice(0).map(async (directory) => {
            await rm(directory, { recursive: true, force: true });
        }));
    });

    it.each(CLI_BINARY_TARGETS)('keeps rg and projects unused base tools for $os-$arch', async (target) => {
        const root = await createTempDir();
        const rgName = target.os === 'windows' ? 'rg.exe' : 'rg';
        const zellijName = target.os === 'windows' ? 'zellij.exe' : 'zellij';
        const put = async (path: string, contents: string) => {
            const fullPath = join(root, path);
            await mkdir(join(fullPath, '..'), { recursive: true });
            await writeFile(fullPath, contents);
        };
        await put(`tools/unpacked/${rgName}`, 'rg');
        await put('tools/unpacked/ripgrep.node', 'obsolete addon');
        await put(`tools/unpacked/${zellijName}`, 'zellij');
        await put('tools/unpacked/ripgrep-LICENSE', 'rg license');
        await put('tools/unpacked/zellij-LICENSE', 'zellij license');

        await finalizeRuntimeArtifactPayload(root, target);

        await expect(readFile(join(root, 'tools', 'unpacked', rgName), 'utf8')).resolves.toBe('rg');
        await expect(readFile(join(root, 'tools', 'unpacked', 'ripgrep-LICENSE'), 'utf8')).resolves.toBe('rg license');
        await expect(stat(join(root, 'tools', 'unpacked', 'ripgrep.node'))).rejects.toMatchObject({ code: 'ENOENT' });
        if (target.os === 'windows') {
            await expect(stat(join(root, 'tools', 'unpacked', zellijName))).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(stat(join(root, 'tools', 'unpacked', 'zellij-LICENSE'))).rejects.toMatchObject({ code: 'ENOENT' });
        } else {
            await expect(readFile(join(root, 'tools', 'unpacked', zellijName), 'utf8')).resolves.toBe('zellij');
            await expect(readFile(join(root, 'tools', 'unpacked', 'zellij-LICENSE'), 'utf8')).resolves.toBe('zellij license');
        }
    });

    it('projects esbuild executables and Iroh addons onto the selected target', async () => {
        const root = await createTempDir();
        const put = async (path: string) => {
            await mkdir(join(root, path, '..'), { recursive: true });
            await writeFile(join(root, path), path);
        };
        for (const platform of ['linux', 'darwin', 'win32']) for (const arch of ['x64', 'arm64']) {
            await put(`node_modules/@esbuild/${platform}-${arch}/bin/esbuild`);
            await put(`node_modules/@happier-dev/iroh-native/native/happier-iroh-native-lifecycle.${platform}-${arch}.node`);
            await put(`node_modules/bare-url/node_modules/bare-path/prebuilds/${platform}-${arch}/bare-path.bare`);
        }
        await finalizeRuntimeArtifactPayload(root, { os: 'linux', arch: 'arm64', exeExt: '', bunTarget: 'bun-linux-arm64' });
        await expect(stat(join(root, 'node_modules/@esbuild/linux-x64'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(join(root, 'node_modules/@esbuild/linux-arm64/bin/esbuild'))).resolves.toBeDefined();
        await expect(stat(join(root, 'node_modules/@happier-dev/iroh-native/native/happier-iroh-native-lifecycle.linux-x64.node'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(join(root, 'node_modules/@happier-dev/iroh-native/native/happier-iroh-native-lifecycle.linux-arm64.node'))).resolves.toBeDefined();
        await expect(stat(join(root, 'node_modules/bare-url/node_modules/bare-path/prebuilds/linux-x64'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(join(root, 'node_modules/bare-url/node_modules/bare-path/prebuilds/linux-arm64/bare-path.bare'))).resolves.toBeDefined();
    });

    it.each(CLI_BINARY_TARGETS)('projects native packages for $os-$arch without pruning SDK or sidecar formats', async (target) => {
        const root = await createTempDir();
        const platform = target.os === 'windows' ? 'win32' : target.os;
        const put = async (path: string) => {
            const fullPath = join(root, path);
            await mkdir(join(fullPath, '..'), { recursive: true });
            await writeFile(fullPath, path);
        };
        for (const os of ['darwin', 'linux', 'win32']) {
            for (const arch of ['arm64', 'x64']) {
                for (const pkg of ['node_modules/onnxruntime-node', 'node_modules/plugin/node_modules/onnxruntime-node']) {
                    for (const name of ['onnxruntime_binding.node', 'libonnxruntime.so', 'LICENSE']) await put(`${pkg}/bin/napi-v3/${os}/${arch}/${name}`);
                }
                for (const pkg of ['node_modules/node-pty', 'node_modules/@homebridge/node-pty-prebuilt-multiarch']) {
                    await put(`${pkg}/prebuilds/${os}-${arch}/pty.node`);
                    await put(`${pkg}/prebuilds/${os}-${arch}/spawn-helper`);
                }
            }
        }
        const ptyPackages = [
            ['node_modules/node-pty', '1.23.251008001'],
            ['node_modules/@homebridge/node-pty-prebuilt-multiarch', '1.22.250204002'],
        ] as const;
        const windowsModules = ['windowsConoutConnection', 'windowsPtyAgent', 'windowsPtyAgent.test',
            'windowsTerminal', 'windowsTerminal.test', 'conpty_console_list_agent',
            'shared/conout', 'worker/conoutSocketWorker'];
        const unixModules = ['unixTerminal', 'unixTerminal.test', 'prebuild-loader'];
        const sharedModules = ['index', 'terminal', 'utils', 'eventEmitter2', 'interfaces', 'types',
            'prebuild-file-path', 'shared/retain', 'worker/retain'];
        for (const [pkg, version] of ptyPackages) {
            await put(`${pkg}/package.json`);
            for (const module of [...windowsModules, ...unixModules, ...sharedModules]) {
                await put(`${pkg}/lib/${module}.js`);
                await put(`${pkg}/src/${module}.ts`);
            }
            await put(`${pkg}/deps/winpty/src/agent/Agent.cc`);
            await put(`${pkg}/src/win/conpty.cc`);
            await put(`${pkg}/src/unix/pty.cc`);
            await put(`${pkg}/third_party/conpty/NOTICE`);
            await put(`${pkg}/third_party/conpty/${version}/metadata.json`);
            for (const arch of ['arm64', 'x64']) {
                await put(`${pkg}/third_party/conpty/${version}/win10-${arch}/OpenConsole.exe`);
                await put(`${pkg}/third_party/conpty/${version}/win10-${arch}/conpty.dll`);
            }
        }
        const sharpRoot = 'node_modules/sharp/node_modules/@img';
        const sharpPackages = [
            'sharp-darwin-arm64', 'sharp-darwin-x64',
            'sharp-libvips-darwin-arm64', 'sharp-libvips-darwin-x64',
            'sharp-linux-arm64', 'sharp-linux-x64',
            'sharp-linux-arm', 'sharp-linux-ppc64', 'sharp-linux-riscv64', 'sharp-linux-s390x',
            'sharp-libvips-linux-arm64', 'sharp-libvips-linux-x64',
            'sharp-libvips-linux-arm', 'sharp-libvips-linux-ppc64',
            'sharp-libvips-linux-riscv64', 'sharp-libvips-linux-s390x',
            'sharp-linuxmusl-arm64', 'sharp-linuxmusl-x64',
            'sharp-libvips-linuxmusl-arm64', 'sharp-libvips-linuxmusl-x64',
            'sharp-win32-arm64', 'sharp-win32-ia32', 'sharp-win32-x64',
            'sharp-wasm32',
        ];
        for (const packageName of sharpPackages) await put(`${sharpRoot}/${packageName}/package.json`);
        for (const nativeTarget of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'linuxmusl-arm64', 'linuxmusl-x64']) {
            const nested = join(root, sharpRoot, `sharp-${nativeTarget}/node_modules/@img/sharp-libvips-${nativeTarget}`);
            await mkdir(join(nested, '..'), { recursive: true });
            await cp(join(root, sharpRoot, `sharp-libvips-${nativeTarget}`), nested, { recursive: true });
        }
        await put(`${sharpRoot}/colour/package.json`);
        for (const packageName of ['bare-fs', 'bare-os', 'bare-url']) {
            await put(`node_modules/${packageName}/LICENSE`);
            for (const targetKey of [
                'darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64',
                'android-arm64', 'ios-arm64', 'ios-arm64-simulator',
            ]) await put(`node_modules/${packageName}/prebuilds/${targetKey}/runtime.node`);
        }
        const retained = ['scripts/relay.cjs', 'node_modules/unrelated/lib/windowsTerminal.js', 'node_modules/@happier-dev/plugin-sdk/dist/index.d.ts', 'node_modules/@happier-dev/plugin-sdk/dist/index.js.map', 'node_modules/plugin/package-dist/index.cjs', 'package-dist/worker.mjs', 'package-dist/worker.js.map', 'package-dist/worker.mjs.map', 'package-dist/worker.cjs.map', 'package-dist/runtime.json', 'node_modules/node-pty/build/Release/pty.node', 'node_modules/@homebridge/node-pty-prebuilt-multiarch/build/Release/pty.node'];
        const removedMetadata = ['package-dist/index.d.ts', 'package-dist/index.d.mts', 'package-dist/worker/entry.d.cts', 'package-dist/index.d.ts.map', 'package-dist/worker/entry.d.cts.map', 'package-dist/cache.tsbuildinfo', 'node_modules/@happier-dev/plugin-sdk/dist/index.d.ts.map', 'node_modules/@happier-dev/plugin-sdk/dist/cache.tsbuildinfo'];
        for (const path of [...retained, ...removedMetadata, 'package-dist/index.cjs', 'node_modules/ps-list/vendor/fastlist-0.3.0-x64.exe', 'node_modules/ps-list/vendor/LICENSE']) await put(path);

        await finalizeRuntimeArtifactPayload(root, target);

        for (const pkg of ['node_modules/onnxruntime-node', 'node_modules/plugin/node_modules/onnxruntime-node']) {
            expect(await readdir(join(root, pkg, 'bin/napi-v3'))).toEqual([platform]);
            expect(await readdir(join(root, pkg, 'bin/napi-v3', platform))).toEqual([target.arch]);
            expect(await readdir(join(root, pkg, 'bin/napi-v3', platform, target.arch))).toEqual(['LICENSE', 'libonnxruntime.so', 'onnxruntime_binding.node']);
        }
        for (const pkg of ['node_modules/node-pty', 'node_modules/@homebridge/node-pty-prebuilt-multiarch']) {
            expect(await readdir(join(root, pkg, 'prebuilds'))).toEqual([`${platform}-${target.arch}`]);
            if (process.platform !== 'win32') expect((await stat(join(root, pkg, 'prebuilds', `${platform}-${target.arch}`, 'spawn-helper'))).mode & 0o777).toBe(0o755);
        }
        for (const [pkg, version] of ptyPackages) {
            const conptyDir = join(root, pkg, 'third_party/conpty');
            if (target.os === 'windows') {
                expect(await readdir(conptyDir)).toEqual(['NOTICE', version].sort());
                expect(await readdir(join(conptyDir, version))).toEqual(['metadata.json', `win10-${target.arch}`].sort());
                await expect(readFile(join(conptyDir, version, `win10-${target.arch}`, 'OpenConsole.exe'), 'utf8'))
                    .resolves.toContain('OpenConsole.exe');
            } else {
                await expect(stat(conptyDir)).rejects.toMatchObject({ code: 'ENOENT' });
            }
            for (const path of ['deps/winpty', 'src/win']) {
                if (target.os === 'windows') {
                    expect((await stat(join(root, pkg, path))).isDirectory()).toBe(true);
                } else {
                    await expect(stat(join(root, pkg, path))).rejects.toMatchObject({ code: 'ENOENT' });
                }
            }
            if (target.os === 'windows') {
                await expect(stat(join(root, pkg, 'src/unix'))).rejects.toMatchObject({ code: 'ENOENT' });
            } else {
                await expect(readFile(join(root, pkg, 'src/unix/pty.cc'), 'utf8')).resolves.toBeTruthy();
            }
            for (const module of target.os === 'windows' ? unixModules : windowsModules) {
                for (const path of [`lib/${module}.js`, `src/${module}.ts`]) {
                    await expect(stat(join(root, pkg, path))).rejects.toMatchObject({ code: 'ENOENT' });
                }
            }
            for (const module of [...sharedModules, ...(target.os === 'windows' ? windowsModules : unixModules)]) {
                for (const path of [`lib/${module}.js`, `src/${module}.ts`]) {
                    await expect(readFile(join(root, pkg, path), 'utf8')).resolves.toBeTruthy();
                }
            }
            for (const retainedPath of ['package.json']) {
                await expect(readFile(join(root, pkg, retainedPath), 'utf8')).resolves.toBeTruthy();
            }
        }
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
        for (const name of expectedSharp.filter((name) => !name.includes('libvips'))) {
            const nativeTarget = name.slice('sharp-'.length);
            await expect(stat(join(root, sharpRoot, name, 'node_modules/@img', `sharp-libvips-${nativeTarget}`)))
                .rejects.toMatchObject({ code: 'ENOENT' });
        }
        for (const packageName of ['bare-fs', 'bare-os', 'bare-url']) {
            expect(await readdir(join(root, 'node_modules', packageName, 'prebuilds'))).toEqual([`${platform}-${target.arch}`]);
            await expect(readFile(join(root, 'node_modules', packageName, 'LICENSE'), 'utf8')).resolves.toContain('LICENSE');
        }
        for (const path of retained) expect(await readFile(join(root, path), 'utf8')).toBe(path);
        await expect(stat(join(root, 'package-dist', 'index.cjs'))).rejects.toMatchObject({ code: 'ENOENT' });
        for (const path of removedMetadata) await expect(stat(join(root, path))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readdir(join(root, 'node_modules/ps-list/vendor'))).toEqual(target.os === 'windows' ? ['LICENSE', 'fastlist-0.3.0-x64.exe'] : ['LICENSE']);
    });

    it('keeps a materialized plugin SDK type-resolvable after metadata projection', async () => {
        const root = await createTempDir();
        const sdkRoot = join(root, 'node_modules', '@happier-dev', 'plugin-sdk');
        await mkdir(sdkRoot, { recursive: true });
        await writeFile(join(sdkRoot, 'package.json'), JSON.stringify({
            name: '@happier-dev/plugin-sdk',
            version: '0.0.0',
            type: 'module',
            exports: { '.': { types: './index.d.ts', default: './index.js' } },
        }), 'utf8');
        await writeFile(join(sdkRoot, 'index.d.ts'), [
            'export type PluginDefinition = Readonly<{ id: string; version: string }>;',
            'export declare function definePlugin<const T extends PluginDefinition>(definition: T): T;',
            '',
        ].join('\n'), 'utf8');
        await writeFile(join(sdkRoot, 'index.d.ts.map'), '{}\n', 'utf8');
        await writeFile(join(sdkRoot, 'index.js'), 'export const definePlugin = (definition) => definition;\n', 'utf8');
        await writeFile(join(sdkRoot, 'index.js.map'), '{}\n', 'utf8');
        await writeFile(join(sdkRoot, 'cache.tsbuildinfo'), '{}\n', 'utf8');
        await writeFile(join(root, 'plugin.ts'), [
            "import { definePlugin, type PluginDefinition } from '@happier-dev/plugin-sdk';",
            "export const plugin = definePlugin({ id: 'acme.fixture', version: '1.0.0' }) satisfies PluginDefinition;",
            '',
        ].join('\n'), 'utf8');
        await writeFile(join(root, 'tsconfig.json'), JSON.stringify({
            compilerOptions: {
                module: 'ESNext',
                moduleResolution: 'Bundler',
                noEmit: true,
                strict: true,
                target: 'ES2022',
            },
            include: ['plugin.ts'],
        }), 'utf8');

        await finalizeRuntimeArtifactPayload(root, CLI_BINARY_TARGETS[0]);

        await expect(readFile(join(sdkRoot, 'index.d.ts'), 'utf8')).resolves.toContain('PluginDefinition');
        await expect(readFile(join(sdkRoot, 'index.js.map'), 'utf8')).resolves.toBe('{}\n');
        await expect(stat(join(sdkRoot, 'index.d.ts.map'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(join(sdkRoot, 'cache.tsbuildinfo'))).rejects.toMatchObject({ code: 'ENOENT' });
        await execFileAsync(process.execPath, [
            resolve(import.meta.dirname, '../../../../scripts/workspaces/runTypeScriptCli.mjs'),
            '--noEmit',
            '-p',
            'tsconfig.json',
        ], {
            cwd: root,
            env: { ...process.env, HAPPIER_DEV_TARGET_EXECUTION: '1' },
        });
    });

    it('projects only SDK governance files while preserving complete author packages', async () => {
        const root = await createTempDir();
        const nodeModulesRoot = join(root, 'node_modules');
        const sdkRoot = join(nodeModulesRoot, '@happier-dev', 'plugin-sdk');
        const uiRoot = join(nodeModulesRoot, '@happier-dev', 'plugin-ui');
        const writePackageFile = async (packageRoot: string, relativePath: string, contents = relativePath) => {
            const path = join(packageRoot, relativePath);
            await mkdir(join(path, '..'), { recursive: true });
            await writeFile(path, contents, 'utf8');
        };
        const publicAuthorClassification = {
            publicSdkRelease: {
                posture: 'developer_preview',
                externalPublicationRequiresApproval: true,
            },
        };
        const sdkManifest = {
            name: '@happier-dev/plugin-sdk',
            version: '0.0.0',
            type: 'module',
            main: './dist/index.js',
            types: './dist/index.d.ts',
            exports: {
                '.': { types: './dist/index.d.ts', default: './dist/index.js' },
                './ui/build': { types: './dist/ui/build/index.d.ts', default: './dist/ui/build/index.js' },
            },
            bin: { 'happier-plugin-build-ui': './dist/ui/build/bin.js' },
            files: [
                'dist',
                'examples/public-authoring/index.ts',
                'scripts',
                'package.json',
                'README.md',
                'API.md',
                'api-declarations.md',
                'api-surface.json',
                'capability-matrix.json',
            ],
            happier: publicAuthorClassification,
            dependencies: {},
            bundledDependencies: [],
        };
        const uiManifest = {
            name: '@happier-dev/plugin-ui',
            version: '0.0.0',
            type: 'module',
            main: './dist/index.js',
            types: './dist/index.d.ts',
            exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
            files: [
                'dist',
                'package.json',
                'README.md',
                'API.md',
                'api-declarations.md',
                'api-surface.json',
            ],
            happier: publicAuthorClassification,
            dependencies: { '@happier-dev/plugin-sdk': '0.0.0' },
            bundledDependencies: [],
        };
        await writePackageFile(sdkRoot, 'package.json', `${JSON.stringify(sdkManifest, null, 2)}\n`);
        await writePackageFile(sdkRoot, 'dist/index.js', 'export const definePlugin = (definition) => definition;\n');
        await writePackageFile(sdkRoot, 'dist/index.d.ts', [
            'export type PluginDefinition = Readonly<{ id: string; version: string }>;',
            'export declare function definePlugin<const T extends PluginDefinition>(definition: T): T;',
            '',
        ].join('\n'));
        await writePackageFile(sdkRoot, 'dist/index.js.map', '{}\n');
        await writePackageFile(sdkRoot, 'dist/ui/build/index.js', 'export const builder = true;\n');
        await writePackageFile(sdkRoot, 'dist/ui/build/index.d.ts', 'export declare const builder: true;\n');
        await writePackageFile(sdkRoot, 'dist/ui/build/bin.js', '#!/usr/bin/env node\n');
        await writePackageFile(sdkRoot, 'examples/public-authoring/index.ts', 'export const example = true;\n');
        await writePackageFile(sdkRoot, 'scripts/check-api.mjs', 'export {};\n');
        for (const path of ['README.md', 'API.md', 'api-declarations.md', 'api-surface.json', 'capability-matrix.json']) {
            await writePackageFile(sdkRoot, path);
        }
        await writePackageFile(uiRoot, 'package.json', `${JSON.stringify(uiManifest, null, 2)}\n`);
        await writePackageFile(uiRoot, 'dist/index.js', 'export const uiMarker = true;\n');
        await writePackageFile(uiRoot, 'dist/index.d.ts', 'export declare const uiMarker: true;\n');
        await writePackageFile(uiRoot, 'dist/index.js.map', '{}\n');
        for (const path of ['README.md', 'API.md', 'api-declarations.md', 'api-surface.json']) {
            await writePackageFile(uiRoot, path);
        }

        await finalizeRuntimeArtifactPayload(root, CLI_BINARY_TARGETS[0]);

        for (const packageRoot of [sdkRoot, uiRoot]) {
            await expect(stat(join(packageRoot, 'api-declarations.md'))).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(stat(join(packageRoot, 'api-surface.json'))).rejects.toMatchObject({ code: 'ENOENT' });
        }
        await expect(stat(join(sdkRoot, 'scripts'))).rejects.toMatchObject({ code: 'ENOENT' });
        const projectedSdkManifest = JSON.parse(await readFile(join(sdkRoot, 'package.json'), 'utf8')) as typeof sdkManifest;
        const projectedUiManifest = JSON.parse(await readFile(join(uiRoot, 'package.json'), 'utf8')) as typeof uiManifest;
        expect(projectedSdkManifest.files).toEqual([
            'dist',
            'examples/public-authoring/index.ts',
            'package.json',
            'README.md',
            'API.md',
            'capability-matrix.json',
        ]);
        expect(projectedUiManifest.files).toEqual(['dist', 'package.json', 'README.md', 'API.md']);
        expect(projectedSdkManifest.exports).toEqual(sdkManifest.exports);
        expect(projectedSdkManifest.bin).toEqual(sdkManifest.bin);
        expect(projectedUiManifest.exports).toEqual(uiManifest.exports);
        for (const [packageRoot, manifest] of [[sdkRoot, projectedSdkManifest], [uiRoot, projectedUiManifest]] as const) {
            for (const relativePath of manifest.files) {
                const retainedEntry = await stat(join(packageRoot, relativePath));
                expect(retainedEntry.isFile() || retainedEntry.isDirectory()).toBe(true);
            }
        }
        for (const path of [
            'dist/index.js',
            'dist/index.d.ts',
            'dist/index.js.map',
            'dist/ui/build/index.js',
            'dist/ui/build/index.d.ts',
            'dist/ui/build/bin.js',
            'examples/public-authoring/index.ts',
            'README.md',
            'API.md',
            'capability-matrix.json',
        ]) await expect(readFile(join(sdkRoot, path), 'utf8')).resolves.toBeTruthy();
        for (const path of ['dist/index.js', 'dist/index.d.ts', 'dist/index.js.map', 'README.md', 'API.md']) {
            await expect(readFile(join(uiRoot, path), 'utf8')).resolves.toBeTruthy();
        }

        const authorRoot = join(root, 'author');
        const materializedNodeModulesRoot = join(authorRoot, 'node_modules');
        materializePrepublicationWorkspacePackageRoots({
            bundles: [
                {
                    packageName: '@happier-dev/plugin-sdk',
                    srcDir: sdkRoot,
                    destDir: join(materializedNodeModulesRoot, '@happier-dev', 'plugin-sdk'),
                },
                {
                    packageName: '@happier-dev/plugin-ui',
                    srcDir: uiRoot,
                    destDir: join(materializedNodeModulesRoot, '@happier-dev', 'plugin-ui'),
                },
            ],
            rootPackageNames: ['@happier-dev/plugin-sdk', '@happier-dev/plugin-ui'],
        });
        await writeFile(join(authorRoot, 'package.json'), '{"type":"module"}\n', 'utf8');
        const { createRequire } = await import('node:module');
        const authorRequire = createRequire(join(authorRoot, 'package.json'));
        expect(await realpath(authorRequire.resolve('@happier-dev/plugin-sdk')))
            .toBe(await realpath(join(materializedNodeModulesRoot, '@happier-dev/plugin-sdk/dist/index.js')));
        expect(await realpath(authorRequire.resolve('@happier-dev/plugin-sdk/ui/build')))
            .toBe(await realpath(join(materializedNodeModulesRoot, '@happier-dev/plugin-sdk/dist/ui/build/index.js')));
        expect(await realpath(authorRequire.resolve('@happier-dev/plugin-ui')))
            .toBe(await realpath(join(materializedNodeModulesRoot, '@happier-dev/plugin-ui/dist/index.js')));
        await writeFile(join(authorRoot, 'plugin.ts'), [
            "import { definePlugin, type PluginDefinition } from '@happier-dev/plugin-sdk';",
            "import type { uiMarker } from '@happier-dev/plugin-ui';",
            "export const plugin = definePlugin({ id: 'acme.fixture', version: '1.0.0' }) satisfies PluginDefinition;",
            'export type UiMarker = typeof uiMarker;',
            '',
        ].join('\n'), 'utf8');
        await writeFile(join(authorRoot, 'tsconfig.json'), JSON.stringify({
            compilerOptions: {
                module: 'ESNext',
                moduleResolution: 'Bundler',
                noEmit: true,
                strict: true,
                target: 'ES2022',
            },
            include: ['plugin.ts'],
        }), 'utf8');
        await execFileAsync(process.execPath, [
            resolve(import.meta.dirname, '../../../../scripts/workspaces/runTypeScriptCli.mjs'),
            '--noEmit',
            '-p',
            'tsconfig.json',
        ], {
            cwd: authorRoot,
            env: { ...process.env, HAPPIER_DEV_TARGET_EXECUTION: '1' },
        });
    });

    it.each([
        {
            packageRoot: 'node_modules/sharp',
            installedPackage: 'node_modules/sharp/node_modules/@img/sharp-linux-arm64',
            expectedMissing: '@img/sharp-darwin-arm64',
        },
    ])('rejects an incomplete cross-target closure for $packageRoot', async ({ packageRoot, installedPackage, expectedMissing }) => {
        const root = await createTempDir();
        for (const path of [`${packageRoot}/package.json`, `${installedPackage}/package.json`, 'package-dist/index.mjs']) {
            const fullPath = join(root, path);
            await mkdir(join(fullPath, '..'), { recursive: true });
            await writeFile(fullPath, '{}');
        }

        await expect(finalizeRuntimeArtifactPayload(root, {
            os: 'darwin', arch: 'arm64', bunTarget: 'bun-darwin-arm64', exeExt: '',
        })).rejects.toThrow(expectedMissing);
    });

    it.each([
        ['@happier-dev/agents/node_modules/zod', 'zod'],
        ['@happier-dev/protocol/node_modules/zod', 'zod'],
        ['@modelcontextprotocol/sdk/node_modules/zod', 'zod'],
        ['@happier-dev/release-runtime/node_modules/tar', 'tar'],
        ['archiver/node_modules/zip-stream/node_modules/archiver-utils', 'archiver/node_modules/archiver-utils'],
        ['@modelcontextprotocol/sdk/node_modules/express/node_modules/body-parser/node_modules/qs', '@modelcontextprotocol/sdk/node_modules/express/node_modules/qs'],
    ])('removes the audited identical %s copy while preserving resolution and authoring files', async (duplicate, survivorPath) => {
        const root = await createTempDir();
        const packageName = duplicate.split('/node_modules/').at(-1)!;
        const survivor = join(root, 'node_modules', survivorPath);
        const nested = join(root, 'node_modules', duplicate);
        await mkdir(survivor, { recursive: true });
        await writeFile(join(survivor, 'package.json'), JSON.stringify({ name: packageName, main: 'index.cjs' }));
        await writeFile(join(survivor, 'index.cjs'), 'module.exports = "survivor";');
        await writeFile(join(survivor, 'index.d.ts'), 'export declare const schema: unknown;');
        await writeFile(join(survivor, 'LICENSE'), 'license');
        await mkdir(join(nested, '..'), { recursive: true });
        await cp(survivor, nested, { recursive: true });

        await finalizeRuntimeArtifactPayload(root, CLI_BINARY_TARGETS[0]);

        await expect(stat(nested)).rejects.toMatchObject({ code: 'ENOENT' });
        const { createRequire } = await import('node:module');
        const resolved = createRequire(join(nested, '../../consumer.cjs')).resolve(packageName);
        expect(await realpath(resolved)).toBe(await realpath(join(survivor, 'index.cjs')));
        expect(await readFile(join(survivor, 'index.d.ts'), 'utf8')).toContain('schema');
        expect(await readFile(join(survivor, 'LICENSE'), 'utf8')).toBe('license');
    });

    it.each([
        ['@happier-dev/plugin-sdk/node_modules/esbuild', 'esbuild'],
        ['@happier-dev/plugin-sdk/node_modules/zod', 'zod'],
        ['@happier-dev/plugins-claude/node_modules/zod', 'zod'],
        ['@happier-dev/plugins-codex/node_modules/zod', 'zod'],
        ['@happier-dev/plugins-cursor/node_modules/zod', 'zod'],
        ['@happier-dev/plugins-elevenlabs/node_modules/zod', 'zod'],
        ['@happier-dev/plugins-google/node_modules/zod', 'zod'],
        ['@happier-dev/plugins-kimi/node_modules/zod', 'zod'],
        ['@happier-dev/plugins-openai/node_modules/zod', 'zod'],
        ['@happier-dev/plugins-opencode/node_modules/zod', 'zod'],
        ['@happier-dev/plugins-xai/node_modules/zod', 'zod'],
        ['@happier-dev/cli-common/node_modules/tar', 'tar'],
        ['fastify/node_modules/@fastify/fast-json-stringify-compiler/node_modules/fast-json-stringify', 'fastify/node_modules/fast-json-stringify'],
        ['@happier-dev/protocol/node_modules/ajv', 'ajv'],
        ['@happier-dev/protocol/node_modules/ajv-formats/node_modules/ajv', 'ajv'],
        ['@modelcontextprotocol/sdk/node_modules/ajv', 'ajv'],
        ['@modelcontextprotocol/sdk/node_modules/ajv-formats/node_modules/ajv', 'ajv'],
        ['fastify/node_modules/fast-json-stringify/node_modules/ajv', 'ajv'],
        ['fastify/node_modules/fast-json-stringify/node_modules/ajv-formats/node_modules/ajv', 'ajv'],
        ['fastify/node_modules/@fastify/ajv-compiler/node_modules/ajv', 'ajv'],
        ['fastify/node_modules/@fastify/ajv-compiler/node_modules/ajv-formats/node_modules/ajv', 'ajv'],
        ['@happier-dev/sdk/node_modules/undici', 'undici'],
    ])('removes the newly audited identical %s copy and resolves through %s', async (duplicate, survivorPath) => {
        const root = await createTempDir();
        const packageName = duplicate.split('/node_modules/').at(-1)!;
        const survivor = join(root, 'node_modules', survivorPath);
        const nested = join(root, 'node_modules', duplicate);
        await mkdir(survivor, { recursive: true });
        await writeFile(join(survivor, 'package.json'), JSON.stringify({ name: packageName, main: 'index.cjs' }));
        await writeFile(join(survivor, 'index.cjs'), `module.exports = ${JSON.stringify(packageName)};`);
        await mkdir(join(nested, '..'), { recursive: true });
        await cp(survivor, nested, { recursive: true });

        await finalizeRuntimeArtifactPayload(root, CLI_BINARY_TARGETS[0]);

        await expect(stat(nested)).rejects.toMatchObject({ code: 'ENOENT' });
        const { createRequire } = await import('node:module');
        const resolved = createRequire(join(nested, '../../consumer.cjs')).resolve(packageName);
        expect(await realpath(resolved)).toBe(await realpath(join(survivor, 'index.cjs')));
    });

    it('deletes AJV shadows in dependency order and rechecks resolution after each deletion', async () => {
        const root = await createTempDir();
        const survivor = join(root, 'node_modules/ajv');
        const direct = join(root, 'node_modules/@happier-dev/protocol/node_modules/ajv');
        const nested = join(root, 'node_modules/@happier-dev/protocol/node_modules/ajv-formats/node_modules/ajv');
        await mkdir(survivor, { recursive: true });
        await writeFile(join(survivor, 'package.json'), JSON.stringify({ name: 'ajv', main: 'index.cjs' }));
        await writeFile(join(survivor, 'index.cjs'), 'module.exports = "root-ajv";');
        await mkdir(join(direct, '..'), { recursive: true });
        await cp(survivor, direct, { recursive: true });
        await mkdir(join(nested, '..'), { recursive: true });
        await cp(survivor, nested, { recursive: true });

        await finalizeRuntimeArtifactPayload(root, CLI_BINARY_TARGETS[0]);

        await expect(stat(direct)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(nested)).rejects.toMatchObject({ code: 'ENOENT' });
        const { createRequire } = await import('node:module');
        const resolved = createRequire(join(nested, '../../consumer.cjs')).resolve('ajv');
        expect(await realpath(resolved)).toBe(await realpath(join(survivor, 'index.cjs')));
    });

    it('retains MCP divergent and peer-shadowed Zod copies', async () => {
        const root = await createTempDir();
        const rootZod = join(root, 'node_modules/zod');
        const sdkZod = join(root, 'node_modules/@modelcontextprotocol/sdk/node_modules/zod');
        const peerZod = join(root, 'node_modules/@modelcontextprotocol/sdk/node_modules/zod-to-json-schema/node_modules/zod');
        const putZod = async (directory: string, version: string) => {
            await mkdir(directory, { recursive: true });
            await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'zod', version, main: 'index.cjs' }));
            await writeFile(join(directory, 'index.cjs'), `module.exports = ${JSON.stringify(version)};`);
        };
        await putZod(rootZod, '4.3.6');
        await putZod(sdkZod, '4.4.3');
        await mkdir(join(peerZod, '..'), { recursive: true });
        await cp(rootZod, peerZod, { recursive: true });

        await finalizeRuntimeArtifactPayload(root, CLI_BINARY_TARGETS[0]);

        expect(await readFile(join(sdkZod, 'index.cjs'), 'utf8')).toContain('4.4.3');
        expect(await readFile(join(peerZod, 'index.cjs'), 'utf8')).toContain('4.3.6');
        const { createRequire } = await import('node:module');
        const sdkResolved = createRequire(join(sdkZod, '../../consumer.cjs')).resolve('zod');
        const peerResolved = createRequire(join(peerZod, '../../consumer.cjs')).resolve('zod');
        expect(await realpath(sdkResolved)).toBe(await realpath(join(sdkZod, 'index.cjs')));
        expect(await realpath(peerResolved)).toBe(await realpath(join(peerZod, 'index.cjs')));
    });

    it.each(['missing', 'binary', 'extra', 'mode', 'shadow'])('retains an audited copy when the survivor differs: %s', async (difference) => {
        const root = await createTempDir();
        const nested = join(root, 'node_modules/@happier-dev/agents/node_modules/zod');
        const survivor = join(root, 'node_modules/zod');
        await mkdir(nested, { recursive: true });
        await writeFile(join(nested, 'data.bin'), Buffer.from([0x80]));
        if (difference !== 'missing') {
            await cp(nested, survivor, { recursive: true });
            if (difference === 'binary') await writeFile(join(survivor, 'data.bin'), Buffer.from([0x81]));
            if (difference === 'extra') await writeFile(join(nested, 'LICENSE'), 'must retain');
            if (difference === 'shadow') {
                const shadow = join(root, 'node_modules/@happier-dev/node_modules/zod');
                await mkdir(shadow, { recursive: true });
                await writeFile(join(shadow, 'data.bin'), 'different');
            }
            if (difference === 'mode' && process.platform !== 'win32') await chmod(join(nested, 'data.bin'), 0o755);
        }
        if (difference === 'mode' && process.platform === 'win32') return;

        await finalizeRuntimeArtifactPayload(root, CLI_BINARY_TARGETS[0]);

        expect(await readFile(join(nested, 'data.bin'))).toEqual(Buffer.from([0x80]));
    });

    it('rejects a linked payload root before mutating its target', async () => {
        const rootDir = await createTempDir();
        const sourceDir = join(rootDir, 'source');
        const payloadDir = join(rootDir, 'payload');
        const packageManagerBinPath = join(sourceDir, 'node_modules', '.bin', 'tool');
        await mkdir(join(sourceDir, 'node_modules', '.bin'), { recursive: true });
        await writeFile(packageManagerBinPath, 'external-package-manager-shim', 'utf8');
        await symlink(
            sourceDir,
            payloadDir,
            process.platform === 'win32' ? 'junction' : 'dir',
        );

        await expect(finalizeRuntimeArtifactPayload(payloadDir)).rejects.toThrow(
            /root must be a physical directory/i,
        );

        expect((await lstat(payloadDir)).isSymbolicLink()).toBe(true);
        expect(await readFile(packageManagerBinPath, 'utf8')).toBe('external-package-manager-shim');
    });

    it.skipIf(process.platform === 'win32')('retains copies whose same relative link text materializes different bytes', async () => {
        const root = await createTempDir();
        const nested = join(root, 'node_modules/@happier-dev/agents/node_modules/zod');
        const survivor = join(root, 'node_modules/zod');
        for (const [path, contents] of [[nested, 'nested'], [survivor, 'survivor']]) {
            await mkdir(path, { recursive: true });
            await writeFile(join(path, '../target.bin'), contents);
            await symlink('../target.bin', join(path, 'runtime.bin'));
        }

        await finalizeRuntimeArtifactPayload(root, CLI_BINARY_TARGETS[0]);

        expect(await readFile(join(nested, 'runtime.bin'), 'utf8')).toBe('nested');
        expect(await readFile(join(survivor, 'runtime.bin'), 'utf8')).toBe('survivor');
    });

    it('rejects an escaping node_modules link before mutating its target', async () => {
        const rootDir = await createTempDir();
        const externalNodeModulesDir = join(rootDir, 'external-node-modules');
        const payloadDir = join(rootDir, 'payload');
        const packageManagerBinPath = join(externalNodeModulesDir, '.bin', 'tool');
        await mkdir(join(externalNodeModulesDir, '.bin'), { recursive: true });
        await mkdir(payloadDir, { recursive: true });
        await writeFile(packageManagerBinPath, 'external-package-manager-shim', 'utf8');
        await symlink(
            externalNodeModulesDir,
            join(payloadDir, 'node_modules'),
            process.platform === 'win32' ? 'junction' : 'dir',
        );

        await expect(finalizeRuntimeArtifactPayload(payloadDir)).rejects.toThrow(
            /escapes the artifact/i,
        );

        expect((await lstat(join(payloadDir, 'node_modules'))).isSymbolicLink()).toBe(true);
        expect(await readFile(packageManagerBinPath, 'utf8')).toBe('external-package-manager-shim');
    });

    it.skipIf(process.platform === 'win32')('removes package-manager links before planning retained link materialization', async () => {
        const rootDir = await createTempDir();
        const payloadDir = join(rootDir, 'payload');
        await mkdir(join(payloadDir, 'runtime'), { recursive: true });
        await mkdir(join(payloadDir, 'aliases'), { recursive: true });
        await mkdir(join(payloadDir, 'node_modules', '.bin'), { recursive: true });
        await writeFile(join(payloadDir, 'runtime', 'tool'), 'runtime', 'utf8');
        await symlink(
            join('..', '..', 'runtime', 'tool'),
            join(payloadDir, 'node_modules', '.bin', 'tool'),
        );
        await symlink(
            join('..', 'runtime', 'tool'),
            join(payloadDir, 'aliases', 'tool'),
        );

        await finalizeRuntimeArtifactPayload(payloadDir);

        await expect(lstat(join(payloadDir, 'node_modules', '.bin'))).rejects.toMatchObject({
            code: 'ENOENT',
        });
        expect((await lstat(join(payloadDir, 'aliases', 'tool'))).isSymbolicLink()).toBe(false);
        expect(await readFile(join(payloadDir, 'aliases', 'tool'), 'utf8')).toBe('runtime');
    });

    it(
        'materializes contained symlinks and hardlinks into an update-safe payload without mutating its source',
        async () => {
            const rootDir = await createTempDir();
            const sourceDir = join(rootDir, 'source');
            const payloadDir = join(rootDir, 'payload');
            const archivePath = join(rootDir, 'payload.tar.gz');
            const extractDir = join(rootDir, 'extracted');

            await mkdir(join(sourceDir, 'runtime'), { recursive: true });
            await mkdir(join(sourceDir, 'aliases'), { recursive: true });
            await writeFile(join(sourceDir, 'runtime', 'tool'), '#!/bin/sh\necho runtime\n', 'utf8');
            await chmod(join(sourceDir, 'runtime', 'tool'), 0o755);
            await symlink(
                process.platform === 'win32' ? join(sourceDir, 'runtime') : join('..', 'runtime'),
                join(sourceDir, 'aliases', 'runtime'),
                process.platform === 'win32' ? 'junction' : 'dir',
            );
            if (process.platform !== 'win32') {
                await symlink(join('..', 'runtime', 'tool'), join(sourceDir, 'aliases', 'tool'));
            }
            await link(join(sourceDir, 'runtime', 'tool'), join(sourceDir, 'runtime', 'tool-hardlink'));

            await cp(sourceDir, payloadDir, {
                recursive: true,
                dereference: false,
                verbatimSymlinks: true,
            });
            if (process.platform === 'win32') {
                await rm(join(payloadDir, 'aliases', 'runtime'), { recursive: true });
                await symlink(
                    join(payloadDir, 'runtime'),
                    join(payloadDir, 'aliases', 'runtime'),
                    'junction',
                );
            }
            // Node's recursive copy deliberately does not promise hardlink preservation.
            await rm(join(payloadDir, 'runtime', 'tool-hardlink'));
            await link(join(payloadDir, 'runtime', 'tool'), join(payloadDir, 'runtime', 'tool-hardlink'));

            const sourceToolBefore = await stat(join(sourceDir, 'runtime', 'tool'));
            const sourceHardlinkBefore = await stat(join(sourceDir, 'runtime', 'tool-hardlink'));

            await finalizeRuntimeArtifactPayload(payloadDir);

            expect((await lstat(join(payloadDir, 'aliases', 'runtime'))).isDirectory()).toBe(true);
            expect((await lstat(join(payloadDir, 'aliases', 'runtime'))).isSymbolicLink()).toBe(false);
            expect(await readFile(join(payloadDir, 'aliases', 'runtime', 'tool'), 'utf8')).toBe(
                '#!/bin/sh\necho runtime\n',
            );
            expect((await stat(join(payloadDir, 'aliases', 'runtime', 'tool'))).mode & 0o777).toBe(
                (await stat(join(payloadDir, 'runtime', 'tool'))).mode & 0o777,
            );
            if (process.platform !== 'win32') {
                expect((await stat(join(payloadDir, 'aliases', 'runtime', 'tool'))).mode & 0o777).toBe(0o755);
                expect((await lstat(join(payloadDir, 'aliases', 'tool'))).isFile()).toBe(true);
                expect((await lstat(join(payloadDir, 'aliases', 'tool'))).isSymbolicLink()).toBe(false);
            }

            const payloadTool = await stat(join(payloadDir, 'runtime', 'tool'));
            const payloadHardlink = await stat(join(payloadDir, 'runtime', 'tool-hardlink'));
            expect(payloadTool.ino).not.toBe(payloadHardlink.ino);
            expect(payloadTool.nlink).toBe(1);
            expect(payloadHardlink.nlink).toBe(1);

            expect((await lstat(join(sourceDir, 'aliases', 'runtime'))).isSymbolicLink()).toBe(true);
            expect((await stat(join(sourceDir, 'runtime', 'tool'))).ino).toBe(sourceToolBefore.ino);
            expect((await stat(join(sourceDir, 'runtime', 'tool-hardlink'))).ino).toBe(sourceHardlinkBefore.ino);
            expect(sourceToolBefore.ino).toBe(sourceHardlinkBefore.ino);

            await finalizeRuntimeArtifactPayload(payloadDir);
            expect((await stat(join(payloadDir, 'runtime', 'tool'))).ino).toBe(payloadTool.ino);
            expect((await stat(join(payloadDir, 'runtime', 'tool-hardlink'))).ino).toBe(payloadHardlink.ino);

            await tar.c({
                cwd: rootDir,
                file: archivePath,
                gzip: true,
                portable: true,
            }, ['payload']);
            const entries = await inspectTarArchiveEntries({ archivePath });
            expect(entries.some((entry) => entry.path === 'payload/aliases/runtime/tool')).toBe(true);

            await extractArchivePayloadToDirectory({
                archivePath,
                archiveName: 'payload.tar.gz',
                extractDir,
            });
            expect(await readFile(join(extractDir, 'payload', 'aliases', 'runtime', 'tool'), 'utf8')).toBe(
                '#!/bin/sh\necho runtime\n',
            );
        },
    );

    it.skipIf(process.platform === 'win32')('rejects broken, escaping, and special payload entries before materializing any links', async () => {
        const rootDir = await createTempDir();
        const outsidePath = join(rootDir, 'outside.txt');
        await writeFile(outsidePath, 'outside-original', 'utf8');

        for (const topology of ['broken', 'escaping'] as const) {
            const payloadDir = join(rootDir, topology);
            await mkdir(join(payloadDir, 'links'), { recursive: true });
            await writeFile(join(payloadDir, 'target'), 'inside', 'utf8');
            await symlink(join('..', 'target'), join(payloadDir, 'links', 'contained'));
            await symlink(
                topology === 'broken' ? join('..', 'missing') : join('..', '..', 'outside.txt'),
                join(payloadDir, 'links', topology),
            );

            await expect(finalizeRuntimeArtifactPayload(payloadDir)).rejects.toThrow(
                topology === 'broken' ? /cannot be resolved/i : /escapes the artifact/i,
            );
            expect((await lstat(join(payloadDir, 'links', 'contained'))).isSymbolicLink()).toBe(true);
            expect(await readFile(outsidePath, 'utf8')).toBe('outside-original');
        }

        const specialPayloadDir = await mkdtemp('/tmp/hrp-special-');
        tempDirs.push(specialPayloadDir);
        const socketPath = join(specialPayloadDir, 'runtime.sock');
        const { createServer } = await import('node:net');
        const { once } = await import('node:events');
        const server = createServer();
        try {
            server.listen(socketPath);
            await once(server, 'listening');
            await expect(finalizeRuntimeArtifactPayload(specialPayloadDir)).rejects.toThrow(
                /unsupported file type/i,
            );
        } finally {
            server.close();
            await once(server, 'close');
        }
    });

    it.skipIf(process.platform === 'win32')('rolls back link replacement and cleans staging after copy or rename failure', async () => {
        for (const failure of ['copy', 'rename'] as const) {
            const rootDir = await createTempDir();
            const payloadDir = join(rootDir, failure);
            await mkdir(join(payloadDir, 'runtime'), { recursive: true });
            await mkdir(join(payloadDir, 'aliases'), { recursive: true });
            await writeFile(join(payloadDir, 'runtime', 'tool'), 'runtime', 'utf8');
            await symlink(join('..', 'runtime', 'tool'), join(payloadDir, 'aliases', 'tool'));

            fsFailurePlan.failCopy = failure === 'copy';
            fsFailurePlan.failStagedRename = failure === 'rename';
            await expect(finalizeRuntimeArtifactPayload(payloadDir)).rejects.toThrow(
                failure === 'copy' ? /injected payload copy failure/i : /injected staged rename failure/i,
            );
            fsFailurePlan.failCopy = false;
            fsFailurePlan.failStagedRename = false;

            expect((await lstat(join(payloadDir, 'aliases', 'tool'))).isSymbolicLink()).toBe(true);
            expect(await readFile(join(payloadDir, 'aliases', 'tool'), 'utf8')).toBe('runtime');
            expect(
                (await readdir(join(payloadDir, 'aliases')))
                    .filter((entry) => entry.startsWith('.happier-materialize-link-')),
            ).toEqual([]);
        }
    });
});
