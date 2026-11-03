import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseOrganizationPolicyV1, type OrganizationPolicyLoadResult } from '@happier-dev/protocol/organizationPolicy/organizationPolicyV1';
import { resolveRelayRuntimeDefaults } from '../firstPartyRuntime/relayRuntime.js';

const host = vi.hoisted(() => ({ homeDir: '' }));
vi.mock('node:os', async (importOriginal) => ({ ...await importOriginal<typeof import('node:os')>(), homedir: () => host.homeDir }));
// Service discovery is an OS boundary. No service commands reach the real host.
vi.mock('node:child_process', async (importOriginal) => ({ ...await importOriginal<typeof import('node:child_process')>(), spawnSync: () => ({ status: 0, stdout: 'LoadState=not-found\n', stderr: '' }) }));

describe('local Home organization policy admission', () => {
  const homeDirs: string[] = [];
  afterEach(async () => { await Promise.all(homeDirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
  const off = parseOrganizationPolicyV1('{"schemaVersion":1,"organization":"Example","personalHome":{"value":"off","locked":true}}');
  const invalid: OrganizationPolicyLoadResult = { status: 'invalid', error: { path: '$', code: 'invalid_json' } };

  async function setup(organizationPolicy: OrganizationPolicyLoadResult, existing = false) {
    host.homeDir = await mkdtemp(join(tmpdir(), 'org-policy-home-'));
    homeDirs.push(host.homeDir);
    if (existing) {
      const defaults = resolveRelayRuntimeDefaults({ platform: process.platform, mode: 'user', channel: 'preview', homeDir: host.homeDir });
      await mkdir(defaults.installRoot, { recursive: true });
      await writeFile(join(defaults.installRoot, 'self-host-state.json'), JSON.stringify({ purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43123' } }));
    }
    const { createRelayHostEngine } = await import('./relayHostEngine.js');
    return createRelayHostEngine({
      localInstallPolicy: { organizationPolicy, runServiceCommands: false, skipHealthCheck: true },
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async () => ({ binaryPath: '', versionId: '' }),
    });
  }
  const request = { target: { kind: 'local' as const }, mode: 'user' as const, channel: 'preview' as const, purpose: { kind: 'personal-home' as const, canonicalServerUrl: 'http://127.0.0.1:43123' }, env: { PORT: '43123' } };

  it.each([['off', off, 'organization_policy_off'], ['invalid', invalid, 'organization_policy_invalid']] as const)('blocks a fresh Home with %s policy before runtime mutation', async (_label, policy, code) => {
    const engine = await setup(policy);
    await expect(engine.installOrUpdate(request)).rejects.toMatchObject({ name: 'OrganizationPolicyActionError', code });
    expect(await readdir(host.homeDir)).toEqual([]);
  });

  it.each([['absent', { status: 'absent' } as const, false], ['off retained Home', off, true], ['invalid retained Home', invalid, true]] as const)('admits %s through the existing installer preflight', async (_label, policy, existing) => {
    const engine = await setup(policy, existing);
    await expect(engine.installOrUpdate(request)).rejects.toThrow('Local relay runtime install requires selfHostRelayBinaryOverride');
  });

  it('forces local relay policy over requested and previously installed relay lists', async () => {
    const engine = await setup(parseOrganizationPolicyV1('{"schemaVersion":1,"organization":"Example","relays":{"policy":"disabled"}}'));
    const payload = join(host.homeDir, 'payload');
    const migration = join(payload, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
    await mkdir(migration, { recursive: true });
    await writeFile(join(migration, 'migration.sql'), '-- fixture\n');
    const binary = join(payload, process.platform === 'win32' ? 'happier-server.exe' : 'happier-server');
    await writeFile(binary, '#!/bin/sh\n');
    const defaults = resolveRelayRuntimeDefaults({ platform: process.platform, mode: 'user', channel: 'preview', homeDir: host.homeDir });
    await mkdir(defaults.configDir, { recursive: true });
    await writeFile(join(defaults.configDir, 'server.env'), 'HAPPIER_IROH_RELAY_POLICY=automatic\nHAPPIER_IROH_RELAY_URLS=https://previous.example\n');
    await engine.installOrUpdate({ ...request, purpose: { kind: 'generic' }, selfHostRelayBinaryOverride: binary, env: { HAPPIER_IROH_RELAY_POLICY: 'automatic', HAPPIER_IROH_RELAY_URLS: 'https://outside.example' } });
    const env = await readFile(join(defaults.configDir, 'server.env'), 'utf8');
    expect(env).toContain('HAPPIER_IROH_RELAY_POLICY=disabled');
    expect(env).not.toContain('https://previous.example');
    expect(env).not.toContain('https://outside.example');
  });
});
