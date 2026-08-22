import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
    expandHomePath,
    resolveHomeDirFromEnvironment,
} from '@happier-dev/plugin-sdk/fs';
import type { AgentExternalSessionSource } from '@happier-dev/plugin-sdk/sessions/external';

import { resolveClaudeConfigDir as resolveEffectiveClaudeConfigDir } from '../../../environment.js';

export type ClaudeExternalSessionSource = Readonly<{
    kind: 'claudeConfig';
    configDir?: string | null;
    projectId?: string | null;
}>;

function readOptionalSourceString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function projectClaudeExternalSessionSource(
    source: AgentExternalSessionSource,
): ClaudeExternalSessionSource | null {
    if (source.kind !== 'claudeConfig') return null;
    const configDir = readOptionalSourceString(source.configDir);
    const projectId = readOptionalSourceString(source.projectId);
    return {
        kind: 'claudeConfig',
        ...(configDir ? { configDir } : {}),
        ...(projectId ? { projectId } : {}),
    };
}

export type ClaudeExternalSessionSourceValidationResult =
    | Readonly<{ ok: true; source: ClaudeExternalSessionSource }>
    | Readonly<{ ok: false; error: string }>;

function sourceValidationError(error: string): ClaudeExternalSessionSourceValidationResult {
    return { ok: false, error };
}

function resolveDefaultClaudeConfigDir(env: NodeJS.ProcessEnv): string {
    return join(resolveHomeDirFromEnvironment(env), '.claude');
}

export function expandClaudeConfigDirHome(raw: string, env: NodeJS.ProcessEnv = process.env): string {
    return expandHomePath(raw, resolveHomeDirFromEnvironment(env));
}

export function canonicalizeClaudeConfigDir(raw: string, env: NodeJS.ProcessEnv = process.env): string {
    const resolved = resolve(expandClaudeConfigDirHome(raw, env));
    try {
        return realpathSync(resolved);
    } catch {
        return resolved;
    }
}

export function resolveConfiguredClaudeConfigDir(params: Readonly<{ env: NodeJS.ProcessEnv }>): string {
    const defaultConfigDir = resolveDefaultClaudeConfigDir(params.env);
    const resolved = resolveEffectiveClaudeConfigDir(params.env);
    return expandClaudeConfigDirHome(resolved, params.env) || defaultConfigDir;
}

export function resolveCanonicalConfiguredClaudeConfigDir(params: Readonly<{ env: NodeJS.ProcessEnv }>): string {
    return canonicalizeClaudeConfigDir(resolveConfiguredClaudeConfigDir(params), params.env);
}

export function resolveClaudeConfigDir(params: Readonly<{
    source: ClaudeExternalSessionSource;
    env: NodeJS.ProcessEnv;
}>): string {
    if (params.source.kind !== 'claudeConfig') {
        return resolveDefaultClaudeConfigDir(params.env);
    }
    const fromSource = typeof params.source.configDir === 'string' ? params.source.configDir.trim() : '';
    const resolved = fromSource || resolveConfiguredClaudeConfigDir({ env: params.env });
    return expandClaudeConfigDirHome(resolved, params.env) || resolveDefaultClaudeConfigDir(params.env);
}

/**
 * Canonicalizes a Claude source; it decides nothing about whether the caller
 * may name that config directory. Whether a requested value is one the machine
 * environment or the account's settings authorized is decided once, by the host
 * admission boundary, for every Agent — this leaf only produces the canonical
 * form both sides of that comparison use.
 */
export function validateClaudeExternalSessionSource(params: Readonly<{
    source: ClaudeExternalSessionSource;
    env: NodeJS.ProcessEnv;
}>): ClaudeExternalSessionSourceValidationResult {
    const { source, env } = params;
    if (source.kind !== 'claudeConfig') return sourceValidationError('provider/source mismatch');

    const requestedConfigDir =
        typeof source.configDir === 'string' && source.configDir.trim().length > 0
            ? canonicalizeClaudeConfigDir(source.configDir, env)
            : null;

    return {
        ok: true,
        source: {
            ...source,
            configDir: requestedConfigDir ?? resolveCanonicalConfiguredClaudeConfigDir({ env }),
        },
    };
}
