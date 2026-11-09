import { createPluginTestkit, createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { expect, it } from 'vitest';
import { machineProvisionerAuthorFixture } from '../../../plugin-sdk/fixtures/authoring-inference/machineProvisioners.js';
import { createMachineProvisionerJourneySurface } from '../../fixtures/external-authoring/src/machineProvisionerSurface.js';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { ManagedMachineActionInputSchemasV1, ManagedMachineActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { MachineProvisionerAcquireResultV1Schema, MachineProvisionerPowerResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';

it.each([
  { size: 'Small', acquired: 'accepted', power: 'accepted', recovery: 'present' },
  { size: 'Archived preset', acquired: 'preset_archived', power: null, recovery: null },
  { size: 'Lost start reply', acquired: 'accepted', power: 'accepted', recovery: 'running' },
  { size: 'Missing machine', acquired: 'accepted', power: 'accepted', recovery: 'absent' },
  { size: 'Unavailable start', acquired: 'accepted', power: 'provider_unavailable', recovery: null },
])('renders returned options and preserves acquire/power results for $size', async ({ size, acquired, power, recovery }) => {
  const provisioner = machineProvisionerAuthorFixture.manifest.contributes.machineProvisioners?.[0];
  if (!provisioner) throw new Error('Expected the declared public provisioner');
  const plugin = await createPluginTestkit({ manifest: machineProvisionerAuthorFixture.manifest, module: machineProvisionerAuthorFixture });
  const calls: string[] = [];
  let machine: ReturnType<typeof ManagedMachineV1Schema.parse> | undefined;
  let powered = false;
  const ui = await createPluginUiTestkit({
    identity: { instanceId: 'machine-author', mountNonce: 'machine-author-mount' },
    authorPlugin: machineProvisionerAuthorFixture.manifest,
    surface: createMachineProvisionerJourneySurface(provisioner, {
      homeId: 'author-home', retention: { kind: 'unused', afterMs: 60_000, effect: 'delete' }, wakeOnAcceptedMessage: false,
      enrollmentIdentity: { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'server', adminAccessAtCreation: 'none' },
    }),
    surfaceContext: createSurfaceContextFixture(),
    adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    // Substitute the host transport, validating both sides with its canonical
    // contracts. Admission itself is covered by the managed host's suites;
    // this author fixture must call that host, never a private native role.
    handlers: { executeAction: async ({ action, input }) => {
      if (typeof action !== 'string') throw new Error('Author attempted a private native role');
      calls.push(action);
      if (action === 'machines.provisioners.options') {
        const request = ManagedMachineActionInputSchemasV1[action].parse(input);
        expect(request).toMatchObject({ homeId: 'author-home', contribution: { pluginId: machineProvisionerAuthorFixture.manifest.id, localId: provisioner.id } });
        return ManagedMachineActionOutputSchemasV1[action].parse(await plugin.invokeAction('options', {}));
      }
      if (action === 'machines.managed.acquire') {
        const request = ManagedMachineActionInputSchemasV1[action].parse(input);
        if (request.selection.kind !== 'one-off') throw new Error('Expected selected native choices');
        expect(request.selection).toMatchObject({ homeId: 'author-home', launch: { provider: {
          pluginId: machineProvisionerAuthorFixture.manifest.id, localId: provisioner.id,
        }, choices: { name: expect.any(String) } } });
        const result = MachineProvisionerAcquireResultV1Schema.parse(await plugin.invokeAction('acquire', { launch: request.selection.launch.choices }));
        if (result.kind === 'rejected') throw new PluginError({ code: result.code });
        if (result.kind !== 'bound') throw new Error('Expected a bound fixture resource');
        machine = ManagedMachineV1Schema.parse({
          id: 'author-managed', homeId: request.selection.homeId, custodianAccountId: 'author',
          launch: request.selection.launch, resource: result.resource, allocation: 'bound', creationState: 'active',
          desired: 'start', desiredWhen: 'now', intentRevision: 3,
          retention: request.selection.retention, wakeOnAcceptedMessage: request.selection.wakeOnAcceptedMessage,
          observation: { observedAt: 1, availability: 'present', power: 'stopped' },
        });
        return ManagedMachineActionOutputSchemasV1[action].parse({ managedId: machine.id });
      }
      if (action === 'machines.managed.inspect') {
        const request = ManagedMachineActionInputSchemasV1[action].parse(input);
        expect(request).toEqual({ homeId: 'author-home', managedId: 'author-managed' });
        if (!machine) throw new Error('No admitted Machine');
        if (powered) machine = ManagedMachineV1Schema.parse({ ...machine,
          observation: await plugin.invokeAction('inspect', { resource: machine.launch.choices }),
        });
        return ManagedMachineActionOutputSchemasV1[action].parse({ machine });
      }
      if (action === 'machines.managed.power.set') {
        const request = ManagedMachineActionInputSchemasV1[action].parse(input);
        expect(request).toEqual({ homeId: 'author-home', managedId: 'author-managed', expectedRevision: 3, intent: 'start', when: 'now' });
        if (!machine) throw new Error('No admitted Machine');
        powered = true;
        const result = MachineProvisionerPowerResultV1Schema.parse(await plugin.invokeAction('power', { resource: machine.launch.choices, intent: request.intent }));
        return ManagedMachineActionOutputSchemasV1[action].parse(result.kind === 'refused'
          ? { kind: 'refused', code: 'provider_unavailable' }
          : { kind: 'accepted', managedId: machine.id, intentRevision: 4 });
      }
      throw new Error(`Unexpected host Action: ${action}`);
    } },
  });
  try {
    const press = async (name: string) => ui.press(await ui.getByRole('button', { name }));
    await press('Load options');
    expect(calls).toEqual(['machines.provisioners.options']);
    await press(size);
    await press('Linux');
    await press('Helsinki');
    await press('Create machine');
    await expect(ui.getByText(acquired)).resolves.toEqual({ content: acquired });
    if (power !== null) {
      await press('Check now');
      await press('Start machine');
      await expect(ui.getByText(power)).resolves.toEqual({ content: power });
      if (recovery !== null) {
        await press('Check now');
        await expect(ui.getByText(recovery)).resolves.toEqual({ content: recovery });
        expect(calls).toEqual(['machines.provisioners.options', 'machines.managed.acquire',
          'machines.managed.inspect', 'machines.managed.power.set', 'machines.managed.inspect']);
      }
    }
  } finally { await ui.dispose(); await plugin.dispose(); }
});
