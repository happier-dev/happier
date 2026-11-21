import { afterEach, expect, it, vi } from 'vitest';
import { AutomationDefinitionDetailSchema, AutomationDefinitionListItemSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { AutomationSourceSelectorIdV1Schema } from '@happier-dev/protocol/automations/automationOccurrenceV1';
import { AutomationTriggerIdSchema } from '@happier-dev/protocol/automations/automationTriggerIdentity';
import { sealAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';
import { machinePageHref } from '@/components/machines/page/machinePageHref';
import { HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, HEALTH_CHECK_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/healthCheckV1';
import type { ManagedConfiguredCheckRow } from '@/components/store/inventory/managedOperationalInventory';
import { createAutomationDefinitionSummary } from '@/sync/domains/automations/automationDefinitionProjection';

import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import {
  createProviderSettingsAccountHarness,
  createProviderSettingsHarness,
  installProviderSettingsRpcBoundary,
} from '@/dev/testkit/harness/providerSettingsHarness';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

// The real sync owner under the canonical Account/RPC boundary (the saved Check's edit seed is read through it).
const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
await loadSyncSingletonForTests();
const { ItemList } = await import('@/components/ui/lists/ItemList');
const { Item } = await import('@/components/ui/lists/Item');
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


it('keeps Address editing on the Check page when the saved source needs recovery', async () => {
  const { router } = await import('expo-router');
  vi.mocked(router.push).mockClear();
  const id = 'service-address-check';
  const triggerId = '33333333-3333-4333-8333-333333333331';
  const scope = await account.restore({ httpAnswers: {
    ['GET /v3/automations/' + id]: { status: 404, body: { error: 'not_found' } },
  } });
  const native = createAutomationDefinitionSummary(AutomationDefinitionListItemSchema.parse({
    id, name: 'Storefront', description: null, enabled: true,
    targetType: null, existingSessionId: null, templateVersion: 1, lastRunAt: null,
    createdAt: 1, updatedAt: 1, assignments: [], observationOnly: { kind: 'observationOnly', templateVersion: 1 },
    triggers: [{ id: triggerId, kind: 'pluginEvent', revision: 1, enabled: true, createdAt: 1, updatedAt: 1,
      eventRef: HEALTH_CHECK_EVENT_REFS_V1.status, sourceSelectorId: '22222222-2222-4222-8222-222222222222',
      sourceContractVersion: 1, observation: { kind: 'checkpointedPull', watcher: null },
      sourceStatus: null, sourceCatalogStatus: null }],
  }));
  const row: ManagedConfiguredCheckRow = {
    kind: 'configuredCheck', key: id, scope, automationId: id, triggerId, native,
    definitionFacts: { kind: 'available', observerMachineId: null, checks: [{ checkId: 'readiness', name: 'HTTP',
      targetLabel: 'https://storefront.test/health', periodMs: 60_000, domainId: null, keyFlow: null }] },
    lastResults: { kind: 'available', checks: [] },
  };
  const screen = await renderScreen(<ServiceCheckDetail row={row} nowMs={NOW} />);
  try {
    await screen.pressByTestIdAsync('services.check.settings.address');
    expect(router.push).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      const rows = screen.findAllByType(Item).filter(item => item.props.title === 'Address');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.props.mode).toBe('info');
      expect(screen.getTextContent()).toContain('https://storefront.test/health');
      expect(screen.getTextContent()).toMatch(/couldn’t (?:be reached|read this check)/i);
      expect(screen.findByTestId('services.check.settings.recovery-action')).not.toBeNull();
    });
  } finally {
    await screen.unmount();
  }
});

