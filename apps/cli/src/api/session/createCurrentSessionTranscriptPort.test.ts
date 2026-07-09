import { describe, expect, it, vi } from 'vitest';

import { createCurrentSessionTranscriptPort } from './createCurrentSessionTranscriptPort';

describe('createCurrentSessionTranscriptPort', () => {
  it('routes transcript-vNext writes through the latest swapped session', async () => {
    const firstSession = {
      sendAgentMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => {}),
    };
    const secondSession = {
      sendAgentMessage: vi.fn(),
      sendAgentMessageCommitted: vi.fn(async () => {}),
    };

    let currentSession = firstSession;
    const port = createCurrentSessionTranscriptPort(() => currentSession as any);

    currentSession = secondSession;

    await port.sendAgentMessageCommitted(
      'gemini' as any,
      { type: 'thinking', text: 'final' } as any,
      { localId: 'commit_1' },
    );

    expect(firstSession.sendAgentMessageCommitted).not.toHaveBeenCalled();
    expect(secondSession.sendAgentMessageCommitted).toHaveBeenCalledWith(
      'gemini',
      { type: 'thinking', text: 'final' },
      { localId: 'commit_1' },
    );
  });

  it('routes durable enqueue hooks through the latest swapped session', async () => {
    const firstSession = {
      sendAgentMessageCommitted: vi.fn(async () => {}),
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true as const, delivered: false })),
    };
    const secondSession = {
      sendAgentMessageCommitted: vi.fn(async () => {}),
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true as const, delivered: false })),
    };

    let currentSession = firstSession;
    const port = createCurrentSessionTranscriptPort(() => currentSession as any);

    currentSession = secondSession;

    await expect((port as any).enqueueAgentMessageCommitted(
      'opencode',
      { type: 'message', message: 'final' },
      { localId: 'commit_1' },
    )).resolves.toEqual({ persisted: true, delivered: false });

    expect(firstSession.enqueueAgentMessageCommitted).not.toHaveBeenCalled();
    expect(firstSession.sendAgentMessageCommitted).not.toHaveBeenCalled();
    expect(secondSession.sendAgentMessageCommitted).not.toHaveBeenCalled();
    expect(secondSession.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'opencode',
      { type: 'message', message: 'final' },
      { localId: 'commit_1' },
    );
  });

  it('preserves the current session receiver for forwarded transcript methods', async () => {
    class SessionWithDurableQueue {
      readonly calls: unknown[] = [];

      async sendAgentMessage(provider: string, body: unknown, opts: unknown) {
        this.calls.push({ method: 'sendAgentMessage', provider, body, opts });
      }

      async sendAgentMessageEphemeral(provider: string, body: unknown, opts: unknown) {
        this.calls.push({ method: 'sendAgentMessageEphemeral', provider, body, opts });
      }

      async sendAgentMessageCommitted(provider: string, body: unknown, opts: unknown) {
        this.calls.push({ method: 'sendAgentMessageCommitted', provider, body, opts });
      }

      async enqueueAgentMessageCommitted(provider: string, body: unknown, opts: unknown) {
        this.calls.push({ method: 'enqueueAgentMessageCommitted', provider, body, opts });
        return { persisted: true as const, delivered: true as const };
      }

      async sendAgentSessionMediaCommitted(provider: string, request: unknown) {
        this.calls.push({ method: 'sendAgentSessionMediaCommitted', provider, request });
      }
    }

    const currentSession = new SessionWithDurableQueue();
    const port = createCurrentSessionTranscriptPort(() => currentSession as any);

    await expect(port.sendAgentMessage?.(
      'gemini' as any,
      { type: 'message', message: 'live' } as any,
      { localId: 'live_bound' },
    )).resolves.toBeUndefined();
    await expect(port.sendAgentMessageEphemeral?.(
      'gemini' as any,
      { type: 'message', message: 'ephemeral' } as any,
      { localId: 'ephemeral_bound', createdAt: 123 },
    )).resolves.toBeUndefined();
    await expect(port.sendAgentMessageCommitted(
      'gemini' as any,
      { type: 'message', message: 'committed' } as any,
      { localId: 'committed_bound' },
    )).resolves.toBeUndefined();
    await expect((port as any).enqueueAgentMessageCommitted(
      'gemini',
      { type: 'message', message: 'bound' },
      { localId: 'commit_bound' },
    )).resolves.toEqual({ persisted: true, delivered: true });
    await expect((port as any).sendAgentSessionMediaCommitted(
      'gemini',
      { localId: 'media_bound' },
    )).resolves.toBeUndefined();

    expect(currentSession.calls).toEqual([
      {
        method: 'sendAgentMessage',
        provider: 'gemini',
        body: { type: 'message', message: 'live' },
        opts: { localId: 'live_bound' },
      },
      {
        method: 'sendAgentMessageEphemeral',
        provider: 'gemini',
        body: { type: 'message', message: 'ephemeral' },
        opts: { localId: 'ephemeral_bound', createdAt: 123 },
      },
      {
        method: 'sendAgentMessageCommitted',
        provider: 'gemini',
        body: { type: 'message', message: 'committed' },
        opts: { localId: 'committed_bound' },
      },
      {
        method: 'enqueueAgentMessageCommitted',
        provider: 'gemini',
        body: { type: 'message', message: 'bound' },
        opts: { localId: 'commit_bound' },
      },
      {
        method: 'sendAgentSessionMediaCommitted',
        provider: 'gemini',
        request: { localId: 'media_bound' },
      },
    ]);
  });

  it('forwards live delta sends and the connection epoch only when the current session supports them', () => {
    const deltaSession = {
      sendAgentMessageCommitted: vi.fn(async () => {}),
      sendAgentMessageEphemeral: vi.fn(),
      sendAgentMessageEphemeralDelta: vi.fn(),
      getEphemeralStreamConnectionEpoch: vi.fn(() => 7),
    };
    const snapshotOnlySession = {
      sendAgentMessageCommitted: vi.fn(async () => {}),
      sendAgentMessageEphemeral: vi.fn(),
    };

    let currentSession: unknown = deltaSession;
    const port = createCurrentSessionTranscriptPort(() => currentSession as any);

    expect(typeof port.sendAgentMessageEphemeralDelta).toBe('function');
    port.sendAgentMessageEphemeralDelta?.(
      'codex' as any,
      { type: 'message', message: ' world' } as any,
      { localId: 'segment-1', tick: 2, baseLength: 5, createdAt: 1_000 },
    );
    expect(deltaSession.sendAgentMessageEphemeralDelta).toHaveBeenCalledWith(
      'codex',
      { type: 'message', message: ' world' },
      { localId: 'segment-1', tick: 2, baseLength: 5, createdAt: 1_000 },
    );
    expect(port.getEphemeralStreamConnectionEpoch?.()).toBe(7);

    // Capability handshake: sessions without delta support must not expose the delta surface,
    // so the streamed transcript writer keeps emitting full snapshots.
    currentSession = snapshotOnlySession;
    expect(port.sendAgentMessageEphemeralDelta).toBeUndefined();
    expect(port.getEphemeralStreamConnectionEpoch).toBeUndefined();
  });
});
