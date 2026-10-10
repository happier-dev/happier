import { describe, expect, it } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import type { RuntimeActivitySnapshotTail } from '@/api/session/sessionClientPort';
import { createDeferred } from '@/testkit/async/deferred';
import { createSessionProviderInputConsumer } from './sessionProviderInputConsumer';

function idleTail(): RuntimeActivitySnapshotTail {
  return { sequence: 1, custody: null, settlement: {
    identity: { mutationKey: 'runtime-activity:s1', admissionOrder: 1 },
    desiredValue: { state: 'idle', activeCount: 0 }, result: 'applied',
    committedProjection: { state: 'idle', activeCount: 0, observedAt: 1, revision: 2 }, committedRevision: 2,
  } };
}

describe('Session input live-work observation', () => {
  it('requires fresh known Pending state and an exact committed idle tail', async () => {
    let tail = idleTail();
    let pendingCount = 0;
    let known = false;
    const consumer = createSessionProviderInputConsumer({
      messageQueue: new MessageQueue2<string>(() => 'mode'),
      session: {
        waitForMetadataUpdate: async () => false,
        readRuntimeActivitySnapshotTail: () => tail,
        readPendingQueueStateForLiveWork: async () => known
          ? { known: true, pendingCount, pendingBlockedCount: pendingCount, pendingVersion: 1 }
          : { known: false },
      },
    });
    await expect(consumer.readLiveWork()).resolves.toEqual({ session: 'settled', input: 'unknown' });
    known = true;
    pendingCount = 1;
    await expect(consumer.readLiveWork()).resolves.toEqual({ session: 'settled', input: 'active' });
    pendingCount = 0;
    await expect(consumer.readLiveWork()).resolves.toEqual({ session: 'settled', input: 'settled' });
    tail = { ...tail, custody: { identity: { mutationKey: 'runtime-activity:s1', admissionOrder: 2 },
      value: { state: 'idle', activeCount: 0 } } };
    await expect(consumer.readLiveWork()).resolves.toEqual({ session: 'unknown', input: 'settled' });
    tail = { ...idleTail(), settlement: { ...idleTail().settlement!, committedRevision: 3 } };
    await expect(consumer.readLiveWork()).resolves.toEqual({ session: 'unknown', input: 'settled' });
  });

  it('keeps preparation and held input busy through real dispatch settlement', async () => {
    const queue = new MessageQueue2<string>(() => 'mode');
    const dispatch = createDeferred<void>();
    const consumer = createSessionProviderInputConsumer({ messageQueue: queue, session: {
      waitForMetadataUpdate: async () => false,
      readRuntimeActivitySnapshotTail: idleTail,
      readPendingQueueStateForLiveWork: async () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 }),
    } });
    queue.pushImmediate('accepted input', 'mode');
    await expect(consumer.readLiveWork()).resolves.toMatchObject({ input: 'active' });
    await consumer.enforceProviderInputAdmission({ kind: 'action_required', reason: 'group_unavailable', serviceId: 'service', groupId: 'group' });
    await expect(consumer.readLiveWork()).resolves.toMatchObject({ input: 'active' });
    await consumer.clearProviderInputAdmission({ serviceId: 'service', groupId: 'group' });
    await consumer.waitForNextInput({ abortSignal: new AbortController().signal });
    await expect(consumer.readLiveWork()).resolves.toMatchObject({ input: 'active' });
    const running = consumer.runProviderInputDispatch({ abortSignal: new AbortController().signal, dispatch: () => dispatch.promise });
    await expect(consumer.readLiveWork()).resolves.toMatchObject({ input: 'active' });
    dispatch.resolve();
    await running;
    await expect(consumer.readLiveWork()).resolves.toMatchObject({ input: 'active' });
    consumer.releaseInputBatch();
    await expect(consumer.readLiveWork()).resolves.toMatchObject({ input: 'settled' });
  });

  it('cannot turn a failed fresh Pending query into settled input', async () => {
    const consumer = createSessionProviderInputConsumer({ messageQueue: new MessageQueue2<string>(() => 'mode'), session: {
      waitForMetadataUpdate: async () => false,
      readRuntimeActivitySnapshotTail: idleTail,
      readPendingQueueStateForLiveWork: async () => { throw new Error('transport unavailable'); },
    } });
    await expect(consumer.readLiveWork()).resolves.toMatchObject({ input: 'unknown' });
  });

  it('transfers queue custody before notifying observers and releases the last subscription', async () => {
    const queue = new MessageQueue2<string>(() => 'mode');
    const consumer = createSessionProviderInputConsumer({ messageQueue: queue, session: {
      waitForMetadataUpdate: async () => false,
      readRuntimeActivitySnapshotTail: idleTail,
      readPendingQueueStateForLiveWork: async () => ({ known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 }),
    } });
    const reads: Array<ReturnType<typeof consumer.readLiveWork>> = [];
    const unsubscribe = consumer.subscribeLiveWork(() => { reads.push(consumer.readLiveWork()); });
    queue.pushImmediate('accepted', 'mode');
    await consumer.waitForNextInput({ abortSignal: new AbortController().signal });
    expect((await Promise.all(reads)).every(read => read.input === 'active')).toBe(true);
    consumer.releaseInputBatch();
    await expect(reads.at(-1)).resolves.toMatchObject({ input: 'settled' });
    unsubscribe();
    const lastRead = reads.at(-1);
    queue.pushImmediate('next', 'mode');
    expect(reads.at(-1)).toBe(lastRead);
  });
});
