import { afterEach, expect, it } from 'vitest';

import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import {
  createProviderSettingsAccountHarness,
  createProviderSettingsHarness,
  installProviderSettingsRpcBoundary,
} from '@/dev/testkit/harness/providerSettingsHarness';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

// The real sync owner under the canonical Account/RPC boundary (the saved Check's edit seed is read through it).
const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
await loadSyncSingletonForTests();
const { ItemList } = await import('@/components/ui/lists/ItemList');
const { ServiceCheckDetail } = await import('./ServiceCheckDetail');
const { storage } = await import('@/sync/domains/state/storageStore');

afterEach(async () => {
  standardCleanup();
  await account.reset();
  rpc.reset();
});

const NOW = Date.UTC(2026, 10, 15, 10, 0, 0);

// LIVE-FID-1115: opening a Check whose recent results hold a failure crashed the app ("Happier UI theme is
// unavailable") because a result's state word used the plugin-ui Status outside any plugin-ui scope.
it('opens a Check with a recent failing result and says that result in words', async () => {
  const row = {
    kind: 'configuredCheck',
    key: 'check-1',
    scope: { serverId: 'server-1', accountId: 'account-1' },
    automationId: 'automation-1',
    triggerId: 'trigger-1',
    native: {
      name: 'acme-api availability',
      templateVersion: 1,
      enabled: true,
      triggers: [],
    },
    definitionFacts: { kind: 'loading' },
    lastResults: {
      kind: 'available',
      checks: [
        {
          checkId: 'c1',
          result: {
            status: 'down',
            observedAt: NOW - 60_000,
            latencyMs: 4,
            evidence: { kind: 'none' },
          },
        },
      ],
    },
  } as never;

  const screen = await renderScreen(
    <ServiceCheckDetail row={row} nowMs={NOW} />,
  );

  const result = screen.findHostByTestId(
    `services.check.result.${NOW - 60_000}`,
  );
  expect(result).toBeTruthy();
  expect(screen.getTextContent()).toContain('Down');
});

it('describes the last passing result as stale until its observer returns', async () => {
  const observer = createMachineFixture({ id: 'observer-1', active: false, activeAt: Date.now() - 3_600_000, storageMode: 'plain' });
  const scope = await account.restore({ machines: [observer] });
  const setPresence = (active: boolean) => storage.getState().applyMachineActivityUpdates([
    { id: observer.id, active, activeAt: Date.now() - (active ? 0 : 3_600_000) },
  ], { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
  setPresence(false);
  const row = {
    kind: 'configuredCheck',
    key: 'check-offline',
    scope,
    automationId: 'automation-1',
    triggerId: 'trigger-1',
    native: { name: 'Availability', templateVersion: 1, enabled: true, triggers: [] },
    definitionFacts: { kind: 'available', observerMachineId: observer.id,
      checks: [{ checkId: 'c1', name: 'HTTP', targetLabel: 'app', periodMs: 60_000, domainId: null }] },
    lastResults: { kind: 'available', checks: [{ checkId: 'c1',
      result: { status: 'up', observedAt: NOW - 86_400_000, evidence: { kind: 'none' } } }] },
  } as never;
  const screen = await renderScreen(<ServiceCheckDetail row={row} nowMs={NOW} />);
  expect(screen.getTextContent()).toMatch(/Not checked since.*Nov/);
  await act(async () => { setPresence(true); });
  expect(screen.getTextContent()).not.toContain('Not checked since');
  expect(screen.getTextContent()).toMatch(/Passing.*checked/i);
});

// MONITOR-ACCEPT-1116: the 30-day strip's left edge is its oldest day; a check younger than the window says when its
// checks began instead of labelling the oldest slot with the first observed day.
it('labels the 30-day strip from its oldest day and says when a young check began', async () => {
  const DAY = 86_400_000;
  const today = Math.floor(NOW / DAY) * DAY;
  const day = (ago: number) => ({ dayStartAt: today - ago * DAY, up: 10, down: 0, degraded: 0, unknown: 0, uptimePercent: 100 });
  const row = {
    kind: 'configuredCheck',
    key: 'check-2',
    scope: { serverId: 'server-1', accountId: 'account-1' },
    automationId: 'automation-2',
    triggerId: 'trigger-2',
    native: { name: 'acme-api availability', templateVersion: 1, enabled: true, triggers: [] },
    definitionFacts: { kind: 'loading' },
    lastResults: {
      kind: 'available',
      checks: [
        {
          checkId: 'c1',
          result: { status: 'up', observedAt: NOW - 60_000, latencyMs: 4, evidence: { kind: 'none' } },
          history: { lastObservedAt: NOW - 60_000, uptimePercent: 100, days: [day(3), day(2), day(1), day(0)] },
        },
      ],
    },
  } as never;

  // Inside the list its hosts (the details pane and the Check page) draw it in, so section actions stand.
  const screen = await renderScreen(<ItemList><ServiceCheckDetail row={row} nowMs={NOW} /></ItemList>);

  const text = screen.getTextContent();
  // Nov 15 minus 29 days is Oct 17: the oldest slot; the first checked day is Nov 12.
  expect(text).toContain('Oct 17');
  expect(text).toContain('no checks before Nov 12');
});
