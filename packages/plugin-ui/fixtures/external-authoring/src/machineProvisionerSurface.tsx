import { useState } from 'react';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import type { PluginActionInputById, PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import {
  MACHINE_PROVISIONER_DIMENSIONS_V1,
  MachineProvisionerOptionsResultV1Schema,
  projectMachineProvisionerSelectionV1,
  type MachineProvisionerContributionV1,
  type MachineProvisionerOptionsResultV1,
  type MachineProvisionerSelectionV1,
} from '@happier-dev/plugin-sdk/machine-provisioners';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { Button, ItemGroup, Text } from '@happier-dev/plugin-ui/components';

type AcquireInput = PluginActionInputById['machines.managed.acquire'];
type OneOffSelection = Extract<AcquireInput['selection'], { kind: 'one-off' }>;

/** The caller supplies the person's chosen placement, retention and identity.
 * Native roles, credentials and admission remain private to the managed host. */
export function createMachineProvisionerJourneySurface(provisioner: MachineProvisionerContributionV1,
  context: Pick<OneOffSelection, 'homeId' | 'controller' | 'retention' | 'wakeOnAcceptedMessage'>
    & Pick<AcquireInput, 'enrollmentIdentity'> & Pick<OneOffSelection['launch'], 'credentials'>) {
  return defineUiSurface(function MachineProvisionerJourney({ hostApi, plugin }: RenderContext) {
    const [options, setOptions] = useState<MachineProvisionerOptionsResultV1 | null>(null);
    const [selection, setSelection] = useState<MachineProvisionerSelectionV1>({});
    const [acquired, setAcquired] = useState<PluginActionResultById['machines.managed.acquire'] | null>(null);
    const [power, setPower] = useState<PluginActionResultById['machines.managed.power.set'] | null>(null);
    const [inspected, setInspected] = useState<PluginActionResultById['machines.managed.inspect'] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const selected = options && projectMachineProvisionerSelectionV1({ options, selection, launchSchema: provisioner.launchSchema });
    const contribution = { pluginId: plugin.id, localId: provisioner.id };
    const observation = inspected?.machine.observation;
    const perform = async (operation: () => Promise<void>) => {
      setError(null);
      try { await operation(); }
      catch (failure) {
        setError(failure !== null && typeof failure === 'object' && 'code' in failure && typeof failure.code === 'string'
          ? failure.code : 'Action unavailable');
      }
    };
    return <ItemGroup title="Native machine">
      <Button title="Load options" onPress={() => perform(async () => {
        setOptions(MachineProvisionerOptionsResultV1Schema.parse(await hostApi.executeAction('machines.provisioners.options', {
          homeId: context.homeId, contribution, selectors: {},
          ...(context.controller ? { controller: context.controller } : {}),
          ...(context.credentials ? { credentials: context.credentials } : {}),
        })));
      })} />
      {options ? MACHINE_PROVISIONER_DIMENSIONS_V1.flatMap(dimension => options.dimensions[dimension].map(option =>
        <Button key={`${dimension}:${option.id}`} title={typeof option.title === 'string' ? option.title : option.title.fallback}
          disabled={option.available === false}
          onPress={() => setSelection(current => ({ ...current, [dimension]: option.id }))} />)) : null}
      <Button title="Create machine" disabled={selected?.kind !== 'ready'} onPress={() => perform(async () => {
        if (selected?.kind !== 'ready') return;
        setAcquired(await hostApi.executeAction('machines.managed.acquire', {
          selection: { kind: 'one-off', homeId: context.homeId,
            ...(context.controller ? { controller: context.controller } : {}),
            launch: { provider: contribution, schemaVersion: provisioner.schemaVersion, name: 'Author machine', choices: selected.launch,
              ...(context.credentials ? { credentials: context.credentials } : {}) },
            retention: context.retention, wakeOnAcceptedMessage: context.wakeOnAcceptedMessage },
          enrollmentIdentity: context.enrollmentIdentity,
        }));
      })} />
      {acquired && !power ? <Text value="accepted" /> : null}
      {inspected && provisioner.actions.power ? <Button title="Start machine" onPress={() => perform(async () => {
        const machine = inspected.machine;
        setInspected(null);
        setPower(await hostApi.executeAction('machines.managed.power.set', {
          homeId: context.homeId, managedId: machine.id, expectedRevision: machine.intentRevision, intent: 'start', when: 'now',
        }));
      })} /> : null}
      {power ? <Text value={power.kind === 'refused' ? power.code : power.kind} /> : null}
      {acquired ? <Button title="Check now" onPress={() => perform(async () => {
        setInspected(await hostApi.executeAction('machines.managed.inspect', { homeId: context.homeId, managedId: acquired.managedId }));
      })} /> : null}
      {observation ? <Text value={observation.power ?? observation.availability} /> : null}
      {error ? <Text value={error} /> : null}
    </ItemGroup>;
  });
}
