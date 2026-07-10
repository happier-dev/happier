import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { expandHomePath } from '@happier-dev/plugin-sdk/experimental/sessions/fileStores';
import type { ExternalSessionsSource } from '@happier-dev/plugin-sdk/sessions';
import { HAPPIER_CLAUDE_CONFIG_DIR_ENV } from '@happier-dev/plugin-sdk/experimental/envConstants';

export type ClaudeExternalSessionSourceValidationResult =
    | Readonly<{ ok: true; source: ExternalSessionsSource }>
    | Readonly<{ ok: false; error: string }>;

function sourceValidationError(error: string): ClaudeExternalSessionSourceValidationResult {
    return { ok: false, error };
}

export function expandClaudeConfigDirHome(raw: string): string {
    return expandHomePath(raw);
}

export function canonicalizeClaudeConfigDir(raw: string): string {
    const resolved = resolve(expandClaudeConfigDirHome(raw));
    try {
        return realpathSync(resolved);
    } catch {
        return resolved;
    }
}

export function resolveConfiguredClaudeConfigDir(params: Readonly<{ env: NodeJS.ProcessEnv }>): string {
    const fromEnv =
        typeof params.env[HAPPIER_CLAUDE_CONFIG_DIR_ENV] === 'string' && params.env[HAPPIER_CLAUDE_CONFIG_DIR_ENV].trim().length > 0
            ? params.env[HAPPIER_CLAUDE_CONFIG_DIR_ENV].trim()
            : typeof params.env.CLAUDE_CONFIG_DIR === 'string'
                ? params.env.CLAUDE_CONFIG_DIR.trim()
                : '';

    const resolved = fromEnv || join(homedir(), '.claude');
    return expandClaudeConfigDirHome(resolved) || join(homedir(), '.claude');
}

export function resolveCanonicalConfiguredClaudeConfigDir(params: Readonly<{ env: NodeJS.ProcessEnv }>): string {
    return canonicalizeClaudeConfigDir(resolveConfiguredClaudeConfigDir(params));
}

export function resolveClaudeConfigDir(params: Readonly<{
    source: ExternalSessionsSource;
    env: NodeJS.ProcessEnv;
}>): string {
    if (params.source.kind !== 'claudeConfig') {
        return join(homedir(), '.claude');
    }
    const fromSource = typeof params.source.configDir === 'string' ? params.source.configDir.trim() : '';
    const resolved = fromSource || resolveConfiguredClaudeConfigDir({ env: params.env });
    return expandClaudeConfigDirHome(resolved) || join(homedir(), '.claude');
}

export function validateClaudeExternalSessionSource(params: Readonly<{
    source: ExternalSessionsSource;
    env: NodeJS.ProcessEnv;
}>): ClaudeExternalSessionSourceValidationResult {
    const { source, env } = params;
    if (source.kind !== 'claudeConfig') return sourceValidationError('provider/source mismatch');

    const requestedConfigDir =
        typeof source.configDir === 'string' && source.configDir.trim().length > 0
            ? canonicalizeClaudeConfigDir(source.configDir)
            : null;
    const configuredConfigDir = resolveCanonicalConfiguredClaudeConfigDir({ env });
    if (requestedConfigDir && requestedConfigDir !== configuredConfigDir) {
        return sourceValidationError('source configDir override is not allowed');
    }

    return {
        ok: true,
        source: {
            ...source,
            configDir: configuredConfigDir,
        },
    };
}
