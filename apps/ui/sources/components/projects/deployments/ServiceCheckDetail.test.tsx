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
