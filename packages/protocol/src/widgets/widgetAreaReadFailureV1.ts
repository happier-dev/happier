import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import type { ActionExecuteFailure } from '../actions/actionExecutionResult.js';

/** Failed acquisition does not withdraw a previously admitted layout. Authority refusals do. */
export const WidgetAreaReadFailureDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('widget_area_read_failure'),
}));

export function createWidgetAreaReadFailureV1(errorCode: string): ActionExecuteFailure {
  return { ok: false, errorCode, error: errorCode, details: { kind: 'widget_area_read_failure' } };
}

/** Preserve the transport owner's recovery decision rather than reconstructing it from error codes. */
export function projectWidgetAreaReadExceptionV1(error: unknown): ActionExecuteFailure {
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : null;
  if (code === 'cancelled' || error instanceof Error && error.name === 'AbortError') {
    return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
  }
  const errorCode = code ?? 'widget_area_unavailable';
  const canTryAgain = error instanceof Error && 'canTryAgain' in error ? error.canTryAgain : undefined;
  if (canTryAgain === true || canTryAgain === undefined && !code) {
    return createWidgetAreaReadFailureV1(errorCode);
  }
  return { ok: false, errorCode, error: errorCode };
}
