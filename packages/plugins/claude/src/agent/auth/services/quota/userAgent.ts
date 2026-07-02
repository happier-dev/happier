export const CLAUDE_CODE_USAGE_USER_AGENT_FALLBACK = 'claude-code/0.0.0';

const CLAUDE_CODE_USER_AGENT_ENV_KEYS = [
    'HAPPIER_CONNECTED_SERVICES_CLAUDE_CODE_USER_AGENT',
    'HAPPIER_CLAUDE_CODE_USER_AGENT',
] as const;

const CLAUDE_CODE_VERSION_ENV_KEYS = [
    'HAPPIER_CONNECTED_SERVICES_CLAUDE_CODE_VERSION',
    'HAPPIER_CLAUDE_CODE_VERSION',
] as const;

function readNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isClaudeCodeUserAgent(value: string): boolean {
    return /^claude-code\/[^\s/]+$/u.test(value);
}

function readEnvValue(
    env: Readonly<Record<string, string | undefined>> | undefined,
    keys: readonly string[],
): string | null {
    if (!env) return null;
    for (const key of keys) {
        const value = readNonEmptyString(env[key]);
        if (value) return value;
    }
    return null;
}

export function resolveClaudeCodeUsageUserAgent(params?: Readonly<{
    env?: Readonly<Record<string, string | undefined>>;
    configuredUserAgent?: string | null;
}>): string {
    const envUserAgent = readEnvValue(params?.env, CLAUDE_CODE_USER_AGENT_ENV_KEYS);
    if (envUserAgent && isClaudeCodeUserAgent(envUserAgent)) return envUserAgent;

    const envVersion = readEnvValue(params?.env, CLAUDE_CODE_VERSION_ENV_KEYS);
    if (envVersion) return `claude-code/${envVersion}`;

    const configuredUserAgent = readNonEmptyString(params?.configuredUserAgent);
    if (configuredUserAgent && isClaudeCodeUserAgent(configuredUserAgent)) return configuredUserAgent;

    return CLAUDE_CODE_USAGE_USER_AGENT_FALLBACK;
}
