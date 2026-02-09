const POTENTIAL_AUTH_VARS = [
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_HOME',
  'AZURE_OPENAI_API_KEY',
  'TOGETHER_API_KEY',
] as const;

export function findUnexpandedAuthEnvironmentReferences(env: Record<string, string | undefined>): string[] {
  const findings: string[] = [];

  for (const varName of POTENTIAL_AUTH_VARS) {
    const value = env[varName];
    if (!value || !value.includes('${')) {
      continue;
    }

    const unresolvedMatch = value.match(/\$\{([A-Z_][A-Z0-9_]*)(:-[^}]*)?\}/);
    const missingVar = unresolvedMatch ? unresolvedMatch[1] : 'unknown';
    findings.push(`${varName} references \${${missingVar}} which is not defined`);
  }

  return findings.sort();
}

export function buildAuthEnvUnexpandedErrorMessage(details: string[]): string {
  return (
    `Authentication will fail - environment variables not found in daemon: ${details.join('; ')}. ` +
    `Ensure these variables are set in the daemon's environment (not just your shell) before starting sessions.`
  );
}
