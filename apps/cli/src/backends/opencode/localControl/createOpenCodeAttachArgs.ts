export function createOpenCodeAttachArgs(params: Readonly<{
  baseUrl: string;
  directory: string;
  sessionId: string;
}>): string[] {
  return [
    'attach',
    params.baseUrl,
    '--dir',
    params.directory,
    '--session',
    params.sessionId,
  ];
}
