import { BrowserAutomationActionResultV1Schema, BrowserAutomationTimelineEntryV1Schema, isBrowserAutomationMutatingActionKind } from '@happier-dev/protocol/browser/automation/v1';
import { redactBrowserAutomationActionResultDetails, redactBrowserAutomationTimelineDetails } from '@happier-dev/protocol/browser/automation/redaction';
import type { BrowserAutomationActionRequestV1, BrowserAutomationActionResultV1, BrowserAutomationActionStatusV1, BrowserAutomationTimelineEntryV1 } from '@happier-dev/protocol';

import type { BrowserAutomationAdapter, BrowserAutomationAdapterExecutionContext, BrowserAutomationAdapterExecuteResult } from './adapters/types';

export type BrowserAutomationActionOutcome = Readonly<{
  result: BrowserAutomationActionResultV1;
  timelineEntry: BrowserAutomationTimelineEntryV1;
  interruptionCompletion?: 'stopped' | 'uncertain';
}>;

function redactDetails(
  value: Readonly<Record<string, unknown>> | undefined,
  options: Readonly<{ preserveLocatorValues?: boolean }> = {},
): Record<string, unknown> {
  if (!value) return {};
  const redacted = options.preserveLocatorValues
    ? redactBrowserAutomationActionResultDetails(value)
    : redactBrowserAutomationTimelineDetails(value);
  return redacted && typeof redacted === 'object' && !Array.isArray(redacted)
    ? (redacted as Record<string, unknown>)
    : {};
}

function targetSummaryFor(request: BrowserAutomationActionRequestV1): Record<string, unknown> {
  return redactDetails({
    actionKind: request.actionKind,
    ...(request.payload && typeof request.payload === 'object' ? request.payload : {}),
  });
}

export async function executeBrowserAutomationAction(input: Readonly<{
  request: BrowserAutomationActionRequestV1;
  adapter: BrowserAutomationAdapter;
  controlEpoch: number;
  navigationGenerationBefore: number;
  navigationGenerationAfter?: number;
  getNavigationGenerationAfter?: () => number;
  now?: () => number;
  executionContext?: BrowserAutomationAdapterExecutionContext;
  generateTimelineEntryId: () => string;
}>): Promise<BrowserAutomationActionOutcome> {
  const now = input.now ?? (() => Date.now());
  const queuedAtMs = now();
  const startedAtMs = now();
  let adapterResult: BrowserAutomationAdapterExecuteResult;
  try { adapterResult = await input.adapter.execute(input.request, input.executionContext); }
  catch { adapterResult = { status: input.executionContext?.signal?.aborted ? 'canceled' : 'failed', fidelity: 'unavailable', trustedInput: false,
    errorCode: input.executionContext?.signal?.aborted ? 'user_canceled' : 'runtime_unavailable', interruptionCompletion: 'uncertain' }; }
  const finishedAtMs = now();
  const durationMs = Math.max(0, finishedAtMs - startedAtMs);

  const navigationGenerationBefore = input.navigationGenerationBefore;
  const navigationGenerationAfter = input.getNavigationGenerationAfter?.() ?? (isBrowserAutomationMutatingActionKind(input.request.actionKind)
    ? input.navigationGenerationAfter ?? navigationGenerationBefore
    : navigationGenerationBefore);

  const status: BrowserAutomationActionStatusV1 = adapterResult.status;
  const resultSummary = redactDetails(adapterResult.resultSummary, { preserveLocatorValues: true });
  const timelineResultSummary = redactDetails(adapterResult.resultSummary);
  const diagnostics = redactDetails(adapterResult.diagnostics);

  const result = BrowserAutomationActionResultV1Schema.parse({
    v: 1,
    automationRequestId: input.request.automationRequestId,
    status,
    durationMs,
    adapterKind: input.adapter.adapterKind,
    fidelity: adapterResult.fidelity,
    trustedInput: adapterResult.trustedInput,
    navigationGenerationBefore,
    navigationGenerationAfter,
    controlEpochBefore: input.controlEpoch,
    controlEpochAfter: input.controlEpoch,
    ...(adapterResult.errorCode ? { errorCode: adapterResult.errorCode } : {}),
    diagnostics,
    resultSummary,
  });

  const timelineEntry = BrowserAutomationTimelineEntryV1Schema.parse({
    v: 1,
    timelineEntryId: input.generateTimelineEntryId(),
    automationRequestId: input.request.automationRequestId,
    browserSessionId: input.request.browserSessionId,
    viewId: input.request.viewId,
    actionKind: input.request.actionKind,
    requesterKind: input.request.requestedBy,
    status,
    adapterKind: input.adapter.adapterKind,
    fidelity: adapterResult.fidelity,
    trustedInput: adapterResult.trustedInput,
    queuedAtMs,
    startedAtMs,
    finishedAtMs,
    durationMs,
    navigationGenerationBefore,
    navigationGenerationAfter,
    controlEpochBefore: input.controlEpoch,
    controlEpochAfter: input.controlEpoch,
    targetSummary: targetSummaryFor(input.request),
    resultSummary: timelineResultSummary,
    ...(adapterResult.errorCode ? { reasonCode: adapterResult.errorCode } : {}),
  });

  return { result, timelineEntry, ...(adapterResult.interruptionCompletion ? { interruptionCompletion: adapterResult.interruptionCompletion } : {}) };
}
