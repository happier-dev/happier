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