it('keeps saved Check settings readable with the observing Machine offline and links to that Machine', async () => {
  const { router } = await import('expo-router');
  vi.mocked(router.push).mockClear();
  const id = 'service-observer-offline';
  const checkId = 'readiness';
  const triggerId = AutomationTriggerIdSchema.parse('33333333-3333-4333-8333-333333333332');
  const sourceSelectorId = AutomationSourceSelectorIdV1Schema.parse('22222222-2222-4222-8222-222222222222');
  const observer = createMachineFixture({ id: 'observer-5a9e', active: false, activeAt: Date.now() - 3_600_000, storageMode: 'plain' });
  const endpoint = 'http://127.0.0.1:59458/health';
  const eventRef = HEALTH_CHECK_EVENT_REFS_V1.status;
  const trigger = {
    id: triggerId, kind: 'pluginEvent', revision: 1, enabled: true, createdAt: 1, updatedAt: 1,
    eventRef, sourceSelectorId, sourceContractVersion: 1, sourceStatus: null, sourceCatalogStatus: null,
    observation: { kind: 'checkpointedPull', watcher: {
      machineId: observer.id, machineInstallationId: 'observer-installation',
      pluginId: eventRef.pluginId, materializationId: 'machine-services-observer',
    } },
  };
  const summary = AutomationDefinitionListItemSchema.parse({
    id, name: 'Storefront', description: null, enabled: true,
    targetType: null, existingSessionId: null, templateVersion: 1, lastRunAt: null,
    createdAt: 1, updatedAt: 1, assignments: [], observationOnly: { kind: 'observationOnly', templateVersion: 1 },
    triggers: [trigger],
  });
  const detail = AutomationDefinitionDetailSchema.parse({ ...summary, triggers: [{
    ...trigger,
    triggerDefinitionEnvelope: JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({
      mode: 'plain',
      binding: { v: 1, automationId: id, triggerId, triggerRevision: 1, triggerKind: 'pluginEvent', eventRef, sourceSelectorId },
      definition: { v: 1, sourceInstanceId: 'saved-http-source', displayLabel: 'Saved health checks', filter: null,
        maximumObservationAgeMs: null, sourceConfig: { v: 1,
          subject: { kind: 'machineService', machineId: observer.id, serviceId: 'systemd:qa-health' },
          checks: [{ checkId, kind: { pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, localId: 'http' },
            binding: { kind: 'healthCheck' }, config: { endpoint, expectStatus: 200 }, periodMs: 60_000,
            consecutiveFailuresBeforeAlerting: 1 }],
        },
      },
    })),
  }] });
  const scope = await account.restore({ machines: [observer], httpAnswers: {
    ['GET /v3/automations/' + id]: { body: detail },
  } });
  storage.getState().applyMachineActivityUpdates([{ id: observer.id, active: false, activeAt: Date.now() - 3_600_000 }],
    { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
  const row: ManagedConfiguredCheckRow = {
    kind: 'configuredCheck', key: id, scope, automationId: id, triggerId,
    native: createAutomationDefinitionSummary(summary),
    definitionFacts: { kind: 'available', observerMachineId: observer.id, checks: [{ checkId, name: 'HTTP',
      targetLabel: endpoint, periodMs: 60_000, domainId: null, keyFlow: null }] },
    lastResults: { kind: 'available', checks: [] },
  };
  const screen = await renderScreen(<ServiceCheckDetail row={row} nowMs={NOW} />);
  try {
    await vi.waitFor(() => expect(screen.findByTestId('services.check.settings.from')).not.toBeNull());
    // The check says its Machine is offline at a glance and offers no Check now it cannot run (PAGE-ACCEPT-176 R10-D4).
    await vi.waitFor(() => expect(screen.findByTestId('services.check.offline')).not.toBeNull());
    expect(screen.findByTestId('services.check.checkNow')?.props.disabled).toBe(true);
    await screen.pressByTestIdAsync('services.check.settings.from');
    await vi.waitFor(() => expect(screen.findByTestId('automation-event-watcher-picker')).not.toBeNull());
    expect(screen.getTextContent()).toMatch(/choose a machine/i);
    for (const field of ['expect', 'alert', 'address'] as const) {
      await screen.pressByTestIdAsync(`services.check.settings.${field}`);
      expect(router.push).not.toHaveBeenCalled();
      await vi.waitFor(() => {
        const row = screen.findAllByType(Item).find(item => item.props.testID === `services.check.settings.${field}`);
        expect(row?.props.mode).toBe('info');
        expect(screen.getTextContent()).toMatch(/is offline/i);
        expect(screen.findByTestId('services.check.settings.recovery-action')).not.toBeNull();
      });
    }
    expect(screen.findAllByType(Item).filter(item => item.props.title === 'Address')).toHaveLength(1);
    expect(screen.getTextContent()).toContain(endpoint);
    expect(screen.getTextContent()).not.toContain('automations.form.trigger.watcherMachineOffline');
    expect(screen.getTextContent()).not.toContain('happier.machine.services/health-status');
    await screen.pressByTestIdAsync('services.check.settings.recovery-action');
    expect(router.push).toHaveBeenCalledWith(machinePageHref({ door: 'rail', target: { machineId: observer.id, serverId: scope.serverId } }));

    // The account read still owns the saved settings when the Machine returns but cannot serve the editor.
    await act(async () => {
      storage.getState().applyMachineActivityUpdates([{ id: observer.id, active: true, activeAt: Date.now() }],
        { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
    });
    await vi.waitFor(() => {
      const recovery = screen.findByTestId('services.check.settings.recovery');
      expect(recovery).not.toBeNull();
      expect(screen.getTextContent()).toContain(endpoint);
      expect(screen.getTextContent()).toMatch(/editing this check.*unavailable.*saved value/i);
      expect(screen.getTextContent()).toContain('tester.local');
    });
  } finally {
    await screen.unmount();
  }
});
