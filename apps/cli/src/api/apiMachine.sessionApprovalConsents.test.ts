import '@/testkit/async/mockNodeTimers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ArtifactReadBatchInputV1Schema,
  ArtifactReadBatchResponseV1Schema,
} from '@happier-dev/protocol/artifacts/artifactAccessV1';
import {
  buildSessionApprovalConsentsHeaderV1,
  SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1,
} from '@happier-dev/protocol/actions/sessionApprovalConsentsV1';
import {
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  encodePlainArtifactStoredContent,
} from '@happier-dev/protocol/storage/artifactStoredContent';
import * as persistence from '@/persistence';
import type { Machine } from '@/api/types';
import { readHeldSessionApprovalConsents } from '@/settings/profiles/sessionApprovalConsentsCatalog';
import { artifactKindListResponse } from '@/testkit/http/artifactHome';
import {
  bindApiSessionSocketMock,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import { ApiMachineClient } from './apiMachine';

const { mockIo, axiosGet, axiosPost } = vi.hoisted(() => ({
  mockIo: vi.fn(),
  axiosGet: vi.fn(),
  axiosPost: vi.fn(),
}));
// Network transports and on-disk credentials are system boundaries; the consent owner stays real.
vi.mock('socket.io-client', () => ({ io: mockIo }));
vi.mock('axios', () => ({
  default: {
    get: axiosGet,
    post: axiosPost,
    defaults: {},
    isAxiosError: vi.fn(() => false),
  },
  isAxiosError: vi.fn(() => false),
}));
vi.mock('@/persistence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/persistence')>()),
  readAccountChangesCursor: vi.fn(async () => 0),
}));

afterEach(() => vi.restoreAllMocks());

describe('ApiMachineClient Session approval rows', () => {
  it('refreshes the held rows of Sessions forwarding Actions here when their consent record changes', async () => {
    const sessionId = 'forwarding-session';
    const credentials = {
      token: `e30.${Buffer.from(JSON.stringify({ sub: 'consent-daemon-account' })).toString('base64url')}.signature`,
      encryption: null,
    };
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(
      credentials,
    );
    vi.spyOn(persistence, 'readStoredCredentialsForServerId').mockResolvedValue(
      credentials,
    );
    bindApiSessionSocketMock(mockIo, createApiSessionSocketStub());
    const machine: Machine = {
      id: 'consent-machine',
      encryptionMode: 'plain',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };
    const row = {
      actionId: 'machines.list',
      audience: 'agent',
      mode: 'ask_first',
    } as const;
    const stored = () => ({
      id: 'consents-1',
      ownerAccountId: 'consent-daemon-account',
      access: 'owner',
      encryptionMode: 'plain',
      publicAudience: 'none',
      kind: 'other',
      kindHint: SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1,
      header: encodePlainArtifactStoredContent(
        buildSessionApprovalConsentsHeaderV1(sessionId),
      ),
      body: encodePlainArtifactStoredContent({
        body: JSON.stringify({
          v: 1,
          kind: SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1,
          sessionId,
          rows: [row],
        }),
      }),
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      headerVersion: 1,
      bodyVersion: 1,
      seq: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    let wake: 'unrelated' | 'consent' = 'unrelated';
    const consentReads: string[] = [];
    axiosGet.mockImplementation(async (url: string) => {
      const parsed = new URL(url);
      const path = parsed.pathname;
      if (path === '/v1/account/profile')
        return { status: 200, data: { id: 'consent-daemon-account' } };
      if (path === '/v2/changes')
        return {
          status: 200,
          data: {
            changes: [
              {
                cursor: 1,
                kind: 'artifact',
                entityId: wake === 'consent' ? 'consents-1' : 'other-artifact',
                changedAt: 1,
                hint: {
                  artifactKinds: [
                    wake === 'consent'
                      ? `v1:other:${SESSION_APPROVAL_CONSENTS_ARTIFACT_KIND_V1}`
                      : 'v1:other:unrelated.v1',
                  ],
                },
              },
            ],
            nextCursor: 1,
          },
        };
      if (path === '/v1/account/encryption/currentness')
        return {
          status: 200,
          data: {
            mode: 'plain',
            version: 1,
            signingKeyFingerprint: null,
            contentKeyFingerprint: null,
            updatedAt: 1,
          },
        };
      if (path === '/v1/account/encryption')
        return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/artifacts') {
        consentReads.push(parsed.searchParams.get('approvalSessionIds') ?? '');
        const { body: _body, ...header } = stored();
        return { status: 200, data: artifactKindListResponse([header]) };
      }
      throw new Error(`Unexpected consent refresh request: ${path}`);
    });
    axiosPost.mockImplementation(async (url: string, body: unknown) => {
      const path = new URL(url).pathname;
      if (path !== '/v1/artifacts/read')
        throw new Error(`Unexpected consent refresh POST: ${path}`);
      return {
        status: 200,
        data: ArtifactReadBatchResponseV1Schema.parse({
          items: ArtifactReadBatchInputV1Schema.parse(body).artifactIds.map(
            (artifactId) => ({
              artifactId,
              ok: true,
              artifact: stored(),
              recipientCensus: null,
            }),
          ),
        }),
      };
    });
    // A forwarded Action admitted earlier holds this Session's rows (none yet) in the daemon process.
    const held = () =>
      readHeldSessionApprovalConsents({
        token: credentials.token,
        sessionId,
        store: () => ({ list: async () => ({ items: [] }) }),
      });
    expect(await held()).toEqual({ sessionId, rows: [] });
    const client = new ApiMachineClient(credentials.token, machine);
    client.onConnectedServicesProjection(async () => {});
    const catchUp = () =>
      (
        client as unknown as {
          syncChangesOnConnect(options: { reason: 'live' }): Promise<void>;
        }
      ).syncChangesOnConnect({ reason: 'live' });
    try {
      await catchUp();
      expect(consentReads).toEqual([]);
      expect(await held()).toEqual({ sessionId, rows: [] });
      // The person sets the row to Ask first from their client; the record's change wakes the daemon.
      wake = 'consent';
      await catchUp();
      expect(consentReads).toEqual([JSON.stringify([sessionId])]);
      expect(await held()).toEqual({ sessionId, rows: [row] });
    } finally {
      await client.shutdown();
    }
  });
});
