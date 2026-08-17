import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

type ProductDescriptor = Readonly<{
  productId: string;
  defaultAgentDirSegments: readonly string[];
  agentDirEnvVar: string;
  agentDirSettingId?: string;
  legacySessionDirEnvVars: readonly string[];
  readsSettingsSessionDir: boolean;
  configDirName: string;
  encodeCwdSubdir: ((cwd: string) => string) | null;
}>;

type RootDescriptor = Readonly<{
  v: 1;
  productId: string;
  agentDir: string;
  grantedBy: 'host-config' | 'host-takeover-env' | 'host-external-session-source';
}>;

type ResolverModule = Readonly<{
  resolveSessionFileStoreLaunchEnvironment(input: Readonly<{
    product: ProductDescriptor;
    settings?: Readonly<Record<string, unknown>>;
    env?: Readonly<Record<string, string | undefined>>;
  }>): Readonly<Record<string, string>>;
  listSessionFileStoreRoots(resolution: Readonly<{ sessionsRoot: string }>): Promise<readonly string[]>;
  resolveSessionFileStoreDirs(input: Readonly<{
    product: ProductDescriptor;
    env?: Readonly<Record<string, string | undefined>>;
    homeDir?: string;
    cwd?: string;
    grantedRoot?: RootDescriptor | null;
  }>): Promise<Readonly<{
    agentDir: string;
    sessionsRoot: string;
    resolvedFrom: 'grantedRoot' | 'agentDirEnv' | 'legacySessionDirEnv' | 'settingsSessionDir' | 'productDefault';
  }>>;
  resolveSessionFileStoreDirsSync(input: Readonly<{
    product: ProductDescriptor;
    env?: Readonly<Record<string, string | undefined>>;
    homeDir?: string;
    cwd?: string;
    grantedRoot?: RootDescriptor | null;
  }>): Readonly<{
    agentDir: string;
    sessionsRoot: string;
    resolvedFrom: 'grantedRoot' | 'agentDirEnv' | 'legacySessionDirEnv' | 'settingsSessionDir' | 'productDefault';
  }>;
  validateSessionFileStoreRootDescriptor(input: Readonly<{
    descriptor: RootDescriptor;
    product: ProductDescriptor;
    env?: Readonly<Record<string, string | undefined>>;
  }>): Promise<Readonly<{ ok: true; canonicalAgentDir: string } | { ok: false; error: string }>>;
}>;

const product = {
  productId: 'generic-file-agent',
  defaultAgentDirSegments: ['.generic-file-agent', 'agent'],
  agentDirEnvVar: 'GENERIC_FILE_AGENT_DIR',
  legacySessionDirEnvVars: ['GENERIC_FILE_AGENT_SESSION_DIR'],
  readsSettingsSessionDir: true,
  configDirName: '.generic-file-agent',
  encodeCwdSubdir: null,
} satisfies ProductDescriptor;

const tempDirs = new Set<string>();

async function loadResolver(): Promise<ResolverModule> {
  const loaded = await import('./index.js').catch((error: unknown) => error);
  expect(loaded).not.toBeInstanceOf(Error);
  return loaded as ResolverModule;
}

afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

