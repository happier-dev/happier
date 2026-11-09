/** Shell bridge provenance lowers a generated invocation to the Agent caller surface. */
export function isShellBridgeAgentMarkerV1(token: string): boolean {
  // Moving 0.2 predecessor produces the longer spelling. Retain it while those
  // generated commands may reach this CLI, without restoring credential lookup.
  return token === '--agent-bridge' || token === '--session-agent-bridge';
}

export function resolveShellBridgeActionSurfaceV1(args: readonly string[]): 'cli' | 'agent' {
  return args.some(isShellBridgeAgentMarkerV1) ? 'agent' : 'cli';
}
