import tweetnacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createPlainSessionOwnerMetadataEnvelopeV1,
  createSessionOwnerMetadataV1,
  openSessionOwnerMetadataEnvelopeV1,
  projectSessionSharedMetadataV1,
  sealEncryptedDataKeyEnvelopeV1,
  sealSessionOwnerMetadataEnvelopeV1,
} from '@happier-dev/protocol';

import {
  fetchSessionMetadataV2,
} from './sessionHandoffMetadata';
import { decryptDataKeyBase64, encryptDataKeyBase64 } from './rpcCrypto';
import { encryptLegacyBase64 } from './messageCrypto';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const observation = {
  v: 1,
  qualifiedLinkIdentity: {
    v: 1,
    agent: {
      pluginId: 'acme.external-session-live',
      localId: 'fixture-agent',
    },
    source: {
      kind: 'fixtureLive',
      contractVersion: 1,
    },
  },
  linkGeneration: 'link-generation-1',
  status: 'working',
  observedAtMs: 1_000,
  expiresAtMs: 31_000,
} as const;

function createOwnerMetadata() {
  const created = createSessionOwnerMetadataV1({
    metadata: {
      externalAgentObservationV1: observation,
    },
  });
  if (!created.ok) {
    throw new Error(`Failed to create owner metadata fixture: ${created.unsupportedFields.join(', ')}`);
  }
  return created.ownerMetadata;
}

function createSessionRow(overrides: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: 'session-1',
    seq: 1,
    metadata: 'unused',
    metadataVersion: 2,
    metadataLayoutVersion: 0,
    agentState: null,
    agentStateVersion: 0,
    createdAt: 1,
    updatedAt: 2,
    meaningfulActivityAt: 2,
    active: true,
    activeAt: 2,
    latestTurnStatus: null,
    lastRuntimeIssue: null,
    encryptionMode: 'e2ee',
    dataEncryptionKey: null,
    share: null,
    ...overrides,
  };
}

