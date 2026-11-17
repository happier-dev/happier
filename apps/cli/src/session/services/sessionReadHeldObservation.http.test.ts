import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { AccountEncryptionCurrentnessResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { V2SessionByIdResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { acquireRequesterAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentnessObservation';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { getSessionTranscript } from './getSessionTranscript';
import { createPluginSessionsInventory, type PluginSessionsInventoryParams } from './pluginSessionsInventory';

const sessionId = 'c123456789012345678901234';
const currentnessPath = '/v1/account/encryption/currentness';

// OWNER-RULINGS 2026-11-16 "Remove overbuilt re-reads": reading a transcript or a plugin Session
// summary is a read, so it borrows the held, push-updated Account observation. Only HTTP and the
// Socket.IO transport are substituted; the observation, Session lookup and projectors stay real.
async function withHeldObservation(run: (count: (path: string) => number) => Promise<void>): Promise<void> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://loopback').pathname;
    requests.push(path);
    response.setHeader('Content-Type', 'application/json');
    if (path === currentnessPath) {
      response.end(JSON.stringify(AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'plain', version: 1,
        updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null })));
    } else if (path === `/v2/sessions/${sessionId}`) {
      response.end(JSON.stringify(V2SessionByIdResponseSchema.parse({ session: createSessionRecordFixture({
        id: sessionId, encryptionMode: 'plain', metadata: '{}',
      }) })));
    } else if (path === `/v1/sessions/${sessionId}/messages`) {
      response.end(JSON.stringify({ messages: [], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null }));
    } else {
      response.writeHead(404).end('{}');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback HTTP address unavailable');
  const base = `http://127.0.0.1:${address.port}`;
  const channel = await createRequesterCurrentnessSocketHarness();
  const holder = acquireRequesterAccountEncryptionCurrentness({ accountId: 'account-held', token, serverBaseUrl: base });
  try {
    await runWithServerHttpBaseUrl(base, async () => {
      await holder.read();
      const before = requests.filter(value => value === currentnessPath).length;
      await run(path => requests.filter(value => value === path).length - (path === currentnessPath ? before : 0));
    });
  } finally {
    await holder.dispose();
    await channel.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

const token = 'session-read-held-fixture';
const credentials = { token, encryption: null } as const;

describe('Session reads borrow the held Account observation', () => {
  it('reads transcripts without a fresh currentness witness per read', async () => {
    await withHeldObservation(async count => {
      for (let index = 0; index < 3; index += 1) {
        await expect(getSessionTranscript({ credentials, idOrPrefix: sessionId, cursor: '0', direction: 'after',
          serverFeaturesSnapshot: { status: 'unsupported', reason: 'endpoint_missing' } }))
          .resolves.toMatchObject({ ok: true, sessionId });
      }
      expect(count(currentnessPath)).toBe(0);
      expect(count(`/v2/sessions/${sessionId}`)).toBe(3);
    });
  });

  it('reuses the caller operation\'s fresh Session record instead of reading it again', async () => {
    await withHeldObservation(async count => {
      const session = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadata: '{}' });
      for (let index = 0; index < 3; index += 1) {
        await expect(getSessionTranscript({ credentials, idOrPrefix: sessionId, cursor: '0', direction: 'after', session,
          serverFeaturesSnapshot: { status: 'unsupported', reason: 'endpoint_missing' } }))
          .resolves.toMatchObject({ ok: true, sessionId });
      }
      expect(count(`/v2/sessions/${sessionId}`)).toBe(0);
      expect(count(`/v1/sessions/${sessionId}/messages`)).toBe(3);
    });
  });

  it('projects plugin Session summaries without a fresh currentness witness per read', async () => {
    await withHeldObservation(async count => {
      const inventory = createPluginSessionsInventory({
        credentials,
        signal: new AbortController().signal,
        currentSessionId: null,
        sessionScopes: [{ access: ['read'] }],
        isCurrent: () => true,
        readStoragePolicy: async () => 'optional',
        // Unused boundaries for summary reads: no external Sessions, input or handle capabilities run here.
        external: {} as PluginSessionsInventoryParams['external'],
        executeMessageAction: async () => { throw new Error('not_used'); },
        createHandleCapabilities: () => ({}) as ReturnType<PluginSessionsInventoryParams['createHandleCapabilities']>,
      });
      for (let index = 0; index < 3; index += 1) {
        await expect(inventory.get(sessionId)).resolves.not.toBeNull();
      }
      expect(count(currentnessPath)).toBe(0);
      expect(count(`/v2/sessions/${sessionId}`)).toBe(3);
    });
  });
});
