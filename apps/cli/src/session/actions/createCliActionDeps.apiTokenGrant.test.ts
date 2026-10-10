import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_TOKEN_FULL_GRANT_V1, type ActionExecutorContext } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationV1Schema, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createCliActionDeps } from './createCliActionDeps';

describe('CLI grant source attribution', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads the exact Session owner using requester-signed HTTP, never the daemon bearer', async () => {
    const sessionId = 'c' + '1'.repeat(24);
    const actionId = 'session.transcript.get' as const;
    const target = { kind: 'machine' as const, machineId: 'reader-machine' };
    const grant = { ...API_TOKEN_FULL_GRANT_V1, targets: { sessions: [], machines: ['reader-machine', 'source-machine'] } };
    const envelope = { v: 1 as const, requestId: 'source-read', target, input: { sessionId } };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'requester-proof', binding: {
      accountId: 'requester', principalId: 'principal', credentialId: 'credential', grant,
      serverIdentityId: 'home', machineId: target.machineId, custodianAccountId: 'custodian', installationId: 'installation',
      actionId, requestId: envelope.requestId, target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      accountEncryptionMode: 'plain',
    } });
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
    const context: ActionExecutorContext = { surface: 'api', authority: 'account_automation', externalActionTarget: target,
      externalActionCredential: { accountId: 'requester', principalId: 'principal', credentialId: 'credential', grant },
      externalActionExecutionAuthorization: authorization };
    const network = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      const path = new URL(String(url)).pathname;
      expect(config?.headers).not.toHaveProperty('Authorization');
      expect(config?.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(authorization.token);
      expect(verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token, effectActionId: actionId,
        target, installationId: 'installation', requestId: envelope.requestId, method: 'GET', path,
        publicKey: keys.publicKey, signature: String(config?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]) })).toBe(true);
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: createSessionRecordFixture({
        id: sessionId, encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'source-machine' }),
      }) } };
      throw new Error(`Unexpected network path: ${path}`);
    });
    const deps = createCliActionDeps({ token: 'daemon-bearer', credentials: { token: 'daemon-bearer', encryption: null },
      sessionId: 'bound-session', mode: 'plain', ctx: null, serverIdentityId: 'home',
      externalActionMachineRequestPrivateKey: keys.secretKey, externalActionMachineInstallationId: 'installation' });
    expect(await deps.resolveApiTokenGrantSessionMachineId!({ actionId, sessionId, context })).toBe('source-machine');
    expect(network).toHaveBeenCalled();
    network.mockClear();
    await expect(deps.resolveApiTokenGrantSessionMachineId!({ actionId, sessionId,
      context: { ...context, externalActionExecutionAuthorization: undefined } })).rejects.toThrow('authorization unavailable');
    expect(network).not.toHaveBeenCalled();
  });
});
