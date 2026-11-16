import { describe, expect, it } from 'vitest';
import { ExternalActionRequestEnvelopeV1Schema } from './externalActionApi.js';
import { openExternalActionRequestV2, sealExternalActionRequestV2 } from './externalActionEncryption.js';
import { computeExternalActionRequestEnvelopeDigestV1, isExternalActionAuthorizationBoundToEnvelope } from './externalActionExecutionAuthorization.js';
import { projectExternalActionMachineRuntimeDemandV1 } from './actionSpecs.js';
import { sealAccountScopedBlobCiphertext } from '../crypto/accountScopedCipher.js';

describe('Workflow preset preparation transport', () => {
  it.each(['plain', 'e2ee'] as const)('binds the selected revision and pool controller to the %s root', mode => {
    const actionId = 'workflow.run.start';
    const target = { kind: 'machine' as const, machineId: 'controller', project: { machineId: 'controller', directory: '/workspace',
      sessionPlacement: { kind: 'preset' as const, homeId: 'home', presetId: 'preset' } } };
    const binding = { serverIdentityId: 'srv_home', accountId: 'person', authentication: { kind: 'account' as const, tokenEpoch: 1 },
      actionId, requestId: 'start', target };
    const input = { runId: 'run', source: { kind: 'saved', definitionId: 'definition', revision: 1 } };
    const workflowPreparation = { project: { ...target.project, machineId: 'authored-machine' },
      acquisition: { selection: { kind: 'preset' as const, homeId: 'home', id: 'preset', revision: 7 },
      controller: { machineId: 'controller', installationId: 'installation' }, retention: { kind: 'until-delete' as const } } };
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) };
    const seal = (preparation: typeof workflowPreparation) => {
      const selectedTarget = { ...target, machineId: preparation.acquisition.controller.machineId,
        project: { ...target.project, machineId: preparation.acquisition.controller.machineId } };
      const params = { binding: { ...binding, target: selectedTarget }, input, workflowPreparation: preparation, material,
        randomBytes: (length: number) => new Uint8Array(length).fill(2), projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1 };
      return mode === 'plain' ? ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: binding.requestId,
        target: selectedTarget, input, workflowPreparation: preparation }) : sealExternalActionRequestV2(params);
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
      const substituted = seal({ ...workflowPreparation, acquisition });
      expect(isExternalActionAuthorizationBoundToEnvelope(signed, { actionId, machineId: 'controller', envelope: substituted })).toBe(false);
    }
  });
  it.each(['plain', 'e2ee'] as const)('rejects %s authored placement that differs from the reviewed target', mode => {
    const placement = { kind: 'preset' as const, homeId: 'home', presetId: 'preset' };
    const target = { kind: 'machine' as const, machineId: 'controller', project: {
      machineId: 'controller', directory: '/reviewed', sessionPlacement: placement,
    } };
    const binding = { serverIdentityId: 'srv_home', accountId: 'person', authentication: { kind: 'account' as const, tokenEpoch: 1 },
      actionId: 'workflow.run.start', requestId: 'start', target };
    const input = { runId: 'run', source: { kind: 'saved', definitionId: 'definition', revision: 1 } };
    const preparation = { project: { ...target.project, machineId: 'authored-machine', workspaceRefId: 'old-machine-ref' },
      acquisition: { selection: { kind: 'preset' as const, homeId: 'home', id: 'preset', revision: 7 },
        controller: { machineId: 'controller', installationId: 'installation' }, retention: { kind: 'until-delete' as const } } };
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) };
    const randomBytes = (length: number) => new Uint8Array(length).fill(2);
    const open = (workflowPreparation: typeof preparation,
      reviewedTarget: typeof target & { project: typeof target.project & { workspaceRefId?: string } } = target) => {
      if (mode === 'plain') return ExternalActionRequestEnvelopeV1Schema.safeParse({ v: 1, requestId: 'start',
        target: reviewedTarget, input, workflowPreparation }).success;
      // The sender is a real external boundary and can encrypt arbitrary JSON;
      // bypass the canonical producer to exercise the receiving V2 opener.
      const receivedBinding = { ...binding, target: reviewedTarget };
      const payload = { v: 2, direction: 'request', ...receivedBinding, input, workflowPreparation };
      const envelope = { v: 2 as const, requestId: 'start', target: reviewedTarget,
        payload: { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({ kind: 'external_action_transport',
          payload, material, randomBytes }) } };
      return openExternalActionRequestV2({ envelope, binding: receivedBinding, material,
        projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1 }) !== null;
    };
    expect(open(preparation)).toBe(true);
    const colocated = { ...preparation, project: { ...preparation.project, machineId: 'controller' } };
    expect(open(colocated, { ...target, project: { ...target.project, workspaceRefId: 'old-machine-ref' } })).toBe(true);
    expect(open(colocated)).toBe(false);
    expect(open({ ...preparation, project: { ...preparation.project, directory: '/different' } })).toBe(false);
    expect(open({ ...preparation, project: { ...preparation.project,
      sessionPlacement: { ...placement, presetId: 'different-preset' } } })).toBe(false);
    expect(open(preparation, { ...target, project: { ...target.project, machineId: 'different-controller' } })).toBe(false);
    expect(open(preparation, { ...target, machineId: 'different-controller' })).toBe(false);
    expect(open(preparation, { ...target, project: { ...target.project, workspaceRefId: 'old-machine-ref' } })).toBe(false);
  });
});
