import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { stageCliTargetRuntimeDependencies } from './stageCliTargetRuntimeDependencies.js';
import { getCliBinaryArtifactSupportTargetUnavailableReason } from '../../componentArtifactTarget.mjs';

it('replaces every copied host PTY occurrence with a target-built addon without altering host dependencies', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'cli-target-dependencies-'));
  const payloadDir = join(repoRoot, 'payload');
  const paths = ['node_modules/node-pty', 'node_modules/sdk/node_modules/node-pty'];
  try {
    for (const path of [...paths.map(path => join(payloadDir, path)), join(repoRoot, 'node_modules/node-pty')]) {
      await mkdir(join(path, 'build/Release'), { recursive: true });
      await writeFile(join(path, 'package.json'), JSON.stringify({ name: 'node-pty', version: '1.1.0' }));
      await writeFile(join(path, 'build/Release/pty.node'), 'host addon');
    }
    await stageCliTargetRuntimeDependencies({ repoRoot, payloadDir,
      target: { os: 'linux', arch: 'arm64', bunTarget: 'bun-linux-arm64', exeExt: '' },
      platform: 'linux', arch: 'x64', commandProbe: () => true,
      // Package acquisition and compilation are genuine external boundaries.
      runCommand: async (cmd, args, options) => {
        const cwd = options?.cwd!;
        if (cmd === 'npm' && args[0] === 'install') {
          expect(args).toEqual(expect.arrayContaining(['--cpu=arm64', '--os=linux', '--ignore-scripts']));
          const dir = join(cwd, 'node_modules/node-pty');
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'node-pty', version: '1.1.0' }));
        } else if (cmd === 'npm' && args[0] === 'rebuild') {
          expect(options?.env).toMatchObject({ CC: 'aarch64-linux-gnu-gcc', CXX: 'aarch64-linux-gnu-g++', LINK: 'aarch64-linux-gnu-g++', npm_config_arch: 'arm64', npm_config_build_from_source: 'true' });
          await mkdir(join(cwd, 'node_modules/node-pty/build/Release'), { recursive: true });
          await writeFile(join(cwd, 'node_modules/node-pty/build/Release/pty.node'), 'arm64 addon');
        } else throw new Error(`unexpected boundary command: ${cmd} ${args.join(' ')}`);
      },
    });
    for (const path of paths) expect(await readFile(join(payloadDir, path, 'build/Release/pty.node'), 'utf8')).toBe('arm64 addon');
    expect(await readFile(join(repoRoot, 'node_modules/node-pty/build/Release/pty.node'), 'utf8')).toBe('host addon');
  } finally { await rm(repoRoot, { recursive: true, force: true }); }
});

it('admits Linux x64 to ARM64 only with the cross toolchain and npm', () => {
  const input = { target: { os: 'linux', arch: 'arm64' }, platform: 'linux', arch: 'x64' };
  expect(getCliBinaryArtifactSupportTargetUnavailableReason({ ...input, commandProbe: () => true })).toBeNull();
  expect(getCliBinaryArtifactSupportTargetUnavailableReason({ ...input, commandProbe: command => command !== 'aarch64-linux-gnu-g++' })).toMatch(/aarch64-linux-gnu-g\+\+/);
});

it('keeps same-host Windows support on its existing native path', async () => {
  await expect(stageCliTargetRuntimeDependencies({ repoRoot: '/not-used', payloadDir: '/not-used',
    target: { os: 'windows', arch: 'x64', bunTarget: 'bun-windows-x64', exeExt: '.exe' },
    platform: 'win32', arch: 'x64', commandProbe: () => false,
    runCommand: () => { throw new Error('native builds must not acquire cross-target dependencies'); },
  })).resolves.toBeUndefined();
});

it('acquires target esbuild and both existing Linux Sharp libc variants, and runs the FFmpeg target installer', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'cli-target-media-'));
  const payloadDir = join(repoRoot, 'payload');
  async function put(path: string, value: string) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value); }
  try {
    for (const name of ['esbuild', 'sharp', 'ffmpeg-static']) {
      await put(join(payloadDir, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
      await put(join(payloadDir, 'node_modules', name, 'host-native'), 'host');
    }
    await stageCliTargetRuntimeDependencies({ repoRoot, payloadDir,
      target: { os: 'linux', arch: 'arm64', bunTarget: 'bun-linux-arm64', exeExt: '' },
      platform: 'linux', arch: 'x64', commandProbe: () => true,
      runCommand: async (cmd, args, options) => {
        if (cmd === 'npm') {
          const root = options?.cwd!;
          const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
          const musl = args.includes('--libc=musl');
          for (const [name, version] of Object.entries(manifest.dependencies)) {
            const optionalDependencies = name === 'esbuild' ? { '@esbuild/linux-arm64': '1.0.0' }
              : name === 'sharp' ? { [`@img/sharp-${musl ? 'linuxmusl' : 'linux'}-arm64`]: '1.0.0' } : {};
            await put(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, version, optionalDependencies }));
            for (const native of Object.keys(optionalDependencies)) {
              await put(join(root, 'node_modules', native, 'package.json'), JSON.stringify({ name: native, version: '1.0.0' }));
              await put(join(root, 'node_modules', native, 'native'), 'arm64');
            }
          }
        } else {
          expect(options?.env).toMatchObject({ npm_config_arch: 'arm64', npm_config_platform: 'linux' });
          await put(join(options?.cwd!, 'ffmpeg'), 'arm64 ffmpeg');
        }
      },
    });
    expect(await readFile(join(payloadDir, 'node_modules/esbuild/node_modules/@esbuild/linux-arm64/native'), 'utf8')).toBe('arm64');
    expect(await readFile(join(payloadDir, 'node_modules/sharp/node_modules/@img/sharp-linux-arm64/native'), 'utf8')).toBe('arm64');
    expect(await readFile(join(payloadDir, 'node_modules/sharp/node_modules/@img/sharp-linuxmusl-arm64/native'), 'utf8')).toBe('arm64');
    expect(await readFile(join(payloadDir, 'node_modules/ffmpeg-static/ffmpeg'), 'utf8')).toBe('arm64 ffmpeg');
  } finally { await rm(repoRoot, { recursive: true, force: true }); }
});
