export function buildDaemonControlHttpHeaders(
  controlToken?: string | null,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Connection: 'close',
  };
  if (controlToken) {
    headers['x-happier-daemon-token'] = controlToken;
  }
  return headers;
}
