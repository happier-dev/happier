import axios from 'axios';
import nacl from 'tweetnacl';
import { x25519 } from '@noble/curves/ed25519';
import { afterEach, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createAccountArtifactStore } from './artifacts/accountArtifactStore';
import { createResourceDataKey } from './encryption/resourceDataKey';
import { encryptWithDataKey } from './encryption';
import { prepareExternalActionRequesterAccountAuthorizationResult } from './externalActionExecutionAuthorization';

afterEach(() => vi.restoreAllMocks());

it.each(['plain', 'e2ee'] as const)('opens owned deployment content with the ordinary issuer\'s admitted %s mode', async mode => {
  const authentication = { kind: 'account' as const, tokenEpoch: 1 };
  const token = `e30.${Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 1,
    provenance: { v: 1, kind: 'account', authority: 'present_user' },
  })).toString('base64url')}.signature`;
  const machineKey = new Uint8Array(32).fill(21);
  const material = { type: 'dataKey' as const, machineKey };
  const credentials = { token, encryption: mode === 'e2ee'
    ? { ...material, publicKey: x25519.getPublicKey(machineKey) } : null };
  const target = { kind: 'machine' as const, machineId: 'controller' };
  const args = { actionId: 'artifact.delete', input: { artifactId: 'receipt', expectedRevision: { headerVersion: 1, bodyVersion: 1 } },
    requestId: 'mode-request', target, machineId: 'controller', accountId: 'requester',
    accountEncryptionMode: mode, tokenEpochHint: 1, token, ...(mode === 'e2ee' ? { material } : {}),
    serverId: 'home-profile', serverIdentityId: 'srv_mode_home', serverHttpBaseUrl: 'https://mode-home.test',
    installationId: 'installation', privateKey: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(18)).secretKey };
  // Home's HTTP mint is the boundary; retain the real ordinary issuer and signed HTTP projection.
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
    const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
    return { status: 200, data: { v: 1, token: 'home-mode-proof', binding: {
      serverIdentityId: args.serverIdentityId, accountId: args.accountId, authentication, actionId: args.actionId,
      requestId: args.requestId, target, machineId: args.machineId, custodianAccountId: args.accountId,
      installationId: args.installationId, accountEncryptionMode: mode, admittedMachineRole: 'manage',
      ...(request.envelope.v === 2 ? { machineRuntimeDemand: request.envelope.machineRuntimeDemand } : {}),
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
    } } };
  });
  const issued = await prepareExternalActionRequesterAccountAuthorizationResult(args);
  expect(issued).not.toHaveProperty('requiredFact');
  if (!('authorization' in issued)) throw new Error(`Issuer refused ${issued.phase}:${issued.requiredFact}`);
  const prepared = issued.authorization;
  if (!prepared.requesterHttpProjection) throw new Error('Expected admitted requester HTTP authority');
  const http = prepared.requesterHttpProjection;
  const resource = await createResourceDataKey({ credentials, mode });
  const seal = (value: unknown) => resource.mode === 'plain' ? encodePlainArtifactStoredContent(value)
    : Buffer.from(encryptWithDataKey(value, resource.dataKey)).toString('base64');
  vi.spyOn(axios, 'get').mockImplementation(async (_url, config) => {
    expect(config?.headers).toMatchObject({ 'x-happier-action-execution-authorization': 'home-mode-proof' });
    expect(config?.headers?.Authorization).toBeUndefined();
    return { status: 200, data: { id: 'receipt', ownerAccountId: 'requester', access: 'owner', encryptionMode: mode,
      dataEncryptionKey: resource.dataEncryptionKey ?? ARTIFACT_PLAIN_DATA_KEY_MARKER,
      header: seal({ kind: 'deployment.receipt.v1' }), body: seal({ body: 'owned deployment' }),
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
  });
  const store = createAccountArtifactStore({ credentials,
    getAccountEncryptionMode: async () => { throw new Error('Signed work must not borrow installed Account mode'); } });
  await expect(store.read('receipt', { prepareRecipients: false, includeSharedAudience: false,
    authorizationHeaders: async request => {
      const headers = await http.createRequestHeaders({ ...request, effectActionId: args.actionId });
      if (!headers) throw new Error('Expected signed request');
      return headers;
    } })).resolves.toMatchObject({ artifactId: 'receipt', body: 'owned deployment' });
});
