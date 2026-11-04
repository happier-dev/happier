import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, expect, it, vi } from 'vitest';
import { getMachineSetupDesiredV1, type MachineMetadataFieldPortV1 } from '@happier-dev/protocol';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { openExternalActionRequesterAccountContextV1, sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createMachineSetupPlanAction } from '@/machines/setup/machineSetupAction';
import { createCliMachineActionTransport } from './machineTransport';

afterEach(() => vi.restoreAllMocks());

it.each(['own', 'shared'] as const)('continues the admitted template update through ordinary %s Account Plan delivery without a requester Machine signing key', async custody => {
  const home = 'https://template-plan.example';
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${encode({ alg: 'none' })}.${encode({ sub: 'recipient', tokenEpoch: 2,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })}.signature`;
  const credentials = { token, encryption: null };
  const target = { kind: 'machine' as const, machineId: 'guest' };
  const setup = { scripts: [{ body: 'echo reviewed', affects: 'none' as const }] };
  const planInput = { homeId: 'srv_template_plan', machineId: 'guest', sources: [{ kind: 'direct' as const, setup }], mode: 'effects' as const };
  const originalActionEnvelope = { v: 1 as const, requestId: 'update-request', target,
    input: { sessionRef: { serverId: 'profile', sessionId: 'copy' }, expectedVersion: '1.1.0', expectedMetadataRevision: 3 } };
  const receiverKeys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(59));
  const custodianAccountId = custody === 'shared' ? 'machine-owner' : 'recipient';
  const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'admitted-template-update', binding: {
    serverIdentityId: 'srv_template_plan', accountId: 'recipient', authentication: { kind: 'account', tokenEpoch: 2 },
    actionId: 'template.updates.apply', requestId: 'update-request', machineId: 'guest', installationId: 'guest-installation',
    custodianAccountId, target, accountEncryptionMode: 'plain', admittedMachineRole: 'manage',
    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(originalActionEnvelope),
    templateRequesterSetupAdmission: { kind: 'software', planInputDigest: computeActionInputApprovalDigestV1('machines.setup.plan', planInput) },
  } });
  const parent = custody === 'shared' ? sealExternalActionRequesterAccountContextV1({ authorization: root,
    credentials: { token }, purpose: { kind: 'external_action' }, installationPublicKey: receiverKeys.publicKey,
    randomBytes: nacl.randomBytes }) : root;
  let nativeReads = 0;
  const metadata: MachineMetadataFieldPortV1 = {
    read: async () => { nativeReads++; return { status: 'ready', metadata: {}, metadataVersion: 0 }; },
    compareAndSwap: async () => { throw new Error('Plan cannot publish metadata'); },
  };
  const native = createCliActionExecutorFromCredentials({ credentials, machineId: 'guest', serverId: 'profile', serverIdentityId: 'srv_template_plan',
    serverApiUrl: home, pluginActionExecutionOwner: 'current_process',
    actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({}) },
    machineSetupPlan: createMachineSetupPlanAction({ machineId: 'guest', homeId: 'srv_template_plan',
      apiMachine: { getMachineSetupDesiredSnapshot: () => getMachineSetupDesiredV1(metadata) },
      acquirePluginRuntimeRegistryLease: async () => { throw new Error('Script-only Plan needs no plugin catalog'); } }),
  });
  const access = { custodian: { accountId: custodianAccountId, displayName: 'Machine owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' };
  const machine = { id: 'guest', kind: 'persistent', active: true, revokedAt: null, replacedByMachineId: null,
    installationId: 'guest-installation', installationPublicKey: Buffer.from(receiverKeys.publicKey).toString('base64'), access };
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (url === `${home}/v1/account/encryption`) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (url === `${home}/v1/machines`) return { status: 200, data: [machine] };
    if (url === `${home}/v1/machines/guest`) return { status: 200, data: { machine } };
    throw new Error(`Unexpected read ${url}`);
  });
  let mints = 0;
  let deliveries = 0;
  vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
    const body = ExternalActionExecutionAuthorizationRequestV1Schema.parse(raw);
    if (url === `${home}/v1/actions/machines.setup.plan/execution-authorization`) {
      mints++;
      expect(body.templateRequesterSetupPlanContinuation).toEqual({ authorization: parent, originalActionEnvelope });
      expect(body.envelope).toMatchObject({ requestId: parent.binding.requestId, input: planInput });
      const { templateRequesterSetupAdmission: _setup, ...planBinding } = parent.binding;
      return { status: 200, data: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'derived-plan', binding: {
        ...planBinding, actionId: 'machines.setup.plan', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(body.envelope),
        templateRequesterSetupPlanAdmission: {
          parentActionId: 'template.updates.apply', parentRequestEnvelopeDigest: parent.binding.requestEnvelopeDigest,
          planInputDigest: parent.binding.templateRequesterSetupAdmission!.planInputDigest },
      } }) };
    }
    expect(url).toBe(`${home}/v1/actions/machines.setup.plan`);
    deliveries++;
    expect(body.executionAuthorization?.binding.templateRequesterSetupPlanAdmission?.parentRequestEnvelopeDigest).toBe(parent.binding.requestEnvelopeDigest);
    if (custody === 'shared') expect(openExternalActionRequesterAccountContextV1({ authorization: body.executionAuthorization,
      purpose: { kind: 'external_action' }, machineId: 'guest', installationId: 'guest-installation',
      serverIdentityId: 'srv_template_plan', installationPrivateKey: receiverKeys.secretKey })).toMatchObject({ token });
    expect(body.envelope.v).toBe(1);
    if (body.envelope.v !== 1) throw new Error('Expected plain Account Plan');
    const execution = await native.execute('machines.setup.plan', body.envelope.input, {
      surface: 'rpc', authority: 'present_user', serverId: 'profile', serverIdentityId: 'srv_template_plan', externalActionTarget: target,
    });
    return { status: 200, data: { v: 1, actionId: 'machines.setup.plan', requestId: body.envelope.requestId, execution } };
  });
  const transport = createCliMachineActionTransport({ credentials, serverId: 'profile', serverIdentityId: 'srv_template_plan', serverHttpBaseUrl: home });
  await expect(transport.callMachineAction({ machineId: 'guest', serverId: 'profile', method: RPC_METHODS.MACHINE_SETUP_PLAN,
    effectActionId: 'machines.setup.plan', request: planInput, exactMachine: true,
    context: { surface: 'cli', authority: 'present_user', serverId: 'profile', serverIdentityId: 'srv_template_plan',
      actionRequestId: 'update-request', externalActionTarget: target, externalActionExecutionAuthorization: parent, originalActionEnvelope },
  })).resolves.toMatchObject({ sources: planInput.sources, desiredRevision: 0 });
  expect({ mints, deliveries, nativeReads }).toEqual({ mints: 1, deliveries: 1, nativeReads: 1 });
});
