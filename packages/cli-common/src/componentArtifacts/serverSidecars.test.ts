import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { readServerRuntimeSupportIdentity } from './serverSidecars.js';

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
    expect(changedToolIdentity.fingerprint).not.toBe(firstToolIdentity.fingerprint);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
