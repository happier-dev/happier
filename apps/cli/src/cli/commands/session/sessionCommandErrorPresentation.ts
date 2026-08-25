export function formatSessionCommandError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown error';
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : message;

  if (code === 'target_unavailable') {
    return 'The selected machine is not currently available. Check its connection and try again.';
  }

  return message;
}
