import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import {
  act,
  createMachineFixture,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import {
  createProviderSettingsAccountHarness,
  createProviderSettingsHarness,
  installProviderSettingsRpcBoundary,
} from '@/dev/testkit/harness/providerSettingsHarness';

const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { storage } = await import('@/sync/domains/state/storage');
const { ServicesWatchedView } = await import('./ServicesChecks');
const { InboxArtifactSourceBoundary } =
  await import('@/hooks/inbox/useInboxArtifactSource');

afterEach(async () => {
  standardCleanup();
  await account.reset();
  rpc.reset();
});

const NO_COUNT = () => {};

/** The inventory coverage owner's "not everything has loaded" line: still arriving, or settled short. */
const notLoadedLine = (screen: Readonly<{ findHostByTestId: (id: string) => unknown }>) =>
  screen.findHostByTestId('services.watched.coverage.partial') ?? screen.findHostByTestId('services.watched.coverage.incomplete');

const { createAutomationDefinitionSummary } = await import('@/sync/domains/automations/automationDefinitionProjection');
const { HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1 } = await import('@happier-dev/protocol/deployments/healthCheckV1');
const healthCheckSummary = (id: string) => createAutomationDefinitionSummary({ id, name: `Check ${id}`, description: null, enabled: true,
  targetType: 'existingSession', existingSessionId: 'session-1', templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1, assignments: [],
  triggers: [{ id: `33333333-3333-4333-8333-33333333333${id}`, revision: 1, enabled: true, createdAt: 1, updatedAt: 1, kind: 'pluginEvent',
    eventRef: { pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, localId: 'health-status' }, sourceSelectorId: '22222222-2222-4222-8222-222222222222',
    sourceContractVersion: 1, observation: { kind: 'checkpointedPull', watcher: null }, sourceStatus: null, sourceCatalogStatus: null }] } as never);

/** The saved Check's private definition as the Home answers it (managedOperationalInventory.test's fixture shape). */
async function healthCheckDetail(id: string) {
  const { sealAutomationTriggerDefinitionStoredEnvelopeV1 } = await import('@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent');
  const { AutomationDefinitionDetailSchema } = await import('@happier-dev/protocol/automations/automationApiV3');
  const { AutomationSourceSelectorIdV1Schema } = await import('@happier-dev/protocol/automations/automationEventDeclarationV1');
  const summary = healthCheckSummary(id);
  const { detail: _privateDetail, linkedExistingSessionId: _linkedSession, ...summaryInput } = summary;
  const trigger = summary.triggers[0]!;
  if (trigger.kind !== 'pluginEvent') throw new Error('Expected health Event fixture');
  return AutomationDefinitionDetailSchema.parse({ ...summaryInput, targetType: null, existingSessionId: null,
    observationOnly: { kind: 'observationOnly', templateVersion: summary.templateVersion },
    triggers: [{ ...trigger, triggerDefinitionEnvelope: JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({
      mode: 'plain' as const,
      binding: { v: 1, automationId: summary.id, triggerId: trigger.id, triggerRevision: trigger.revision,
        triggerKind: 'pluginEvent', eventRef: trigger.eventRef, sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse(trigger.sourceSelectorId) },
      definition: { v: 1, sourceInstanceId: `health:shop:${id}`, displayLabel: `Check ${id}`,
        sourceConfig: { v: 1, subject: { kind: 'environment', environmentId: 'shop' }, checks: [{ checkId: 'readiness',
          kind: { pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, localId: 'http' }, binding: { kind: 'healthCheck' },
          config: { endpoint: 'https://shop.example/ready', expectStatus: 204 }, periodMs: 300_000, consecutiveFailuresBeforeAlerting: 1 }] },
        filter: null, maximumObservationAgeMs: null },
    })) }] });
}

// QA-DEPLOY-1114 #16: Account A's Watched view said "Nothing watched yet" while some of its Machines were still unread.
it('says some watched services have not loaded while a Machine is unread, never "Nothing watched yet"', async () => {
  const watches = MachinePublishedMetadataV1Schema.parse({
    ...createMachineFixture().metadata!,
    serviceWatchesV1: {
      v: 1,
      watches: [
        {
          v: 1,
          watchId: 'recorded-service',
          name: 'Database',
          adapter: { pluginId: 'example.service', localId: 'native' },
          nativeResourceId: 'native-database',
          lifecyclePurpose: 'infrastructure',
        },
      ],
    },
  }).serviceWatchesV1!;
  const machine = createMachineFixture({
    id: 'unread-machine',
    metadata: {
      ...createMachineFixture().metadata!,
      agentInventory: { checkedAt: 1, installedAgentIds: [] },
      serviceWatchesV1: watches,
    },
  });
  await account.restore({
    serverIdentityId: 'srv_services_watched_unread',
    machines: [machine],
  });
  const scope = storage.getState().settingsScope!;
  const admitted = storage.getState().machines[machine.id]!;
  await act(async () => {
    storage
      .getState()
      .applyMachines(
        [
          {
            ...admitted,
            metadata: null,
            metadataVersion: machine.metadataVersion + 1,
          },
        ],
        false,
        { sourceServerId: scope.serverId, sourceAccountId: scope.accountId },
      );
  });

  const screen = await renderScreen(
    <InboxArtifactSourceBoundary>
      <ServicesWatchedView scope={scope} presented onCount={NO_COUNT} />
    </InboxArtifactSourceBoundary>,
  );
  await vi.waitFor(() => expect(notLoadedLine(screen), screen.getTextContent()).not.toBeNull());
  expect(screen.findHostByTestId('services.watched.empty')).toBeNull();
});

