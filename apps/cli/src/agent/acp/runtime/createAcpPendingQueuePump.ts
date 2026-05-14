import { readAuthenticationStatus } from '@/api/client/httpStatusError';

export type AcpRuntimePendingQueue = Readonly<{
  waitForMetadataUpdate: (abortSignal?: AbortSignal) => Promise<boolean>;
  popPendingMessage: () => Promise<boolean>;
  maxPopPerWake?: number;
  drainDuringTurn?: boolean;
  drainAfterStartOrLoad?: boolean;
  pollIntervalMs?: number;
}>;

export function createAcpPendingQueuePump(params: Readonly<{
  enabled: boolean;
  pendingQueue?: AcpRuntimePendingQueue;
}>): Readonly<{
  start: () => void;
  stop: () => void;
  drainAfterStartOrLoad: () => Promise<void>;
}> {
  let pendingPumpController: AbortController | null = null;

  const stop = () => {
    if (!pendingPumpController) return;
    try {
      pendingPumpController.abort('acp-runtime:stop-pending-pump');
    } catch {
      // ignore
    }
    pendingPumpController = null;
  };

  const drainPendingOnce = async (controller?: AbortController): Promise<void> => {
    if (!params.pendingQueue) return;
    const maxPopPerWake = Math.max(1, params.pendingQueue.maxPopPerWake ?? 25);
    for (let i = 0; i < maxPopPerWake; i += 1) {
      if (controller?.signal.aborted) break;
      let did = false;
      try {
        did = await params.pendingQueue.popPendingMessage();
      } catch (error) {
        if (readAuthenticationStatus(error) !== null) {
          stop();
          break;
        }
        did = false;
      }
      if (!did) break;
    }
  };

  const start = () => {
    if (!params.enabled) return;
    if (!params.pendingQueue) return;
    if (params.pendingQueue.drainDuringTurn !== true) return;
    if (pendingPumpController) return;

    const controller = new AbortController();
    pendingPumpController = controller;
    const pollIntervalMs = Math.max(5, params.pendingQueue.pollIntervalMs ?? 2_000);

    const waitForPollWake = async (): Promise<boolean> =>
      await new Promise<boolean>((resolve) => {
        if (controller.signal.aborted) return resolve(false);
        const timer = setTimeout(() => resolve(true), pollIntervalMs);
        timer.unref?.();
        controller.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve(false);
          },
          { once: true },
        );
      });

    void (async () => {
      await drainPendingOnce(controller);

      while (!controller.signal.aborted) {
        const iteration = new AbortController();
        const abortIteration = (reason: string) => {
          try {
            iteration.abort(reason);
          } catch {
            // ignore
          }
        };
        const onGlobalAbort = () => abortIteration('acp-runtime:pending-pump:global-abort');
        controller.signal.addEventListener('abort', onGlobalAbort, { once: true });

        const winner = await Promise.race([
          params.pendingQueue!
            .waitForMetadataUpdate(iteration.signal)
            .then(() => 'metadata')
            .catch(() => 'metadata'),
          waitForPollWake().then(() => 'poll'),
        ]);
        controller.signal.removeEventListener('abort', onGlobalAbort);
        if (winner === 'poll') {
          abortIteration('acp-runtime:pending-pump:poll-wake');
        }
        if (controller.signal.aborted) break;

        await drainPendingOnce(controller);
      }
    })();
  };

  return {
    start,
    stop,
    drainAfterStartOrLoad: async () => {
      if (params.pendingQueue?.drainAfterStartOrLoad !== true) return;
      await drainPendingOnce();
    },
  };
}
