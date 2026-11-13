import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';

import { createApiSessionSocketStub, type ApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';

const sockets = vi.hoisted(() => ({ connect: vi.fn() }));
// The Account socket and the Home HTTP API are the boundaries; the observation's feed follower stays real.
vi.mock('@/api/session/sockets', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/session/sockets')>(),
  createUserScopedSocketConnection: sockets.connect,
}));

import { acquireRequesterAccountEncryptionCurrentness } from './accountEncryptionCurrentnessObservation';

afterEach(() => { vi.restoreAllMocks(); });

describe('requester Account follow observation wakes', () => {
  it('does not read the change feed for a wake whose routed kinds its follow readers never consume', async () => {
    let socket: ApiSessionSocketStub | undefined;
    sockets.connect.mockImplementation(() => {
      socket = createApiSessionSocketStub({ connected: true });
      return { socket, transport: createSocketTransportAdapter(socket) };
    });
    let cursor = 0;
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.includes('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
      } };
      if (url.includes('/v2/changes')) return { status: 200, data: { changes: [], nextCursor: cursor } };
      throw new Error(`Unexpected boundary read: ${url}`);
    });
    const feedReads = () => get.mock.calls.filter(([url]) => String(url).includes('/v2/changes')).length;
    const observation = acquireRequesterAccountEncryptionCurrentness({
      accountId: 'account-follow-wakes', token: 'token-follow-wakes', serverBaseUrl: 'http://home.test',
    });
    const release = observation.subscribeConnectedAccounts(() => {});
    try {
      await vi.waitFor(() => expect(socket).toBeDefined());
      socket!.trigger('connect');
      await vi.waitFor(() => expect(feedReads()).toBeGreaterThan(0));
      await new Promise<void>(resolve => setTimeout(resolve, 10));
      const baseline = feedReads();
      // First-boot plugin availability claims: one pluginDomain wake each.
      for (let n = 0; n < 5; n += 1) {
        cursor += 1;
        socket!.trigger('update', { id: `wake-${n}`, seq: cursor, createdAt: 1,
          body: { t: 'account-change', changeKinds: ['pluginDomain'], entityIds: [`pluginDomain/p${n}/availability`] } });
        await new Promise<void>(resolve => setTimeout(resolve, 5));
      }
      expect(feedReads() - baseline).toBe(0);
      cursor += 1;
      socket!.trigger('update', { id: 'wake-account', seq: cursor, createdAt: 1,
        body: { t: 'account-change', changeKinds: ['account'], entityIds: ['@happier/account/connected-purposes/v1/catalog'] } });
      await vi.waitFor(() => expect(feedReads() - baseline).toBe(1));
    } finally {
      release();
      await observation.dispose();
    }
  });
});
