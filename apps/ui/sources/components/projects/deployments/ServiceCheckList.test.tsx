import { afterEach, expect, it } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
  createProviderSettingsAccountHarness,
  createProviderSettingsHarness,
  installProviderSettingsRpcBoundary,
} from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

// The real sync owner under the canonical Account/RPC boundary; the rows are the managed inventory's own shape.
const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
await loadSyncSingletonForTests();
const { ServiceCheckList } = await import('./ServiceCheckList');

afterEach(async () => {
  standardCleanup();
  await account.reset();
  rpc.reset();
});

const NOW = Date.UTC(2026, 10, 16, 10, 0, 0);
const result = (status: 'up' | 'down' | 'degraded', minutesAgo: number, latencyMs?: number) => ({
  status, observedAt: NOW - minutesAgo * 60_000, evidence: { kind: 'none' }, ...(latencyMs === undefined ? {} : { latencyMs }),
});
const row = (key: string, target: string, lastResults: unknown, enabled = true) => ({
  kind: 'configuredCheck', key, scope: { serverId: 'server-1', accountId: 'account-1' }, automationId: `a-${key}`, triggerId: `t-${key}`,
  native: { name: `${target} availability`, templateVersion: 1, enabled, triggers: [] },
  definitionFacts: { kind: 'available', observerMachineId: null, checks: [{ checkId: key, name: 'HTTP', targetLabel: target, periodMs: 60_000, domainId: null }] },
  lastResults,
}) as never;
const results = (status: 'up' | 'down' | 'degraded', latencyMs: number) => ({ kind: 'available', checks: [{ checkId: 'c', result: result(status, 1, latencyMs),
  recentResults: [result('up', 3, 120), result('up', 2, 130), result(status, 1, latencyMs)], recentResultsCoverage: 'complete',
  ...(status === 'up' ? {} : { failingSince: NOW - 60_000, failureStreak: 1 }),
  history: { lastObservedAt: NOW, uptimePercent: status === 'up' ? 99.98 : 93.1, days: [] } }] });
const SELECTION = { selectedKey: null, onSelect: () => {}, onSelectedRow: () => {} };

it('Monitoring lists what needs the person first, says healthy checks quietly, and draws each row’s bars', async () => {
  const rows = [
    row('ok', 'billing.acme.dev/health', results('up', 142)),
    row('down', 'n8n.acme.dev', results('down', 900)),
    row('paused', 'status.acme.dev', results('up', 88), false),
    row('new', 'api.acme.dev/health', { kind: 'neverObserved' }),
  ];
  const screen = await renderScreen(
    <ServiceCheckList testID="monitoring.checks" rows={rows} scope={{ serverId: 'server-1', accountId: 'account-1' } as never}
      selection={SELECTION} accessibilityLabel="Checks" grouping="attention" />,
  );
  const text = screen.getTextContent();
  expect(text.indexOf('Needs you')).toBeGreaterThanOrEqual(0);
  // The failing check stands in Needs you, before the Checks section and the healthy rows.
  expect(text.indexOf('n8n.acme.dev')).toBeLessThan(text.indexOf('billing.acme.dev/health'));
  expect(text.indexOf('n8n.acme.dev')).toBeGreaterThan(text.indexOf('Needs you'));
  expect(text).toContain('Down');
  expect(text).toContain('Paused');
  expect(text).toContain('Waiting for the first check');
  // Healthy stays quiet: no state word for a passing check, only its figures.
  expect(text).not.toContain('Passing');
  expect(text).toContain('99.98%');
  expect(screen.findHostByTestId('services.checks.row.a-ok.t-ok')).toBeTruthy();
});
