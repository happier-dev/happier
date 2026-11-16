import { describe, expect, it } from 'vitest';
import { ExternalActionRequestEnvelopeV1Schema } from './externalActionApi.js';
import { openExternalActionRequestV2, sealExternalActionRequestV2 } from './externalActionEncryption.js';
import { computeExternalActionRequestEnvelopeDigestV1, isExternalActionAuthorizationBoundToEnvelope } from './externalActionExecutionAuthorization.js';
import { projectExternalActionMachineRuntimeDemandV1 } from './actionSpecs.js';

describe('Workflow preset preparation transport', () => {
  it.each(['plain', 'e2ee'] as const)('binds the selected revision and pool controller to the %s root', mode => {
    const actionId = 'workflow.run.start';
    const target = { kind: 'machine' as const, machineId: 'controller', project: { machineId: 'controller', directory: '/workspace',
      sessionPlacement: { kind: 'preset' as const, homeId: 'home', presetId: 'preset' } } };
    const binding = { serverIdentityId: 'srv_home', accountId: 'person', authentication: { kind: 'account' as const, tokenEpoch: 1 },
      actionId, requestId: 'start', target };
    const input = { runId: 'run', source: { kind: 'saved', definitionId: 'definition', revision: 1 } };
    const workflowPreparation = { acquisition: { selection: { kind: 'preset' as const, homeId: 'home', id: 'preset', revision: 7 },
      controller: { machineId: 'controller', installationId: 'installation' }, retention: { kind: 'until-delete' as const } } };
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) };
    const seal = (preparation: typeof workflowPreparation) => {
      const params = { binding, input, workflowPreparation: preparation, material,
        randomBytes: (length: number) => new Uint8Array(length).fill(2), projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1 };
      return mode === 'plain' ? ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: binding.requestId,
        target, input, workflowPreparation: preparation }) : sealExternalActionRequestV2(params);
    };
    const envelope = seal(workflowPreparation);
    const opened = envelope.v === 1 ? envelope : openExternalActionRequestV2({ envelope, binding, material,
      projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1 });
    expect(opened).toMatchObject({ input, workflowPreparation });
    if (envelope.v === 2) expect(JSON.stringify(envelope)).not.toContain('acquisition');
    const signed = { ...binding, custodianAccountId: 'person', machineId: 'controller', installationId: 'installation',
      machineRuntimeDemand: envelope.v === 2 ? envelope.machineRuntimeDemand : undefined,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) };
    expect(isExternalActionAuthorizationBoundToEnvelope(signed, { actionId, machineId: 'controller', envelope })).toBe(true);
    for (const acquisition of [
      { ...workflowPreparation.acquisition, selection: { ...workflowPreparation.acquisition.selection, revision: 8 } },
      { ...workflowPreparation.acquisition, controller: { machineId: 'other-controller', installationId: 'other-installation' } },
    ]) {
      const substituted = seal({ acquisition });
      expect(isExternalActionAuthorizationBoundToEnvelope(signed, { actionId, machineId: 'controller', envelope: substituted })).toBe(false);
    }
  });
});
