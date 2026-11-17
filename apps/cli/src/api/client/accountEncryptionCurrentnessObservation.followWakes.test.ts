import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import type { ChangeEntry } from '@happier-dev/protocol/changes';

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
      // Plugin availability and Machine writes do not affect connected-account readers.
      for (let n = 0; n < 5; n += 1) {
        cursor += 1;
        socket!.trigger('update', { id: `wake-${n}`, seq: cursor, createdAt: 1,
          body: { t: 'account-change', changeKinds: [n === 4 ? 'machine' : 'pluginDomain'], entityIds: [`pluginDomain/p${n}/availability`] } });
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

  it('demands and classifies durable Machine changes for availability readers on the shared Account cursor', async () => {
    let socket: ApiSessionSocketStub | undefined;
    sockets.connect.mockImplementation(() => {
      socket = createApiSessionSocketStub({ connected: true });
      return { socket, transport: createSocketTransportAdapter(socket) };
    });
    const changes: ChangeEntry[] = [];
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.includes('/v2/changes')) {
        const after = Number(new URL(url).searchParams.get('after') ?? 0);
        return { status: 200, data: { changes: changes.filter(change => change.cursor > after), nextCursor: changes.length } };
      }
      throw new Error(`Unexpected boundary read: ${url}`);
    });
    const feedReads = () => get.mock.calls.filter(([url]) => String(url).includes('/v2/changes')).length;
    const observation = acquireRequesterAccountEncryptionCurrentness({
      accountId: 'account-machine-assignment-wakes', token: 'token-machine-assignment-wakes', serverBaseUrl: 'http://home.test',
    });
    const machines: string[] = [];
    const release = observation.subscribeRunFollowAvailability(change => {
      if (change.kind === 'machine') machines.push(change.machineId);
    });
    let detachOwner: (() => void) | undefined;
    function publish(kind: ChangeEntry['kind'], entityId: string) {
      const cursor = changes.length + 1;
      const change = { cursor, kind, entityId, changedAt: cursor };
      changes.push(change);
      socket!.trigger('update', { id: `assignment-${cursor}`, seq: cursor, createdAt: cursor,
        body: { t: 'account-change', changeKinds: [kind], entityIds: [entityId] } });
      return change;
    }
    try {
      await vi.waitFor(() => expect(socket).toBeDefined());
      socket!.trigger('connect');
      await vi.waitFor(() => expect(feedReads()).toBe(1));
      publish('account', 'unrelated-account-write');
      await vi.waitFor(() => expect(feedReads()).toBe(2));
      publish('machine', 'collector-a');
      await vi.waitFor(() => expect(machines).toEqual(['collector-a']));
      const readsBeforeOwnedPage = feedReads();
      detachOwner = observation.attachFeedOwner();
      const after = changes.length;
      const change = publish('machine', 'collector-b');
      observation.consumeOwnedFeedPage({ after, nextCursor: change.cursor, changes: [change] });
      expect(machines).toEqual(['collector-a', 'collector-b']);
      expect(feedReads()).toBe(readsBeforeOwnedPage);
    } finally {
      release();
      detachOwner?.();
      await observation.dispose();
    }
  });

  it('classifies the same-process feed owner pages instead of reading the feed per Session wake, and reads again without an owner', async () => {
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
      accountId: 'account-feed-owner', token: 'token-feed-owner', serverBaseUrl: 'http://home.test',
    });
    const sources: (string | null)[] = [];
    const release = observation.subscribeSessionFollowSources(sessionId => { sources.push(sessionId); });
    const detachOwner = observation.attachFeedOwner();
    try {
      await vi.waitFor(() => expect(socket).toBeDefined());
      socket!.trigger('connect');
      await vi.waitFor(() => expect(feedReads()).toBeGreaterThan(0));
      await new Promise<void>(resolve => setTimeout(resolve, 10));
      const baseline = feedReads();
      sources.length = 0;
      // Per-turn Session writes: each wakes both the Machine catch-up (the owner) and this socket.
      for (let n = 0; n < 5; n += 1) {
        const after = cursor;
        cursor += 1;
        socket!.trigger('update', { id: `wake-${n}`, seq: cursor, createdAt: 1,
          body: { t: 'account-change', changeKinds: ['session'], entityIds: ['session-turns'] } });
        observation.consumeOwnedFeedPage({ after, nextCursor: cursor,
          changes: [{ cursor, kind: 'session', entityId: 'session-turns', changedAt: 1 }] });
        await new Promise<void>(resolve => setTimeout(resolve, 5));
      }
      expect(feedReads() - baseline).toBe(0);
      // The Session change still reaches the Follow source reader through the owner's page.
      expect(sources.filter(id => id === 'session-turns')).toHaveLength(5);
      // Without an owner, the observer reads its own wakes again.
      detachOwner();
      await vi.waitFor(() => expect(feedReads() - baseline).toBe(1));
      cursor += 1;
      socket!.trigger('update', { id: 'wake-unowned', seq: cursor, createdAt: 1,
        body: { t: 'account-change', changeKinds: ['session'], entityIds: ['session-turns'] } });
      await vi.waitFor(() => expect(feedReads() - baseline).toBe(2));
    } finally {
      detachOwner();
      release();
      await observation.dispose();
    }
  });
});
