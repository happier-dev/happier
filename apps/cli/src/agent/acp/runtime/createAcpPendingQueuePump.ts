import { readAuthenticationStatus } from '@/api/client/httpStatusError';
import type {
  DrainPendingOptions,
  SessionProviderInputConsumer,
} from '@/agent/runtime/session/input/_types';
import { PENDING_QUEUE_ONE_AT_A_TIME_MAX_POP_PER_WAKE } from '@/agent/runtime/session/input/pendingQueueDrainPolicy';

export type AcpRuntimePendingQueue = Readonly<{
  waitForMetadataUpdate: (abortSignal?: AbortSignal) => Promise<boolean>;
  popPendingMessage: () => Promise<boolean>;
  inputConsumer?: Pick<SessionProviderInputConsumer<never, never>, 'drainPending'>;
  shouldAttemptMaterialization?: (() => boolean | Promise<boolean>) | null;
  reconcilePendingQueueState?: ((opts: { force: boolean }) => unknown | Promise<unknown>) | null;
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

  const drainPendingOnce = async (controller?: AbortController, reason = 'acp-pending-pump'): Promise<void> => {
    if (!params.pendingQueue) return;
    const maxPopPerWake = Math.max(1, params.pendingQueue.maxPopPerWake ?? PENDING_QUEUE_ONE_AT_A_TIME_MAX_POP_PER_WAKE);
    if (params.pendingQueue.inputConsumer) {
      const result = await params.pendingQueue.inputConsumer.drainPending({
        maxPopPerWake,
        reason,
        abortSignal: controller?.signal,
        logPrefix: '[ACP-RUNTIME]',
        shouldContinue: () => controller?.signal.aborted !== true,
      } satisfies DrainPendingOptions);
      if (result.stoppedReason === 'auth_failure') {
        stop();
      }
      return;
    }
    for (let i = 0; i < maxPopPerWake; i += 1) {
      if (controller?.signal.aborted) break;
      if ((await (params.pendingQueue.shouldAttemptMaterialization?.() ?? true)) !== true) {
        await params.pendingQueue.reconcilePendingQueueState?.({ force: true });
        if ((await (params.pendingQueue.shouldAttemptMaterialization?.() ?? true)) !== true) break;
      }
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
      await drainPendingOnce(controller, 'acp-in-flight-start');

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

        await drainPendingOnce(controller, 'acp-in-flight-wake');
      }
    })();
  };

  return {
    start,
    stop,
    drainAfterStartOrLoad: async () => {
      if (params.pendingQueue?.drainAfterStartOrLoad !== true) return;
      await drainPendingOnce(undefined, 'acp-start-or-load');
    },
  };
}
