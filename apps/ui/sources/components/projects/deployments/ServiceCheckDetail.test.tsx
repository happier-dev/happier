import { afterEach, expect, it, vi } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest/ingest';
import { PluginProjectedActionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { createHealthCheckSourceInstanceIdV1 } from '@happier-dev/plugin-sdk';
import { plugin as healthPlugin } from '../../../../../../packages/plugins/machine-services/src/manifest';
import { HEALTH_KINDS_ACTION_ID } from '../../../../../../packages/plugins/machine-services/src/healthCatalog';
import { publishCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY } from '@/sync/domains/plugins/ui/projectionUnion';
import * as machineTransport from '@/sync/ops/machineContributionRegistryProjection';
import { AutomationDefinitionDetailSchema, AutomationDefinitionListItemSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { AutomationSourceSelectorIdV1Schema } from '@happier-dev/protocol/automations/automationOccurrenceV1';
import { AutomationTriggerIdSchema } from '@happier-dev/protocol/automations/automationTriggerIdentity';
import { sealAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';
import { machinePageHref } from '@/components/machines/page/machinePageHref';
import { HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, HEALTH_CHECK_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/healthCheckV1';
import type { HealthCheckSourceConfigV1 } from '@happier-dev/plugin-sdk';
import { HealthCheckResultV1Schema } from '@happier-dev/protocol/deployments/healthCheckV1';
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
const { ServiceCheckList } = await import('./ServiceCheckList');
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

it.each([
  { kind: 'uptime-kuma', title: 'Uptime Kuma', config: { monitorId: '7' } },
  { kind: 'gatus', title: 'Gatus', config: { endpointGroup: '', endpointName: 'Shop' } },
] as const)('explains why a saved $title check has no result before its first delivery', async ({ kind, title, config }) => {
  const source: HealthCheckSourceConfigV1 = {
    v: 1, subject: { kind: 'machineService', machineId: 'observer', serviceId: 'shop' },
    checks: [{ checkId: 'shop', kind: { pluginId: healthPlugin.manifest.id, localId: kind },
      binding: { kind: 'healthCheck' }, config: { ...config, webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA', observingSince: NOW - 60_000 }, periodMs: 60_000, consecutiveFailuresBeforeAlerting: 2 }],
  };
  const get = vi.fn(async () => null);
  const kit = await createPluginTestkit({ manifest: healthPlugin.manifest, module: healthPlugin, services: {
    healthChecks: { readSource: async () => source }, storage: { account: { kv: { get } as never } },
  } });
  try {
    const result = HealthCheckResultV1Schema.parse(await kit.invokeAction(`health/${kind}`, {
      sourceInstanceId: 'health:shop', checkId: 'shop',
    }, { chosenMachine: { machineId: 'observer', installationId: 'installation' } }));
    const row = {
      kind: 'configuredCheck', key: 'check-monitor', scope: { serverId: 'server-1', accountId: 'account-1' },
      automationId: 'automation-1', triggerId: 'trigger-1',
      native: { name: 'Availability', templateVersion: 1, enabled: true, triggers: [] },
      definitionFacts: { kind: 'available', observerMachineId: 'observer',
        checks: [{ checkId: 'shop', name: title, targetLabel: null, periodMs: 60_000, domainId: null }] },
      lastResults: { kind: 'available', checks: [{ checkId: 'shop', result }] },
    } as ManagedConfiguredCheckRow;
    const screen = await renderScreen(<ServiceCheckDetail row={row} nowMs={NOW} />);
    expect(screen.getTextContent()).toContain(`Waiting for ${title}`);
    expect(result.cause?.reason).toBe('monitor_observation_missing');
    expect(screen.findByTestId(`services.check.result.${result.observedAt}`)).not.toBeNull();
    const list = await renderScreen(<ServiceCheckList testID="checks" rows={[row]} scope={row.scope}
      selection={{ selectedKey: null, onSelect: () => {}, onSelectedRow: () => {} }} accessibilityLabel="Checks" />);
    expect(list.getTextContent()).toContain(`Waiting for ${title}`);
    expect(get).toHaveBeenCalledTimes(1);
  } finally { await kit.dispose(); }
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

async function restoreSavedHttpCheck() {
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
  return { row, scope, observer, endpoint, checkId };
}

it('keeps saved Check settings readable with the observing Machine offline and links to that Machine', async () => {
  const { router } = await import('expo-router');
  vi.mocked(router.push).mockClear();
  const { row, scope, observer, endpoint } = await restoreSavedHttpCheck();
  const screen = await renderScreen(<ServiceCheckDetail row={row} nowMs={NOW} />);
  try {
    await vi.waitFor(() => expect(screen.findByTestId('services.check.settings.from')).not.toBeNull());
    // Presence still describes the last observed state and points to the Machine.
    await vi.waitFor(() => expect(screen.findByTestId('services.check.offline')).not.toBeNull());
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

it('settles one exact saved HTTP Action and displays the newer result from its ready observer', async () => {
  const { row, scope, observer, checkId } = await restoreSavedHttpCheck();
  const parsed = ingestPluginManifestV2(healthPlugin.manifest);
  if (!parsed.ok) throw new Error('Expected the bundled Machine Services declaration');
  const manifest = parsed.manifest;
  const catalog = manifest.contributes.healthCheckKinds.map(kind => ({ ...kind, pluginId: manifest.id }));
  const http = catalog.find(kind => kind.id === 'http');
  if (!http) throw new Error('Expected the bundled HTTP Check');
  const actions = manifest.contributes.actions.filter(action => action.id === HEALTH_KINDS_ACTION_ID || action.id === http.action);
  expect(actions).toHaveLength(2);
  const occurrenceId = 'ready-health-observer-occurrence';
  const unpublish = publishCommittedAppShellPluginUiProjection(() => ({
    ...EMPTY_PLUGIN_UI_PROJECTION,
    actionsById: Object.fromEntries(actions.map(action => {
      const { inputSchema: _input, resultSchema: _result, ...projected } = action;
      const declaration = PluginProjectedActionV2Schema.parse({ ...projected, pluginId: manifest.id, occurrenceId, available: true });
      return [`${manifest.id}/${action.id}`, { ...declaration, [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: {
        machineId: observer.id, serverId: scope.serverId, executionOrigin: null, phase: 'current', interactionEnabled: true,
      } }];
    })),
  }));
  const requests = vi.fn();
  const result = HealthCheckResultV1Schema.parse({ status: 'down', observedAt: NOW, latencyMs: 11,
    cause: { kind: 'http', vantage: 'sameMachine', observerMachineId: observer.id, expectStatus: 503, httpStatus: 200 },
    evidence: { v: 1, items: [{ source: { kind: 'alert', label: 'HTTP' }, author: { kind: 'process' }, text: 'HTTP 200' }] } });
  const previous = HealthCheckResultV1Schema.parse({ ...result, observedAt: NOW - 60_000 });
  const savedRow: ManagedConfiguredCheckRow = { ...row,
    lastResults: { kind: 'available', checks: [{ checkId, result: previous }] } };
  const kit = await createPluginTestkit({ manifest: healthPlugin.manifest, module: healthPlugin, services: {
    healthChecks: {
      listKinds: async () => catalog,
      readSource: async () => { throw new Error('Unexpected saved source re-read'); },
      manageHeartbeat: async () => { throw new Error('Unexpected heartbeat mutation'); },
      setup: async () => { throw new Error('Unexpected health setup'); },
      read: async ({ sourceInstanceId, checkIds }) => {
        requests(sourceInstanceId, checkIds);
        return [{ checkId, result }];
      },
    },
  } });
  const transport = vi.spyOn(machineTransport, 'machinePluginStructuredMessageActionExecute')
    .mockImplementation(async (machineId, invocation) => {
      expect(machineId).toBe(observer.id);
      expect(invocation.serverId).toBe(scope.serverId);
      const action = actions.find(({ id }) => invocation.qualifiedActionId === `${manifest.id}/${id}`);
      if (!action) throw new Error('Unexpected Machine Services Action');
      return { supported: true, result: { ok: true, result: await kit.invokeAction(action.id, normalizeStrictJsonValue(invocation.input)) } };
    });
  const screen = await renderScreen(<ServiceCheckDetail row={savedRow} nowMs={NOW} renderHeader={actions => actions} />);
  try {
    await vi.waitFor(() => expect(screen.findByTestId('services.check.checkNow')).not.toBeNull());
    expect(screen.findByTestId('services.check.offline')).not.toBeNull();
    await screen.pressByTestIdAsync('services.check.checkNow');
    await vi.waitFor(() => {
      expect(requests).toHaveBeenCalledExactlyOnceWith(createHealthCheckSourceInstanceIdV1({
        kind: 'machineService', machineId: observer.id, serviceId: 'systemd:qa-health',
      }), [checkId]);
      expect(screen.findByTestId('services.check.checkNow.pending')).toBeNull();
      expect(screen.findByTestId('services.check.checkNow.failed')).toBeNull();
      expect([transport.mock.calls.length, Boolean(screen.findByTestId(`services.check.result.${NOW}`))]).toEqual([1, true]);
    });
    const phase = 'rpc.admission.caller_input_authorization';
    transport.mockResolvedValueOnce({ supported: true, result: {
      ok: false, code: RPC_ERROR_CODES.FORBIDDEN, message: 'Invalid RPC caller input authorization',
      effectAttempted: false,
      failureCause: { phase, errorClass: 'Error', errorCode: RPC_ERROR_CODES.FORBIDDEN, httpStatus: null },
    } });
    await screen.pressByTestIdAsync('services.check.checkNow');
    await vi.waitFor(() => expect(screen.findByTestId('services.check.checkNow.failed-details-toggle')).not.toBeNull());
    await screen.pressByTestIdAsync('services.check.checkNow.failed-details-toggle');
    expect(screen.getTextContent()).toContain(phase);
    expect(requests).toHaveBeenCalledTimes(1);
  } finally {
    await screen.unmount();
    transport.mockRestore();
    unpublish();
    await kit.dispose();
  }
});
