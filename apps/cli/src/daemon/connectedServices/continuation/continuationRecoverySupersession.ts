import {
  clearRuntimeAuthFailureReportOutboxForSupersession,
  type RuntimeAuthFailureReportOutboxSupersessionEvent,
} from '../runtimeAuth/reportOutbox/runtimeAuthFailureReportOutboxSupersession';
/** Clears only the runtime-auth report outbox selected by its supersession owner. */
export function createConnectedServiceRecoverySupersessionCleaner(params: Readonly<{
  removeReportOutboxItemsForSession: (input: Readonly<{
    sessionId: string;
    updatedBeforeMs?: number;
  }>) => Promise<void> | void;
  logDebug?: (message: string, error: unknown) => void;
}>) {
  return async (input: Readonly<{
    sessionId: string;
    event: RuntimeAuthFailureReportOutboxSupersessionEvent;
    updatedBeforeMs?: number;
  }>): Promise<void> => {
    await clearRuntimeAuthFailureReportOutboxForSupersession({
      sessionId: input.sessionId,
      event: input.event,
      removeForSession: async (sessionId) => {
        await params.removeReportOutboxItemsForSession({
          sessionId,
          ...(input.updatedBeforeMs === undefined
            ? {}
            : { updatedBeforeMs: input.updatedBeforeMs }),
        });
      },
    }).catch((error) => {
      params.logDebug?.('[DAEMON RUN] Failed to clear connected-service runtime-auth report outbox after supersession (non-fatal)', error);
    });
  };
}
