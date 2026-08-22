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
