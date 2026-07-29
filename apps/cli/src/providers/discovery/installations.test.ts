import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderContributionV1Schema } from '@happier-dev/protocol';

import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import type { ProviderContributionRegistryView } from '@/providers/registry';
import { createProviderLocalInstallationReader } from './installations';
import { createProviderRuntimeStateStore } from '@/providers/runtimeState';

const key = 'happier.provider.lmstudio/lmstudio';
const temporaryPaths: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function runtimeStore() {
  const happyHomeDir = await mkdtemp(join(tmpdir(), 'provider-installations-'));
  temporaryPaths.push(happyHomeDir);
  return createProviderRuntimeStateStore({ happyHomeDir, machineId: 'machine-a' });
}

function registry(): ProviderContributionRegistryView {
  const definition = ProviderContributionV1Schema.parse({
    v: 1, id: 'lmstudio', name: 'LM Studio', kind: 'local',
    endpointTemplates: [{
      id: 'openai', protocol: 'openai-responses', localUrlCandidates: ['http://127.0.0.1:1234/v1'],
      capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'supported', reasoningControls: 'supported' },
    }],
    catalog: { source: 'probe', manualModelPolicy: 'allowed', probes: [{ endpointTemplateId: 'openai', path: '/v1/models', parser: 'openai-models' }] },
    discovery: {
      v: 1,
      listener: { executableBasenames: ['llmster'], defaultPorts: [1234] },
      availabilityProbe: { endpointTemplateId: 'openai', path: '/v1/models', parser: 'openai-models' },
      installedCheck: { lookupNames: ['lms'] },
      presenceCheck: { lookupNames: ['lms'], fixedArgs: ['daemon', 'status', '--json'], parser: 'lms-status-json' },
    },
  });
  const contribution: ResolvedProviderContribution = {
    provenance: 'first_party', source: { kind: 'bundled' }, pluginId: 'happier.provider.lmstudio',
    identity: { pluginId: 'happier.provider.lmstudio', localId: 'lmstudio' },
    definition,
  };
  return { providersByContributionKey: new Map([[key, contribution]]) };
}

