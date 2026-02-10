import { describe, expect, it, vi } from 'vitest';

import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { registerPermissionModeMessageQueueBinding } from './bindPermissionModeQueue';

function createSessionHarness() {
  let handler: ((message: any) => void) | null = null;
  const session = {
    onUserMessage: (fn: (message: any) => void) => {
      handler = fn;
    },
    updateMetadata: vi.fn(),
  };
  return {
    session,
    emitUserMessage: (message: any) => {
      if (!handler) throw new Error('onUserMessage handler not registered');
      handler(message);
    },
  };
}

function createQueue() {
  // MessageQueue2 already implements push + pushIsolateAndClear.
  const queue = new MessageQueue2<{ permissionMode: any }>((mode) => mode.permissionMode);
  const spyPush = vi.spyOn(queue, 'push');
  const spyIsolate = vi.spyOn(queue, 'pushIsolateAndClear');
  return { queue, spyPush, spyIsolate };
}

describe('registerPermissionModeMessageQueueBinding (in-flight steer)', () => {
  it('queues messages normally when no steer controller is provided', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
    });

    emitUserMessage({ content: { text: 'hello' }, meta: {} });
    expect(spyPush).toHaveBeenCalledWith('hello', { permissionMode: 'default' });
  });

  it('steers a message during an in-flight turn and does not queue it when steer succeeds', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    const steerText = vi.fn(async () => {});
    const isTurnInFlight = vi.fn(() => true);
    const supportsInFlightSteer = vi.fn(() => true);

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight,
        supportsInFlightSteer,
        steerText,
      },
    } as any);

    emitUserMessage({ content: { text: 'steer me' }, meta: {} });
    await Promise.resolve();

    expect(steerText).toHaveBeenCalledWith('steer me');
    expect(spyPush).not.toHaveBeenCalled();
  });

  it('falls back to queueing when steering fails', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    const steerText = vi.fn(async () => {
      throw new Error('steer failed');
    });

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
      },
    } as any);

    emitUserMessage({ content: { text: 'queue me' }, meta: {} });
    await Promise.resolve();
    await Promise.resolve();

    expect(spyPush).toHaveBeenCalledWith('queue me', { permissionMode: 'default' });
  });

  it('does not leak unhandledRejection when fallback queueing throws', async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      const { session, emitUserMessage } = createSessionHarness();
      const { queue, spyPush } = createQueue();

      spyPush.mockImplementation(() => {
        throw new Error('queue push failed');
      });

      const steerText = vi.fn(async () => {
        throw new Error('steer failed');
      });

      registerPermissionModeMessageQueueBinding({
        session,
        queue,
        getCurrentPermissionMode: () => 'default',
        setCurrentPermissionMode: () => {},
        inFlightSteer: {
          isTurnInFlight: () => true,
          supportsInFlightSteer: () => true,
          steerText,
        },
      } as any);

      emitUserMessage({ content: { text: 'fallback should not crash' }, meta: {} });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('serializes steering so multiple in-flight messages do not overlap', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    let currentInFlight = 0;
    let maxInFlight = 0;
    let resolveFirstGate: () => void = () => {
      throw new Error('firstGate resolver not initialized');
    };
    const firstGate = new Promise<void>((resolve) => {
      resolveFirstGate = () => resolve();
    });

    const steerText = vi.fn(async (text: string) => {
      currentInFlight += 1;
      maxInFlight = Math.max(maxInFlight, currentInFlight);
      try {
        if (text === 'first') {
          await firstGate;
        }
        await Promise.resolve();
      } finally {
        currentInFlight -= 1;
      }
    });

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
      },
    } as any);

    emitUserMessage({ content: { text: 'first' }, meta: {} });
    emitUserMessage({ content: { text: 'second' }, meta: {} });

    // Allow the async steer tasks to start.
    await Promise.resolve();

    resolveFirstGate();
    await Promise.resolve();
    await Promise.resolve();

    expect(maxInFlight).toBe(1);
    expect(spyPush).not.toHaveBeenCalled();
  });

  it('does not steer when the message changes permission mode (it must be queued)', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush } = createQueue();

    const steerText = vi.fn(async () => {});

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
      },
    } as any);

    emitUserMessage({ content: { text: 'mode change' }, meta: { permissionMode: 'read-only' } });
    await Promise.resolve();

    expect(steerText).not.toHaveBeenCalled();
    expect(spyPush).toHaveBeenCalledWith('mode change', { permissionMode: 'read-only' });
  });

  it('does not steer /clear (it must be isolated+clearing)', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush, spyIsolate } = createQueue();

    const steerText = vi.fn(async () => {});

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
      },
    } as any);

    emitUserMessage({ content: { text: '/clear' }, meta: {} });
    await Promise.resolve();

    expect(steerText).not.toHaveBeenCalled();
    expect(spyPush).not.toHaveBeenCalled();
    expect(spyIsolate).toHaveBeenCalledWith('/clear', { permissionMode: 'default' });
  });

  it('does not steer /compact (it must be handled by the main loop)', async () => {
    const { session, emitUserMessage } = createSessionHarness();
    const { queue, spyPush, spyIsolate } = createQueue();

    const steerText = vi.fn(async () => {});

    registerPermissionModeMessageQueueBinding({
      session,
      queue,
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => {},
      inFlightSteer: {
        isTurnInFlight: () => true,
        supportsInFlightSteer: () => true,
        steerText,
      },
    } as any);

    emitUserMessage({ content: { text: '/compact' }, meta: {} });
    await Promise.resolve();

    expect(steerText).not.toHaveBeenCalled();
    expect(spyIsolate).not.toHaveBeenCalled();
    expect(spyPush).toHaveBeenCalledWith('/compact', { permissionMode: 'default' });
  });
});
