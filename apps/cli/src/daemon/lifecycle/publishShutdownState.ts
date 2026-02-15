import type { DaemonState } from '@/api/types';

type DaemonApiMachineLike = {
  updateDaemonState: (updater: (state: DaemonState | null) => DaemonState) => Promise<unknown>;
  shutdown: () => void;
};

export async function publishShutdownStateBestEffort(params: Readonly<{
  apiMachine: DaemonApiMachineLike;
  source: 'happier-app' | 'happier-cli' | 'os-signal' | 'exception';
  timeoutMs: number;
  warn: (message: string, error?: unknown) => void;
}>): Promise<void> {
  let settled = false;

  const publishPromise = params.apiMachine
    .updateDaemonState((state: DaemonState | null) => ({
      ...state,
      status: 'shutting-down',
      shutdownRequestedAt: Date.now(),
      shutdownSource: params.source,
    }))
    .catch((error) => {
      params.warn('[DAEMON RUN] Failed to publish shutdown daemon state before exit', error);
    })
    .finally(() => {
      settled = true;
    });

  await Promise.race([
    publishPromise,
    new Promise<void>((resolve) => {
      setTimeout(resolve, params.timeoutMs);
    }),
  ]);

  if (!settled) {
    params.warn(`[DAEMON RUN] Shutdown daemon-state publish exceeded ${params.timeoutMs}ms; continuing teardown`);
  }

  params.apiMachine.shutdown();
}
