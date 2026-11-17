import { expect, it } from 'vitest';
import { MachineSetupLocalPlanInputV1Schema, type MachineSetupLocalPlanResultV1 } from './prepareMachineSetupPlan';
import { prepareMachineSetupApps } from './prepareMachineSetupApps';

it('prepares each declared Agent once and refuses a changed reviewed install operand', async () => {
  const input = MachineSetupLocalPlanInputV1Schema.parse({ homeId: 'home', machineId: 'machine', mode: 'effects',
    sources: [{ kind: 'direct', setup: { items: [{ kind: 'agent', agentId: 'catalog/agent' },
      { kind: 'agent', agentId: 'catalog/other' }] } },
    { kind: 'bundledPreset', ref: { pluginId: 'com.example.catalog', localId: 'preset', revision: 'one' },
      setup: { items: [{ kind: 'agent', agentId: 'catalog/agent' }] } }],
  });
  const plan: MachineSetupLocalPlanResultV1 = { sources: input.sources!, desiredRevision: 0, exclusions: [],
    recipePlans: [], support: [{ sourceIndex: 0, itemIndex: 0, status: 'unverifiable' },
      { sourceIndex: 0, itemIndex: 1, status: 'unverifiable' }, { sourceIndex: 1, itemIndex: 0, status: 'unverifiable' }] };
  const prepared = await prepareMachineSetupApps(input, plan, { surface: 'cli', authority: 'present_user' }, {});
  expect(prepared).toMatchObject({ appChildren: [
    { sourceIndex: 0, itemIndex: 0, actionId: 'machines.agents.install', input: {
      machineId: 'machine', agentId: 'catalog/agent', intent: 'install', waitForTerminal: true, consent: { vendorRecipe: true },
    } },
    { sourceIndex: 0, itemIndex: 1, actionId: 'machines.agents.install', input: { agentId: 'catalog/other' } },
  ], support: [{ sourceIndex: 0, itemIndex: 0, status: 'drifted' },
    { sourceIndex: 0, itemIndex: 1, status: 'drifted' }, { sourceIndex: 1, itemIndex: 0, status: 'drifted' }] });
  if ('errorCode' in prepared || !prepared.appChildren) throw new Error('Expected prepared catalog children');
  const changed = prepared.appChildren.map(child => child.actionId === 'machines.agents.install'
    ? { ...child, input: { ...child.input, agentId: 'catalog/unreviewed' } } : child);
  await expect(prepareMachineSetupApps({ ...input, appChildren: changed }, plan,
    { surface: 'cli', authority: 'present_user' }, {})).resolves.toMatchObject({
      ok: false, errorCode: 'machine_setup_app_plan_changed',
    });
  const observed = await prepareMachineSetupApps({ ...input, mode: 'check' }, plan,
    { surface: 'cli', authority: 'present_user' }, {});
  expect(observed).not.toHaveProperty('appChildren');
});
