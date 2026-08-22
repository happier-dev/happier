import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  composeProviderBindingMaterialization,
  createProviderBindingLaunchMaterializationCleanup,
  resolveProviderMaterializationParentPath,
} from './compose';

describe('provider binding host materialization', () => {
  it('resolves Windows config-file parents with the platform path implementation', () => {
    expect(resolveProviderMaterializationParentPath(
      String.raw`C:\Users\alice\.happier\provider-binding\config\provider.json`,
      { dirname: win32.dirname },
    )).toBe(String.raw`C:\Users\alice\.happier\provider-binding\config`);
  });

  it('keeps engine config transient while returning the provider env overlay', async () => {
    const result = await composeProviderBindingMaterialization({
      materialization: {
        v: 1,
        kind: 'engineConfig',
        env: [{ name: 'PROVIDER_KEY', value: 'secret', source: 'provider' }],
        engineConfig: { model_provider: 'gateway' },
      },
      materializationBaseDir: '/unused',
      sessionId: 'session-a',
    });

    expect(result).toMatchObject({
      providerEnvironmentOverlay: [{ name: 'PROVIDER_KEY', value: 'secret', source: 'provider' }],
      launchMaterialization: {
        v: 1,
        kind: 'engineConfig',
        engineConfig: { model_provider: 'gateway' },
      },
    });
    expect(result.cleanup).toBeNull();
  });

  it('writes config files below a host-owned private root and cleans exactly that root', async () => {
    const base = await mkdtemp(join(tmpdir(), 'happier-provider-compose-'));
    const result = await composeProviderBindingMaterialization({
      materialization: {
        v: 1,
        kind: 'configFile',
        env: [{ name: 'PROVIDER_KEY', value: null, source: 'provider' }],
        files: [{ relativePath: 'config/provider.json', utf8: '{"key":"env:PROVIDER_KEY"}' }],
      },
      materializationBaseDir: base,
      sessionId: 'session-a',
    });
    if (result.launchMaterialization.kind !== 'configFile') throw new Error('Expected file materialization');

    expect(await readFile(join(result.launchMaterialization.rootPath, 'config/provider.json'), 'utf8'))
      .toBe('{"key":"env:PROVIDER_KEY"}');
    if (process.platform !== 'win32') {
      expect((await stat(result.launchMaterialization.rootPath)).mode & 0o777).toBe(0o700);
      expect((await stat(join(result.launchMaterialization.rootPath, 'config/provider.json'))).mode & 0o777).toBe(0o600);
    }

    await result.cleanup?.();
    await result.cleanup?.();
    await expect(stat(result.launchMaterialization.rootPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('transfers config-file cleanup to the retained Session owner without generation cleanup deleting it', async () => {
    const base = await mkdtemp(join(tmpdir(), 'happier-provider-compose-transfer-'));
    const result = await composeProviderBindingMaterialization({
      materialization: {
        v: 1,
        kind: 'configFile',
        env: [],
        files: [{ relativePath: 'config/provider.json', utf8: '{}' }],
      },
      materializationBaseDir: base,
      sessionId: 'session-retained',
    });
    if (result.launchMaterialization.kind !== 'configFile') throw new Error('Expected file materialization');

    const retainedCleanup = result.takeCleanupOwnership();
    result.cleanup?.();
    expect(await readFile(join(result.launchMaterialization.rootPath, 'config/provider.json'), 'utf8'))
      .toBe('{}');

    retainedCleanup?.();
    retainedCleanup?.();
    await expect(stat(result.launchMaterialization.rootPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a retained cleanup descriptor outside the canonical materialization root', () => {
    expect(createProviderBindingLaunchMaterializationCleanup({
      materializationBaseDir: '/private/providers/materialized',
      materialization: {
        v: 1,
        kind: 'configFile',
        rootPath: '/private/providers/materialized-sibling/provider-binding-escape',
        relativePaths: ['provider.json'],
      },
    })).toBeNull();
  });
});
