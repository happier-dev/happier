/** Shared task refusal copy for both an exact observation and an already mounted source detail. */
export function presentInternalTaskReadFailure(
  reason: string | undefined,
  text: (key: string, fallback: string) => string,
): string | null {
  if (reason === 'task_content_unavailable') {
    return text('plugins.triage.internal.encryptedUnavailable', 'This task is end-to-end encrypted, and this Account can’t open it yet');
  }
  if (reason === 'task_not_found') {
    return text('plugins.triage.internal.noLongerShared', 'This task isn’t shared with you anymore');
  }
  return null;
}
