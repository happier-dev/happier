import { beforeEach, describe, expect, it, vi } from 'vitest';

import { encodeBase64, encryptLegacy } from '@/api/encryption';
import { createSessionListResponseFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

const { bootstrapAccountSettingsContext, fetchSessionsPage, getSessionTranscript } = vi.hoisted(() => ({
  bootstrapAccountSettingsContext: vi.fn(),
  fetchSessionsPage: vi.fn(),
  getSessionTranscript: vi.fn(),
}));

vi.mock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({
  bootstrapAccountSettingsContext,
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionsPage,
}));

vi.mock('./getSessionTranscript', () => ({
  getSessionTranscript,
}));

describe('listSessions', () => {
  const credentials = {
    token: 'token',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array(32).fill(5),
    },
  } as const;

  function encryptedMetadata(value: Record<string, unknown>): string {
    return encodeBase64(encryptLegacy(value, credentials.encryption.secret));
  }

  beforeEach(() => {
    bootstrapAccountSettingsContext.mockResolvedValue({ settings: null });
    fetchSessionsPage.mockReset();
    getSessionTranscript.mockReset();
  });

  it('propagates a non-terminal server page without terminal rows by default', async () => {
    fetchSessionsPage.mockResolvedValue(createSessionListResponseFixture([
      createSessionRecordFixture({
        id: 'sess-1',
        metadata: encryptedMetadata({ summary: { text: 'Session one' } }),
      }),
    ], { nextCursor: 'cursor-2', hasNext: true }));

    const { listSessions } = await import('./listSessions');
    const result = await listSessions({
      credentials,
      activeOnly: false,
      archivedOnly: false,
      includeSystem: false,
      resumableOnly: false,
    });

    expect(result).toEqual({
      sessions: [
        expect.objectContaining({
          id: 'sess-1',
          title: 'Session one',
        }),
      ],
      nextCursor: 'cursor-2',
      hasNext: true,
    });
    expect('rows' in result).toBe(false);
  });

  it('propagates a terminal server page', async () => {
    fetchSessionsPage.mockResolvedValue(createSessionListResponseFixture([], {
      nextCursor: null,
      hasNext: false,
    }));

    const { listSessions } = await import('./listSessions');
    const result = await listSessions({
      credentials,
      activeOnly: false,
      archivedOnly: false,
      includeSystem: false,
      resumableOnly: false,
    });

    expect(result).toEqual({
      sessions: [],
      nextCursor: null,
      hasNext: false,
    });
  });

  it('includes terminal rows with deterministic session cardinality when requested', async () => {
    fetchSessionsPage.mockResolvedValue(createSessionListResponseFixture([
      createSessionRecordFixture({
        id: 'sess-1',
        metadata: encryptedMetadata({ summary: { text: 'Session one' }, path: '/repo/one' }),
      }),
      createSessionRecordFixture({
        id: 'sess-2',
        metadata: encryptedMetadata({ summary: { text: 'Session two' }, path: '/repo/two' }),
      }),
    ]));

    const { listSessions } = await import('./listSessions');
    const result = await listSessions({
      credentials,
      activeOnly: false,
      archivedOnly: false,
      includeSystem: false,
      resumableOnly: false,
      includeRows: true,
    });

    expect(result.sessions.map((session) => session.id)).toEqual(['sess-1', 'sess-2']);
    expect(result.rows?.map((row) => row.id)).toEqual(['sess-1', 'sess-2']);
    expect(result.rows?.[0]).not.toHaveProperty('encryption');
    expect(result.rows?.[0]).not.toHaveProperty('share');
    expect(result.rows?.[0]).not.toHaveProperty('pendingCount');
  });

  it('caps sessions and rows to the requested limit after server initial-page expansion', async () => {
    fetchSessionsPage.mockResolvedValue(createSessionListResponseFixture([
      createSessionRecordFixture({
        id: 'sess-1',
        metadata: encryptedMetadata({ summary: { text: 'Session one' }, path: '/repo/one' }),
      }),
      createSessionRecordFixture({
        id: 'sess-2',
        metadata: encryptedMetadata({ summary: { text: 'Session two' }, path: '/repo/two' }),
      }),
      createSessionRecordFixture({
        id: 'sess-3',
        metadata: encryptedMetadata({ summary: { text: 'Session three' }, path: '/repo/three' }),
      }),
      createSessionRecordFixture({
        id: 'sess-4',
        metadata: encryptedMetadata({ summary: { text: 'Session four' }, path: '/repo/four' }),
      }),
    ], { nextCursor: 'cursor-2', hasNext: true }));
    getSessionTranscript.mockResolvedValue({
      ok: true,
      sessionId: 'sess',
      items: [],
      nextCursor: null,
      hasMore: false,
      diagnostics: { rawRowsScanned: 0, pagesFetched: 1, scanLimitReached: false, payloadTruncations: 0 },
    });

    const { listSessions } = await import('./listSessions');
    const result = await listSessions({
      credentials,
      activeOnly: false,
      archivedOnly: false,
      includeSystem: false,
      resumableOnly: false,
      includeRows: true,
      includeLastMessagePreview: true,
      limit: 2,
    });

    expect(fetchSessionsPage).toHaveBeenCalledWith(expect.objectContaining({ limit: 2 }));
    expect(result.sessions.map((session) => session.id)).toEqual(['sess-1', 'sess-2']);
    expect(result.rows?.map((row) => row.id)).toEqual(['sess-1', 'sess-2']);
    expect(result.nextCursor).toBe('cursor-2');
    expect(getSessionTranscript).toHaveBeenCalledTimes(2);
  });

  it('adds a bounded semantic last message preview only when requested', async () => {
    fetchSessionsPage.mockResolvedValue(createSessionListResponseFixture([
      createSessionRecordFixture({
        id: 'sess-1',
        metadata: encryptedMetadata({ summary: { text: 'Session one' } }),
      }),
    ]));
    getSessionTranscript.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      items: [
        { id: 'msg-2', createdAt: 20, role: 'assistant', kind: 'assistant_message', text: 'x'.repeat(250) },
      ],
      nextCursor: null,
      hasMore: true,
      diagnostics: { rawRowsScanned: 40, pagesFetched: 1, scanLimitReached: true, payloadTruncations: 0 },
    });

    const { listSessions } = await import('./listSessions');
    const result = await listSessions({
      credentials,
      activeOnly: false,
      archivedOnly: false,
      includeSystem: false,
      resumableOnly: false,
      includeLastMessagePreview: true,
    });

    expect(getSessionTranscript).toHaveBeenCalledWith({
      credentials,
      idOrPrefix: 'sess-1',
      limit: 1,
      roles: ['user', 'assistant'],
      maxCharsPerMessage: 200,
    });
    expect(result.sessions[0]?.lastMessagePreview).toEqual({
      id: 'msg-2',
      createdAt: 20,
      role: 'assistant',
      text: 'x'.repeat(200),
      truncated: true,
    });
    expect(result.sessions[0]?.lastMessagePreview).not.toHaveProperty('raw');
  });

  it('keeps listing sessions when a preview lookup fails', async () => {
    fetchSessionsPage.mockResolvedValue(createSessionListResponseFixture([
      createSessionRecordFixture({
        id: 'sess-1',
        metadata: encryptedMetadata({ summary: { text: 'Session one' } }),
      }),
      createSessionRecordFixture({
        id: 'sess-2',
        metadata: encryptedMetadata({ summary: { text: 'Session two' } }),
      }),
    ]));
    getSessionTranscript
      .mockRejectedValueOnce(new Error('preview failed'))
      .mockResolvedValueOnce({
        ok: true,
        sessionId: 'sess-2',
        items: [{ id: 'msg-2', createdAt: 20, role: 'user', kind: 'user_message', text: 'hello' }],
        nextCursor: null,
        hasMore: false,
        diagnostics: { rawRowsScanned: 1, pagesFetched: 1, scanLimitReached: false, payloadTruncations: 0 },
      });

    const { listSessions } = await import('./listSessions');
    const result = await listSessions({
      credentials,
      activeOnly: false,
      archivedOnly: false,
      includeSystem: false,
      resumableOnly: false,
      includeLastMessagePreview: true,
    });

    expect(result.sessions).toHaveLength(2);
    expect(result.sessions[0]?.lastMessagePreview).toBeUndefined();
    expect(result.sessions[1]?.lastMessagePreview).toEqual({
      id: 'msg-2',
      createdAt: 20,
      role: 'user',
      text: 'hello',
    });
  });
});
