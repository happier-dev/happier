import { afterEach, describe, expect, it, vi } from 'vitest';

import { createStreamedTranscriptWriter } from './createStreamedTranscriptWriter';
import type { StreamedTranscriptWriterSession } from './types';
import { logger } from '@/ui/logger';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settleLivePublication(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

function createWriter(session: StreamedTranscriptWriterSession, liveSnapshotIntervalMs: number | null = 0) {
  return createStreamedTranscriptWriter({
    provider: 'codex',
    session,
    makeLocalId: () => 'segment-1',
    initialCheckpointDelayMs: 10_000,
    checkpointIntervalMs: 10_000,
    checkpointMinChars: 999,
    liveSnapshotIntervalMs,
    liveSnapshotMinChars: 1,
    liveCheckpointIntervalMs: 1_000,
  });
}

describe('createStreamedTranscriptWriter locally accepted live delivery', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('publishes a batched delta at the default interval and flushes a pending batch at turn end', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(100));
    vi.stubEnv('HAPPIER_STREAM_LIVE_INTERVAL_MS', undefined);

    const fullSnapshots: string[] = [];
    const deltas: Array<{ text: string; baseLength: number }> = [];
    const session: StreamedTranscriptWriterSession = {
      getEphemeralStreamConnectionEpoch: () => 1,
      sendAgentMessageEphemeral: (_provider, body) => {
        fullSnapshots.push(body.type === 'message' ? body.message : '');
        return { accepted: true, epoch: 1 };
      },
      sendAgentMessageEphemeralDelta: (_provider, body, opts) => {
        deltas.push({
          text: body.type === 'message' ? body.message : '',
          baseLength: opts.baseLength,
        });
        return { accepted: true, epoch: 1 };
      },
      sendAgentMessageCommitted: async () => {},
    };
    const writer = createWriter(session, null);

    writer.appendAssistantDelta('Hel');
    await settleLivePublication();
    expect(fullSnapshots).toEqual(['Hel']);

    await vi.advanceTimersByTimeAsync(30);
    writer.appendAssistantDelta('lo ');
    await vi.advanceTimersByTimeAsync(30);
    writer.appendAssistantDelta('world');

    await vi.advanceTimersByTimeAsync(39);
    expect(fullSnapshots).toEqual(['Hel']);
    expect(deltas).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(deltas).toEqual([{ text: 'lo world', baseLength: 3 }]);

    writer.appendAssistantDelta('!');
    const flushed = writer.flushAll({ reason: 'turn-end' });
    await settleLivePublication();
    expect(fullSnapshots).toEqual(['Hel', 'Hello world!']);
    await flushed;

    await vi.advanceTimersByTimeAsync(100);
    expect(fullSnapshots).toEqual(['Hel', 'Hello world!']);
    expect(deltas).toEqual([{ text: 'lo world', baseLength: 3 }]);
  });

  it('does not chain a delta from a synchronously failed snapshot', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(100));

    const fullSnapshots: string[] = [];
    const deltas: Array<{ text: string; baseLength: number }> = [];
    let snapshotAttempt = 0;
    const session: StreamedTranscriptWriterSession = {
      getEphemeralStreamConnectionEpoch: () => 1,
      sendAgentMessageEphemeral: (_provider, body) => {
        snapshotAttempt += 1;
        fullSnapshots.push(body.type === 'message' ? body.message : '');
        if (snapshotAttempt === 1) throw new Error('synchronous transport failure');
        return { accepted: true, epoch: 1 };
      },
      sendAgentMessageEphemeralDelta: (_provider, body, opts) => {
        deltas.push({
          text: body.type === 'message' ? body.message : '',
          baseLength: opts.baseLength,
        });
        return { accepted: true, epoch: 1 };
      },
      sendAgentMessageCommitted: async () => {},
    };
    const writer = createWriter(session);

    writer.appendAssistantDelta('hello');
    await settleLivePublication();
    writer.appendAssistantDelta(' world');
    await settleLivePublication();

    expect(fullSnapshots).toEqual(['hello', 'hello world']);
    expect(deltas).toEqual([]);
  });

  it('does not chain a delta from an asynchronously rejected snapshot', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(100));

    const fullSnapshots: string[] = [];
    const deltas: Array<{ text: string; baseLength: number }> = [];
    let snapshotAttempt = 0;
    const session: StreamedTranscriptWriterSession = {
      getEphemeralStreamConnectionEpoch: () => 2,
      sendAgentMessageEphemeral: async (_provider, body) => {
        snapshotAttempt += 1;
        fullSnapshots.push(body.type === 'message' ? body.message : '');
        if (snapshotAttempt === 1) throw new Error('asynchronous transport failure');
        return { accepted: true as const, epoch: 2 };
      },
      sendAgentMessageEphemeralDelta: async (_provider, body, opts) => {
        deltas.push({
          text: body.type === 'message' ? body.message : '',
          baseLength: opts.baseLength,
        });
        return { accepted: true as const, epoch: 2 };
      },
      sendAgentMessageCommitted: async () => {},
    };
    const writer = createWriter(session);

    writer.appendAssistantDelta('hello');
    await settleLivePublication();
    writer.appendAssistantDelta(' world');
    await settleLivePublication();

    expect(fullSnapshots).toEqual(['hello', 'hello world']);
    expect(deltas).toEqual([]);
  });

  it('serializes live sends and coalesces concurrent appends onto the accepted base', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(100));

    const firstSend = createDeferred<{ accepted: true; epoch: number }>();
    const fullSnapshots: string[] = [];
    const deltas: Array<{ text: string; baseLength: number }> = [];
    const session: StreamedTranscriptWriterSession = {
      getEphemeralStreamConnectionEpoch: () => 3,
      sendAgentMessageEphemeral: (_provider, body) => {
        fullSnapshots.push(body.type === 'message' ? body.message : '');
        return firstSend.promise;
      },
      sendAgentMessageEphemeralDelta: (_provider, body, opts) => {
        deltas.push({
          text: body.type === 'message' ? body.message : '',
          baseLength: opts.baseLength,
        });
        return { accepted: true, epoch: 3 };
      },
      sendAgentMessageCommitted: async () => {},
    };
    const writer = createWriter(session);

    writer.appendAssistantDelta('hello');
    writer.appendAssistantDelta(' world');
    await settleLivePublication();

    expect(fullSnapshots).toEqual(['hello']);
    expect(deltas).toEqual([]);

    firstSend.resolve({ accepted: true, epoch: 3 });
    await settleLivePublication();

    expect(deltas).toEqual([{ text: ' world', baseLength: 5 }]);
  });

  it('uses a full checkpoint when the connection epoch changes during an in-flight publication', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(100));

    const firstSend = createDeferred<{ accepted: true; epoch: number }>();
    const fullSnapshots: string[] = [];
    const deltas: string[] = [];
    let epoch = 1;
    const session: StreamedTranscriptWriterSession = {
      getEphemeralStreamConnectionEpoch: () => epoch,
      sendAgentMessageEphemeral: (_provider, body) => {
        fullSnapshots.push(body.type === 'message' ? body.message : '');
        return fullSnapshots.length === 1 ? firstSend.promise : { accepted: true, epoch };
      },
      sendAgentMessageEphemeralDelta: (_provider, body) => {
        deltas.push(body.type === 'message' ? body.message : '');
        return { accepted: true, epoch };
      },
      sendAgentMessageCommitted: async () => {},
    };
    const writer = createWriter(session);

    writer.appendAssistantDelta('hello');
    writer.appendAssistantDelta(' world');
    epoch = 2;
    firstSend.resolve({ accepted: true, epoch: 1 });
    await settleLivePublication();

    expect(fullSnapshots).toEqual(['hello', 'hello world']);
    expect(deltas).toEqual([]);
  });

  it('waits for in-flight live publication before completing a turn flush', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(100));

    const firstSend = createDeferred<{ accepted: true; epoch: number }>();
    const terminalSnapshots: string[] = [];
    let sendCount = 0;
    const session: StreamedTranscriptWriterSession = {
      getEphemeralStreamConnectionEpoch: () => 4,
      sendAgentMessageEphemeral: (_provider, body, opts) => {
        sendCount += 1;
        if (opts.meta?.happierStreamSegmentV1
          && typeof opts.meta.happierStreamSegmentV1 === 'object'
          && (opts.meta.happierStreamSegmentV1 as Record<string, unknown>).segmentState === 'complete') {
          terminalSnapshots.push(body.type === 'message' ? body.message : '');
        }
        return sendCount === 1 ? firstSend.promise : { accepted: true, epoch: 4 };
      },
      sendAgentMessageCommitted: async () => {},
    };
    const writer = createWriter(session);

    writer.appendAssistantDelta('final answer');
    let flushResolved = false;
    const flushPromise = writer.flushAll({ reason: 'turn-end' }).then(() => {
      flushResolved = true;
    });
    await settleLivePublication();

    expect(flushResolved).toBe(false);
    expect(terminalSnapshots).toEqual([]);

    firstSend.resolve({ accepted: true, epoch: 4 });
    await flushPromise;

    expect(terminalSnapshots).toEqual(['final answer']);
  });

  it('publishes the terminal live snapshot before committing its durable replacement', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(100));

    const firstSend = createDeferred<{ accepted: true; epoch: number }>();
    const publicationOrder: string[] = [];
    let sendCount = 0;
    const session: StreamedTranscriptWriterSession = {
      getEphemeralStreamConnectionEpoch: () => 4,
      sendAgentMessageEphemeral: (_provider, _body, opts) => {
        sendCount += 1;
        const segmentMeta = opts.meta?.happierStreamSegmentV1;
        if (
          segmentMeta
          && typeof segmentMeta === 'object'
          && (segmentMeta as Record<string, unknown>).segmentState === 'interrupted'
        ) {
          publicationOrder.push('terminal-live');
        }
        return sendCount === 1 ? firstSend.promise : { accepted: true, epoch: 4 };
      },
      enqueueAgentMessageCommitted: async () => {
        publicationOrder.push('durable');
        return { persisted: true, delivered: true };
      },
      sendAgentMessageCommitted: async () => {},
    };
    const writer = createWriter(session);

    writer.setCommitProvenance({ kind: 'non_dependent', source: 'external' });
    writer.appendAssistantDelta('partial answer');
    const flushPromise = writer.flushAll({ reason: 'abort', interruptedReason: 'cancelled' });
    await settleLivePublication();

    expect(publicationOrder).toEqual([]);

    firstSend.resolve({ accepted: true, epoch: 4 });
    await flushPromise;

    expect(publicationOrder).toEqual(['terminal-live', 'durable']);
  });

  it('reports the final suppressed failure count when a segment settles without live acceptance', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(100));
    const logSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const failure = {
      accepted: false as const,
      epoch: 5,
      reason: {
        code: 'local_failure' as const,
        error: { name: 'Error', message: 'same local failure' },
      },
    };
    const session: StreamedTranscriptWriterSession = {
      getEphemeralStreamConnectionEpoch: () => 5,
      sendAgentMessageEphemeral: () => failure,
      sendAgentMessageCommitted: async () => {},
    };
    const writer = createWriter(session);

    writer.appendAssistantDelta('hello');
    await settleLivePublication();
    writer.appendAssistantDelta(' world');
    await settleLivePublication();
    await writer.flushAll({ reason: 'turn-end' });

    expect(logSpy).toHaveBeenCalledWith(
      '[StreamedTranscriptWriter] Live publication remained locally non-accepted at segment settlement',
      expect.objectContaining({
        failureCount: 3,
        suppressedFailureCount: 2,
        firstReason: failure.reason,
        localId: 'segment-1',
      }),
    );
  });

  it('fails closed when a transport returns a malformed non-acceptance outcome', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(100));
    const logSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const session: StreamedTranscriptWriterSession = {
      getEphemeralStreamConnectionEpoch: () => 6,
      sendAgentMessageEphemeral: () => ({
        accepted: false,
        epoch: 6,
        reason: { unexpected: 'shape' },
      } as never),
      sendAgentMessageCommitted: async () => {},
    };
    const writer = createWriter(session);

    writer.appendAssistantDelta('hello');
    await settleLivePublication();
    await writer.flushAll({ reason: 'turn-end' });

    expect(logSpy).toHaveBeenCalledWith(
      '[StreamedTranscriptWriter] Live publication was not locally accepted (non-fatal)',
      expect.objectContaining({
        reason: expect.objectContaining({
          code: 'local_failure',
          error: expect.objectContaining({
            message: 'Ephemeral send returned an invalid acceptance outcome',
          }),
        }),
      }),
    );
  });

  it('re-sanitizes structured local failures returned by transcript adapters', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(100));
    const logSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const session: StreamedTranscriptWriterSession = {
      getEphemeralStreamConnectionEpoch: () => 7,
      sendAgentMessageEphemeral: () => ({
        accepted: false,
        epoch: 7,
        reason: {
          code: 'local_failure',
          error: {
            name: 'Error',
            message: 'Authorization: Bearer ADAPTER_SECRET',
            stack: `https://alice:PASSWORD@example.test/live?token=secret\n${'x'.repeat(32_000)}`,
            cause: { name: 'TypeError', message: 'Bearer NESTED_SECRET' },
          },
        },
      } as never),
      sendAgentMessageCommitted: async () => {},
    };
    const writer = createWriter(session);

    writer.appendAssistantDelta('hello');
    await settleLivePublication();

    const serializedLogs = JSON.stringify(logSpy.mock.calls);
    expect(serializedLogs).not.toContain('ADAPTER_SECRET');
    expect(serializedLogs).not.toContain('PASSWORD');
    expect(serializedLogs).not.toContain('token=secret');
    expect(serializedLogs).not.toContain('NESTED_SECRET');
    expect(Buffer.byteLength(serializedLogs, 'utf8')).toBeLessThan(14_000);
    writer.discard();
  });
});
