import { afterEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';

import { AcpBackend } from '../AcpBackend';

/**
 * Killing the local process only releases local resources. An Agent that
 * negotiated `session/close` owns session resources beyond this process — a
 * remote or cloud session, a shared worker — so disposal must release them
 * explicitly while the transport is still usable.
 */
function backendWithActiveSession(input: Readonly<{
  closeNegotiated: boolean;
  closeSession?: () => Promise<unknown>;
}>): Readonly<{
  backend: AcpBackend;
  cancel: ReturnType<typeof vi.fn>;
  closeSession: ReturnType<typeof vi.fn>;
  connectionClose: ReturnType<typeof vi.fn>;
}> {
  const cancel = vi.fn(async () => ({}));
  const closeSession = vi.fn(input.closeSession ?? (async () => ({})));
  const connectionClose = vi.fn();
  const backend = new AcpBackend({
    agentName: 'test',
    cwd: '/workspace',
    command: 'noop',
  });
  (backend as any).connection = {
    peer: { cancel, closeSession },
    close: connectionClose,
    closed: Promise.resolve(),
  };
  (backend as any).acpSessionId = ' sess_remote ';
  (backend as any).negotiatedSessionCapabilities = Object.freeze({
    loadSession: false,
    listSessions: false,
    forkSession: false,
    closeSession: input.closeNegotiated,
    deleteSession: false,
  });
  return { backend, cancel, closeSession, connectionClose };
}

describe('AcpBackend disposal session/close', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('releases the Agent-owned session with the exact opaque id after cancelling', async () => {
    let cancellationSettled = false;
    let closeSawCancellationSettled: boolean | undefined;
    const { backend, cancel, closeSession, connectionClose } = backendWithActiveSession({
      closeNegotiated: true,
      closeSession: async () => {
        closeSawCancellationSettled = cancellationSettled;
        return {};
      },
    });
    cancel.mockImplementation(async () => {
      await Promise.resolve();
      cancellationSettled = true;
      return {};
    });

    await backend.dispose();

    expect(cancel).toHaveBeenCalledWith({ sessionId: ' sess_remote ' });
    // Byte-exact identifier: the Agent must be able to match the session it handed us.
    expect(closeSession).toHaveBeenCalledWith({ sessionId: ' sess_remote ' });
    expect(closeSawCancellationSettled).toBe(true);
    expect(connectionClose).toHaveBeenCalled();
  });

  it('does not call session/close against an Agent that did not negotiate it', async () => {
    const { backend, cancel, closeSession, connectionClose } = backendWithActiveSession({
      closeNegotiated: false,
    });

    await backend.dispose();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(closeSession).not.toHaveBeenCalled();
    expect(connectionClose).toHaveBeenCalled();
  });

  /**
   * A peer that accepts `session/close` and never answers must not hold the
   * daemon's teardown open past the graceful bound, and the outcome must reach
   * an operator: an unobservable silent close is indistinguishable from a
   * completed release.
   */
  it('reports the close timeout and continues disposal against a never-settling peer', async () => {
    vi.useFakeTimers();
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const { backend, closeSession, connectionClose } = backendWithActiveSession({
      closeNegotiated: true,
      closeSession: () => new Promise<never>(() => undefined),
    });

    const disposal = backend.dispose();
    // The cancel bound settles first, then the close bound; neither may be
    // waited on past its established two-second grace.
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(disposal).resolves.toBeUndefined();

    expect(closeSession).toHaveBeenCalledWith({ sessionId: ' sess_remote ' });
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('ACP session/close did not settle'),
      expect.objectContaining({ sessionId: ' sess_remote ' }),
    );
    expect(connectionClose).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the graceful close timer as soon as the Agent answers', async () => {
    vi.useFakeTimers();
    const { backend, closeSession } = backendWithActiveSession({ closeNegotiated: true });

    await expect(backend.dispose()).resolves.toBeUndefined();

    expect(closeSession).toHaveBeenCalledTimes(1);
    // A settled close must leave no pending 2s timer keeping the runtime alive.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still tears the transport down when session/close fails', async () => {
    const { backend, closeSession, connectionClose } = backendWithActiveSession({
      closeNegotiated: true,
      closeSession: async () => {
        throw new Error('agent refused session/close');
      },
    });

    await expect(backend.dispose()).resolves.toBeUndefined();

    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(connectionClose).toHaveBeenCalled();
    expect((backend as any).connection).toBeNull();
  });
});
