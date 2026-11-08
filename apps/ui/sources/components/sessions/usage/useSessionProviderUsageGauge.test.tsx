import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The static storage graph reaches the Socket.IO transport; register its external boundary before any import.
vi.mock('socket.io-client', async (importOriginal) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(importOriginal),
);
import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import type { Session } from '@/sync/domains/state/storageTypes';
import {
  createLegacyQuotaAuthWrapper,
  createLegacyQuotaTestHarness,
  makeQuotaSnapshot,
  plainQuotaResponse,
  resetConnectedServiceQuotaSnapshotsTestState,
} from '@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshots.testkit';

/** A legacy-layout Codex Session whose launch bound the connected `openai-codex/work` profile. */
function connectedCodexSession(): Session {
  const session = {
    id: 'usage-gauge-session',
    seq: 1,
    encryptionMode: 'plain',
    presence: 'online',
    active: true,
    metadata: {
      machineId: 'machine-1',
      host: 'host',
      flavor: 'codex',
      version: '0.0.0',
      path: '/tmp',
      homeDir: '/tmp',
      connectedServices: {
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'profile',
            profileId: 'work',
          },
        },
      },
    },
    agentState: {},
  };
  // Test fixture: only the Session fields the usage owner reads are populated.
  return session as unknown as Session;
}

describe('useSessionProviderUsageGauge', () => {
  let boundary: Awaited<ReturnType<typeof createLegacyQuotaTestHarness>>;
  const Wrapper = createLegacyQuotaAuthWrapper(() => boundary);

  beforeEach(async () => {
    await resetConnectedServiceQuotaSnapshotsTestState();
    boundary = await createLegacyQuotaTestHarness();
    boundary.plainRead.mockImplementation(async () =>
      plainQuotaResponse(
        makeQuotaSnapshot({
          serviceId: 'openai-codex',
          profileId: 'work',
          meterId: 'weekly',
        }),
      ),
    );
  });
  afterEach(async () => {
    standardCleanup();
    await boundary.dispose();
    vi.restoreAllMocks();
  });

  it('returns the connected-service quota gauge the Session composer presents', async () => {
    const { useSessionProviderUsageGauge } =
      await import('./useSessionProviderUsage');
    const session = connectedCodexSession();
    const serverId = getActiveServerSnapshot().serverId;
    const hook = await renderHook(
      () => useSessionProviderUsageGauge({ session, serverId }),
      { wrapper: Wrapper },
    );
    await flushHookEffects({ cycles: 12, turns: 12 });

    expect(hook.getCurrent()).toEqual(
      expect.objectContaining({
        serviceId: 'openai-codex',
        remainingPct: 60,
      }),
    );
    await hook.unmount();
  });

  it('returns no gauge when the person hides the Session provider usage gauge', async () => {
    storage
      .getState()
      .applySettingsLocal({ sessionProviderUsageGaugeMode: 'hidden' });
    const { useSessionProviderUsageGauge } =
      await import('./useSessionProviderUsage');
    const session = connectedCodexSession();
    const serverId = getActiveServerSnapshot().serverId;
    const hook = await renderHook(
      () => useSessionProviderUsageGauge({ session, serverId }),
      { wrapper: Wrapper },
    );
    await flushHookEffects({ cycles: 12, turns: 12 });

    expect(hook.getCurrent()).toBeNull();
    await hook.unmount();
  });
});
