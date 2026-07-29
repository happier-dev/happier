import { logger } from '@/ui/logger';

import type {
  DeferredStartupBootstrapResult,
  DeferredStartupStartOptions,
} from './deferredStartupTypes';
import type { StartupTiming } from './startupSpec';

const DEFAULT_TIMING_INCLUDE_IDS = [
  'vendor_spawn_invoked',
  'initialize_backend_api_context',
  'initialize_backend_run_session',
] as const;

export type TimedDeferredStartupBootstrapResult<TBootstrap extends DeferredStartupBootstrapResult> =
  TBootstrap & Readonly<{
    markVendorSpawnInvoked: () => void;
    timing: StartupTiming;
  }>;

export function createTimedDeferredStartupBootstrap<TBootstrap extends DeferredStartupBootstrapResult>(params: Readonly<{
  bootstrap: TBootstrap;
  timing: StartupTiming;
  logPrefix: string;
  includeIds?: ReadonlyArray<string>;
}>): TimedDeferredStartupBootstrapResult<TBootstrap> {
  let startPromise: Promise<void> | null = null;

  const start = async (
    options: DeferredStartupStartOptions = {},
  ): Promise<void> => {
    if (startPromise) {
      await startPromise;
      return;
    }

    startPromise = (async () => {
      const stopApiSpan = params.timing.startSpan('initialize_backend_api_context');
      const stopSessionSpan = params.timing.startSpan('initialize_backend_run_session');
      try {
        await params.bootstrap.start?.(options);
      } finally {
        stopSessionSpan();
        stopApiSpan();
        if (params.timing.enabled) {
          logger.debug(
            params.timing.formatSummaryLine({
              prefix: params.logPrefix,
              includeIds: params.includeIds ?? DEFAULT_TIMING_INCLUDE_IDS,
            }),
          );
        }
      }
    })();

    await startPromise;
  };

  return {
    ...params.bootstrap,
    start,
    markVendorSpawnInvoked: () => {
      params.timing.mark('vendor_spawn_invoked');
    },
    timing: params.timing,
  };
}
