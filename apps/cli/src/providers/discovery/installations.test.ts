import { describe, expect, it, vi } from 'vitest';
import { ProviderContributionV1Schema } from '@happier-dev/protocol';

import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import type { ProviderContributionRegistryView } from '@/providers/registry';
import { createProviderLocalInstallationReader } from './installations';
import type { ProviderLocalToolResolver } from '@/providers/probe/localCommand';

const key = 'happier.provider.lmstudio/lmstudio';

function registry(options: Readonly<{ managedRuntime?: boolean }> = {}): ProviderContributionRegistryView {
  const definition = ProviderContributionV1Schema.parse({
    v: 1, id: 'lmstudio', name: 'LM Studio', kind: 'local',
    endpointTemplates: [{
      id: 'openai', protocol: 'openai-responses', localUrlCandidates: ['http://127.0.0.1:1234/v1'],
      capabilities: { streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'supported', reasoningControls: 'supported' },
    }],
    catalog: {
      source: 'probe', manualModelPolicy: 'allowed',
      probes: [{ endpointTemplateId: 'openai', path: '/v1/models', parser: 'openai-models' }],
      ...(options.managedRuntime ? { sourceRegistryVersion: 'installations-fixture:v1' } : {}),
    },
    ...(options.managedRuntime
      ? { managedRuntime: { kind: 'managed', endpointTemplateIds: ['openai'] } }
      : {}),
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
    const reader = createProviderLocalInstallationReader({ resolveSystemTool, runSystemTool });
    await expect(reader.read({ machineId: 'machine-a', registry: registry(), candidates: [] })).resolves.toEqual({ status: 'complete', installations: [{
      v: 1, machineId: 'machine-a', contributionKey: key, providerName: 'LM Studio', status: 'app_running_server_off', managedStartAvailable: false,
    }] });
  });

  it('reports installed-not-running when the binary exists without proven app presence', async () => {
    const reader = createProviderLocalInstallationReader({
      resolveSystemTool: vi.fn(async () => ({ ok: true as const, command: '/usr/bin/lms', args: [], source: 'system' })),
      runSystemTool: vi.fn(async () => ({ ok: true as const, exitCode: 1, stdout: '{}', stderr: '' })),
    });
    await expect(reader.read({ machineId: 'machine-a', registry: registry(), candidates: [] })).resolves.toMatchObject({ status: 'complete', installations: [
      { contributionKey: key, status: 'installed_not_running' },
    ] });
  });

  it('offers managed start only from the public managed Provider declaration', async () => {
    const reader = createProviderLocalInstallationReader({
      resolveSystemTool: vi.fn(async () => ({ ok: true as const, command: '/usr/bin/lms', args: [], source: 'system' })),
      runSystemTool: vi.fn(async () => ({ ok: true as const, exitCode: 1, stdout: '{}', stderr: '' })),
    });

    await expect(reader.read({
      machineId: 'machine-a',
      registry: registry({ managedRuntime: true }),
      candidates: [],
    })).resolves.toMatchObject({ status: 'complete', installations: [{
      contributionKey: key,
      managedStartAvailable: true,
    }] });
  });

  it('does not execute installation or presence checks for an already listening contribution', async () => {
    const resolveSystemTool = vi.fn();
    const runSystemTool = vi.fn();
    const reader = createProviderLocalInstallationReader({ resolveSystemTool, runSystemTool });
    await expect(reader.read({
      machineId: 'machine-a', registry: registry(),
      candidates: [{ contributionKey: 'happier.provider.lmstudio/lmstudio' }],
    })).resolves.toEqual({ status: 'complete', installations: [] });
    expect(resolveSystemTool).not.toHaveBeenCalled();
    expect(runSystemTool).not.toHaveBeenCalled();
  });

  it('refreshes installation evidence on each new inventory without an advisory TTL', async () => {
    const resolveSystemTool = vi.fn(async () => ({ ok: true as const, command: '/usr/bin/lms', args: [], source: 'system' }));
    const runSystemTool = vi.fn(async () => ({ ok: true as const, exitCode: 1, stdout: '{}', stderr: '' }));
    const reader = createProviderLocalInstallationReader({ resolveSystemTool, runSystemTool });
    await reader.read({ machineId: 'machine-a', registry: registry(), candidates: [] });
    await reader.read({ machineId: 'machine-a', registry: registry(), candidates: [] });
    expect(resolveSystemTool).toHaveBeenCalledTimes(2);
    await reader.read({ machineId: 'machine-a', registry: registry(), candidates: [] });
    expect(resolveSystemTool).toHaveBeenCalledTimes(3);
  });

  it('reads the OS again across reader restart and uses current declared lookup names', async () => {
    const resolveSystemTool = vi.fn(async () => ({ ok: true as const, command: '/usr/bin/lms', args: [], source: 'system' }));
    const runSystemTool = vi.fn(async () => ({ ok: true as const, exitCode: 1, stdout: '{}', stderr: '' }));
    const createReader = () => createProviderLocalInstallationReader({
      resolveSystemTool, runSystemTool,
    });
    await createReader().read({ machineId: 'machine-a', registry: registry(), candidates: [] });
    await createReader().read({ machineId: 'machine-a', registry: registry(), candidates: [] });
    expect(resolveSystemTool).toHaveBeenCalledTimes(2);

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
    expect(resolveSystemTool).toHaveBeenCalledTimes(3);
    expect(resolveSystemTool).toHaveBeenLastCalledWith(expect.objectContaining({ lookupNames: ['lmstudio-cli'] }));
  });

  it('accepts a settled installation after the former two-second advisory cutoff', async () => {
    let started!: () => void;
    let settle!: (value: { ok: true; command: string; args: string[]; source: string }) => void;
    const lookupStarted = new Promise<void>(resolve => { started = resolve; });
    const reader = createProviderLocalInstallationReader({
      resolveSystemTool: () => new Promise(resolve => { settle = resolve; started(); }),
      runSystemTool: async () => ({ ok: true, exitCode: 1, stdout: '{}', stderr: '' }),
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const outcome = reader.read({ machineId: 'machine-a', registry: registry(), candidates: [] });
      await lookupStarted;
      await vi.advanceTimersByTimeAsync(2500);
      settle({ ok: true, command: '/usr/bin/lms', args: [], source: 'system' });
      await expect(outcome).resolves.toMatchObject({ status: 'complete', installations: [{ status: 'installed_not_running' }] });
    } finally { vi.useRealTimers(); }
  });

  it('returns typed incomplete on containing cancellation without publishing absence', async () => {
    let notifyLookupStarted!: () => void;
    const lookupStarted = new Promise<void>((resolve) => { notifyLookupStarted = resolve; });
    const reader = createProviderLocalInstallationReader({
      resolveSystemTool: vi.fn(() => {
        notifyLookupStarted();
        return new Promise<never>(() => {});
      }),
      runSystemTool: vi.fn(),
    });

    const controller = new AbortController();
    const outcome = reader.read({ machineId: 'machine-a', registry: registry(), candidates: [], signal: controller.signal });
    await lookupStarted;
    controller.abort();
    await expect(outcome).resolves.toEqual({ status: 'incomplete', installations: [] });
  });

  it('keeps a cancelled waiter lookup in flight and lets another operation observe late success', async () => {
    let settle!: (value: { ok: true; command: string; args: readonly string[]; source: string }) => void;
    let notifyLookupStarted!: () => void;
    const lookupStarted = new Promise<void>(resolve => { notifyLookupStarted = resolve; });
    const resolveSystemTool = vi.fn<ProviderLocalToolResolver['resolveSystemTool']>()
      .mockImplementationOnce(() => new Promise<{
        ok: true; command: string; args: readonly string[]; source: string;
      }>((resolve) => { settle = resolve; notifyLookupStarted(); }))
      .mockResolvedValue({ ok: true, command: '/usr/bin/lms', args: [], source: 'system' });
    const reader = createProviderLocalInstallationReader({
      resolveSystemTool,
      runSystemTool: vi.fn(async () => ({ ok: true as const, exitCode: 1, stdout: '{}', stderr: '' })),
    });

    const controller = new AbortController();
    const cancelled = reader.read({ machineId: 'machine-a', registry: registry(), candidates: [], signal: controller.signal });
    await lookupStarted;
    controller.abort();
    await expect(cancelled).resolves.toEqual({ status: 'incomplete', installations: [] });
    expect(resolveSystemTool).toHaveBeenCalledTimes(1);

    const next = reader.read({ machineId: 'machine-a', registry: registry(), candidates: [] });
    // The uncancellable lookup is still consuming a real system operation, so
    // its custody must not be released merely because one waiter cancelled.
    expect(resolveSystemTool).toHaveBeenCalledTimes(1);

    settle({ ok: true, command: '/usr/bin/lms', args: [], source: 'system' });
    await expect(next).resolves.toMatchObject({ status: 'complete', installations: [{ contributionKey: key, status: 'installed_not_running' }] });
    await expect(reader.read({ machineId: 'machine-a', registry: registry(), candidates: [] }))
      .resolves.toMatchObject({ status: 'complete', installations: [{ contributionKey: key, status: 'installed_not_running' }] });

    await reader.read({ machineId: 'machine-a', registry: registry(), candidates: [] });
    expect(resolveSystemTool).toHaveBeenCalledTimes(3);
  });

  it('reports a rejected OS lookup as incomplete and retries on the next inventory', async () => {
    const resolveSystemTool = vi.fn<ProviderLocalToolResolver['resolveSystemTool']>()
      .mockRejectedValueOnce(new Error('system tool resolver unavailable'))
      .mockResolvedValue({ ok: true, command: '/usr/bin/lms', args: [], source: 'system' });
    const reader = createProviderLocalInstallationReader({
      resolveSystemTool,
      runSystemTool: vi.fn(async () => ({ ok: true as const, exitCode: 1, stdout: '{}', stderr: '' })),
    });

    await expect(reader.read({ machineId: 'machine-a', registry: registry(), candidates: [] }))
      .resolves.toEqual({ status: 'incomplete', installations: [] });
    await expect(reader.read({ machineId: 'machine-a', registry: registry(), candidates: [] }))
      .resolves.toMatchObject({ status: 'complete', installations: [{ contributionKey: key, status: 'installed_not_running' }] });

    expect(resolveSystemTool).toHaveBeenCalledTimes(2);
  });
});
