export type ClaudeUnifiedTerminalLaunchIntent =
  | Readonly<{ kind: 'new_session' }>
  | Readonly<{ kind: 'resume_native'; providerSessionId: string }>;

/**
 * Makes provider-session identity singular at the Claude CLI boundary. Every launch
 * removes competing continuation/session flags; resume then appends the exact ID.
 */
export function applyClaudeUnifiedTerminalLaunchIntent(
  args: readonly string[],
  intent: ClaudeUnifiedTerminalLaunchIntent,
): readonly string[] {
  const argsWithoutSessionIdentity: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--continue' || arg === '-c' || arg === '--fork-session') continue;
    if (arg === '--resume' || arg === '-r' || arg === '--session-id') {
      const next = args[index + 1];
      if (typeof next === 'string' && !next.startsWith('-')) index += 1;
      continue;
    }
    if (
      arg.startsWith('--resume=')
      || arg.startsWith('-r=')
      || arg.startsWith('--session-id=')
      || arg.startsWith('--fork-session=')
    ) {
      continue;
    }
    argsWithoutSessionIdentity.push(arg);
  }

  return intent.kind === 'resume_native'
    ? [...argsWithoutSessionIdentity, '--resume', intent.providerSessionId]
    : argsWithoutSessionIdentity;
}
