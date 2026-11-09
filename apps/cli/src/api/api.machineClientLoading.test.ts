import { describe, expect, it, vi } from 'vitest';

const loads = vi.hoisted(() => ({ count: 0 }));

// The Machine client is daemon-only and pulls the RPC handler tree; runner
// processes import ApiClient, so it must not arrive with this module.
vi.mock('./apiMachine', () => {
  loads.count += 1;
  return {
    ApiMachineClient: class {
      constructor(readonly token: string, readonly machine: unknown) {}
    },
  };
});

describe('ApiClient machine client loading', () => {
  it('loads the daemon Machine client only when a Machine client is created', async () => {
    const { ApiClient } = await import('./api');
    expect(loads.count).toBe(0);

    const api = await ApiClient.create({ token: 'token', encryption: null });
    const machine = { id: 'machine-1', encryptionMode: 'plain', metadata: null,
      metadataVersion: 0, daemonState: null, daemonStateVersion: 0 } as never;

    const client = await api.machineSyncClient(machine);
    expect(loads.count).toBe(1);
    expect((client as unknown as { machine: unknown }).machine).toBe(machine);

    await api.machineSyncClient(machine);
    expect(loads.count).toBe(1);
  }, 180_000);
});
