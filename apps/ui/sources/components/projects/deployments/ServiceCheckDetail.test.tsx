import { afterEach, expect, it } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
  createProviderSettingsAccountHarness,
  createProviderSettingsHarness,
  installProviderSettingsRpcBoundary,
} from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

// The real sync owner under the canonical Account/RPC boundary (the saved Check's edit seed is read through it).
const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
await loadSyncSingletonForTests();
const { ItemList } = await import('@/components/ui/lists/ItemList');
const { ServiceCheckDetail } = await import('./ServiceCheckDetail');

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
