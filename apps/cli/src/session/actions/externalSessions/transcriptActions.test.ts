import { dirname } from 'node:path';

import { describe, expect, it, vi, afterEach } from 'vitest';

const validateDirectMachineSourceMock = vi.fn();
const getExternalSessionProviderOpsMock = vi.fn();

vi.mock('@/api/session/external/security/validateDirectMachineSource', () => ({
  validateDirectMachineSource: (...args: unknown[]) => validateDirectMachineSourceMock(...args),
}));

vi.mock('./providerOpsResolution', () => ({
  getExternalSessionProviderOps: (...args: unknown[]) => getExternalSessionProviderOpsMock(...args),
}));

describe('external session transcript actions', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('keeps direct-session media browsing transient with scoped read dirs only', async () => {
    const providerMediaPath = '/tmp/happier-provider-media/provider-owned.png';
    validateDirectMachineSourceMock.mockResolvedValue({
      ok: true,
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096', directory: '/repo' },
    });
    getExternalSessionProviderOpsMock.mockResolvedValue({
      pageTranscript: async () => ({
        items: [
          {
            id: 'direct-item-1',
            localId: 'direct-item-1',
            createdAtMs: 123,
            raw: {
              role: 'agent',
              content: { type: 'output', data: { type: 'message', message: 'preview only' } },
              meta: {
                happier: {
                  kind: 'session_media.v1',
                  payload: {
                    media: [{
                      id: 'provider-media-1',
                      role: 'output',
                      category: 'generated',
                      mediaKind: 'image',
                      mimeType: 'image/png',
                      name: 'provider-owned.png',
                      path: providerMediaPath,
                      sizeBytes: 12,
                      origin: { source: 'provider-generated' },
                    }],
                  },
                },
              },
            },
          },
        ],
        nextCursor: null,
        tailCursor: null,
        hasMore: false,
      }),
    });

    const { executeExternalSessionTranscriptPageAction } = await import('./transcriptActions');
    const response = await executeExternalSessionTranscriptPageAction({
      machineId: 'machine-1',
      providerId: 'opencode',
      remoteSessionId: 'provider-session-1',
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096', directory: '/repo' },
      direction: 'older',
    });

    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error('expected transcript page to succeed');
    expect(JSON.stringify(response.items)).toContain(providerMediaPath);
    expect(JSON.stringify(response.items)).not.toContain('.happier/uploads/generated');
    expect((response as { transientMediaReadDirs?: readonly string[] }).transientMediaReadDirs).toEqual([
      dirname(providerMediaPath),
    ]);
  });
});
