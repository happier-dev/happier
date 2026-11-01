// These non-secret provider directory overrides already belong to the durable
// respawn contract. Keep capture and restoration on the same allowlist.
const NATIVE_ENVIRONMENT_KEYS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CODEX_SQLITE_HOME'] as const;

export type SessionNativeEnvironment = Partial<Record<typeof NATIVE_ENVIRONMENT_KEYS[number], string>>;

export function readSessionNativeEnvironment(value: unknown): SessionNativeEnvironment | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const environment: SessionNativeEnvironment = {};
    for (const key of NATIVE_ENVIRONMENT_KEYS) {
        const raw = record[key];
        if (typeof raw === 'string' && raw.trim()) environment[key] = raw.trim();
    }
    return Object.keys(environment).length > 0 ? environment : undefined;
}
