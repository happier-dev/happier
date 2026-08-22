import { describe, expect, it, vi } from 'vitest';

const { updateSessionMetadataForTargetMock } = vi.hoisted(() => ({
  updateSessionMetadataForTargetMock: vi.fn(),
}));

vi.mock('./updateSessionMetadataForTarget', () => ({
  updateSessionMetadataForTarget: (...args: unknown[]) => updateSessionMetadataForTargetMock(...args),
}));

describe('setSessionTitle', () => {
  it('routes display.title writes through the session-state target updater', async () => {
    updateSessionMetadataForTargetMock.mockImplementationOnce(async ({ updater }: {
      updater: (metadata: Record<string, unknown>) => Record<string, unknown>;
    }) => ({
      ok: true,
      sessionId: 's1',
      version: 3,
      metadata: updater({
        summary: {
          text: 'Current',
          updatedAt: 10,
        },
      }),
    }));

    const { setSessionTitle } = await import('./setSessionTitle');
    await expect(setSessionTitle({
      credentials: { token: 'token' } as never,
      idOrPrefix: 's1',
      title: 'Renamed',
    })).resolves.toEqual({
      ok: true,
      sessionId: 's1',
      version: 3,
      metadata: {
        summary: {
          text: 'Renamed',
          updatedAt: expect.any(Number),
        },
      },
    });

    expect(updateSessionMetadataForTargetMock).toHaveBeenCalledWith(expect.objectContaining({
      credentials: { token: 'token' },
      idOrPrefix: 's1',
    }));
  });

  it('maps target metadata authorization failures through the session-state port contract', async () => {
    updateSessionMetadataForTargetMock.mockRejectedValueOnce(Object.assign(new Error('not authenticated'), {
      code: 'not_authenticated',
      status: 403,
    }));

    const { setSessionTitle } = await import('./setSessionTitle');
    await expect(setSessionTitle({
      credentials: { token: 'token' } as never,
      idOrPrefix: 's1',
      title: 'Renamed',
    })).resolves.toEqual({ ok: false, code: 'forbidden' });
  });

  it('clears display.title through the same session-state target updater', async () => {
    updateSessionMetadataForTargetMock.mockImplementationOnce(async ({ updater }: {
      updater: (metadata: Record<string, unknown>) => Record<string, unknown>;
    }) => ({
      ok: true,
      sessionId: 's1',
      version: 4,
      metadata: updater({ summary: { text: 'Current', updatedAt: 10 } }),
    }));

    const { setSessionTitle } = await import('./setSessionTitle');
    await expect(setSessionTitle({
      credentials: { token: 'token' } as never,
      idOrPrefix: 's1',
      title: null,
    })).resolves.toEqual({ ok: true, sessionId: 's1', version: 4, metadata: {} });
  });

  it('maps target metadata retry exhaustion through the session-state port contract', async () => {
    updateSessionMetadataForTargetMock.mockRejectedValueOnce(Object.assign(
      new Error('Failed to update session metadata after 6 attempts'),
      { code: 'conflict' },
    ));

    const { setSessionTitle } = await import('./setSessionTitle');
    await expect(setSessionTitle({
      credentials: { token: 'token' } as never,
      idOrPrefix: 's1',
      title: 'Renamed',
    })).resolves.toEqual({ ok: false, code: 'conflict' });
  });

  it('preserves session lookup timeouts through the session-state port contract', async () => {
    updateSessionMetadataForTargetMock.mockResolvedValueOnce({
      ok: false,
      code: 'session_lookup_timeout',
    });

    const { setSessionTitle } = await import('./setSessionTitle');
    await expect(setSessionTitle({
      credentials: { token: 'token' } as never,
      idOrPrefix: 'c123456789012345678901234',
      title: 'Renamed',
    })).resolves.toEqual({ ok: false, code: 'session_lookup_timeout' });
  });
});
