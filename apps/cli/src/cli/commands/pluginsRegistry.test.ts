import { describe, expect, it, vi } from 'vitest';

import { handlePluginsRegistryCommand } from './pluginsRegistry';

function harness() {
  let snapshot = { protocolVersion: 1 as const, revision: 0, profiles: [] as unknown[], pausedSources: [] as unknown[] };
  const mutate = vi.fn(async (request: { action: string; profileId: string; profile?: Record<string, unknown> }) => {
    if (request.action === 'add') snapshot = { ...snapshot, revision: 1, profiles: [{ profileId: request.profileId, ...request.profile }] };
    else snapshot = { ...snapshot, revision: snapshot.revision + 1 };
    return { status: 'success' as const, snapshot };
  });
  const output: unknown[] = [];
  return {
    output,
    mutate,
    deps: {
      service: { snapshot: async () => snapshot as never, mutate: mutate as never },
      machineId: 'machine-a',
      allocateProfileId: () => 'registry_acme',
      promptSecret: vi.fn(async () => 'boundary-secret'),
      write: (value: unknown) => { output.push(value); },
    },
  };
}

describe('plugins registry CLI', () => {
  it('adds and lists a private registry through the daemon-owned service API', async () => {
    const h = harness();
    await handlePluginsRegistryCommand([
      'add', 'https://registry.acme.test', '--name', 'Acme', '--scope', '@acme', '--allow-private-network', '--json',
    ], h.deps);
    expect(h.mutate).toHaveBeenCalledWith(expect.objectContaining({
      action: 'add', profileId: 'registry_acme',
      profile: expect.objectContaining({ origin: 'https://registry.acme.test', scopes: ['@acme'], allowPrivateNetwork: true }),
    }));
    await handlePluginsRegistryCommand(['list', '--json'], h.deps);
    expect(JSON.stringify(h.output)).not.toContain('credentialSecretRef');
  });

  it('reads login credentials only from the hidden prompt and never writes them', async () => {
    const h = harness();
    await handlePluginsRegistryCommand(['login', 'registry_acme', '--json'], h.deps);
    expect(h.deps.promptSecret).toHaveBeenCalledTimes(1);
    expect(h.mutate).toHaveBeenCalledWith(expect.objectContaining({
      action: 'login', credential: { kind: 'bearer_token', secret: 'boundary-secret' },
    }));
    expect(JSON.stringify(h.output)).not.toContain('boundary-secret');
  });

  it('rejects credential flags so secrets cannot enter shell history', async () => {
    const h = harness();
    await expect(handlePluginsRegistryCommand(['login', 'registry_acme', '--token', 'leaked'], h.deps))
      .rejects.toThrow(/hidden prompt/i);
    expect(h.deps.promptSecret).not.toHaveBeenCalled();
    expect(h.mutate).not.toHaveBeenCalled();
  });
});
