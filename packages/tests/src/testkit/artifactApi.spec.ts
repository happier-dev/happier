import { describe, expect, it } from 'vitest';

import { deriveBoxPublicKeyFromSeed } from '@happier-dev/protocol';

import type { CliAccessKey } from './cliAccessKey';
import {
  buildEncryptedArtifactCreateRequestForCliAccessKey,
  decodeEncryptedArtifactJsonBase64ForCliAccessKey,
} from './artifactApi';

function createDataKeyAccessKey(machineKey: Uint8Array): CliAccessKey {
  const publicKey = deriveBoxPublicKeyFromSeed(machineKey);
  return {
    token: 'token',
    encryption: {
      publicKey: Buffer.from(publicKey).toString('base64'),
      machineKey: Buffer.from(machineKey).toString('base64'),
    },
  };
}

function deterministicRandomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = (index + 1) & 0xff;
  }
  return out;
}

describe('artifactApi testkit encryption helpers', () => {
  it('builds approval artifacts decryptable by the CLI/UI data-key account', () => {
    const cliAccessKey = createDataKeyAccessKey(new Uint8Array(32).fill(9));
    const dataEncryptionKeyBytes = new Uint8Array(32).fill(4);
    const header = {
      v: 1,
      kind: 'approval_request.v1',
      title: 'Session status',
      approvalStatus: 'open',
      actionId: 'session.status.get',
    };
    const body = {
      body: JSON.stringify({
        v: 1,
        status: 'open',
        actionId: 'session.status.get',
      }),
    };

    const request = buildEncryptedArtifactCreateRequestForCliAccessKey({
      artifactId: 'artifact-1',
      headerJson: header,
      bodyJson: body,
      cliAccessKey,
      dataEncryptionKeyBytes,
      randomBytes: deterministicRandomBytes,
    });

    expect(request.id).toBe('artifact-1');
    expect(request.header).not.toBe(Buffer.from(JSON.stringify(header), 'utf8').toString('base64'));
    expect(request.body).not.toBe(Buffer.from(JSON.stringify(body), 'utf8').toString('base64'));
    expect(
      decodeEncryptedArtifactJsonBase64ForCliAccessKey<Record<string, unknown>>({
        encryptedJsonBase64: request.header,
        dataEncryptionKeyBase64: request.dataEncryptionKey,
        cliAccessKey,
      }),
    ).toEqual(header);
    expect(
      decodeEncryptedArtifactJsonBase64ForCliAccessKey<Record<string, unknown>>({
        encryptedJsonBase64: request.body,
        dataEncryptionKeyBase64: request.dataEncryptionKey,
        cliAccessKey,
      }),
    ).toEqual(body);
  });

  it('unwraps serialized JSON values written by UI artifact encryption', () => {
    const cliAccessKey = createDataKeyAccessKey(new Uint8Array(32).fill(10));
    const wrappedBody = {
      __happierSerializedJsonValueV1: true,
      type: 'json',
      value: {
        body: JSON.stringify({ status: 'executed' }),
      },
    };

    const request = buildEncryptedArtifactCreateRequestForCliAccessKey({
      artifactId: 'artifact-2',
      headerJson: { v: 1, kind: 'approval_request.v1', title: 'Session status' },
      bodyJson: wrappedBody,
      cliAccessKey,
      dataEncryptionKeyBytes: new Uint8Array(32).fill(5),
      randomBytes: deterministicRandomBytes,
    });

    expect(
      decodeEncryptedArtifactJsonBase64ForCliAccessKey<{ body: string }>({
        encryptedJsonBase64: request.body,
        dataEncryptionKeyBase64: request.dataEncryptionKey,
        cliAccessKey,
      }),
    ).toEqual(wrappedBody.value);
  });
});
