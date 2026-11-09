import { expect, it } from 'vitest';
import { getMachineSetupDesiredV1, type MachineMetadataFieldPortV1, type MachineSetupDesiredV1 } from '@happier-dev/protocol';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createMachineSetupPlanAction } from '@/machines/setup/machineSetupAction';

it('keeps the receiving current-copy plan owner through the actual credentialed factory without self-RPC or catalog work', async () => {
  const desired: MachineSetupDesiredV1 = { version: 1, revision: 2, exclusions: [], sources: [
    { kind: 'accountPreset', presetId: 'saved', presetRevision: 1,
      setup: { scripts: [{ body: '\r\necho retained\r\n', affects: 'none' }],  } },
    { kind: 'direct', setup: { items: [{ kind: 'softwareRecipe', selection: {
      ref: { pluginId: 'example.retired-software', recipeId: 'fonts', revision: '1' }, inputs: {},
    } }] } },
  ] };
  let metadataReads = 0;
  let writes = 0;
  let selfRpc = 0;
  let catalogReads = 0;
  // Metadata persistence and Machine transport are the only supplied system
  // boundaries. Saved-copy preparation and Action dispatch remain real.
  const port: MachineMetadataFieldPortV1 = {
    read: async () => { metadataReads++; return { status: 'ready', metadata: { setup: desired }, metadataVersion: 7 }; },
    compareAndSwap: async () => { writes++; throw new Error('A current-copy read cannot publish'); },
  };
  const executor = createCliActionExecutorFromCredentials({ credentials: { token: 'fixture-token', encryption: null },
    machineId: 'guest', serverId: 'profile', serverApiUrl: 'https://saved-setup.test', serverIdentityId: 'home',
    pluginActionExecutionOwner: 'current_process', actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({}) },
    machineActionDirectTargetTransport: { machineId: 'guest', invoke: async () => { selfRpc++; throw new Error('The receiver cannot self-RPC'); } },
    machineSetupPlan: createMachineSetupPlanAction({ machineId: 'guest', homeId: 'home',
      apiMachine: { getMachineSetupDesiredSnapshot: () => getMachineSetupDesiredV1(port) },
      acquirePluginRuntimeRegistryLease: async () => { catalogReads++; throw new Error('Saved copies need no catalog'); },
    }),
  });
  const result = await executor.execute('machines.setup.plan', { homeId: 'home', machineId: 'guest' },
    { surface: 'rpc', authority: 'present_user', externalActionTarget: { kind: 'machine', machineId: 'guest' } });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: {
    desiredRevision: 2, sources: desired.sources, exclusions: [],
    support: [{ sourceIndex: 1, itemIndex: 0, status: 'unsupported', reason: 'required_fact_unavailable' }],
  } });
  expect({ metadataReads, writes, selfRpc, catalogReads }).toEqual({ metadataReads: 1, writes: 0, selfRpc: 0, catalogReads: 0 });
});
