import type { ActionExecuteFailure, HostReviewedChildPortV1 } from '@happier-dev/protocol/actions/executor/types';
import { OpenProjectResultV1Schema, projectOpenProjectRefusalV1, type OpenProjectInputV1, type OpenProjectResultV1 } from '@happier-dev/protocol/projects/openProjectV1';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';

/** Reviewed composites consume the same strict Project Open outcome contract. */
export async function invokeReviewedProjectOpen(input: Readonly<{
  request: OpenProjectInputV1; role: string; invokeReviewedChild?: HostReviewedChildPortV1['invoke']; signal?: AbortSignal;
}>): Promise<Readonly<{ ok: true; opened: Extract<OpenProjectResultV1, { kind: 'opened' }> }> | ActionExecuteFailure> {
  if (!input.invokeReviewedChild) return { ok: false as const, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' };
  input.signal?.throwIfAborted();
  const action = await input.invokeReviewedChild({ action: 'projects.open', role: input.role,
    input: projectNativeJsonValueForTransport(input.request) });
  if (!action.ok) return action;
  const parsed = OpenProjectResultV1Schema.safeParse(action.result);
  if (!parsed.success) return { ok: false as const, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
  if (parsed.data.kind === 'refused') return projectOpenProjectRefusalV1(parsed.data);
  if (parsed.data.kind !== 'opened') return { ok: false as const,
    errorCode: parsed.data.kind === 'ambiguous' ? 'workspace_ambiguous' : 'outcome_unknown',
    error: parsed.data.kind === 'ambiguous' ? 'workspace_ambiguous' : 'outcome_unknown', details: parsed.data };
  return { ok: true as const, opened: parsed.data };
}
