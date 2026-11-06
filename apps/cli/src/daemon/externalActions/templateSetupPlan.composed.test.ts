import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { getMachineSetupDesiredV1, type MachineMetadataFieldPortV1 } from '@happier-dev/protocol';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { openExternalActionResponseV2, sealExternalActionRequestV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createMachineSetupPlanAction } from '@/machines/setup/machineSetupAction';
import { executeExternalAction } from './executeExternalAction';
import { createDaemonExternalActionTargetResolver } from './daemonExternalActionTargetResolver';

it.each(['plain', 'e2ee'] as const)('runs only the exact issuer-derived template Setup Plan at the real %s receiving owner', async mode => {
  const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(57));
  const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(58) };
  const credentials = { token: 'native-account-credential', encryption: null };
  const target = { kind: 'machine' as const, machineId: 'guest' };
  const planInput = { homeId: 'srv_template_plan', machineId: 'guest', mode: 'effects' as const,
    sources: [{ kind: 'direct' as const, setup: { scripts: [{ body: 'echo reviewed', affects: 'none' as const }] } }] };
  const binding = { serverIdentityId: 'srv_template_plan', accountId: 'recipient', authentication: { kind: 'account' as const, tokenEpoch: 2 },
    actionId: 'machines.setup.plan', requestId: 'original-update', target };
  let nativeReads = 0;
  const metadata: MachineMetadataFieldPortV1 = {
    read: async () => { nativeReads++; return { status: 'ready', metadata: {}, metadataVersion: 0 }; },
    compareAndSwap: async () => { throw new Error('Plan cannot write Machine metadata'); },
  };
  const executor = createCliActionExecutorFromCredentials({ credentials, machineId: 'guest', serverId: 'profile', serverIdentityId: 'srv_template_plan',
    serverApiUrl: 'https://template-plan.example', pluginActionExecutionOwner: 'current_process',
    actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({}) },
    machineSetupPlan: createMachineSetupPlanAction({ machineId: 'guest', homeId: 'srv_template_plan',
      apiMachine: { getMachineSetupDesiredSnapshot: () => getMachineSetupDesiredV1(metadata) },
      acquirePluginRuntimeRegistryLease: async () => { throw new Error('Script-only Plan needs no catalog'); } }),
  });
  for (const substituted of [false, true]) {
    const opened = substituted ? { ...planInput, sources: [{ kind: 'direct' as const,
      setup: { scripts: [{ body: 'echo substituted', affects: 'none' as const }] } }] } : planInput;
    const envelope = mode === 'plain' ? { v: 1 as const, requestId: binding.requestId, target, input: opened }
      : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, material, input: opened, randomBytes: nacl.randomBytes });
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'signed-derived-plan', binding: {
      ...binding, machineId: 'guest', installationId: 'guest-installation', custodianAccountId: 'recipient', accountEncryptionMode: mode, admittedMachineRole: 'manage',
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      templateRequesterSetupPlanAdmission: { parentActionId: 'template.updates.apply', parentRequestEnvelopeDigest: 'p'.repeat(43),
        planInputDigest: computeActionInputApprovalDigestV1('machines.setup.plan', planInput) },
    } });
    const before = nativeReads;
    const result = await executeExternalAction({ actionId: 'machines.setup.plan', envelope, executionAuthorization: authorization,
      principal: { accountId: 'recipient', authentication: binding.authentication, authority: 'present_user' },
      currentMachineId: 'guest', currentAccountId: 'recipient', currentServerId: 'profile',
      currentInstallationId: 'guest-installation', externalActionMachineRequestPrivateKey: keys.secretKey,
      // Home signature verification and Account key acquisition are network/keychain boundaries.
      verifyExecutionAuthorization: async () => true,
      resolveEncryption: async () => ({ serverIdentityId: 'srv_template_plan', material }),
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials }), executor,
    });
    if (substituted) {
      expect(result).toMatchObject({ kind: 'invalid_request', errorCode: mode === 'plain' ? 'invalid_envelope' : 'invalid_encrypted_envelope' });
      expect(nativeReads).toBe(before);
    } else {
      expect(result.kind).toBe('response');
      if (result.kind !== 'response') throw new Error('Expected native Plan response');
      const execution = mode === 'e2ee' && envelope.v === 2
        ? openExternalActionResponseV2({ envelope: result.response, binding, material, request: envelope })
        : 'execution' in result.response ? result.response.execution : null;
      expect(execution, JSON.stringify(execution)).toMatchObject({ ok: true, result: { desiredRevision: 0, sources: planInput.sources } });
      expect(nativeReads).toBe(before + 1);
    }
  }
});
