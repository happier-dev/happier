import { describe, expect, it } from 'vitest';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';

import { waitForNextPermissionModeMessage } from './waitForNextPermissionModeMessage';

type QueueMode = { permissionMode: PermissionMode };
type PermissionModeSessionFixture = Pick<ApiSessionClient, 'popPendingMessage' | 'waitForMetadataUpdate'>;

function createQueue(): MessageQueue2<QueueMode> {
  return new MessageQueue2<QueueMode>(() => 'hash');
}

function asSessionClient(session: PermissionModeSessionFixture): ApiSessionClient {
  return session as unknown as ApiSessionClient;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe('waitForNextPermissionModeMessage', () => {
  it('wakes on metadata update and then processes a pending-queue item', async () => {
    const queue = createQueue();
    const metadataUpdate = createDeferred<boolean>();
    let pendingText: string | null = null;
    let popCount = 0;

    const session: PermissionModeSessionFixture = {
      async popPendingMessage() {
        popCount += 1;
        if (!pendingText) return false;
        const text = pendingText;
        pendingText = null;
        queue.pushImmediate(text, { permissionMode: 'default' });
        return true;
      },
      async waitForMetadataUpdate() {
        return await metadataUpdate.promise;
      },
    };

    const resultPromise = waitForNextPermissionModeMessage({
      messageQueue: queue,
      abortSignal: new AbortController().signal,
      session: asSessionClient(session),
      onMetadataUpdate: () => {
        pendingText = 'from-pending';
      },
    });

    metadataUpdate.resolve(true);
    const result = await resultPromise;

    expect(popCount).toBeGreaterThanOrEqual(2);
    expect(result?.message).toBe('from-pending');
  });

  it('returns a queue message when one arrives while waiting', async () => {
    const queue = createQueue();
    const waitingForMetadata = createDeferred<void>();
    const session: PermissionModeSessionFixture = {
      async popPendingMessage() {
        return false;
      },
      async waitForMetadataUpdate(abortSignal?: AbortSignal) {
        waitingForMetadata.resolve();
        return await new Promise<boolean>((resolve) => {
          abortSignal?.addEventListener('abort', () => resolve(false), { once: true });
        });
      },
    };

    const resultPromise = waitForNextPermissionModeMessage({
      messageQueue: queue,
      abortSignal: new AbortController().signal,
      session: asSessionClient(session),
    });

    await waitingForMetadata.promise;
    queue.pushImmediate('from-queue', { permissionMode: 'default' });

    const result = await resultPromise;
    expect(result?.message).toBe('from-queue');
  });

  it('returns null when aborted while waiting for metadata updates', async () => {
    const queue = createQueue();
    const waitingForMetadata = createDeferred<void>();
    let popCount = 0;
    let waitCount = 0;

    const session: PermissionModeSessionFixture = {
      async popPendingMessage() {
        popCount += 1;
        return false;
      },
      async waitForMetadataUpdate(abortSignal?: AbortSignal) {
        waitCount += 1;
        waitingForMetadata.resolve();
        return await new Promise<boolean>((resolve) => {
          abortSignal?.addEventListener('abort', () => resolve(false), { once: true });
        });
      },
    };

    const abortController = new AbortController();
    const resultPromise = waitForNextPermissionModeMessage({
      messageQueue: queue,
      abortSignal: abortController.signal,
      session: asSessionClient(session),
    });

    await waitingForMetadata.promise;
    abortController.abort();

    await expect(resultPromise).resolves.toBeNull();
    expect(popCount).toBe(1);
    expect(waitCount).toBe(1);
  });

  it('continues processing when onMetadataUpdate throws', async () => {
    const queue = createQueue();
    let pendingText: string | null = null;
    let metadataWaitCalls = 0;

    const session: PermissionModeSessionFixture = {
      async popPendingMessage() {
        if (!pendingText) return false;
        const text = pendingText;
        pendingText = null;
        queue.pushImmediate(text, { permissionMode: 'default' });
        return true;
      },
      async waitForMetadataUpdate(abortSignal?: AbortSignal) {
        metadataWaitCalls += 1;
        if (metadataWaitCalls === 1) return true;
        return await new Promise<boolean>((resolve) => {
          abortSignal?.addEventListener('abort', () => resolve(false), { once: true });
        });
      },
    };

    const result = await waitForNextPermissionModeMessage({
      messageQueue: queue,
      abortSignal: new AbortController().signal,
      session: asSessionClient(session),
      onMetadataUpdate: () => {
        pendingText = 'after-callback-error';
        throw new Error('expected test callback failure');
      },
    });

    expect(metadataWaitCalls).toBeGreaterThanOrEqual(1);
    expect(result?.message).toBe('after-callback-error');
  });
});
