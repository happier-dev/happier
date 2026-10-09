import { z } from 'zod';

import { lazyZodSchema } from '../lazyZodSchema.js';
import { WorkspaceWorkerPreferenceV1Schema } from '../workspaces/projectWorkerPreferencesV1.js';
import { ActionExecuteFailureSchema } from './actionExecutionResult.js';

/** These facts establish no acceptance, unlike unknown eligibility or a full queue. */
export const ProjectWorkerNoAcceptanceReasonV1Schema = lazyZodSchema(() => z.enum([
  'empty', 'no_available_machine', 'not_accepting', 'draining', 'unsupported', 'forbidden',
  'workspace_unavailable', 'memory_insufficient',
]));
export type ProjectWorkerNoAcceptanceReasonV1 = z.infer<typeof ProjectWorkerNoAcceptanceReasonV1Schema>;

/** Redacted pre-acceptance facts; neither this detail nor fallback intent grants execution authority. */
export const ProjectWorkerNoAcceptanceFailureDetailsV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('no_worker_can_accept'),
  unavailable: WorkspaceWorkerPreferenceV1Schema.options[0].shape.unavailable,
  reason: ProjectWorkerNoAcceptanceReasonV1Schema,
}).strict());
export type ProjectWorkerNoAcceptanceFailureDetailsV1 = z.infer<typeof ProjectWorkerNoAcceptanceFailureDetailsV1Schema>;

export function readProjectWorkerNoAcceptanceFailureV1(value: unknown):
  Readonly<{ ok: false; errorCode: string; error: string; details: ProjectWorkerNoAcceptanceFailureDetailsV1 }> | null {
  const failure = ActionExecuteFailureSchema.safeParse(value);
  if (!failure.success) return null;
  const details = ProjectWorkerNoAcceptanceFailureDetailsV1Schema.safeParse(failure.data.details);
  if (!details.success || failure.data.errorCode !== details.data.reason
    && (details.data.unavailable === 'fail' || failure.data.errorCode !== 'choice_required')) return null;
  return { ok: false, errorCode: failure.data.errorCode, error: failure.data.errorCode, details: details.data };
}
