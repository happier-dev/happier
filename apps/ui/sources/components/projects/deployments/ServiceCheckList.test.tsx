import { afterEach, expect, it } from 'vitest';

import { Text } from 'react-native';

import { act } from 'react-test-renderer';

import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
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
const { ServiceCheckList, useServiceCheckSelection } = await import('./ServiceCheckList');

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

// MONITOR-ACCEPT-1116: a Check opened beside the page is named by what it checks, as its row is ("n8n.acme.dev"),
// never by the saved automation's name ("n8n.acme.dev availability", live: "Event observation").
it('names an opened Check by what it checks, as its row does', async () => {
  const rows = [row('down', 'n8n.acme.dev', results('down', 900))];
  function Harness() {
    const { selection, details } = useServiceCheckSelection(true);
    return (
      <>
        <ServiceCheckList testID="monitoring.checks" rows={rows} scope={{ serverId: 'server-1', accountId: 'account-1' } as never}
          selection={selection} accessibilityLabel="Checks" />
        {details ? <Text testID="pane.title">{details.header.title}</Text> : null}
        {details ? <Text testID="pane.subtitle">{String(details.header.subtitle ?? '')}</Text> : null}
        {details ? details.content : null}
      </>
    );
  }
  const screen = await renderScreen(<Harness />);
  await screen.pressByTestIdAsync('services.checks.row.a-down.t-down');
  const title = screen.findHostByTestId('pane.title');
  expect(title).toBeTruthy();
  expect(screen.getTextContent()).not.toContain('n8n.acme.dev availability');
  // What it is stands under the name in the pane's band (lab A3), never again as the body's first line (R2-D2).
  expect(screen.findHostByTestId('pane.subtitle')?.props.children).toContain('HTTP');
  expect(screen.findByTestId('services.check.meta')).toBeNull();
});

// MONITOR-ACCEPT-1116 F1 (live: "eadc runs this check and is offline" while eadc reported every minute and the Machines
// list called it online). A Machine's heartbeat moves its activity, not its record: the row must follow the presence
// owner's pushed answer, not a reading frozen when the record last changed.
it('says the observing Machine stopped checking only while its presence owner says offline, and follows its heartbeat', async () => {
  const observer = createMachineFixture({ id: 'observer-1', active: false, activeAt: Date.now() - 3_600_000, storageMode: 'plain' });
  const scope = await account.restore({ machines: [observer] });
  storage.getState().applyMachineActivityUpdates([{ id: observer.id, active: false, activeAt: Date.now() - 3_600_000 }],
    { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
  const watched = { ...(row('down', 'n8n.acme.dev', results('down', 900)) as object), scope,
    definitionFacts: { kind: 'available', observerMachineId: observer.id,
      checks: [{ checkId: 'down', name: 'HTTP', targetLabel: 'n8n.acme.dev', periodMs: 60_000, domainId: null }] } } as never;
  const screen = await renderScreen(
    <ServiceCheckList testID="monitoring.checks" rows={[watched]} scope={scope as never} selection={SELECTION} accessibilityLabel="Checks" />,
  );
  expect(screen.getTextContent()).toContain('is offline');
  await act(async () => {
    storage.getState().applyMachineActivityUpdates([{ id: observer.id, active: true, activeAt: Date.now() }],
      { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
  });
  expect(screen.getTextContent()).not.toContain('is offline');
  expect(screen.getTextContent()).toContain('Down');
});

// MONITOR-ACCEPT-1116 F9: Services → Checks (no sections) leads with what fails, as lab A1 does.
it('lists a failing check before healthy ones without sections', async () => {
  const rows = [row('ok', 'billing.acme.dev/health', results('up', 142)), row('down', 'n8n.acme.dev', results('down', 900))];
  const screen = await renderScreen(
    <ServiceCheckList testID="services.checks" rows={rows} scope={{ serverId: 'server-1', accountId: 'account-1' } as never}
      selection={SELECTION} accessibilityLabel="Checks" />,
  );
  const text = screen.getTextContent();
  expect(text).not.toContain('Needs you');
  expect(text.indexOf('n8n.acme.dev')).toBeLessThan(text.indexOf('billing.acme.dev/health'));
});

// MONITOR-ACCEPT-1116 F6: until results and the definition arrive, a row never says the saved automation's name it
// would then flip from, and no section is decided yet.
it('reserves titles and sections while results and definitions arrive', async () => {
  const pending = { ...(row('down', 'n8n.acme.dev', { kind: 'loading' }) as object), definitionFacts: { kind: 'loading' } } as never;
  const loaded = row('ok', 'billing.acme.dev/health', { kind: 'loading' });
  const screen = await renderScreen(
    <ServiceCheckList testID="monitoring.checks" rows={[pending, loaded]} scope={{ serverId: 'server-1', accountId: 'account-1' } as never}
      selection={SELECTION} accessibilityLabel="Checks" grouping="attention" />,
  );
  const text = screen.getTextContent();
  expect(text).not.toContain('n8n.acme.dev availability');
  expect(text).not.toContain('Needs you');
});

// DBW-UI-INSIGHTS-4 review §3 #1/#2 (D33): a Key flow row is named by its flow; a breached limit reads Failing and says
// its measurement on line 2, never as an unreachable target's Down or a slow answer.
it('names a failing Key flow by its flow and says its measurement, as Failing rather than Down', async () => {
  const keyFlow = { name: 'Checkout', environmentId: 'env-prod', serviceName: 'billing-api', windowMs: 600_000,
    measure: { kind: 'route', routes: [{ method: 'POST', route: '/checkout' }], statistic: 'p95' }, threshold: { operator: 'above', value: 800 } };
  const measured = (minutesAgo: number, value: number) => ({ ...result(value > 800 ? 'degraded' : 'up', minutesAgo, value),
    measurements: { measure: 'p95', unit: 'ms', basis: 'metric_points', producers: [], completeness: 'complete', reasons: [], value,
      window: { since: NOW - (minutesAgo + 10) * 60_000, until: NOW - minutesAgo * 60_000 } } });
  const flow = { ...(row('flow', 'POST /checkout', { kind: 'available', checks: [{ checkId: 'flow', result: measured(1, 1420),
    recentResults: [measured(3, 240), measured(2, 1380), measured(1, 1420)], recentResultsCoverage: 'complete',
    failingSince: NOW - 2 * 60_000, failureStreak: 2, history: { lastObservedAt: NOW, uptimePercent: 99.4, days: [] } }] }) as object),
  definitionFacts: { kind: 'available', observerMachineId: null, checks: [{ checkId: 'flow', name: 'Key flow', targetLabel: 'POST /checkout',
    periodMs: 60_000, domainId: null, keyFlow }] } } as never;
  const screen = await renderScreen(
    <ServiceCheckList testID="monitoring.checks" rows={[flow]} scope={{ serverId: 'server-1', accountId: 'account-1' } as never}
      selection={SELECTION} accessibilityLabel="Checks" />,
  );
  const text = screen.getTextContent();
  expect(text).toContain('Checkout');
  expect(text).toContain('Failing');
  expect(text).not.toContain('Down');
  expect(text).toMatch(/p95 1\.42/);
  expect(text).not.toContain('usually');
});
