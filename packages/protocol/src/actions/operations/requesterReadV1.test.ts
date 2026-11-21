import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { computeExternalActionRequestEnvelopeDigestV1 } from '../externalActionExecutionAuthorization.js';
import { computeMachineInstallationKeyFingerprintV1 } from '../../machines/identity/installationKeySchemas.js';
import type { ExternalActionExecutionAuthorizationRequestV1 } from '../externalActionApi.js';
import { readRequesterActionOperationV1, readRequesterOperationAddressV1 } from './requesterReadV1.js';
import { ACTION_OPERATION_GET_ACTION_ID_V1 } from './actionIdsV1.js';

const executor = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(51));
const substitute = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(52));

// Home is the genuine boundary: it mints the signed root and delivers a key it chooses.
function readWith(deliveredKey: Uint8Array, pinnedKey: Uint8Array) {
  const requests: string[] = [];
  const result = readRequesterActionOperationV1({
    input: readRequesterOperationAddressV1(ACTION_OPERATION_GET_ACTION_ID_V1,
      { serverId: 'srv_home', machineId: 'executor', operationId: 'operation-1' })!,
    accountId: 'reader',
    serverIdentityId: 'srv_home',
    tokenEpoch: 1,
    requestId: 'read-1',
    randomBytes: tweetnacl.randomBytes,
    request: async (
      path: string,
      body: ExternalActionExecutionAuthorizationRequestV1,
    ) => {
      requests.push(path);
      if (!path.endsWith('/execution-authorization'))
        return { status: 200, value: {} };
      return {
        status: 200,
        value: {
          v: 1,
          token: 'operation-read',
          binding: {
            accountId: 'reader',
            custodianAccountId: 'reader',
            authentication: { kind: 'account', tokenEpoch: 1 },
            serverIdentityId: 'srv_home',
            machineId: 'executor',
            installationId: 'installation',
            accountEncryptionMode: 'e2ee',
            actionId: 'action.operations.get',
            requestId: 'read-1',
            target: { kind: 'machine', machineId: 'executor' },
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(
              body.envelope,
            ),
            requesterOperationRead: true,
          },
          requesterOperationReadInstallationPublicKey:
            Buffer.from(deliveredKey).toString('base64url'),
        },
      };
    },
    readExecutorKeyPin: async (machineId) => ({
      machineId,
      installationKeyFingerprint:
        computeMachineInstallationKeyFingerprintV1(pinnedKey),
    }),
  });
  return { result, requests };
}

describe('requester operation read executor key', () => {
  it('refuses a Home-substituted executor key before anything is sealed or sent', async () => {
    const { result, requests } = readWith(
      substitute.publicKey,
      executor.publicKey,
    );
    await expect(result).resolves.toMatchObject({
      ok: false,
      errorCode: 'installation_key_mismatch',
    });
    expect(requests).toEqual([
      '/v1/actions/action.operations.get/execution-authorization',
    ]);
  });

  it('sends the sealed read when the delivered key matches the executor content', async () => {
    const { result, requests } = readWith(
      executor.publicKey,
      executor.publicKey,
    );
    await result;
    expect(requests).toEqual([
      '/v1/actions/action.operations.get/execution-authorization',
      '/v1/actions/action.operations.get',
    ]);
  });
});
