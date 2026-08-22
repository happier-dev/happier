import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { createCurrentSessionTranscriptPort } from './createCurrentSessionTranscriptPort';

describe('createCurrentSessionTranscriptPort', () => {
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
      { localId: 'commit_1', provenance: { kind: 'non_dependent', source: 'external' } },
    )).resolves.toEqual({ persisted: true, delivered: false });

    expect(firstSession.enqueueAgentMessageCommitted).not.toHaveBeenCalled();
    expect(firstSession.sendAgentMessageCommitted).not.toHaveBeenCalled();
    expect(secondSession.sendAgentMessageCommitted).not.toHaveBeenCalled();
    expect(secondSession.enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'opencode',
      { type: 'message', message: 'final' },
      { localId: 'commit_1', provenance: { kind: 'non_dependent', source: 'external' } },
    );
  });

  it('does not admit a durable enqueue options shape without observation provenance', () => {
    const session = {
      sendAgentMessageCommitted: vi.fn(async () => {}),
      enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true as const, delivered: false })),
    };
    const port = createCurrentSessionTranscriptPort(() => session as any);
    type DurableEnqueue = NonNullable<typeof port.enqueueAgentMessageCommitted>;
    type DurableOptions = Parameters<DurableEnqueue>[2];

    expectTypeOf<{ localId: string }>().not.toMatchTypeOf<DurableOptions>();
    expectTypeOf<{
      localId: string;
      provenance: { kind: 'non_dependent'; source: 'external' };
    }>().toMatchTypeOf<DurableOptions>();
  });

  it('preserves the current session receiver for forwarded transcript methods', async () => {
    class SessionWithDurableQueue {
      readonly calls: unknown[] = [];

      async sendAgentMessageEphemeral(provider: string, body: unknown, opts: unknown) {
        this.calls.push({ method: 'sendAgentMessageEphemeral', provider, body, opts });
        return { accepted: true as const, epoch: 1 };
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

    await expect(port.sendAgentMessageEphemeral?.(
      'gemini' as any,
      { type: 'message', message: 'ephemeral' } as any,
      { localId: 'ephemeral_bound', createdAt: 123 },
    )).resolves.toEqual({ accepted: true, epoch: 1 });
    await expect((port as any).enqueueAgentMessageCommitted(
      'gemini',
      { type: 'message', message: 'bound' },
      { localId: 'commit_bound', provenance: { kind: 'non_dependent', source: 'external' } },
    )).resolves.toEqual({ persisted: true, delivered: true });
    await expect((port as any).sendAgentSessionMediaCommitted(
      'gemini',
      { localId: 'media_bound' },
    )).resolves.toBeUndefined();

    expect(currentSession.calls).toEqual([
      {
        method: 'sendAgentMessageEphemeral',
        provider: 'gemini',
        body: { type: 'message', message: 'ephemeral' },
        opts: { localId: 'ephemeral_bound', createdAt: 123 },
      },
      {
        method: 'enqueueAgentMessageCommitted',
        provider: 'gemini',
        body: { type: 'message', message: 'bound' },
        opts: { localId: 'commit_bound', provenance: { kind: 'non_dependent', source: 'external' } },
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
      sendAgentMessageEphemeral: vi.fn(() => ({ accepted: true as const, epoch: 7 })),
      sendAgentMessageEphemeralDelta: vi.fn(() => ({ accepted: true as const, epoch: 7 })),
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

  it('rejects an in-flight acceptance when the current session object is replaced at the same epoch', async () => {
    let resolveFirst!: (outcome: { accepted: true; epoch: number }) => void;
    const firstSession = {
      sendAgentMessageCommitted: vi.fn(async () => undefined),
      getEphemeralStreamConnectionEpoch: () => 7,
      sendAgentMessageEphemeral: vi.fn(() => new Promise<{ accepted: true; epoch: number }>((resolve) => {
        resolveFirst = resolve;
      })),
    };
    const secondSession = {
      sendAgentMessageCommitted: vi.fn(async () => undefined),
      getEphemeralStreamConnectionEpoch: () => 7,
      sendAgentMessageEphemeral: vi.fn(() => ({ accepted: true as const, epoch: 7 })),
    };
    let currentSession: unknown = firstSession;
    const port = createCurrentSessionTranscriptPort(() => currentSession as any);

    const pending = port.sendAgentMessageEphemeral?.(
      'codex' as any,
      { type: 'message', message: 'old receiver' } as any,
      { localId: 'segment-1', createdAt: 1 },
    );
    currentSession = secondSession;
    resolveFirst({ accepted: true, epoch: 7 });

    await expect(pending).resolves.toEqual({
      accepted: false,
      epoch: 8,
      reason: 'connection_epoch_changed',
    });
  });

  it('advances the exposed epoch when the current session is replaced between sends at the same underlying epoch', async () => {
    const firstSession = {
      sendAgentMessageCommitted: vi.fn(async () => undefined),
      getEphemeralStreamConnectionEpoch: () => 7,
      sendAgentMessageEphemeral: vi.fn(() => ({ accepted: true as const, epoch: 7 })),
    };
    const secondSession = {
      sendAgentMessageCommitted: vi.fn(async () => undefined),
      getEphemeralStreamConnectionEpoch: () => 7,
      sendAgentMessageEphemeral: vi.fn(() => ({ accepted: true as const, epoch: 7 })),
    };
    let currentSession: unknown = firstSession;
    const port = createCurrentSessionTranscriptPort(() => currentSession as any);

    const firstEpoch = port.getEphemeralStreamConnectionEpoch?.();
    await expect(port.sendAgentMessageEphemeral?.(
      'codex' as any,
      { type: 'message', message: 'first receiver' } as any,
      { localId: 'segment-1', createdAt: 1 },
    )).resolves.toEqual({ accepted: true, epoch: firstEpoch });

    currentSession = secondSession;
    const replacementEpoch = port.getEphemeralStreamConnectionEpoch?.();

    expect(replacementEpoch).toBeGreaterThan(firstEpoch ?? 0);
    await expect(port.sendAgentMessageEphemeral?.(
      'codex' as any,
      { type: 'message', message: 'replacement receiver' } as any,
      { localId: 'segment-1', createdAt: 2 },
    )).resolves.toEqual({ accepted: true, epoch: replacementEpoch });
  });

  it('fails a live send closed when reading the underlying connection epoch throws', async () => {
    const session = {
      sendAgentMessageCommitted: vi.fn(async () => undefined),
      getEphemeralStreamConnectionEpoch: vi.fn(() => {
        throw new Error('epoch unavailable');
      }),
      sendAgentMessageEphemeral: vi.fn(() => ({ accepted: true as const, epoch: 7 })),
    };
    const port = createCurrentSessionTranscriptPort(() => session as any);

    await expect(Promise.resolve(port.sendAgentMessageEphemeral?.(
      'codex' as any,
      { type: 'message', message: 'must checkpoint' } as any,
      { localId: 'segment-epoch-error', createdAt: 1 },
    ))).resolves.toMatchObject({
      accepted: false,
      reason: 'transport_unavailable',
      error: { message: expect.stringContaining('epoch unavailable') },
    });
    expect(session.sendAgentMessageEphemeral).not.toHaveBeenCalled();
  });
});
