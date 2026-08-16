export function resolveClaudeExternalSandboxEnv(
  env: Readonly<NodeJS.ProcessEnv>,
): Record<string, string> {
  return env.IS_SANDBOX === '1' ? { IS_SANDBOX: '1' } : {};
}
