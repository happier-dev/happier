import type { EntityDropOutcomeV1 } from '@happier-dev/plugin-sdk';
import { TriageTaskWriteResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { taskWriteMessage } from '../taskWriteMessage.js';

/** The task writer owns whether the domain mutation actually happened. */
export function settleTriageTaskDropResult(result: unknown): EntityDropOutcomeV1 {
  const parsed = TriageTaskWriteResultV1Schema.safeParse(result);
  if (!parsed.success) return { status: 'unknown', reason: { code: 'triage_task_drop_invalid_result', message: 'The task result could not be read. Check the task before trying again.' } };
  const write = parsed.data;
  const message = taskWriteMessage((_key, fallback) => fallback ?? _key, write);
  switch (write.kind) {
    case 'applied': return { status: 'applied' };
    case 'refused': return { status: 'refused', reason: { code: write.reason, message } };
    case 'failed': return { status: 'refused', reason: { code: write.failure.code, message } };
    case 'uncertain': return { status: 'unknown', reason: {
      code: write.failure?.code ?? 'triage_task_write_uncertain',
      message,
    } };
  }
}
