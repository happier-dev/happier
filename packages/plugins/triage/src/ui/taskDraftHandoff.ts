import type { PluginEphemeralSharedScope } from '@happier-dev/plugin-sdk';
import { TriageTaskDraftLaunchV1Schema, type TriageTaskDraftV1 } from '../actions/tasksProtocol.js';
import { mintTriageOpaqueIdV1 } from '../opaqueId.js';

/** Draft text stays on this client; navigation carries only its address. */
function acquireDrafts(scope: PluginEphemeralSharedScope | null) {
  // Action and destination are separate artifacts. Their continuation belongs
  // to the admitted execution custody, not either artifact's presentation.
  return scope?.acquireExecutionBound?.('tasks/create-draft-handoff/v1', () => {
    const drafts = new Map<string, TriageTaskDraftV1>();
    return { value: drafts, retainWhenIdle: true, dispose: () => drafts.clear() };
  }) ?? null;
}

export function stageTriageTaskDraft(scope: PluginEphemeralSharedScope | null, fields: TriageTaskDraftV1) {
  const lease = acquireDrafts(scope);
  if (lease === null) return null;
  const draftId = mintTriageOpaqueIdV1();
  lease.value.set(draftId, fields);
  lease.release();
  return {
    input: { v: 1 as const, kind: 'createTask' as const, draftId },
    discard: () => { lease.value.delete(draftId); },
  };
}

export type TriageTaskDraftLaunch =
  | Readonly<{ status: 'none' }>
  | Readonly<{ status: 'unavailable' }>
  | Readonly<{ status: 'ready'; fields: TriageTaskDraftV1; discard(): void }>;

/** Read without consuming during render; the committed create surface takes custody. */
export function readTriageTaskDraftLaunch(scope: PluginEphemeralSharedScope | null, input: unknown): TriageTaskDraftLaunch {
  const parsed = TriageTaskDraftLaunchV1Schema.safeParse(input);
  if (!parsed.success) return { status: 'none' };
  const lease = acquireDrafts(scope);
  if (lease === null) return { status: 'unavailable' };
  const fields = lease.value.get(parsed.data.draftId);
  lease.release();
  return fields === undefined ? { status: 'unavailable' } : {
    status: 'ready', fields, discard: () => { lease.value.delete(parsed.data.draftId); },
  };
}
