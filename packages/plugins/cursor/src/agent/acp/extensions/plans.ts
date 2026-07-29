import {
  cursorCreatePlanResponseSchema,
  type CursorCreatePlanRequest,
} from './schemas.js';

export function buildCursorPlanPermissionInput(request: CursorCreatePlanRequest): string {
  const details = [
    request.overview,
    request.plan,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  return details.join('\n\n') || 'Approve the plan proposed by Cursor?';
}

export function buildCursorPlanResponse(
  outcome: 'accepted' | 'rejected' | 'cancelled',
  reason?: string,
) {
  if (outcome === 'cancelled') {
    return cursorCreatePlanResponseSchema.parse({ outcome: { outcome } });
  }
  if (outcome === 'rejected') {
    return cursorCreatePlanResponseSchema.parse({
      outcome: { outcome, ...(reason ? { reason } : {}) },
    });
  }
  return cursorCreatePlanResponseSchema.parse({ outcome: { outcome } });
}
