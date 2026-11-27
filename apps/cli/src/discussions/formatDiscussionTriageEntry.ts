import { isInternalTaskReferenceV1, type TriageEntryRefV1 } from '@happier-dev/protocol/tasks/entryRefV1';

export function formatDiscussionTriageEntry(entry: TriageEntryRefV1): string {
  return isInternalTaskReferenceV1(entry) ? '[Task]' : '[Triage entry]';
}
