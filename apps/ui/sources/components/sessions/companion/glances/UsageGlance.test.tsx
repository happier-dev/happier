import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The static storage graph reaches the Socket.IO transport; register its external boundary before any import.
vi.mock('socket.io-client', async (importOriginal) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(importOriginal),
);
import {
  act,
  flushHookEffects,
  renderHook,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import { useConnectedServiceQuotaSnapshots } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshots';
import {
  createLegacyQuotaAuthWrapper,
  createLegacyQuotaTestHarness,
  makeQuotaSnapshot,
  plainQuotaResponse,
  resetConnectedServiceQuotaSnapshotsTestState,
} from '@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshots.testkit';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import type { Session } from '@/sync/domains/state/storageTypes';

import { Item } from '@/components/ui/lists/Item';
import { UsageGlance } from './UsageGlance';

/** A Codex Session whose launch bound the connected `openai-codex/work` profile. */
function connectedCodexSession(bound = true): Session {
  const session = {
    id: 'usage-glance-session',
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
      ...(bound
        ? {
            connectedServices: {
              bindingsByServiceId: {
                'openai-codex': {
                  source: 'connected',
                  selection: 'profile',
                  profileId: 'work',
                },
              },
            },
          }
        : {}),
    },
    agentState: {},
  };
  // Test fixture: only the Session fields the usage owners read are populated.
  return session as unknown as Session;
}

describe('UsageGlance', () => {
  let boundary: Awaited<ReturnType<typeof createLegacyQuotaTestHarness>>;
  const Wrapper = createLegacyQuotaAuthWrapper(() => boundary);
  const fetchedAt = Date.now() - 5 * 60_000;

  beforeEach(async () => {
    await resetConnectedServiceQuotaSnapshotsTestState();
    boundary = await createLegacyQuotaTestHarness();
    boundary.plainRead.mockImplementation(async () =>
      plainQuotaResponse(
        makeQuotaSnapshot({
          serviceId: 'openai-codex',
          profileId: 'work',
          meterId: 'weekly',
          fetchedAt,
          staleAfterMs: 60 * 60_000,
        }),
      ),
    );
  });
  afterEach(async () => {
    standardCleanup();
    await boundary.dispose();
    vi.restoreAllMocks();
  });

  async function renderGlance(session: Session) {
    const serverId = getActiveServerSnapshot().serverId;
    const screen = await renderScreen(
      <Wrapper>
        <UsageGlance
          session={session}
          sessionId={session.id}
          serverId={serverId}
          frameStyle="plain"
          measurementOnly={false}
          testID="usage"
        />
      </Wrapper>,
    );
    await flushHookEffects({ cycles: 12, turns: 12 });
    return screen;
  }

  it('says the quota is unavailable when the first read fails, never as if no service were connected', async () => {
    // A refused read settles at once; a 5xx is retried by the transport before it settles as failed.
    boundary.plainRead.mockImplementation(
      async () => new Response('{}', { status: 400 }),
    );
    const screen = await renderGlance(connectedCodexSession());

    const quota = screen.findByTestId('usage.quota');
    expect(quota).not.toBeNull();
    expect(screen.getTextContent()).not.toContain('%');
    expect(screen.findByTestId('usage.asOf')).toBeNull();
    // It says the read failed (the composer ring's words too) in the row's caption and offers the owner's next
    // read, never a bare trailing "Unavailable" that reads as "no quota here" (acceptance follow-up #18).
    expect(screen.findByTestId('usage.quota.reason')).not.toBeNull();
    expect(screen.findAllByType(Item).find(row => row.props.testID === 'usage.quota')?.props.detail).toBeUndefined();
    const reads = boundary.plainRead.mock.calls.length + boundary.refreshRead.mock.calls.length;
    await screen.pressByTestIdAsync('usage.quota.retry');
    await flushHookEffects({ cycles: 12, turns: 12 });
    expect(boundary.plainRead.mock.calls.length + boundary.refreshRead.mock.calls.length).toBeGreaterThan(reads);
    await screen.unmount();
  });

  it('draws no quota row for a Session with no connected service', async () => {
    const screen = await renderGlance(connectedCodexSession(false));
    expect(screen.findByTestId('usage.quota')).toBeNull();
    await screen.unmount();
  });

  it('keeps the last good value with its as-of after a failed refresh', async () => {
    const session = connectedCodexSession();
    const screen = await renderGlance(session);
    expect(screen.getTextContent()).toContain('60%');
    expect(screen.findByTestId('usage.asOf')).toBeNull();

    boundary.refreshRead.mockImplementation(
      async () => new Response('{}', { status: 400 }),
    );
    const refresher = await renderHook(
      () =>
        useConnectedServiceQuotaSnapshots([
          { serviceId: 'openai-codex', profileId: 'work' },
        ]),
      { wrapper: Wrapper },
    );
    await flushHookEffects({ cycles: 8, turns: 8 });
    await act(async () => {
      await refresher.getCurrent().refresh();
    });
    await flushHookEffects({ cycles: 12, turns: 12 });

    expect(screen.getTextContent()).toContain('60%');
    // The refresh failure sits in the row's own caption beside its as-of, with Retry; no separate tile.
    expect(screen.findByTestId('usage.quota.reason')).not.toBeNull();
    expect(screen.findByTestId('usage.quota.retry')).not.toBeNull();
    expect(screen.findByTestId('usage.stale')).toBeNull();
    await refresher.unmount();
    await screen.unmount();
  });
});
