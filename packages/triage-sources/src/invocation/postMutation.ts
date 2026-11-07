/**
 * One write-to-read-owner completion lifecycle. Provider semantics identify a possible effect;
 * the resource owner owns the exact reread and publication from its typed result.
 * Host pending/idle and answer-lost outcomes retain their universal settlement semantics.
 */
export function shouldCompleteTriagePostMutation<Result extends object>(
  execution: Result,
  providerMayHaveChanged: (execution: Result) => boolean,
): boolean {
  if ('status' in execution) {
    if (execution.status === 'idle' || execution.status === 'pending') return false;
    if (execution.status === 'outcomeUnknown') return true;
  }
  return providerMayHaveChanged(execution);
}

export async function completeTriagePostMutationIfNeeded<Result extends object>(
  complete: () => Promise<void>,
  execution: Result,
  providerMayHaveChanged: (execution: Result) => boolean,
): Promise<void> {
  if (shouldCompleteTriagePostMutation(execution, providerMayHaveChanged)) await complete();
}
