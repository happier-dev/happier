import {
  CLAUDE_CODE_REQUIRED_OAUTH_SCOPES,
  CLAUDE_CODE_SETUP_TOKEN_SCOPES,
} from '@happier-dev/agents';

export {
  CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
  CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPES,
  CLAUDE_CODE_REQUIRED_OAUTH_SCOPES,
  CLAUDE_CODE_SETUP_TOKEN_SCOPES,
} from '@happier-dev/agents';

export function parseClaudeCodeCredentialScopes(
  value: string | readonly string[] | null | undefined,
): string[] {
  const rawScopes = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/\s+/)
      : [];
  const seen = new Set<string>();
  const scopes: string[] = [];
  for (const rawScope of rawScopes) {
    const scope = rawScope.trim();
    if (!scope || seen.has(scope)) continue;
    seen.add(scope);
    scopes.push(scope);
  }
  return scopes;
}

export function findMissingClaudeCodeCredentialScopes(
  value: string | readonly string[] | null | undefined,
): string[] {
  const scopes = new Set(parseClaudeCodeCredentialScopes(value));
  return CLAUDE_CODE_REQUIRED_OAUTH_SCOPES.filter((scope) => !scopes.has(scope));
}

export function findMissingClaudeCodeNativeCredentialScopes(
  value: string | readonly string[] | null | undefined,
): string[] {
  const scopes = parseClaudeCodeCredentialScopes(value);
  if (
    scopes.length === CLAUDE_CODE_SETUP_TOKEN_SCOPES.length
    && CLAUDE_CODE_SETUP_TOKEN_SCOPES.every((scope) => scopes.includes(scope))
  ) {
    return [];
  }
  return findMissingClaudeCodeCredentialScopes(scopes);
}
