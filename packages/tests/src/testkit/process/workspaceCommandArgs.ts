export function resolveWorkspaceCommandArgs(workspaceName: string, ...commandParts: string[]): string[] {
  return ['-s', 'workspace', workspaceName, ...commandParts];
}
