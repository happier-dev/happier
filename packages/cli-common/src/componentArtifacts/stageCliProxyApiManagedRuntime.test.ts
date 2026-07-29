import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { stageCliProxyApiManagedRuntime } from './stageCliProxyApiManagedRuntime.js';
import type { BinaryTarget } from './targets.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cliproxyapi-managed-runtime-stage-'));
  tempDirs.push(dir);
  return dir;
}

async function writeFixture(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('stageCliProxyApiManagedRuntime', () => {
  it('invokes the one package-owned build contract and stages its license beside the executable', async () => {
    const repoRoot = await createTempDir();
    const payloadDir = join(repoRoot, 'payload');
    const licensePath = join(
      repoRoot,
      'packages',
      'plugins',
      'cliproxyapi',
      'managed-runtime',
      'licenses',
      'CLIProxyAPI-LICENSE',
    );
    await writeFixture(licensePath, 'MIT fixture\n');
    await writeFixture(
      join(
        repoRoot,
        'packages',
        'plugins',
        'cliproxyapi',
        'managed-runtime',
        'licenses',
        'THIRD-PARTY-NOTICES',
      ),
      'transitive notices fixture\n',
    );
    const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
    const target: BinaryTarget = {
      bunTarget: 'bun-linux-x64-baseline',
      os: 'linux',
      arch: 'x64',
      exeExt: '',
    };

    const result = await stageCliProxyApiManagedRuntime({
      repoRoot,
      payloadDir,
      target,
      yarn: { cmd: 'corepack', args: ['yarn'] },
      runCommand: async (cmd, args, options) => {
        calls.push({ cmd, args, cwd: options?.cwd });
        const outputIndex = args.indexOf('--output');
        expect(outputIndex).toBeGreaterThan(-1);
        await writeFixture(args[outputIndex + 1]!, 'managed runtime fixture\n');
      },
    });

    expect(calls).toEqual([{
      cmd: 'corepack',
      args: [
        'yarn',
        'workspace',
        '@happier-dev/plugins-cliproxyapi',
        'managed-runtime:build',
        '--target',
        'linux-amd64',
        '--output',
        join(payloadDir, 'tools', 'unpacked', 'happier-cliproxyapi-managed'),
      ],
      cwd: repoRoot,
    }]);
    expect(result).toEqual({
      executablePath: join(payloadDir, 'tools', 'unpacked', 'happier-cliproxyapi-managed'),
      licensePath: join(payloadDir, 'tools', 'unpacked', 'CLIProxyAPI-LICENSE'),
      thirdPartyNoticesPath: join(payloadDir, 'tools', 'unpacked', 'CLIProxyAPI-THIRD-PARTY-NOTICES'),
    });
    await expect(readFile(result.executablePath, 'utf8')).resolves.toBe('managed runtime fixture\n');
    await expect(readFile(result.licensePath, 'utf8')).resolves.toBe('MIT fixture\n');
    await expect(readFile(result.thirdPartyNoticesPath, 'utf8')).resolves.toBe('transitive notices fixture\n');
    expect((await stat(result.executablePath)).mode & 0o777).toBe(0o755);
  });

  it('copies a prebuilt signed Windows leaf without invoking a second build', async () => {
    const repoRoot = await createTempDir();
    const payloadDir = join(repoRoot, 'payload');
    const prebuiltExecutablePath = join(repoRoot, 'signed', 'happier-cliproxyapi-managed.exe');
    await writeFixture(prebuiltExecutablePath, 'signed windows fixture\n');
    await writeFixture(
      join(repoRoot, 'packages', 'plugins', 'cliproxyapi', 'managed-runtime', 'licenses', 'CLIProxyAPI-LICENSE'),
      'MIT fixture\n',
    );
    await writeFixture(
      join(repoRoot, 'packages', 'plugins', 'cliproxyapi', 'managed-runtime', 'licenses', 'THIRD-PARTY-NOTICES'),
      'transitive notices fixture\n',
    );

    const result = await stageCliProxyApiManagedRuntime({
      repoRoot,
      payloadDir,
      target: {
        bunTarget: 'bun-windows-x64',
        os: 'windows',
        arch: 'x64',
        exeExt: '.exe',
      },
      yarn: { cmd: 'yarn', args: [] },
      prebuiltExecutablePath,
      runCommand: () => {
        throw new Error('prebuilt staging must not invoke the Go build');
      },
    });

    await expect(readFile(result.executablePath, 'utf8')).resolves.toBe('signed windows fixture\n');
    await expect(readFile(result.licensePath, 'utf8')).resolves.toBe('MIT fixture\n');
    await expect(readFile(result.thirdPartyNoticesPath, 'utf8')).resolves.toBe('transitive notices fixture\n');
  });

  it('fails closed when the package build reports success without producing the target executable', async () => {
    const repoRoot = await createTempDir();
    await writeFixture(
      join(repoRoot, 'packages', 'plugins', 'cliproxyapi', 'managed-runtime', 'licenses', 'CLIProxyAPI-LICENSE'),
      'MIT fixture\n',
    );
    await writeFixture(
      join(repoRoot, 'packages', 'plugins', 'cliproxyapi', 'managed-runtime', 'licenses', 'THIRD-PARTY-NOTICES'),
      'transitive notices fixture\n',
    );

    await expect(stageCliProxyApiManagedRuntime({
      repoRoot,
      payloadDir: join(repoRoot, 'payload'),
      target: {
        bunTarget: 'bun-darwin-arm64',
        os: 'darwin',
        arch: 'arm64',
        exeExt: '',
      },
      yarn: { cmd: 'yarn', args: [] },
      runCommand: () => undefined,
    })).rejects.toThrow(/expected file to exist.*happier-cliproxyapi-managed/i);
  });

  it('fails closed when the generated third-party notices are missing', async () => {
    const repoRoot = await createTempDir();
    const prebuiltExecutablePath = join(repoRoot, 'signed', 'happier-cliproxyapi-managed');
    await writeFixture(prebuiltExecutablePath, 'signed fixture\n');
    await writeFixture(
      join(repoRoot, 'packages', 'plugins', 'cliproxyapi', 'managed-runtime', 'licenses', 'CLIProxyAPI-LICENSE'),
      'MIT fixture\n',
    );

    await expect(stageCliProxyApiManagedRuntime({
      repoRoot,
      payloadDir: join(repoRoot, 'payload'),
      target: {
        bunTarget: 'bun-linux-x64-baseline',
        os: 'linux',
        arch: 'x64',
        exeExt: '',
      },
      yarn: { cmd: 'yarn', args: [] },
      prebuiltExecutablePath,
      runCommand: () => {
        throw new Error('prebuilt staging must not invoke the Go build');
      },
    })).rejects.toThrow(/expected file to exist.*THIRD-PARTY-NOTICES/i);
  });
});
