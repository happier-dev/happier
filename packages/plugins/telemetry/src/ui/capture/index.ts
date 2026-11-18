/**
 * The capture views every capture reader draws (the Environment's Telemetry tab, a worktree's local capture,
 * the exception detail's request): one component set over the `capture/*` read answers.
 */
export {
  CaptureEndpoints,
  CaptureLogs,
  CaptureQueries,
  CaptureTraces,
  type CaptureEndpointAction,
  type CapturePageMore,
} from './CaptureViews.js';
export {
  CapturedLogLines,
  CapturedRequestLogs,
  CapturedRequestSlowest,
  CapturedRequestWaterfall,
  type CapturedLogBodyReader,
  type CapturedTraceV1,
} from './CapturedRequest.js';
export {
  captureEndpointTitle,
  captureSummaryFailed,
  projectCaptureEndpoints,
  type CaptureEndpointView,
} from './model.js';
export { projectWaterfall, requestLabelOf, slowestSteps } from '../traceWaterfall.js';
