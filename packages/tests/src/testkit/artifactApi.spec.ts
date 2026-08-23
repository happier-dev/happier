import { describe, expect, it, vi } from 'vitest';

import { deriveBoxPublicKeyFromSeed } from '@happier-dev/protocol';

import type { CliAccessKey } from './cliAccessKey';
import {
  buildEncryptedArtifactCreateRequestForCliAccessKey,
  buildEncryptedArtifactUpdateRequestForCliAccessKey,
  decodeEncryptedArtifactJsonBase64ForCliAccessKey,
  updateEncryptedArtifactViaApi,
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

  it('re-encrypts versioned artifact updates with the artifact data key', () => {
    const cliAccessKey = createDataKeyAccessKey(new Uint8Array(32).fill(11));
    const created = buildEncryptedArtifactCreateRequestForCliAccessKey({
      artifactId: 'artifact-3',
      headerJson: { v: 1, kind: 'target_action_approval.v1', approvalStatus: 'open' },
      bodyJson: { body: JSON.stringify({ status: 'open' }) },
      cliAccessKey,
      dataEncryptionKeyBytes: new Uint8Array(32).fill(6),
      randomBytes: deterministicRandomBytes,
    });

    const update = buildEncryptedArtifactUpdateRequestForCliAccessKey({
      artifact: {
        headerVersion: 3,
        bodyVersion: 4,
        dataEncryptionKey: created.dataEncryptionKey,
      },
      cliAccessKey,
      headerJson: { v: 1, kind: 'target_action_approval.v1', approvalStatus: 'approved' },
      bodyJson: { body: JSON.stringify({ status: 'approved' }) },
    });

    expect(update.expectedHeaderVersion).toBe(3);
    expect(update.expectedBodyVersion).toBe(4);
    if (!update.header || !update.body) throw new Error('Expected both encrypted update fields');
    expect(
      decodeEncryptedArtifactJsonBase64ForCliAccessKey<Record<string, unknown>>({
        encryptedJsonBase64: update.header,
        dataEncryptionKeyBase64: created.dataEncryptionKey,
        cliAccessKey,
      }),
    ).toEqual({ v: 1, kind: 'target_action_approval.v1', approvalStatus: 'approved' });
    expect(
      decodeEncryptedArtifactJsonBase64ForCliAccessKey<{ body: string }>({
        encryptedJsonBase64: update.body,
        dataEncryptionKeyBase64: created.dataEncryptionKey,
        cliAccessKey,
      }),
    ).toEqual({ body: JSON.stringify({ status: 'approved' }) });
  });

  it('sends encrypted artifact update ciphertext under the canonical update field names', async () => {
    const cliAccessKey = createDataKeyAccessKey(new Uint8Array(32).fill(12));
    const created = buildEncryptedArtifactCreateRequestForCliAccessKey({
      artifactId: 'artifact-4',
      headerJson: { v: 1, kind: 'target_action_approval.v1', approvalStatus: 'open' },
      bodyJson: { body: JSON.stringify({ status: 'open' }) },
      cliAccessKey,
      dataEncryptionKeyBytes: new Uint8Array(32).fill(7),
      randomBytes: deterministicRandomBytes,
    });
    const fetch = vi.fn(async () => new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetch);
    try {
      await expect(updateEncryptedArtifactViaApi({
        baseUrl: 'https://account.example.test',
        token: 'present-user-token',
        artifact: {
          id: 'artifact-4',
          header: created.header,
          body: created.body,
          dataEncryptionKey: created.dataEncryptionKey,
          headerVersion: 3,
          bodyVersion: 4,
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
        },
        cliAccessKey,
        headerJson: { v: 1, kind: 'target_action_approval.v1', approvalStatus: 'approved' },
        bodyJson: { body: JSON.stringify({ status: 'approved' }) },
      })).resolves.toMatchObject({ success: true });

      const init = fetch.mock.calls[0]?.[1] as RequestInit | undefined;
      const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(requestBody).toMatchObject({
        expectedHeaderVersion: 3,
        expectedBodyVersion: 4,
        header: expect.any(String),
        body: expect.any(String),
      });
      expect(requestBody.header).not.toBe(created.header);
      expect(requestBody.body).not.toBe(created.body);
      expect(
        decodeEncryptedArtifactJsonBase64ForCliAccessKey<Record<string, unknown>>({
          encryptedJsonBase64: String(requestBody.header),
          dataEncryptionKeyBase64: created.dataEncryptionKey,
          cliAccessKey,
        }),
      ).toEqual({ v: 1, kind: 'target_action_approval.v1', approvalStatus: 'approved' });
      expect(
        decodeEncryptedArtifactJsonBase64ForCliAccessKey<{ body: string }>({
          encryptedJsonBase64: String(requestBody.body),
          dataEncryptionKeyBase64: created.dataEncryptionKey,
          cliAccessKey,
        }),
      ).toEqual({ body: JSON.stringify({ status: 'approved' }) });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