describe('session file-store directory resolver', () => {
  it('applies one canonical precedence chain', async () => {
    const resolver = await loadResolver();
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-file-store-home-'));
    const cwd = await mkdtemp(join(tmpdir(), 'happier-file-store-cwd-'));
    tempDirs.add(homeDir);
    tempDirs.add(cwd);

    const defaultAgentDir = join(homeDir, '.generic-file-agent', 'agent');
    const envAgentDir = join(homeDir, 'env-agent');
    const legacySessionDir = join(homeDir, 'legacy-sessions');
    const settingsSessionDir = join(homeDir, 'settings-sessions');
    const grantedAgentDir = join(homeDir, 'granted-agent');
    await mkdir(defaultAgentDir, { recursive: true });
    await mkdir(envAgentDir, { recursive: true });
    await mkdir(legacySessionDir, { recursive: true });
    await mkdir(settingsSessionDir, { recursive: true });
    await mkdir(grantedAgentDir, { recursive: true });
    await writeFile(join(defaultAgentDir, 'settings.json'), JSON.stringify({ sessionDir: settingsSessionDir }), 'utf8');

    await expect(resolver.resolveSessionFileStoreDirs({ product, homeDir, cwd })).resolves.toMatchObject({
      agentDir: await realpath(defaultAgentDir),
      sessionsRoot: await realpath(settingsSessionDir),
      resolvedFrom: 'settingsSessionDir',
    });

    await expect(resolver.resolveSessionFileStoreDirs({
      product,
      homeDir,
      cwd,
      env: { GENERIC_FILE_AGENT_SESSION_DIR: legacySessionDir },
    })).resolves.toMatchObject({
      sessionsRoot: await realpath(legacySessionDir),
      resolvedFrom: 'legacySessionDirEnv',
    });

    await expect(resolver.resolveSessionFileStoreDirs({
      product,
      homeDir,
      cwd,
      env: {
        GENERIC_FILE_AGENT_DIR: envAgentDir,
        GENERIC_FILE_AGENT_SESSION_DIR: legacySessionDir,
      },
    })).resolves.toMatchObject({
      agentDir: await realpath(envAgentDir),
      sessionsRoot: join(await realpath(envAgentDir), 'sessions'),
      resolvedFrom: 'agentDirEnv',
    });

    await expect(resolver.resolveSessionFileStoreDirs({
      product,
      homeDir,
      cwd,
      env: { GENERIC_FILE_AGENT_DIR: envAgentDir },
      grantedRoot: {
        v: 1,
        productId: product.productId,
        agentDir: grantedAgentDir,
        grantedBy: 'host-config',
      },
    })).resolves.toMatchObject({
      agentDir: await realpath(grantedAgentDir),
      sessionsRoot: join(await realpath(grantedAgentDir), 'sessions'),
      resolvedFrom: 'grantedRoot',
    });
  });

  it('validates granted roots fail closed on product or configured-root mismatch', async () => {
    const resolver = await loadResolver();
    const root = await mkdtemp(join(tmpdir(), 'happier-file-store-grant-'));
    tempDirs.add(root);
    const configuredAgentDir = join(root, 'configured');
    const otherAgentDir = join(root, 'other');
    await mkdir(configuredAgentDir, { recursive: true });
    await mkdir(otherAgentDir, { recursive: true });

    await expect(resolver.validateSessionFileStoreRootDescriptor({
      product,
      env: { GENERIC_FILE_AGENT_DIR: configuredAgentDir },
      descriptor: {
        v: 1,
        productId: product.productId,
        agentDir: configuredAgentDir,
        grantedBy: 'host-external-session-source',
      },
    })).resolves.toEqual({
      ok: true,
      canonicalAgentDir: await realpath(configuredAgentDir),
    });

    await expect(resolver.validateSessionFileStoreRootDescriptor({
      product,
      descriptor: {
        v: 1,
        productId: 'different-product',
        agentDir: configuredAgentDir,
        grantedBy: 'host-external-session-source',
      },
    })).resolves.toMatchObject({ ok: false });

    await expect(resolver.validateSessionFileStoreRootDescriptor({
      product,
      env: { GENERIC_FILE_AGENT_DIR: configuredAgentDir },
      descriptor: {
        v: 1,
        productId: product.productId,
        agentDir: otherAgentDir,
        grantedBy: 'host-external-session-source',
      },
    })).resolves.toMatchObject({ ok: false });
  });

  it('fails closed for sync granted external source roots that differ from the configured root', async () => {
    const resolver = await loadResolver();
    const root = await mkdtemp(join(tmpdir(), 'happier-file-store-sync-grant-'));
    tempDirs.add(root);
    const configuredAgentDir = join(root, 'configured');
    const otherAgentDir = join(root, 'other');
    await mkdir(configuredAgentDir, { recursive: true });
    await mkdir(otherAgentDir, { recursive: true });

    expect(resolver.resolveSessionFileStoreDirsSync({
      product,
      env: { GENERIC_FILE_AGENT_DIR: configuredAgentDir },
      grantedRoot: {
        v: 1,
        productId: product.productId,
        agentDir: otherAgentDir,
        grantedBy: 'host-external-session-source',
      },
    })).toMatchObject({
      agentDir: await realpath(configuredAgentDir),
      sessionsRoot: join(await realpath(configuredAgentDir), 'sessions'),
      resolvedFrom: 'agentDirEnv',
    });
  });

  it('projects a per-Agent configured root over the ambient vendor environment', async () => {
    const resolver = await loadResolver();
    const configured = resolver.resolveSessionFileStoreLaunchEnvironment({
      product: { ...product, agentDirSettingId: 'genericAgentDir' },
      settings: { genericAgentDir: '  ~/isolated-agent  ' },
      env: {
        HOME: '/home/alice',
        GENERIC_FILE_AGENT_DIR: '/ambient/shared-agent',
      },
    });
    const ambient = resolver.resolveSessionFileStoreLaunchEnvironment({
      product: { ...product, agentDirSettingId: 'genericAgentDir' },
      settings: {},
      env: { GENERIC_FILE_AGENT_DIR: '/ambient/shared-agent' },
    });

    expect(configured).toEqual({ GENERIC_FILE_AGENT_DIR: '/home/alice/isolated-agent' });
    expect(ambient).toEqual({ GENERIC_FILE_AGENT_DIR: '/ambient/shared-agent' });
  });

  it('enumerates existing child roots and skips symlinks', async () => {
    const resolver = await loadResolver();
    const root = await mkdtemp(join(tmpdir(), 'happier-file-store-roots-'));
    tempDirs.add(root);
    const sessionsRoot = join(root, 'sessions');
    const realRoot = join(sessionsRoot, 'workspace');
    const linkedTarget = join(root, 'linked-target');
    await mkdir(realRoot, { recursive: true });
    await mkdir(linkedTarget, { recursive: true });
    await symlink(linkedTarget, join(sessionsRoot, 'linked'));

    await expect(resolver.listSessionFileStoreRoots({ sessionsRoot })).resolves.toEqual([realRoot]);
  });
});
