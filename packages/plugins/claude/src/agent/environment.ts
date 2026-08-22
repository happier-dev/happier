import { homedir } from 'node:os';
import { join } from 'node:path';

export const HAPPIER_CLAUDE_CONFIG_DIR_ENV = 'HAPPIER_CLAUDE_CONFIG_DIR' as const;

type ClaudeConfigEnvironment = Readonly<Record<string, string | undefined>>;

function readNonEmptyEnvironmentValue(value: string | undefined): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Resolve the config-root override used by the spawned Claude process. Connected-account
 * materialization writes Claude's native variable, so it remains authoritative when both exist.
 */
export function resolveClaudeConfigDirOverride(env: ClaudeConfigEnvironment): string | null {
    return readNonEmptyEnvironmentValue(env.CLAUDE_CONFIG_DIR)
        ?? readNonEmptyEnvironmentValue(env[HAPPIER_CLAUDE_CONFIG_DIR_ENV]);
}

/** Resolve the effective Claude config root, including the platform home fallback. */
export function resolveClaudeConfigDir(env: ClaudeConfigEnvironment): string {
    const override = resolveClaudeConfigDirOverride(env);
    if (override) return override;
    const home = readNonEmptyEnvironmentValue(env.HOME)
        ?? readNonEmptyEnvironmentValue(env.USERPROFILE)
        ?? homedir();
    return join(home, '.claude');
}
