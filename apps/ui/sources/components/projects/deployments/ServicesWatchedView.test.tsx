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
  await vi.waitFor(() =>
    expect(
      screen.findHostByTestId('services.watched.coverage.partial'),
    ).not.toBeNull(),
  );
  expect(screen.findHostByTestId('services.watched.empty')).toBeNull();
});

// Partly read results (a Check's health history) are facts of listed rows, not missing rows: no "haven't loaded" line.
it('lists saved Checks without a "haven\'t loaded" line while only their results are partly read', async () => {
  const { ServicesChecksView } = await import('./ServicesChecks');
  const { createAutomationDefinitionSummary } = await import('@/sync/domains/automations/automationDefinitionProjection');
  const { HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1 } = await import('@happier-dev/protocol/deployments/healthCheckV1');
  const summary = (id: string) => createAutomationDefinitionSummary({ id, name: `Check ${id}`, description: null, enabled: true,
    targetType: 'existingSession', existingSessionId: 'session-1', templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1, assignments: [],
    triggers: [{ id: `33333333-3333-4333-8333-33333333333${id}`, revision: 1, enabled: true, createdAt: 1, updatedAt: 1, kind: 'pluginEvent',
      eventRef: { pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, localId: 'health-status' }, sourceSelectorId: '22222222-2222-4222-8222-222222222222',
      sourceContractVersion: 1, observation: { kind: 'checkpointedPull', watcher: null }, sourceStatus: null, sourceCatalogStatus: null }] } as never);
  await account.restore({ serverIdentityId: 'srv_services_checks_results', machines: [] });
  const scope = storage.getState().settingsScope!;
  await act(async () => { storage.setState({ automations: { '1': summary('1'), '2': summary('2') }, isDataReady: true, automationDefinitionNextCursor: null }); });
  const screen = await renderScreen(<InboxArtifactSourceBoundary>
    <ServicesChecksView scope={scope} presented selectedKey={null} onSelect={NO_COUNT} onSelectedRow={NO_COUNT} onCount={NO_COUNT} />
  </InboxArtifactSourceBoundary>);
  await vi.waitFor(() => expect(screen.getTextContent()).toContain('Check 2'));
  expect(screen.findHostByTestId('services.checks.coverage.partial')).toBeNull();
});
