import { ActionOperationProgressV1Schema, type ActionOperationProgressV1 } from '@happier-dev/protocol/actions';

import type { ActionOperationProgressUpdate } from './actionOperationTypes';

export function parseActionOperationProgressUpdate(
  update: ActionOperationProgressUpdate,
): ActionOperationProgressV1 | null {
  const candidate = update.current !== undefined || update.total !== undefined
    ? update.current !== undefined && update.total !== undefined
      ? { kind: 'determinate' as const, current: update.current, total: update.total, ...(update.label ? { label: update.label } : {}) }
      : null
    : update.phase !== undefined
      ? update.label !== undefined
        ? { kind: 'phase' as const, phase: update.phase, label: update.label }
        : null
      : update.label !== undefined
        ? { kind: 'indeterminate' as const, label: update.label }
        : { kind: 'indeterminate' as const };
  if (!candidate) return null;
  const parsed = ActionOperationProgressV1Schema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
