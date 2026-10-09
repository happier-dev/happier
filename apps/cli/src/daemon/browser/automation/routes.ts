import { BrowserAutomationActionRequestV1Schema, BrowserAutomationActionResultV1Schema, resolveBrowserAutomationActionRequester, BrowserAutomationCancelActiveResultV1Schema } from '@happier-dev/protocol/browser/automation/v1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { BrowserAutomationActionResultV1, BrowserAutomationCancelActiveResultV1, ActionExecutorContext, BrowserAutomationTimelineV1, RuntimeActionIdV1 } from '@happier-dev/protocol';

import type { BrowserAutomationDaemonService } from './service';
import type { BrowserAutomationViewRef } from './owners';
import { BrowserAutomationSecretFillRequestV1Schema } from '@happier-dev/protocol/browser/automation/v1';
import type { BrowserConfidentialFillPreparation } from './adapters/types';
import type { SurfaceInputControl } from '../../surfaces/inputControl';

export type BrowserAutomationRouteFailure = Readonly<{
  ok: false;
  errorCode: 'invalid_parameters' | 'runtime_action_disabled';
  error: string;
}>;

export type BrowserAutomationRouteResult =
  | BrowserAutomationActionResultV1
  | BrowserAutomationCancelActiveResultV1
  | BrowserAutomationTimelineV1
  | BrowserAutomationRouteFailure;

export type BrowserAutomationRoutes = Readonly<{
  resolveInputControl?(view: BrowserAutomationViewRef): SurfaceInputControl;
  prepareConfidentialFill(input: unknown, context?: ActionExecutorContext): Promise<BrowserConfidentialFillPreparation>;
  dispatch(
    actionId: RuntimeActionIdV1,
    input: unknown,
    context?: ActionExecutorContext,
  ): Promise<BrowserAutomationRouteResult>;
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
    resolveInputControl: view => input.service.getInputControl(view),
    async prepareConfidentialFill(rawInput, context) {
      if (context?.authority !== 'present_user') return { status: 'refused', code: 'approval_required' };
      const parsed = BrowserAutomationSecretFillRequestV1Schema.safeParse(rawInput);
      if (!parsed.success) return { status: 'refused', code: 'target_changed' };
      return input.service.prepareConfidentialFill(parsed.data, context);
    },
    async dispatch(actionId, rawInput, context) {
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
            ...(state.activeAutomationRequestId
              ? { activeAutomationRequestId: state.activeAutomationRequestId }
              : {}),
          },
        });
      }

      if (actionId === 'browser.automation.timeline.get') {
        const view = readViewRef(rawInput);
        if (!view) return invalidParameters;
        return input.service.getTimeline(view);
      }

      if (actionId === 'browser.automation.cancelActive') {
        const parsed = getActionSpec(actionId).inputSchema.safeParse(rawInput ?? {});
        if (!parsed.success) return invalidParameters;
        const view = readViewRef(parsed.data);
        if (!view) return invalidParameters;
        if (context?.authority !== 'present_user') {
          return BrowserAutomationCancelActiveResultV1Schema.parse({
            v: 1,
            outcome: 'owner_mismatch',
            canceledCount: 0,
          });
        }
        const canceled = await input.service.cancelActive({ ...view, authority: context.authority });
        return canceled.ok
          ? BrowserAutomationCancelActiveResultV1Schema.parse({
              v: 1,
              outcome: 'canceled',
              canceledCount: 1,
              completion: canceled.completion,
            })
          : BrowserAutomationCancelActiveResultV1Schema.parse({
              v: 1,
              outcome: canceled.errorCode === 'owner_mismatch' ? 'owner_mismatch' : 'no_active',
              canceledCount: 0,
            });
      }

      const parsed = getActionSpec(actionId).inputSchema.safeParse(rawInput ?? {});
      if (!parsed.success) return invalidParameters;
      const request = BrowserAutomationActionRequestV1Schema.safeParse(parsed.data);
      if (!request.success) return invalidParameters;

      const requestedBy = resolveBrowserAutomationActionRequester(request.data.requestedBy, context?.authority);
      if (!requestedBy) return invalidParameters;
      return input.service.execute({ ...request.data, requestedBy }, { signal: context?.signal });
    },
  };
}
