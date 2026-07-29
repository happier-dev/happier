import {
  BrowserAutomationActionRequestV1Schema,
  BrowserAutomationActionResultV1Schema,
  getActionSpec,
  type BrowserAutomationActionResultV1,
  type BrowserAutomationTimelineV1,
  type RuntimeActionIdV1,
} from '@happier-dev/protocol';

import type { BrowserAutomationDaemonService } from './service';
import type { BrowserAutomationViewRef } from './owners';

export type BrowserAutomationRouteFailure = Readonly<{
  ok: false;
  errorCode: 'invalid_parameters' | 'runtime_action_disabled';
  error: string;
}>;

export type BrowserAutomationRouteResult =
  | BrowserAutomationActionResultV1
  | BrowserAutomationTimelineV1
  | BrowserAutomationRouteFailure;

export type BrowserAutomationRoutes = Readonly<{
  dispatch(actionId: RuntimeActionIdV1, input: unknown): Promise<BrowserAutomationRouteResult>;
}>;

const invalidParameters: BrowserAutomationRouteFailure = {
  ok: false,
  errorCode: 'invalid_parameters',
  error: 'invalid_parameters',
};

function readViewRef(input: unknown): BrowserAutomationViewRef | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const data = input as Record<string, unknown>;
  const browserSessionId = typeof data.browserSessionId === 'string' ? data.browserSessionId.trim() : '';
  const viewId = typeof data.viewId === 'string' ? data.viewId.trim() : '';
  if (!browserSessionId || !viewId) return null;
  return { browserSessionId, viewId };
}

function syntheticResult(input: Readonly<{
  view: BrowserAutomationViewRef;
  status: 'succeeded' | 'failed';
  resultSummary?: Readonly<Record<string, unknown>>;
  errorCode?: BrowserAutomationActionResultV1['errorCode'];
}>): BrowserAutomationActionResultV1 {
  return BrowserAutomationActionResultV1Schema.parse({
    v: 1,
    automationRequestId: `${input.view.browserSessionId} ${input.view.viewId}`,
    status: input.status,
    durationMs: 0,
    adapterKind: 'chromiumSidecar',
    fidelity: input.status === 'succeeded' ? 'cdp' : 'unavailable',
    trustedInput: true,
    navigationGenerationBefore: 0,
    navigationGenerationAfter: 0,
    controlEpochBefore: 0,
    controlEpochAfter: 0,
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    ...(input.resultSummary ? { resultSummary: input.resultSummary } : {}),
  });
}

export function createBrowserAutomationRoutes(input: Readonly<{
  service: BrowserAutomationDaemonService;
}>): BrowserAutomationRoutes {
  return {
    async dispatch(actionId, rawInput) {
      if (actionId === 'browser.automation.status') {
        const view = readViewRef(rawInput);
        if (!view) return invalidParameters;
        const state = input.service.getStatus(view);
        return syntheticResult({
          view,
          status: 'succeeded',
          resultSummary: {
            controller: state.controller,
            controlEpoch: state.controlEpoch,
            hasActiveLease: Boolean(state.activeLease),
          },
        });
      }

      if (actionId === 'browser.automation.timeline.get') {
        const view = readViewRef(rawInput);
        if (!view) return invalidParameters;
        return input.service.getTimeline(view);
      }

      if (actionId === 'browser.automation.cancelActive') {
        const view = readViewRef(rawInput);
        if (!view) return invalidParameters;
        const requesterRef = readRequesterRef(rawInput) ?? { kind: 'agent', id: `${view.browserSessionId}` };
        const canceled = input.service.cancelActive({ ...view, requesterRef });
        return canceled.ok
          ? syntheticResult({ view, status: 'succeeded' })
          : syntheticResult({
              view,
              status: 'failed',
              errorCode: canceled.errorCode === 'owner_mismatch' ? 'owner_mismatch' : 'unsupported_action',
            });
      }

      const parsed = getActionSpec(actionId).inputSchema.safeParse(rawInput ?? {});
      if (!parsed.success) return invalidParameters;
      const request = BrowserAutomationActionRequestV1Schema.safeParse(parsed.data);
      if (!request.success) return invalidParameters;

      return input.service.execute(request.data);
    },
  };
}

function readRequesterRef(input: unknown): Readonly<{ kind: string; id: string }> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const ref = (input as Record<string, unknown>).requesterRef;
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;
  const kind = (ref as Record<string, unknown>).kind;
  const id = (ref as Record<string, unknown>).id;
  if (typeof kind !== 'string' || typeof id !== 'string' || !kind || !id) return null;
  return { kind, id };
}
