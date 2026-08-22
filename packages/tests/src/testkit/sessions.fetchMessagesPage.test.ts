import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAccountStoredContentCompatibilityHttpHeadersV1,
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
} from '@happier-dev/protocol';

import { fetchMessagesPage, fetchSessionsV2, fetchSessionV2 } from './sessions';

function createFakeResponse(body: unknown, opts?: { status?: number }) {
  const status = opts?.status ?? 200;
  return {
    status,
    headers: new Headers(),
    text: async () => JSON.stringify(body),
  } as any;
}

describe('fetchMessagesPage', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('includes scope and sidechainId query params when provided', async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      return createFakeResponse({ messages: [], hasMore: false, nextAfterSeq: null }, { status: 200 });
    });
    globalThis.fetch = fetchSpy as any;

    await fetchMessagesPage({
      baseUrl: 'http://localhost:1234',
      token: 'token',
      sessionId: 'ses_1',
      afterSeq: 0,
      limit: 50,
      scope: 'sidechain',
      sidechainId: 'sc_1',
    } as any);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = String(fetchSpy.mock.calls[0]?.[0] ?? '');
    expect(url).toContain('/v1/sessions/ses_1/messages?');
    expect(url).toContain('afterSeq=0');
    expect(url).toContain('limit=50');
    expect(url).toContain('scope=sidechain');
    expect(url).toContain('sidechainId=sc_1');
  });

  it('includes role query param when provided', async () => {
    const fetchSpy = vi.fn(async (_url: string) => {
      return createFakeResponse({ messages: [], hasMore: false, nextAfterSeq: null }, { status: 200 });
    });
    globalThis.fetch = fetchSpy as any;

    await fetchMessagesPage({
      baseUrl: 'http://localhost:1234',
      token: 'token',
      sessionId: 'ses_1',
      afterSeq: 0,
      limit: 25,
      role: 'user',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const firstCall = fetchSpy.mock.calls[0] as [string] | undefined;
    expect(firstCall).toBeDefined();
    const url = String(firstCall?.[0] ?? '');
    expect(url).toContain('role=user');
  });

  it('includes CSV roles query param when provided', async () => {
    const fetchSpy = vi.fn(async (_url: string) => {
      return createFakeResponse({ messages: [], hasMore: false, nextAfterSeq: null }, { status: 200 });
    });
    globalThis.fetch = fetchSpy as any;

    await fetchMessagesPage({
      baseUrl: 'http://localhost:1234',
      token: 'token',
      sessionId: 'ses_1',
      afterSeq: 0,
      limit: 25,
      roles: ['user', 'agent'],
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const firstCall = fetchSpy.mock.calls[0] as [string] | undefined;
    expect(firstCall).toBeDefined();
    const url = String(firstCall?.[0] ?? '');
    expect(url).toContain('roles=user%2Cagent');
  });

  it('normalizes JSON-string message content envelopes returned by SQLite-backed servers', async () => {
    globalThis.fetch = vi.fn(async () => createFakeResponse({
      messages: [
        {
          id: 'msg_1',
          seq: 1,
          localId: 'local_1',
          messageRole: 'user',
          content: JSON.stringify({ t: 'encrypted', c: 'ciphertext' }),
          createdAt: 10,
          updatedAt: 20,
        },
      ],
      hasMore: false,
      nextAfterSeq: null,
    })) as any;

    const page = await fetchMessagesPage({
      baseUrl: 'http://localhost:1234',
      token: 'token',
      sessionId: 'ses_1',
      afterSeq: 0,
      limit: 50,
    });

    expect(page.messages).toEqual([
      expect.objectContaining({
        id: 'msg_1',
        messageRole: 'user',
        content: { t: 'encrypted', c: 'ciphertext' },
      }),
    ]);
  });
});

describe('fetchSessionV2', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('normalizes omitted primary-turn projection fields to null', async () => {
    globalThis.fetch = vi.fn(async () => createFakeResponse({
      session: {
        id: 'ses_1',
        seq: 3,
        metadata: 'ciphertext',
        metadataVersion: 2,
        agentState: null,
        agentStateVersion: 1,
        createdAt: 10,
        updatedAt: 20,
        meaningfulActivityAt: 15,
        active: true,
        activeAt: 20,
        encryptionMode: 'e2ee',
        dataEncryptionKey: 'sealed-key',
        share: null,
        lastViewedSessionSeq: 2,
        pendingCount: 1,
        pendingVersion: 4,
      },
    })) as any;

    const session = await fetchSessionV2('http://localhost:1234', 'token', 'ses_1');

    expect(session).toEqual(expect.objectContaining({
      id: 'ses_1',
      meaningfulActivityAt: 15,
      latestTurnStatus: null,
      lastRuntimeIssue: null,
      encryptionMode: 'e2ee',
      dataEncryptionKey: 'sealed-key',
      share: null,
      lastViewedSessionSeq: 2,
      pendingCount: 1,
      pendingVersion: 4,
    }));
  });

  it('rejects invalid primary-turn projection fields with endpoint-aware diagnostics', async () => {
    globalThis.fetch = vi.fn(async () => createFakeResponse({
      session: {
        id: 'ses_1',
        seq: 3,
        metadata: 'ciphertext',
        metadataVersion: 2,
        agentState: null,
        agentStateVersion: 1,
        createdAt: 10,
        updatedAt: 20,
        meaningfulActivityAt: 10,
        active: true,
        activeAt: 20,
        latestTurnStatus: 'broken-status',
        lastRuntimeIssue: null,
      },
    })) as any;

    await expect(fetchSessionV2('http://localhost:1234', 'token', 'ses_1')).rejects.toThrow('/v2/sessions/ses_1');
  });
});

describe('fetchSessionsV2', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('declares current stored-content compatibility before reading layout-one rows', async () => {
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      return createFakeResponse({ sessions: [], nextCursor: null, hasNext: false });
    });
    globalThis.fetch = fetchSpy as typeof globalThis.fetch;

    await fetchSessionsV2('http://localhost:1234', 'token');

    const request = fetchSpy.mock.calls[0]?.[1];
    expect(request?.headers).toEqual(expect.objectContaining(
      buildAccountStoredContentCompatibilityHttpHeadersV1(
        CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
      ),
    ));
  });
});
