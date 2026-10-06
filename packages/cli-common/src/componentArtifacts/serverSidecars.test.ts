import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import {
  readServerRuntimeSupportIdentity,
  resolveIrohNativeServerSidecarEntries,
  resolveServerRuntimeSupportBuildDbProviders,
  resolveServerRuntimeSupportEntries,
  serverRuntimeSupportNeedsPackagedMigration,
} from './serverSidecars.js';

test.each(['linux', 'darwin'])('cross-target %s server support acquires target Sharp packages without replacing host build dependencies', async (targetOs) => {
  const root = await mkdtemp(join(tmpdir(), 'server-cross-target-support-'));
  const targetArch = process.arch === 'arm64' ? 'x64' : 'arm64';
  const target = { os: targetOs, arch: targetArch, bunTarget: `bun-${targetOs}-${targetArch}`, exeExt: '' };
  const write = async (path: string, contents: string) => {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, contents);
  };
  try {
    for (const path of ['apps/server/generated/sqlite-client/index.js', 'apps/server/prisma/sqlite/migrations/fixture.sql', 'node_modules/.prisma/client/index.js', 'node_modules/@prisma/client/package.json', 'packages/iroh-native/package.json', 'packages/iroh-native/dist/index.js', 'packages/iroh-native/scripts/load.mjs']) {
      await write(join(root, path), '{}');
    }
    await write(join(root, 'node_modules/sharp/package.json'), JSON.stringify({ name: 'sharp', version: '0.34.3' }));
    const hostAddon = join(root, 'node_modules', '@img', `sharp-linux-${process.arch}`, 'lib', 'sharp.node');
    await write(hostAddon, 'host addon');
    const entries = await resolveServerRuntimeSupportEntries({
      repoRoot: root,
      target,
      buildDbProviders: 'sqlite',
      commandProbe: (command) => command === 'yarn' || command === 'npm',
      runCommand: async (command, args, options) => {
        if (command !== 'npm') return;
        // npm is the external acquisition boundary. It installs only packages
        // admitted by the requested OS/CPU, without executing foreign scripts.
        expect(args).toContain(`--cpu=${targetArch}`);
        expect(args).toContain(`--os=${targetOs}`);
        expect(args).toContain('--ignore-scripts');
        const installRoot = options?.cwd;
        if (!installRoot) throw new Error('native install requires an isolated cwd');
        const manifest = JSON.parse(await readFile(join(installRoot, 'package.json'), 'utf8'));
        expect(manifest.dependencies).toEqual({ sharp: '0.34.3' });
        for (const packageName of ['sharp', `@img/sharp-${targetOs}-${targetArch}`, `@img/sharp-libvips-${targetOs}-${targetArch}`]) {
          const packageDir = join(installRoot, 'node_modules', ...packageName.split('/'));
          await write(join(packageDir, 'package.json'), JSON.stringify({ name: packageName, version: '0.34.3', os: [targetOs], cpu: [targetArch] }));
          await write(join(packageDir, 'lib', 'native'), `target ${targetArch}`);
        }
      },
    });
    const nativeEntry = entries.find((entry) => entry.targetPath === join('node_modules', '@img', `sharp-${targetOs}-${targetArch}`));
    expect(nativeEntry).toBeDefined();
    expect(await readFile(join(nativeEntry!.sourcePath, 'lib', 'native'), 'utf8')).toBe(`target ${targetArch}`);
    expect(await readFile(hostAddon, 'utf8')).toBe('host addon');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('server runtime support stages the ordinary Iroh package root and exact target addon', async () => {
  const root = await mkdtemp(join(tmpdir(), 'server-iroh-native-sidecar-'));
  try {
    const packageRoot = join(root, 'packages', 'iroh-native');
    await mkdir(join(packageRoot, 'dist'), { recursive: true });
    await mkdir(join(packageRoot, 'scripts'), { recursive: true });
    await mkdir(join(packageRoot, 'native'), { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), '{"name":"@happier-dev/iroh-native"}\n', 'utf8');
    await writeFile(join(packageRoot, 'dist', 'nodeNative.js'), 'export {};\n', 'utf8');
    await writeFile(join(packageRoot, 'scripts', 'verify-node-addon-load.mjs'), 'export {};\n', 'utf8');
    await writeFile(
      join(packageRoot, 'native', 'happier-iroh-native-lifecycle.linux-x64.node'),
      'native-addon',
      'utf8',
    );

    await expect(resolveIrohNativeServerSidecarEntries({
      repoRoot: root,
      target: { os: 'linux', arch: 'x64', bunTarget: 'bun-linux-x64-baseline', exeExt: '' },
      requireNativeAddon: true,
    })).resolves.toEqual([
      {
        sourcePath: join(packageRoot, 'package.json'),
        targetPath: join('node_modules', '@happier-dev', 'iroh-native', 'package.json'),
      },
      {
        sourcePath: join(packageRoot, 'dist'),
        targetPath: join('node_modules', '@happier-dev', 'iroh-native', 'dist'),
      },
      {
        sourcePath: join(packageRoot, 'scripts'),
        targetPath: join('node_modules', '@happier-dev', 'iroh-native', 'scripts'),
      },
      {
        sourcePath: join(packageRoot, 'native', 'happier-iroh-native-lifecycle.linux-x64.node'),
        targetPath: join(
          'node_modules',
          '@happier-dev',
          'iroh-native',
          'native',
          'happier-iroh-native-lifecycle.linux-x64.node',
        ),
      },
    ]);

    await rm(join(packageRoot, 'native'), { recursive: true, force: true });
    await expect(resolveIrohNativeServerSidecarEntries({
      repoRoot: root,
      target: { os: 'linux', arch: 'x64', bunTarget: 'bun-linux-x64-baseline', exeExt: '' },
      requireNativeAddon: true,
    })).rejects.toThrow(/missing Iroh lifecycle addon for linux-x64/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('server provider capability is independent of the behavior preset', () => {
  for (const serverComponent of ['happier-server', 'happier-server-light'] as const) {
    expect(resolveServerRuntimeSupportBuildDbProviders({ serverComponent, buildDbProviders: 'postgresql' }))
      .toBe('postgresql');
  }
  expect(serverRuntimeSupportNeedsPackagedMigration('sqlite')).toBe(false);
  expect(serverRuntimeSupportNeedsPackagedMigration('postgresql')).toBe(true);
  expect(serverRuntimeSupportNeedsPackagedMigration('mysql')).toBe(true);
  expect(serverRuntimeSupportNeedsPackagedMigration('all')).toBe(true);
});

test('server runtime support identity changes for Prisma/native contents and target inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'server-runtime-support-identity-'));
  const prismaClientDir = join(root, 'generated', 'sqlite-client');
  try {
    await mkdir(prismaClientDir, { recursive: true });
    const enginePath = join(prismaClientDir, 'libquery_engine-debian-openssl-3.0.x.so.node');
    const prismaToolPath = join(root, 'tools', 'buildPrismaMigrateBinary.mjs');
    await writeFile(enginePath, 'engine-one', 'utf8');
    await mkdir(join(prismaToolPath, '..'), { recursive: true });
    await writeFile(prismaToolPath, 'tool-one', 'utf8');

    const entries = [{
      sourcePath: prismaClientDir,
      targetPath: join('generated', 'sqlite-client'),
    }];
    const first = await readServerRuntimeSupportIdentity({
      entries,
      target: { os: 'linux', arch: 'x64', bunTarget: 'bun-linux-x64-baseline', exeExt: '' },
      serverComponent: 'happier-server-light',
      buildDbProviders: 'sqlite',
    });

    await writeFile(enginePath, 'engine-two', 'utf8');
    const changedNativeInput = await readServerRuntimeSupportIdentity({
      entries,
      target: { os: 'linux', arch: 'x64', bunTarget: 'bun-linux-x64-baseline', exeExt: '' },
      serverComponent: 'happier-server-light',
      buildDbProviders: 'sqlite',
    });
    const changedTarget = await readServerRuntimeSupportIdentity({
      entries,
      target: { os: 'windows', arch: 'x64', bunTarget: 'bun-windows-x64', exeExt: '.exe' },
      serverComponent: 'happier-server-light',
      buildDbProviders: 'sqlite',
    });
    const changedProviderSelection = await readServerRuntimeSupportIdentity({
      entries,
      target: { os: 'linux', arch: 'x64', bunTarget: 'bun-linux-x64-baseline', exeExt: '' },
      serverComponent: 'happier-server-light',
      buildDbProviders: 'mysql',
    });
    const sameSupportForOtherPreset = await readServerRuntimeSupportIdentity({
      entries,
      target: { os: 'linux', arch: 'x64', bunTarget: 'bun-linux-x64-baseline', exeExt: '' },
      serverComponent: 'happier-server',
      buildDbProviders: 'sqlite',
    });
    const firstToolIdentity = await readServerRuntimeSupportIdentity({
      entries,
      toolIdentityEntries: [{
        sourcePath: prismaToolPath,
        targetPath: join('tool-inputs', 'buildPrismaMigrateBinary.mjs'),
      }],
      toolInputs: ['bun=1.0.0'],
      target: { os: 'linux', arch: 'x64', bunTarget: 'bun-linux-x64-baseline', exeExt: '' },
      serverComponent: 'happier-server-light',
      buildDbProviders: 'sqlite',
    });
    await writeFile(prismaToolPath, 'tool-two', 'utf8');
    const changedToolIdentity = await readServerRuntimeSupportIdentity({
      entries,
      toolIdentityEntries: [{
        sourcePath: prismaToolPath,
        targetPath: join('tool-inputs', 'buildPrismaMigrateBinary.mjs'),
      }],
      toolInputs: ['bun=1.0.0'],
      target: { os: 'linux', arch: 'x64', bunTarget: 'bun-linux-x64-baseline', exeExt: '' },
      serverComponent: 'happier-server-light',
      buildDbProviders: 'sqlite',
    });

    expect(changedNativeInput.fingerprint).not.toBe(first.fingerprint);
    expect(changedTarget.fingerprint).not.toBe(changedNativeInput.fingerprint);
    expect(changedProviderSelection.fingerprint).not.toBe(changedNativeInput.fingerprint);
    expect(sameSupportForOtherPreset.fingerprint).toBe(changedNativeInput.fingerprint);
    expect(changedToolIdentity.fingerprint).not.toBe(firstToolIdentity.fingerprint);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