function installSessionResponses(params: Readonly<{
  listRow: Record<string, unknown>;
  detailRow: Record<string, unknown>;
}>): { requests: Array<{ method: string; path: string; headers: Record<string, string>; body: unknown }> } {
  const requests: Array<{
    method: string;
    path: string;
    headers: Record<string, string>;
    body: unknown;
  }> = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';
    requests.push({
      method,
      path: url.pathname,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null,
    });
    if (url.pathname === '/v2/sessions') {
      return new Response(JSON.stringify({
        sessions: [{ ...params.listRow,
          documents: 'omitted', metadataAudience: 'owner', agentStateDocument: 'omitted',
          metadata: undefined, ownerMetadata: undefined, agentState: undefined,
        }],
        nextCursor: null,
        hasNext: false,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/v2/sessions/session-1') {
      if (method === 'PATCH') {
        return new Response(JSON.stringify({
          success: true,
          metadataLayoutVersion: 1,
          sharedMetadata: { version: params.detailRow.metadataVersion },
          agentState: { version: params.detailRow.agentStateVersion },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ session: params.detailRow }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }) as typeof globalThis.fetch;
  return { requests };
}

describe('fetchSessionMetadataV2', () => {
  it('preserves layout-zero session metadata decryption', async () => {
    const sessionDataKey = Uint8Array.from({ length: 32 }, () => 7);
    const metadata = {
      path: '/Users/fixture/workspace',
      externalAgentObservationV1: observation,
    };
    const row = createSessionRow({
      metadata: encryptDataKeyBase64(metadata, sessionDataKey),
      dataEncryptionKey: Buffer.from(sessionDataKey).toString('base64'),
    });
    installSessionResponses({ listRow: row, detailRow: row });

    await expect(fetchSessionMetadataV2({
      baseUrl: 'https://test.invalid',
      token: 'token',
      sessionId: 'session-1',
      machineKeys: [],
    })).resolves.toEqual(metadata);
  });

  it('opens layout-one E2EE shared and owner envelopes into the canonical owner compatibility view', async () => {
    const accountMachineKey = Uint8Array.from({ length: 32 }, () => 11);
    const sessionDataKey = Uint8Array.from({ length: 32 }, () => 13);
    const sharedMetadata = projectSessionSharedMetadataV1({
      metadata: { summary: { text: 'Shared summary', updatedAt: 5 } },
    });
    const ownerMetadata = createOwnerMetadata();
    const encryptedDataKey = sealEncryptedDataKeyEnvelopeV1({
      dataKey: sessionDataKey,
      recipientPublicKey: tweetnacl.box.keyPair.fromSecretKey(accountMachineKey).publicKey,
      randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index + 1),
    });
    const row = createSessionRow({
      metadataLayoutVersion: 1,
      metadata: encryptDataKeyBase64(sharedMetadata, sessionDataKey),
      ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({
        material: { type: 'dataKey', machineKey: accountMachineKey },
        ownerMetadata,
        randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index + 31),
      }),
      dataEncryptionKey: Buffer.from(encryptedDataKey).toString('base64'),
    });
    installSessionResponses({ listRow: row, detailRow: row });

    await expect(fetchSessionMetadataV2({
      baseUrl: 'https://test.invalid',
      token: 'token',
      sessionId: 'session-1',
      machineKeys: [accountMachineKey],
    })).resolves.toEqual(expect.objectContaining({
      summary: { text: 'Shared summary', updatedAt: 5 },
      externalAgentObservationV1: observation,
    }));
  });

  it('opens layout-one legacy-account owner envelopes through the canonical compatibility view', async () => {
    const accountSecret = Uint8Array.from({ length: 32 }, () => 29);
    const sessionSecret = Uint8Array.from({ length: 32 }, () => 31);
    const sharedMetadata = projectSessionSharedMetadataV1({
      metadata: { summary: { text: 'Legacy shared summary', updatedAt: 6 } },
    });
    const row = createSessionRow({
      metadataLayoutVersion: 1,
      metadata: encryptLegacyBase64(sharedMetadata, sessionSecret),
      ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({
        material: { type: 'legacy', secret: accountSecret },
        ownerMetadata: createOwnerMetadata(),
        randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index + 47),
      }),
      dataEncryptionKey: Buffer.from(sessionSecret).toString('base64'),
    });
    installSessionResponses({ listRow: row, detailRow: row });
    const access = {
      baseUrl: 'https://test.invalid',
      token: 'token',
      sessionId: 'session-1',
      machineKeys: [],
      accountEncryptionMaterials: [{ type: 'legacy', secret: accountSecret }] as const,
    };

    await expect(fetchSessionMetadataV2(access)).resolves.toEqual(expect.objectContaining({
      summary: { text: 'Legacy shared summary', updatedAt: 6 },
      externalAgentObservationV1: observation,
    }));
  });

  it('opens layout-one plain envelopes without Account E2EE material', async () => {
    const sharedMetadata = projectSessionSharedMetadataV1({
      metadata: { summary: { text: 'Plain shared summary', updatedAt: 8 } },
    });
    const row = createSessionRow({
      metadataLayoutVersion: 1,
      encryptionMode: 'plain',
      metadata: JSON.stringify(sharedMetadata),
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(createOwnerMetadata()),
      dataEncryptionKey: null,
    });
    installSessionResponses({ listRow: row, detailRow: row });

    await expect(fetchSessionMetadataV2({
      baseUrl: 'https://test.invalid',
      token: 'token',
      sessionId: 'session-1',
      accountEncryptionMode: 'plain',
    })).resolves.toEqual(expect.objectContaining({
      summary: { text: 'Plain shared summary', updatedAt: 8 },
      externalAgentObservationV1: observation,
    }));
  });

  it('fails closed when the declared Account mode and owner envelope kind differ', async () => {
    const accountMachineKey = Uint8Array.from({ length: 32 }, () => 17);
    const sharedMetadata = projectSessionSharedMetadataV1({ metadata: {} });
    const row = createSessionRow({
      metadataLayoutVersion: 1,
      encryptionMode: 'plain',
      metadata: JSON.stringify(sharedMetadata),
      ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({
        material: { type: 'dataKey', machineKey: accountMachineKey },
        ownerMetadata: createOwnerMetadata(),
        randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index + 61),
      }),
      dataEncryptionKey: null,
    });
    installSessionResponses({ listRow: row, detailRow: row });

    await expect(fetchSessionMetadataV2({
      baseUrl: 'https://test.invalid',
      token: 'token',
      sessionId: 'session-1',
      accountEncryptionMode: 'plain',
    })).rejects.toThrow(/account_mode_mismatch/);
  });
});
