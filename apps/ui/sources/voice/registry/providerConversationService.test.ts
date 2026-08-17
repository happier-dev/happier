import { describe, expect, it, vi } from 'vitest';

import {
  createProviderConversationServiceFactory,
  getProviderConversationServiceFactory,
} from './providerConversationService';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('provider conversation service', () => {
  it('orders forget after an in-flight write and rejects late writes from the invalidated attempt', async () => {
    const staleWrite = deferred();
    const durableStates: Array<string | null> = [];
    const factory = createProviderConversationServiceFactory({
      async read() {
        return 'conv-old';
      },
      async write(conversationId) {
        if (conversationId === 'conv-stale') await staleWrite.promise;
        durableStates.push(conversationId);
      },
    });
    const attempt = factory.createAttempt('session-1');

    await expect(attempt.read()).resolves.toBe('conv-old');
    const writing = attempt.write('conv-stale');
    await vi.waitFor(() => expect(durableStates).toEqual([]));
    const forgetting = attempt.forget();
    await attempt.write('conv-too-late');

    staleWrite.resolve();
    await Promise.all([writing, forgetting]);
    expect(durableStates).toEqual(['conv-stale', null]);
  });

  it('runs a scoped fixed-carrier clear after an already-admitted write', async () => {
    const admittedWrite = deferred();
    const admitted = deferred();
    const durableStates: Array<readonly [string | null, 'default' | 'scoped']> = [];
    const factory = createProviderConversationServiceFactory({
      async read() {
        return null;
      },
      async write(conversationId) {
        if (conversationId === 'conv-admitted') {
          admitted.resolve();
          await admittedWrite.promise;
        }
        durableStates.push([conversationId, 'default']);
      },
    });
    const oldAttempt = factory.createAttempt('history-session');
    const writing = oldAttempt.write('conv-admitted');
    await admitted.promise;
    const scopedClear = vi.fn(async () => {
      durableStates.push([null, 'scoped']);
    });
    const forgetAttempt = factory.createAttempt('history-session', {
      writeForgottenState: scopedClear,
    });

    const forgetting = forgetAttempt.forget();
    await Promise.resolve();
    expect(scopedClear).not.toHaveBeenCalled();
    admittedWrite.resolve();
    await Promise.all([writing, forgetting]);

    expect(durableStates).toEqual([
      ['conv-admitted', 'default'],
      [null, 'scoped'],
    ]);
  });

  it('fences an older attempt across runtime recreation while keeping sessions independent', async () => {
    const writes: Array<readonly [string, string | null]> = [];
    const factory = createProviderConversationServiceFactory({
      async read(sessionId) {
        return sessionId === 'session-a' ? 'conv-a' : null;
      },
      async write(conversationId, sessionId) {
        writes.push([sessionId, conversationId]);
      },
    });
    const oldAttempt = factory.createAttempt('session-a');
    const latestAttempt = factory.createAttempt('session-a');
    const independentAttempt = factory.createAttempt('session-b');

    await oldAttempt.write('conv-old-attempt');
    await latestAttempt.write('conv-latest');
    await independentAttempt.write('conv-independent');

    expect(writes).toEqual([
      ['session-a', 'conv-latest'],
      ['session-b', 'conv-independent'],
    ]);
  });

  it('shares attempt fencing across host projections with the same persistence boundary', async () => {
    const writes: Array<readonly [string, string | null]> = [];
    const host = Object.freeze({
      async readProviderConversationState() {
        return null;
      },
      async writeProviderConversationState(input: Readonly<{
        conversationSessionId: string;
        state: Readonly<{ conversationId: string }> | null;
      }>) {
        writes.push([
          input.conversationSessionId,
          input.state?.conversationId ?? null,
        ]);
      },
    });
    const projectedHost = Object.freeze({ ...host });
    const projectedFactory = getProviderConversationServiceFactory(
      projectedHost,
      'happier.voice.xai/realtime-grok',
    );
    const oldAttempt = projectedFactory.createAttempt('history-session');
    const directAttempt = projectedFactory.createAttempt('direct-session');
    const forgetAttempt = getProviderConversationServiceFactory(
      host,
      'happier.voice.xai/realtime-grok',
    ).createAttempt('history-session');

    await oldAttempt.write('conv-late');
    await directAttempt.write('conv-direct-current');
    await forgetAttempt.forget();

    expect(writes).toEqual([
      ['direct-session', 'conv-direct-current'],
      ['history-session', null],
    ]);
  });

  it('keeps a failed forget invalidated until an explicit retry succeeds', async () => {
    let failForget = true;
    const writes: Array<string | null> = [];
    const factory = createProviderConversationServiceFactory({
      async read() {
        return 'conv-old';
      },
      async write(conversationId) {
        writes.push(conversationId);
        if (conversationId === null && failForget) {
          failForget = false;
          throw new Error('metadata_unavailable');
        }
      },
    });
    const attempt = factory.createAttempt('session-1');

    await expect(attempt.forget()).rejects.toThrow('metadata_unavailable');
    await attempt.write('conv-late');
    await expect(attempt.forget()).resolves.toBeUndefined();
    expect(writes).toEqual([null, null]);
  });

  it('does not let an older in-flight forget suppress forgetting a replacement conversation', async () => {
    const oldForget = deferred();
    const writes: Array<string | null> = [];
    let firstForget = true;
    const factory = createProviderConversationServiceFactory({
      async read() {
        return null;
      },
      async write(conversationId) {
        writes.push(conversationId);
        if (conversationId === null && firstForget) {
          firstForget = false;
          await oldForget.promise;
        }
      },
    });
    const oldAttempt = factory.createAttempt('session-1');

    const forgettingOld = oldAttempt.forget();
    await vi.waitFor(() => expect(writes).toEqual([null]));
    const replacementAttempt = factory.createAttempt('session-1');
    const writingReplacement = replacementAttempt.write('conv-replacement');

    oldForget.resolve();
    await Promise.all([forgettingOld, writingReplacement]);
    await replacementAttempt.forget();

    expect(writes).toEqual([null, 'conv-replacement', null]);
  });
});
