import { homedir } from 'node:os';
import { join } from 'node:path';

export const CLAUDE_NATIVE_CONFIG_DIR_ENV_KEY = 'HAPPIER_CLAUDE_NATIVE_CONFIG_DIR' as const;

export const HAPPIER_CLAUDE_CONFIG_DIR_ENV = 'HAPPIER_CLAUDE_CONFIG_DIR' as const;
export const CLAUDE_CONFIG_DIR_ENV_KEYS = ['CLAUDE_CONFIG_DIR', HAPPIER_CLAUDE_CONFIG_DIR_ENV] as const;

type ClaudeConfigEnvironment = Readonly<Record<string, string | undefined>>;

function readNonEmptyEnvironmentValue(value: string | undefined): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Resolve the config-root override used by the spawned Claude process. Connected-account
 * materialization writes Claude's native variable, so it remains authoritative when both exist.
 */
export function resolveClaudeConfigDirOverride(env: ClaudeConfigEnvironment): string | null {
    for (const key of CLAUDE_CONFIG_DIR_ENV_KEYS) {
        const value = readNonEmptyEnvironmentValue(env[key]);
        if (value) return value;
    }
    return null;
}

/** Preserve the native override's presence instead of synthesizing the filesystem default. */
export function resolveClaudeConfigDirEnvOverlay(env: ClaudeConfigEnvironment): Record<string, string> {
    const override = resolveClaudeConfigDirOverride(env);
    return override ? { CLAUDE_CONFIG_DIR: override } : {};
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

/** Device policy belongs to the native installation, independently of its user config home. */
export function resolveClaudeManagedConfigDir(platform = process.platform, env: ClaudeConfigEnvironment = process.env): string {
    if (platform === 'darwin') return '/Library/Application Support/ClaudeCode';
    if (platform === 'win32') return join(env.ProgramFiles ?? 'C:\\Program Files', 'ClaudeCode');
    return '/etc/claude-code';
}
