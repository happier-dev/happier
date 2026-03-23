import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderHook } from '@/dev/testkit';
import type { CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';

import { resetCapabilityInstallabilityCacheForTests, useCapabilityInstallability } from './useCapabilityInstallability';

const machineCapabilitiesInvokeSpy = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops', () => ({
  machineCapabilitiesInvoke: (...args: unknown[]) => machineCapabilitiesInvokeSpy(...args),
}));

async function renderInstallability(params: Readonly<{
  machineId: string;
  serverId: string;
  capabilityId: CapabilityId;
}>): Promise<{
  unmount: () => Promise<void>;
}> {
  return renderHook(
    () =>
      useCapabilityInstallability({
        machineId: params.machineId,
        serverId: params.serverId,
        capabilityId: params.capabilityId,
        timeoutMs: 500,
      }),
    {
      flushOptions: { cycles: 0 },
    },
  );
}

describe('useCapabilityInstallability', () => {
  beforeEach(async () => {
    machineCapabilitiesInvokeSpy.mockReset();
    machineCapabilitiesInvokeSpy.mockResolvedValue({
      supported: true,
      response: { ok: true },
    });

    resetCapabilityInstallabilityCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('caches installability results and avoids re-invoking within TTL', async () => {
    const first = await renderInstallability({ machineId: 'm1', serverId: 'server-a', capabilityId: 'cli.opencode' });
    await flushHookEffects();
    await first.unmount();

    expect(machineCapabilitiesInvokeSpy).toHaveBeenCalledTimes(1);

    const second = await renderInstallability({ machineId: 'm1', serverId: 'server-a', capabilityId: 'cli.opencode' });
    await flushHookEffects();
    await second.unmount();

    expect(machineCapabilitiesInvokeSpy).toHaveBeenCalledTimes(1);
  });

  it('does not share cached results across different capabilities', async () => {
    const first = await renderInstallability({ machineId: 'm1', serverId: 'server-a', capabilityId: 'cli.opencode' });
    await flushHookEffects();
    await first.unmount();

    const second = await renderInstallability({ machineId: 'm1', serverId: 'server-a', capabilityId: 'cli.codex' });
    await flushHookEffects();
    await second.unmount();

    expect(machineCapabilitiesInvokeSpy).toHaveBeenCalledTimes(2);
  });
});
