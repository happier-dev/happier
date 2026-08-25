import { beforeEach, describe, expect, it, vi } from 'vitest';

import { encodeBase64, encryptLegacy } from '@/api/encryption';
import { createSessionListResponseFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

const { bootstrapAccountSettingsContext, fetchAccountEncryptionCurrentness, fetchSessionsPage, getSessionTranscript } = vi.hoisted(() => ({
  bootstrapAccountSettingsContext: vi.fn(),
  fetchAccountEncryptionCurrentness: vi.fn(),
  fetchSessionsPage: vi.fn(),
  getSessionTranscript: vi.fn(),
}));

vi.mock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({
  bootstrapAccountSettingsContext,
}));

vi.mock('@/api/client/connectedServiceCredentialApi', () => ({
  fetchAccountEncryptionCurrentness,
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
    fetchAccountEncryptionCurrentness.mockResolvedValue({
      mode: 'e2ee',
      version: 1,
      signingKeyFingerprint: null,
      contentKeyFingerprint: null,
      updatedAt: 1,
    });
    fetchSessionsPage.mockReset();
    getSessionTranscript.mockReset();
  });

  it('fills the requested visible limit from the page after an all-system page', async () => {
    fetchSessionsPage
      .mockResolvedValueOnce(createSessionListResponseFixture([
        createSessionRecordFixture({
          id: 'sess-system',
          metadata: encryptedMetadata({
            systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true },
          }),
        }),
      ], { nextCursor: 'cursor-after-system', hasNext: true }))
      .mockResolvedValueOnce(createSessionListResponseFixture([
        createSessionRecordFixture({
          id: 'sess-visible',
          metadata: encryptedMetadata({ summary: { text: 'Visible session' }, path: '/repo/visible' }),
        }),
      ], { nextCursor: 'cursor-after-visible', hasNext: true }));
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
      limit: 1,
    });

    expect(fetchSessionsPage).toHaveBeenNthCalledWith(1, expect.objectContaining({ limit: 1 }));
    expect(fetchSessionsPage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      cursor: 'cursor-after-system',
      limit: 1,
    }));
    expect(result.sessions.map((session) => session.id)).toEqual(['sess-visible']);
    expect(result.rows?.map((row) => row.id)).toEqual(['sess-visible']);
    expect(result.nextCursor).toBe('cursor-after-visible');
    expect(result.hasNext).toBe(true);
    expect(getSessionTranscript).toHaveBeenCalledTimes(1);
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
    expect(result.hasNext).toBe(true);
    expect(getSessionTranscript).toHaveBeenCalledTimes(2);
  });

  it('fills the requested visible limit after the resumable filter removes an initial page', async () => {
    const resumableMetadata = encryptedMetadata({
      summary: { text: 'Resumable session' },
      path: '/repo',
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'claude',
        agent: {},
      },
      claudeSessionId: 'vendor-resume',
      claudeTranscriptPath: '/repo/vendor-resume.jsonl',
    });
    fetchSessionsPage
      .mockResolvedValueOnce(createSessionListResponseFixture([
        createSessionRecordFixture({
          id: 'sess-not-resumable',
          metadata: encryptedMetadata({ summary: { text: 'Not resumable' }, path: '/repo' }),
        }),
      ], { nextCursor: 'cursor-after-not-resumable', hasNext: true }))
      .mockResolvedValueOnce(createSessionListResponseFixture([
        createSessionRecordFixture({
          id: 'sess-resumable',
          metadata: resumableMetadata,
        }),
      ], { nextCursor: 'cursor-after-resumable', hasNext: true }));

    const { listSessions } = await import('./listSessions');
    const result = await listSessions({
      credentials,
      activeOnly: false,
      archivedOnly: false,
      includeSystem: true,
      resumableOnly: true,
      limit: 1,
    });

    expect(fetchSessionsPage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      cursor: 'cursor-after-not-resumable',
      limit: 1,
    }));
    expect(result.sessions.map((session) => session.id)).toEqual(['sess-resumable']);
    expect(result.nextCursor).toBe('cursor-after-resumable');
    expect(result.hasNext).toBe(true);
  });

  it('continues through more than 200 hidden rows without skipping a later visible session', async () => {
    const hiddenMetadata = encryptedMetadata({
      systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true },
    });
    const hiddenPages = Array.from({ length: 201 }, (_value, index) =>
      createSessionListResponseFixture([
        createSessionRecordFixture({ id: `sess-hidden-${index}`, metadata: hiddenMetadata }),
      ], { nextCursor: `cursor-after-hidden-${index}`, hasNext: true }));
    const visiblePage = createSessionListResponseFixture([
      createSessionRecordFixture({
        id: 'sess-visible-after-hidden-pages',
        metadata: encryptedMetadata({ summary: { text: 'Visible session' }, path: '/repo/visible' }),
      }),
    ], { nextCursor: 'cursor-after-visible', hasNext: true });
    fetchSessionsPage.mockResolvedValueOnce(hiddenPages[0]);
    for (const page of hiddenPages.slice(1)) fetchSessionsPage.mockResolvedValueOnce(page);
    fetchSessionsPage.mockResolvedValueOnce(visiblePage);

    const { listSessions } = await import('./listSessions');
    const result = await listSessions({
      credentials,
      activeOnly: false,
      archivedOnly: false,
      includeSystem: false,
      resumableOnly: false,
      limit: 1,
    });

    expect(fetchSessionsPage).toHaveBeenCalledTimes(202);
    expect(fetchSessionsPage).toHaveBeenLastCalledWith(expect.objectContaining({
      cursor: 'cursor-after-hidden-200',
      limit: 1,
    }));
    expect(result.sessions.map((session) => session.id)).toEqual(['sess-visible-after-hidden-pages']);
    expect(result.nextCursor).toBe('cursor-after-visible');
    expect(result.hasNext).toBe(true);
  });

  it('stops when a filtering continuation repeats its cursor', async () => {
    const hiddenMetadata = encryptedMetadata({
      systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true },
    });
    fetchSessionsPage
      .mockResolvedValueOnce(createSessionListResponseFixture([
        createSessionRecordFixture({ id: 'sess-hidden-initial', metadata: hiddenMetadata }),
      ], { nextCursor: 'cursor-repeated', hasNext: true }))
      .mockResolvedValueOnce(createSessionListResponseFixture([
        createSessionRecordFixture({ id: 'sess-hidden-repeated', metadata: hiddenMetadata }),
      ], { nextCursor: 'cursor-repeated', hasNext: true }));

    const { listSessions } = await import('./listSessions');
    const result = await listSessions({
      credentials,
      activeOnly: false,
      archivedOnly: false,
      includeSystem: false,
      resumableOnly: false,
      limit: 1,
    });

    expect(fetchSessionsPage).toHaveBeenCalledTimes(2);
    expect(result.sessions).toEqual([]);
    expect(result.nextCursor).toBe('cursor-repeated');
    expect(result.hasNext).toBe(true);
  });

  it('keeps fresh resumable page rows ahead of older pinned expansion rows before applying the limit', async () => {
    const resumableMetadata = (title: string, vendorId: string) => encryptedMetadata({
      summary: { text: title },
      path: '/repo',
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'claude',
        agent: {},
      },
      claudeSessionId: vendorId,
      claudeTranscriptPath: `/repo/${vendorId}.jsonl`,
    });
    fetchSessionsPage.mockResolvedValue(createSessionListResponseFixture([
      createSessionRecordFixture({
        id: 'pinned-oldest',
        active: false,
        encryptionMode: 'e2ee',
        updatedAt: 100,
        meaningfulActivityAt: 100,
        metadata: resumableMetadata('Pinned oldest', 'vendor-oldest'),
      }),
      createSessionRecordFixture({
        id: 'pinned-older',
        active: false,
        encryptionMode: 'e2ee',
        updatedAt: 200,
        meaningfulActivityAt: 200,
        metadata: resumableMetadata('Pinned older', 'vendor-older'),
      }),
      createSessionRecordFixture({
        id: 'fresh-page-row',
        active: false,
        encryptionMode: 'e2ee',
        updatedAt: 300,
        meaningfulActivityAt: 300,
        metadata: resumableMetadata('Fresh page row', 'vendor-fresh'),
      }),
    ], { nextCursor: 'cursor-after-fresh-page', hasNext: true }));

    const { listSessions } = await import('./listSessions');
    const result = await listSessions({
      credentials,
      activeOnly: false,
      archivedOnly: false,
      includeSystem: false,
      resumableOnly: true,
      includeRows: true,
      limit: 2,
    });

    expect(result.sessions.map((session) => session.id)).toEqual(['fresh-page-row', 'pinned-older']);
    expect(result.rows?.map((row) => row.id)).toEqual(['fresh-page-row', 'pinned-older']);
    expect(result.nextCursor).toBe('cursor-after-fresh-page');
    expect(result.hasNext).toBe(true);
  });
});
