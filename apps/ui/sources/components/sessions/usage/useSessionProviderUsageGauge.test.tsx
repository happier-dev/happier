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
        v: 1,
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
      () => useSessionProviderUsageGauge({ session, serverId }).gauge,
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

  it('does not show the current pool member when the Session binding names no member', async () => {
    const { useSessionProviderUsageGauge } = await import('./useSessionProviderUsage');
    const session = connectedCodexSession();
    const profile = storage.getState().profile;
    storage.getState().applyProfile({
      ...profile,
      connectedServicesV2: [{
        serviceId: 'openai-codex',
        profiles: [{
          profileId: 'work', status: 'connected', kind: null, providerEmail: null,
          providerAccountId: null, expiresAt: null, lastUsedAt: null, health: null,
        }],
        groups: [{
          groupId: 'pool', displayName: 'Pool', activeProfileId: 'work', generation: 1,
          memberProfileIds: ['work'],
        }],
      }],
    });
    const poolSession = {
      ...session,
      metadata: {
        ...session.metadata!,
        connectedServices: {
          v: 2 as const,
          bindingsByServiceId: {
            'happier.agent.codex/openai-codex': { source: 'connected' as const, selection: 'group' as const, groupId: 'pool' },
          },
        },
      },
    };
    const serverId = getActiveServerSnapshot().serverId;
    const hook = await renderHook(() => useSessionProviderUsageGauge({ session: poolSession, serverId }).gauge,
      { wrapper: Wrapper });
    await flushHookEffects({ cycles: 12, turns: 12 });
    expect(hook.getCurrent()).toBeNull();
    expect(boundary.plainRead).not.toHaveBeenCalled();
    await hook.unmount();
  });

  it('keeps the gauge unavailable when legacy metadata has only an unreadable model selection', async () => {
    const { useSessionProviderUsageGauge } =
      await import('./useSessionProviderUsage');
    const legacySession = {
      ...connectedCodexSession(),
      metadata: { host: 'host', homeDir: '/tmp', path: '/tmp', modelSelectionIntentV2: {} },
    };
    const serverId = getActiveServerSnapshot().serverId;
    const hook = await renderHook(
      () => useSessionProviderUsageGauge({ session: legacySession, serverId }).gauge,
      { wrapper: Wrapper },
    );
    await flushHookEffects({ cycles: 12, turns: 12 });

    expect(hook.getCurrent()).toBeNull();
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
      () => useSessionProviderUsageGauge({ session, serverId }).gauge,
      { wrapper: Wrapper },
    );
    await flushHookEffects({ cycles: 12, turns: 12 });

    expect(hook.getCurrent()).toBeNull();
    await hook.unmount();
  });

  it('resolves account declarations at the usage owner so a caller cannot select a different gauge source', async () => {
    const { useSessionProviderUsage, useSessionProviderUsageGauge } = await import('./useSessionProviderUsage');
    const session = connectedCodexSession();
    const serverId = getActiveServerSnapshot().serverId;
    // A stale caller's entry may differ from the inert Session catalog summary.
    const composerInput = { session, serverId, agentId: 'codex', activeModelId: null,
      connectedAccounts: [{ purpose: 'model_upstream', service: { pluginId: 'happier.agent.claude', localId: 'anthropic' } }] } as const;
    const hook = await renderHook(() => ({
      composer: useSessionProviderUsage(composerInput).gauge,
      companion: useSessionProviderUsageGauge({ session, serverId }).gauge,
    }), { wrapper: Wrapper });
    await flushHookEffects({ cycles: 12, turns: 12 });
    expect(hook.getCurrent().companion).toMatchObject({ serviceId: 'openai-codex', remainingPct: 60 });
    expect(hook.getCurrent().composer).toEqual(hook.getCurrent().companion);
    await hook.unmount();
  });
});
