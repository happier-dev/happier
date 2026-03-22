export function shouldStartClaudeSessionCaffeinate(startedBy: 'terminal' | 'daemon' | undefined): boolean {
  return startedBy !== 'daemon';
}
