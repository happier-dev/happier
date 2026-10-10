import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';
import { buildServerBinaryArtifactPayload, buildServerRuntimeSupportPayload } from './buildServerBinaryArtifactPayload.js';

test.each(['happier-server-light', 'happier-server'] as const)('native %s code compiles main and migration without workspace preparation', async (serverComponent) => {
  const root = await mkdtemp(join(tmpdir(), 'server-native-source-owner-'));
  const payloadDir = join(root, 'payload');
  const entrypoint = join(root, 'apps/server/sources', serverComponent === 'happier-server' ? 'main.ts' : 'main.light.ts');
  const migrationSource = join(root, 'apps/server/scripts/runtime/migrateFullRuntime.ts');
  try {
    for (const path of [entrypoint, migrationSource]) {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, 'export {};');
    }
    const compiled: string[] = [];
    const result = await buildServerBinaryArtifactPayload({
      repoRoot: root, payloadDir, serverComponent, entrypoint, buildDbProviders: 'postgres', includeRuntimeSupport: false,
      target: { os: 'linux', arch: 'x64', bunTarget: 'bun-linux-x64-baseline', exeExt: '' },
      commandProbe: command => command === 'bun',
      // The external compiler boundary writes the artifact it is asked to emit.
      compileBinary: async ({ entrypoint: input, outfile, buildRunnerEntrypoint }) => {
        expect(buildRunnerEntrypoint).toBe(join(root, 'packages/cli-common/scripts/buildServerBunBinary.mjs'));
        compiled.push(input);
        await writeFile(outfile, `compiled ${input}`);
      },
      runCommand: async () => { throw new Error('native code must not run workspace preparation'); },
    });
    expect(compiled).toEqual([entrypoint, migrationSource]);
    expect(await readFile(join(payloadDir, result.entrypoint), 'utf8')).toContain(entrypoint);
    expect(await readFile(join(payloadDir, result.migrationEntrypoint!), 'utf8')).toContain(migrationSource);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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

test('server support ignores workspace JavaScript and build evidence while staging the native addon', async () => {
  const root = await mkdtemp(join(tmpdir(), 'server-support-build-evidence-'));
  const packageRoot = join(root, 'packages', 'iroh-native');
  const dist = join(packageRoot, 'dist');
  const target = { os: 'linux', arch: 'x64', bunTarget: 'bun-linux-x64-baseline', exeExt: '' };
  try {
    await mkdir(dist, { recursive: true });
    await mkdir(join(packageRoot, 'scripts'), { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), '{"name":"@happier-dev/iroh-native"}\n');
    await writeFile(join(dist, 'nodeNative.js'), 'export const runtime = 1;\n');
    const nativePath = join(packageRoot, 'native', 'happier-iroh-native-lifecycle.linux-x64.node');
    await mkdir(join(nativePath, '..'), { recursive: true });
    await writeFile(nativePath, 'native first');
    const buildRecord = join(dist, '.happier-build-inputs.json');
    await writeFile(buildRecord, JSON.stringify({ builtAt: 'first preparation' }));
    const entries = await resolveIrohNativeServerSidecarEntries({ repoRoot: root, target });
    const identityOptions = { entries, target, serverComponent: 'happier-server-light' as const, buildDbProviders: 'sqlite' };
    const first = await readServerRuntimeSupportIdentity(identityOptions);
    await writeFile(buildRecord, JSON.stringify({ builtAt: 'second preparation' }));
    expect((await readServerRuntimeSupportIdentity(identityOptions)).fingerprint).toBe(first.fingerprint);
    await writeFile(join(dist, 'nodeNative.js'), 'export const runtime = 2;\n');
    expect((await readServerRuntimeSupportIdentity(identityOptions)).fingerprint).toBe(first.fingerprint);
    await writeFile(nativePath, 'native changed');
    expect((await readServerRuntimeSupportIdentity(identityOptions)).fingerprint).not.toBe(first.fingerprint);

    const client = join(root, 'client');
    await mkdir(client);
    await writeFile(join(client, 'libquery_engine-debian-openssl-3.0.x.so.node'), 'engine');
    const payloadDir = join(root, 'payload');
    await buildServerRuntimeSupportPayload({
      payloadDir, target, buildDbProviders: 'sqlite',
      entries: [...entries,
        { sourcePath: client, targetPath: join('node_modules', '.prisma', 'client') },
        { sourcePath: client, targetPath: join('generated', 'sqlite-client') },
      ],
    });
    const stagedDist = join(payloadDir, 'node_modules', '@happier-dev', 'iroh-native', 'dist');
    await expect(readFile(join(stagedDist, 'nodeNative.js'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(payloadDir, 'node_modules/@happier-dev/iroh-native/native', 'happier-iroh-native-lifecycle.linux-x64.node'), 'utf8')).toBe('native changed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