describe('createProviderLocalInstallationReader', () => {
  it('reports app-running/server-off only from the verified presence command', async () => {
    const resolveSystemTool = vi.fn(async () => ({ ok: true as const, command: '/usr/bin/lms', args: [], source: 'system' }));
    const runSystemTool = vi.fn(async () => ({
      ok: true as const, exitCode: 0, stdout: '{"status":"running"}', stderr: '',
    }));
    const reader = createProviderLocalInstallationReader({ resolveSystemTool, runSystemTool, runtimeStore: await runtimeStore(), now: () => 100 });
    await expect(reader.read({ machineId: 'machine-a', registry: registry(), candidates: [] })).resolves.toEqual([{
      v: 1, machineId: 'machine-a', contributionKey: key, providerName: 'LM Studio', status: 'app_running_server_off', managedStartAvailable: false,
    }]);
  });

  it('reports installed-not-running when the binary exists without proven app presence', async () => {
    const reader = createProviderLocalInstallationReader({
      runtimeStore: await runtimeStore(),
      resolveSystemTool: vi.fn(async () => ({ ok: true as const, command: '/usr/bin/lms', args: [], source: 'system' })),
      runSystemTool: vi.fn(async () => ({ ok: true as const, exitCode: 1, stdout: '{}', stderr: '' })),
      now: () => 100,
    });
    await expect(reader.read({ machineId: 'machine-a', registry: registry(), candidates: [] })).resolves.toMatchObject([
      { contributionKey: key, status: 'installed_not_running' },
    ]);
  });

  it('does not execute installation or presence checks for an already listening contribution', async () => {
    const resolveSystemTool = vi.fn();
    const runSystemTool = vi.fn();
    const reader = createProviderLocalInstallationReader({ resolveSystemTool, runSystemTool, runtimeStore: await runtimeStore(), now: () => 100 });
    await expect(reader.read({
      machineId: 'machine-a', registry: registry(),
      candidates: [{ contributionKey: 'happier.provider.lmstudio/lmstudio' }],
    })).resolves.toEqual([]);
    expect(resolveSystemTool).not.toHaveBeenCalled();
    expect(runSystemTool).not.toHaveBeenCalled();
  });

  it('caches settled command evidence on its own cadence instead of the inventory tick', async () => {
    let now = 100;
    const resolveSystemTool = vi.fn(async () => ({ ok: true as const, command: '/usr/bin/lms', args: [], source: 'system' }));
    const runSystemTool = vi.fn(async () => ({ ok: true as const, exitCode: 1, stdout: '{}', stderr: '' }));
    const reader = createProviderLocalInstallationReader({ resolveSystemTool, runSystemTool, runtimeStore: await runtimeStore(), now: () => now, ttlMs: 1_000 });
    await reader.read({ machineId: 'machine-a', registry: registry(), candidates: [] });
    now = 500;
    await reader.read({ machineId: 'machine-a', registry: registry(), candidates: [] });
    expect(resolveSystemTool).toHaveBeenCalledTimes(1);
    now = 1_101;
    await reader.read({ machineId: 'machine-a', registry: registry(), candidates: [] });
    expect(resolveSystemTool).toHaveBeenCalledTimes(2);
  });

  it('uses the persisted installation cache across reader restart and invalidates descriptor changes', async () => {
    const store = await runtimeStore();
    const resolveSystemTool = vi.fn(async () => ({ ok: true as const, command: '/usr/bin/lms', args: [], source: 'system' }));
    const runSystemTool = vi.fn(async () => ({ ok: true as const, exitCode: 1, stdout: '{}', stderr: '' }));
    const createReader = () => createProviderLocalInstallationReader({
      resolveSystemTool, runSystemTool, runtimeStore: store, now: () => 100, ttlMs: 1_000,
    });
    await createReader().read({ machineId: 'machine-a', registry: registry(), candidates: [] });
    await createReader().read({ machineId: 'machine-a', registry: registry(), candidates: [] });
    expect(resolveSystemTool).toHaveBeenCalledTimes(1);

    const original = registry();
    const current = original.providersByContributionKey.get(key)!;
    const changedProviders = new Map(original.providersByContributionKey);
    changedProviders.set(key, {
      ...current,
      definition: ProviderContributionV1Schema.parse({
        ...current.definition,
        discovery: { ...current.definition.discovery, installedCheck: { lookupNames: ['lmstudio-cli'] } },
      }),
    });
    const changed: ProviderContributionRegistryView = { providersByContributionKey: changedProviders };
    await createReader().read({ machineId: 'machine-a', registry: changed, candidates: [] });
    expect(resolveSystemTool).toHaveBeenCalledTimes(2);
  });

  it('fails a stalled advisory installation lookup closed without blocking Provider reads', async () => {
    const reader = createProviderLocalInstallationReader({
      runtimeStore: await runtimeStore(),
      resolveSystemTool: vi.fn(() => new Promise<never>(() => {})),
      runSystemTool: vi.fn(),
      now: () => 100,
      installationResolutionTimeoutMs: 10,
    });

    const outcome = await Promise.race([
      reader.read({ machineId: 'machine-a', registry: registry(), candidates: [] })
        .then((rows) => ({ status: 'completed' as const, rows })),
      new Promise<{ status: 'timed_out' }>((resolve) => {
        setTimeout(() => resolve({ status: 'timed_out' }), 100);
      }),
    ]);

    expect(outcome).toEqual({ status: 'completed', rows: [] });
  });

  it('caches an early advisory installation resolver rejection as absence', async () => {
    const store = await runtimeStore();
    const resolveSystemTool = vi.fn(async () => {
      throw new Error('system tool resolver unavailable');
    });
    const reader = createProviderLocalInstallationReader({
      runtimeStore: store,
      resolveSystemTool,
      runSystemTool: vi.fn(),
      now: () => 100,
    });

    await expect(reader.read({ machineId: 'machine-a', registry: registry(), candidates: [] }))
      .resolves.toEqual([]);
    await expect(reader.read({ machineId: 'machine-a', registry: registry(), candidates: [] }))
      .resolves.toEqual([]);

    expect(resolveSystemTool).toHaveBeenCalledTimes(1);
    await expect(store.read()).resolves.toMatchObject({
      installationChecks: [{ state: { status: 'absent', observedAt: 100 } }],
    });
  });
});
