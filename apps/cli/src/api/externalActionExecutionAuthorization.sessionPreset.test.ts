import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, expect, it, vi } from 'vitest';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { openExternalActionRequestV2, prepareExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { openExternalActionRequesterAccountContextV1, projectExternalActionRequesterInvocationContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { ManagedAcquireInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { dispatchOriginalAccountAction } from './externalActionExecutionAuthorization';

afterEach(() => vi.restoreAllMocks());

it.each([
  ['plain', true], ['e2ee', true], ['plain', false], ['e2ee', false],
] as const)('keeps %s hidden-controller Session admission scoped to its preset (%s)', async (mode, presetBacked) => {
  const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(79));
  const controller = { machineId: 'hidden-controller', installationId: 'controller-installation' };
  const controllerAccess = { custodian: { accountId: 'company' }, installationPublicKey: encodeBase64(keys.publicKey, 'base64url') };
  const acquisition = ManagedAcquireInputV1Schema.parse({ selection: { kind: 'preset', homeId: 'srv_home', id: 'team-preset', revision: 3 }, controller });
  const target = { kind: 'machine' as const, machineId: controller.machineId };
  const input = SessionSpawnNewInputV2Schema.parse({ executionTarget: { serverId: 'srv_home', machineId: target.machineId },
    directory: { kind: 'path', path: '/repo' }, ...(presetBacked ? { sessionPlacement: { kind: 'preset', homeId: 'srv_home', presetId: 'team-preset' } } : {}),
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } });
  const invocation = projectExternalActionRequesterInvocationContextV1({ actionCaller: { kind: 'host' }, surface: 'ui', authority: 'present_user',
    sessionCreationDefaults: { context: { memberDefaults: {} }, authoredChoices: {},
      managedPresetAcquisition: acquisition, managedPresetControllerAccess: controllerAccess } });
  if (!invocation) throw new Error('Expected captured creation invocation');
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `header.${encode({ sub: 'member', tokenEpoch: 2,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })}.signature`;
  const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(80) };
  const credentials = mode === 'plain' ? { token, encryption: null } : { token,
    encryption: { ...material, publicKey: nacl.box.keyPair.fromSecretKey(material.machineKey).publicKey } };
  const binding = { accountId: 'member', authentication: { kind: 'account' as const, tokenEpoch: 2 }, serverIdentityId: 'srv_home',
    actionId: 'session.spawn_new', requestId: 'preset-session', target };
  const requests: string[] = [];
  let disclosed: unknown;
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    requests.push(path);
    if (path === '/v1/account/encryption') return { status: 200, data: { mode, updatedAt: 1 } };
    if (!presetBacked && path === `/v1/machines/${controller.machineId}`) return { status: 404, data: { error: 'not_found' } };
    throw new Error(`Unexpected Machine inventory or routing read: ${path}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    const path = new URL(String(url)).pathname;
    requests.push(path);
    const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
    if (path.endsWith('/execution-authorization')) return { status: 200, data: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1,
      token: 'session-root', binding: { ...binding, machineId: controller.machineId, installationId: controller.installationId,
        custodianAccountId: 'company', accountEncryptionMode: mode,
        ...(request.envelope.sessionSpawnAdmission?.managedPresetAcquisition
          ? { sessionPresetAcquisition: request.envelope.sessionSpawnAdmission.managedPresetAcquisition } : {}),
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        ...(request.envelope.v === 2 && request.envelope.machineRuntimeDemand ? { machineRuntimeDemand: request.envelope.machineRuntimeDemand } : {}) } }) };
    expect(path).toBe('/v1/actions/session.spawn_new');
    if (!request.executionAuthorization) throw new Error('Expected Home-admitted Session root');
    const opened = openExternalActionRequesterAccountContextV1({ authorization: request.executionAuthorization,
      purpose: { kind: 'external_action' }, machineId: controller.machineId, installationId: controller.installationId,
      serverIdentityId: 'srv_home', installationPrivateKey: keys.secretKey, includeInvocation: true });
    expect(opened).toMatchObject({ credentials: { token }, invocation });
    const execution = { ok: true as const, result: { kind: 'approval_request_created', artifactId: 'session-review', actionId: 'session.spawn_new' } };
    if (request.envelope.v === 2) {
      expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
        envelope: request.envelope, binding, material })?.input).toEqual(input);
      return { status: 200, data: prepareExternalActionResponseV2({ request: request.envelope, binding,
        material, executedMachineId: controller.machineId, randomBytes: nacl.randomBytes, execution }).response };
    }
    expect(request.envelope.input).toEqual(input);
    return { status: 200, data: { v: 1, actionId: 'session.spawn_new', requestId: binding.requestId, execution } };
  });
  const result = await dispatchOriginalAccountAction({ actionId: 'session.spawn_new', input, requestId: binding.requestId,
    target, credentials, serverHttpBaseUrl: 'https://home.example', serverIdentityId: 'srv_home', invocation,
    onRequesterSessionCredentialDisclosure: disclosure => { disclosed = disclosure; return true; } });
  if (!presetBacked) {
    expect(result).toMatchObject({ ok: false, errorCode: 'machine_offline' });
    expect(disclosed).toBeUndefined();
    expect(requests).not.toContain('/v1/actions/session.spawn_new');
    return;
  }
  expect(result).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
  expect(disclosed).toMatchObject({ disposition: 'ordinary_requester', accountId: 'member', machineId: controller.machineId });
  expect(requests.filter(path => path.includes('/machines/') || path.includes('/pools/'))).toEqual([]);
});
