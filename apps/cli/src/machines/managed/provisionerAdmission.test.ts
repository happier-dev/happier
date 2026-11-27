import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions';
import { prepareCliManagedProvisionerAdmission } from './provisionerAdmission';
import { ManagedGetOutputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineFullV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { GuestCliIdentityV1Schema } from '@happier-dev/protocol/features';
import { executeManagedMachinePolicyAction } from '@/daemon/startup/managedMachinePolicyAction';

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

it('admits an accepted-input Start without feeding the opened E2EE Machine to the public read parser', async () => {
  const controller = { machineId: 'controller', installationId: 'installation' };
  const structural = { id: 'managed', homeId: 'home', custodianAccountId: 'owner', controller,
    preset: { id: 'preset', revision: 0, contentEncryptionMode: 'e2ee' }, enrolledMachineId: 'guest',
    allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 2,
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true } as const;
  const provider = { pluginId: 'acme.compute', localId: 'vm' };
  const machine = ManagedMachineFullV1Schema.parse({ ...structural,
    launch: { provider, schemaVersion: 1, name: 'Private guest', choices: {} },
    resource: { contributionRef: provider, schemaVersion: 1, value: {} } });
  const reviewedMachineRead = ManagedGetOutputV1Schema.parse({ machine: structural,
    presetContent: { content: { t: 'encrypted', c: Buffer.alloc(48).toString('base64') }, recipientEnvelope: null } });
  const signal = new AbortController().signal;
  const runApproved = vi.fn(async () => machine);
  const policy: Parameters<typeof executeManagedMachinePolicyAction<typeof machine>>[0] & {
    reviewedMachineRead: typeof reviewedMachineRead;
  } = {
    machine, reviewedMachineRead, runApproved, serverId: 'home',
    purpose: { kind: 'accepted-input-start', target: { homeId: 'home', managedId: 'managed', controller,
      enrolledMachineId: 'guest', expectedIntentRevision: 2, reason: 'admitted-work', origin: { kind: 'session-input',
        session: { homeId: 'home', sessionId: 'session' }, pendingRequestId: 'send', requestedAt: 123 } } },
    context: { surface: 'cli', signal, operationAcceptance: { operationId: 'operation', accept() {} },
      operationOwnerUpdate: { update() {} }, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
        approvalWaivedSurfaces: { 'machines.managed.power.set': ['cli'] } }) },
    createExecutor: overrides => createActionExecutor({ ...overrides,
      prepareHostReviewedChildren: request => prepareCliManagedProvisionerAdmission(request, {
        serverUrl: 'https://home.example', managedMachineAction: overrides.managedMachineAction,
      }),
    }),
  };
  await expect(executeManagedMachinePolicyAction(policy)).resolves.toBe(machine);
  expect(runApproved).toHaveBeenCalledOnce();
});
