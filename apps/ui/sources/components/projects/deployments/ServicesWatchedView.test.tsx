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