// Partly read results (a Check's health history) are facts of listed rows, not missing rows: no "haven't loaded" line.
it('lists saved Checks without a "haven\'t loaded" line while only their results are partly read', async () => {
  const { ServicesChecksView } = await import('./ServicesChecks');
  await account.restore({ serverIdentityId: 'srv_services_checks_results', machines: [], httpAnswers: {
    'POST /v3/automations/query': { body: { automations: await Promise.all(['1', '2'].map(healthCheckDetail)), nextCursor: null } } } });
  const scope = storage.getState().settingsScope!;
  await act(async () => { storage.setState({ automations: { '1': healthCheckSummary('1'), '2': healthCheckSummary('2') }, isDataReady: true, automationDefinitionNextCursor: null }); });
  const screen = await renderScreen(<InboxArtifactSourceBoundary>
    <ServicesChecksView scope={scope} presented selectedKey={null} onSelect={NO_COUNT} onSelectedRow={NO_COUNT} onCount={NO_COUNT} />
  </InboxArtifactSourceBoundary>);
  await vi.waitFor(() => expect(screen.getTextContent()).toContain('Check 2'));
  expect(screen.findHostByTestId('services.checks.coverage.partial')).toBeNull();
});

// REVIEW-2 R2: a listed family still says what it has not read, and offers its next page instead of hiding it.
it('keeps listed Checks and offers the next page of saved automations under them (ServicesPaging), never a silent end', async () => {
  const { ServicesChecksView } = await import('./ServicesChecks');
  await account.restore({ serverIdentityId: 'srv_services_checks_paged', machines: [], httpAnswers: {
    'POST /v3/automations/query': { body: { automations: await Promise.all(['1'].map(healthCheckDetail)), nextCursor: 'cursor-2' } } } });
  const scope = storage.getState().settingsScope!;
  await act(async () => { storage.setState({ automations: { '1': healthCheckSummary('1') }, isDataReady: true, automationDefinitionNextCursor: 'cursor-2' }); });
  const screen = await renderScreen(<InboxArtifactSourceBoundary>
    <ServicesChecksView scope={scope} presented selectedKey={null} onSelect={NO_COUNT} onSelectedRow={NO_COUNT} onCount={NO_COUNT} />
  </InboxArtifactSourceBoundary>);
  await vi.waitFor(() => expect(screen.getTextContent()).toContain('Check 1'));
  await vi.waitFor(() => expect(screen.findHostByTestId('services.checks.paging.more')).not.toBeNull());
});

it('says a Machine\'s watches have not loaded beside the services already listed', async () => {
  const watch = (watchId: string, name: string) => ({ v: 1, watchId, name, adapter: { pluginId: 'example.service', localId: 'native' },
    nativeResourceId: `native-${watchId}`, lifecyclePurpose: 'infrastructure' });
  const withWatches = (id: string, watches: readonly ReturnType<typeof watch>[]) => createMachineFixture({
    id,
    metadata: { ...createMachineFixture().metadata!, agentInventory: { checkedAt: 1, installedAgentIds: [] },
      serviceWatchesV1: MachinePublishedMetadataV1Schema.parse({ ...createMachineFixture().metadata!,
        serviceWatchesV1: { v: 1, watches } }).serviceWatchesV1! },
  });
  const read = withWatches('read-machine', [watch('db', 'Database')]);
  const unread = withWatches('unread-machine', [watch('cache', 'Cache')]);
  await account.restore({ serverIdentityId: 'srv_services_watched_partial', machines: [read, unread] });
  const scope = storage.getState().settingsScope!;
  const admitted = storage.getState().machines[unread.id]!;
  await act(async () => {
    storage.getState().applyMachines([{ ...admitted, metadata: null, metadataVersion: unread.metadataVersion + 1 }], false,
      { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
  });
  const screen = await renderScreen(<InboxArtifactSourceBoundary>
    <ServicesWatchedView scope={scope} presented onCount={NO_COUNT} />
  </InboxArtifactSourceBoundary>);
  await vi.waitFor(() => expect(screen.getTextContent()).toContain('Database'));
  await vi.waitFor(() => expect(notLoadedLine(screen), screen.getTextContent()).not.toBeNull());
});
