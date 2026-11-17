import { afterEach, expect, it, vi } from 'vitest';
import { prepareCliManagedProvisionerAdmission } from './provisionerAdmission';
import { ManagedMachineFullV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { GuestCliIdentityV1Schema } from '@happier-dev/protocol/features';

afterEach(() => vi.restoreAllMocks());

it.each(['machines.managed.bootstrap.retry', 'machines.managed.delete'] as const)(
  'leaves controller %s custody to Home without reading requester metadata or opening private content', async actionId => {
  const guestCli = GuestCliIdentityV1Schema.parse({ source: 'home-payload', line: '0.3', channel: 'publicdev', payloads: [{
    target: { os: 'linux', arch: 'x64' }, sha256: 'b'.repeat(64), url: '/v1/runtime/guest-cli/payloads/linux/x64',
  }] });
  const machine = ManagedMachineFullV1Schema.parse({ id: 'managed', homeId: 'home', custodianAccountId: 'owner',
    controller: { machineId: 'controller', installationId: 'installation' },
    launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
    allocation: 'unsubmitted', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
  const input = actionId === 'machines.managed.bootstrap.retry'
    ? { homeId: 'home', managedId: 'managed', expectedIntentRevision: 1, guestCli }
    : { homeId: 'home', managedId: 'managed', expectedRevision: 1,
      when: 'now', intent: 'delete', reviewedDependencies: true };
  const features = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ capabilities: { guestCli } }));
  const prepare = (approvalReplay?: true) => prepareCliManagedProvisionerAdmission({ actionId,
    input, context: { surface: 'cli' }, ...(approvalReplay ? { approvalReplay } : {}) }, {
    serverUrl: 'https://home.example',
    // The host Action HTTP adapter is the network boundary. Private hydration
    // and provisioner selection remain real and require no key for this row.
    managedMachineAction: async () => machine,
  });
  expect(await prepare()).toBeNull();
  expect(await prepare(true)).toBeNull();
  expect(features).not.toHaveBeenCalled();
});
