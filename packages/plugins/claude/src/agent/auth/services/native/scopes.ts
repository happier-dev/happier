export const CLAUDE_CODE_REQUIRED_OAUTH_SCOPES = [
    'user:inference',
    'user:profile',
    'user:sessions:claude_code',
] as const;

export const CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPES = [
    'user:inference',
    'user:profile',
    'user:sessions:claude_code',
    'user:mcp_servers',
    'user:file_upload',
] as const;

export const CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE = CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPES.join(' ');

export function parseClaudeCodeCredentialScopes(
    value: string | readonly string[] | null | undefined,
): string[] {
    const rawScopes = Array.isArray(value)
        ? value
        : typeof value === 'string'
            ? value.split(/\s+/u)
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
