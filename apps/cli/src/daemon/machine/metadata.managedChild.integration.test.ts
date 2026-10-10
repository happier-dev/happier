import axios from 'axios';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { readCurrentManagedChildMachineMetadata, refreshMachineMetadataForCurrentDaemon } from './metadata';

describe('current admitted daemon child metadata', () => {
  it('reads the retained namespace through ordinary Home authority and clears retired enrollment without reaching the parent', async () => {
    const contributionRef = { pluginId: 'happier.devcontainer', localId: 'devcontainer' };
    const observation = { nativeResourceId: 'rebuilt-native', user: 'custom-user', workspaceFolder: '/work/custom',
      storage: { kind: 'child' as const, childPath: '/work/custom' } };
    let row = ManagedMachineV1Schema.parse({ id: 'managed-child', homeId: 'srv_child_home', custodianAccountId: 'owner',
      launch: { provider: contributionRef, schemaVersion: 1, name: 'Child', choices: {} },
      controller: { machineId: 'physical-controller', installationId: 'host-installation' },
      allocation: 'bound', creationState: 'active', enrolledMachineId: 'child-machine',
      resource: { contributionRef, schemaVersion: 1, value: { containerId: observation.nativeResourceId }, devcontainerObservation: observation },
      desired: 'start', desiredWhen: 'now', intentRevision: 3, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
    // Only the HTTP transport is substituted; admission schemas, currentness,
    // namespace derivation and the daemon-owned field refresher execute unchanged.
    const post = vi.spyOn(axios, 'post').mockImplementation(async () => ({ status: 200, data: row }));
    onTestFinished(() => post.mockRestore());
    const current = { host: 'child', platform: 'linux', happyCliVersion: 'test', displayName: 'My child',
      devcontainerChild: { relation: { managedMachineId: row.id, managedMachineKind: 'devcontainer' as const,
        parentMachineId: row.controller.machineId }, observation: { ...observation, nativeResourceId: 'old-native' } } };
    const input = { current, credentials: { token: 'account-token', encryption: null }, homeId: row.homeId,
      machineId: 'child-machine', serverHttpBaseUrl: 'https://child-home.example.test' };
    const projection = await readCurrentManagedChildMachineMetadata(input);
    expect(projection).toEqual({ relation: current.devcontainerChild.relation, observation });
    const published = refreshMachineMetadataForCurrentDaemon(current, { host: current.host, platform: current.platform,
      happyCliVersion: current.happyCliVersion, devcontainerChild: projection });
    expect(published).toMatchObject({ displayName: 'My child', devcontainerChild: { observation } });
    expect(post.mock.calls.every(([url]) => url === `${input.serverHttpBaseUrl}${managedMachineActionEndpointPathV1('machines.managed.get')}`)).toBe(true);
    expect(await readCurrentManagedChildMachineMetadata({ ...input, homeId: 'another-Home' })).toBeNull();
    expect(await readCurrentManagedChildMachineMetadata({ ...input, machineId: 'another-child' })).toBeNull();
    row = ManagedMachineV1Schema.parse({ ...row, enrolledMachineId: undefined, creationState: 'canceled' });
    const retired = await readCurrentManagedChildMachineMetadata(input);
    expect(retired).toBeNull();
    expect(refreshMachineMetadataForCurrentDaemon(current, { host: current.host, platform: current.platform,
      happyCliVersion: current.happyCliVersion, devcontainerChild: retired }).devcontainerChild).toBeUndefined();
  });
});
