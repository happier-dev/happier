import { projectExternalActionMachineRuntimeDemandV1 } from './actionSpecs.js';
import { describe, expect, it } from 'vitest';
import { ManagedAcquireInputV1Schema, ManagedAdmissionComputeInputV1Schema } from '../machines/managed/actionsV1.js';
import { ExternalActionManagedAdmissionV1Schema } from './externalActionApi.js';
import { openExternalActionRequestV2, sealExternalActionRequestV2 } from './externalActionEncryption.js';

describe('encrypted managed acquire producer', () => {
  it.each([false, true])('projects only compute admission with continuation=%s for every caller', continuationPresent => {
    const input = ManagedAcquireInputV1Schema.parse({ selection: { kind: 'one-off', homeId: 'home',
      controller: { machineId: 'controller', installationId: 'installation' },
      launch: { provider: { pluginId: 'machine.example', localId: 'vm' }, schemaVersion: 1, name: 'Work VM', choices: {} },
      retention: { kind: 'unused', afterMs: 3600000, effect: 'stop' }, wakeOnAcceptedMessage: true },
      ...(continuationPresent ? { agentStart: { directory: { kind: 'path', path: '/private/repo' },
        agentTarget: { kind: 'agent', identity: { pluginId: 'native.agent', localId: 'agent' } },
        creationKey: 'private-start', initialInput: { text: 'private prompt' } } } : {}) });
    const binding = { serverIdentityId: 'srv_home', accountId: 'account', authentication: { kind: 'account' as const, tokenEpoch: 0 },
      actionId: 'machines.managed.acquire', requestId: 'request', target: { kind: 'machine' as const, machineId: 'controller' } };
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) };
    const request = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, input, material, randomBytes: length => new Uint8Array(length).fill(2) });
    const { agentStart: _private, ...compute } = input;
    expect(ExternalActionManagedAdmissionV1Schema.parse(request.managedAdmission)).toEqual({
      actionId: 'machines.managed.acquire', input: ManagedAdmissionComputeInputV1Schema.parse(compute), continuationPresent });
    expect(JSON.stringify(request)).not.toContain('private prompt');
    expect(JSON.stringify(request)).not.toContain('/private/repo');
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: request, binding, material })).toEqual({ input });
  });
});
