import { getActionSpec, type RuntimeActionIdV1 } from '@happier-dev/protocol';

import type { BrowserRecordingRoutes } from './routes';

/**
 * BA-5: the non-attach `browser.recording.*` runtime-action route owner. The recording daemon
 * routes (`recording/routes.ts`) are fully service-backed (start/stop/cancel/status/listForView/
 * cleanupExpired); the runtime-action executor just never routed the non-attach ids. This owner
 * maps each runtime-action id onto the corresponding service-backed route method so the headless
 * agent + the UI can drive the full recording lifecycle through the single ActionExecutor front
 * door. `attachToComposer` is owned separately (it needs the composer/session-media attach sink),
 * so it is intentionally not handled here.
 */
export type BrowserRecordingActionRouteFailure = Readonly<{
  ok: false;
  errorCode: 'invalid_parameters';
  error: string;
}>;

export type BrowserRecordingActionRoutes = Readonly<{
  dispatch(actionId: RuntimeActionIdV1, input: unknown): Promise<unknown>;
}>;

const invalidParameters: BrowserRecordingActionRouteFailure = {
  ok: false,
  errorCode: 'invalid_parameters',
  error: 'invalid_parameters',
};

function parseInput(actionId: RuntimeActionIdV1, input: unknown): { ok: true; value: unknown } | { ok: false } {
  const parsed = getActionSpec(actionId).inputSchema.safeParse(input ?? {});
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

export function createBrowserRecordingActionRoutes(input: Readonly<{
  routes: BrowserRecordingRoutes;
}>): BrowserRecordingActionRoutes {
  const { routes } = input;
  return {
    async dispatch(actionId, rawInput) {
      const parsed = parseInput(actionId, rawInput);
      if (!parsed.ok) return invalidParameters;
      const value = parsed.value as never;
      switch (actionId) {
        case 'browser.recording.start':
          return await routes.startRecording(value);
        case 'browser.recording.stop':
          return await routes.stopRecording(value);
        // `cancel` aborts an in-flight recording; `discard` disposes a finalized one. Both share the
        // cancel input contract (`DaemonBrowserRecordingCancelInputV1`) and the single terminal
        // disposal route owner, so they map to the same service-backed route.
        case 'browser.recording.cancel':
        case 'browser.recording.discard':
          return await routes.cancelRecording(value);
        case 'browser.recording.status':
          return await routes.getRecordingStatus(value);
        case 'browser.recording.listForView':
          return await routes.listRecordingsForView(value);
        case 'browser.recording.cleanupExpired':
          return await routes.cleanupExpiredRecordings(value);
        default:
          return invalidParameters;
      }
    },
  };
}
