import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type ClaudeCliAuthStatus =
    | Readonly<{
        state: 'logged_in';
        method: 'api_key_env' | 'auth_token_env' | 'credentials_file';
        source: 'env' | 'file';
        reason?: null;
        accountLabel?: string;
    }>
    | Readonly<{
        state: 'logged_out';
        reason: 'expired' | 'missing_credentials';
        source?: 'file';
        method?: 'credentials_file';
	    }>;

const CLAUDE_CREDENTIAL_FILE_NAMES = Object.freeze([
    '.credentials.json',
    '.claude.json',
] as const);

function readStringField(record: Record<string, unknown>, key: string): string | null {
    const value = record[key];
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function readJsonFileSafe(path: string): unknown | null {
    if (!existsSync(path)) return null;
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as unknown;
    } catch {
        return null;
    }
}

function readEnvString(
    env: Readonly<Record<string, string | undefined>>,
    key: string,
): string | null {
    const value = env[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function resolveClaudeConfigDir(env: Readonly<Record<string, string | undefined>>): string {
    return readEnvString(env, 'HAPPIER_CLAUDE_CONFIG_DIR')
        ?? readEnvString(env, 'CLAUDE_CONFIG_DIR')
        ?? join(homedir(), '.claude');
}

function readClaudeCredentialsStatus(env: Readonly<Record<string, string | undefined>>): ClaudeCliAuthStatus {
    const configDir = resolveClaudeConfigDir(env);
    let expiredCredentialsStatus: ClaudeCliAuthStatus | null = null;

    for (const credentialFile of CLAUDE_CREDENTIAL_FILE_NAMES) {
        const parsed = readJsonFileSafe(join(configDir, credentialFile));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            continue;
        }

        const record = parsed as Record<string, unknown>;
        const accessToken = readStringField(record, 'accessToken');
        const expiresAt = readStringField(record, 'expiresAt');
        if (!accessToken) {
            continue;
        }

        if (expiresAt) {
            const expiryMs = Date.parse(expiresAt);
            if (Number.isFinite(expiryMs) && expiryMs <= Date.now()) {
                expiredCredentialsStatus = {
                    state: 'logged_out',
                    reason: 'expired',
                    source: 'file',
                    method: 'credentials_file',
                };
                continue;
            }
        }

        const accountLabel =
            readStringField(record, 'email')
            ?? readStringField(record, 'accountEmail')
            ?? readStringField(record, 'userEmail');

        return {
            state: 'logged_in',
            method: 'credentials_file',
            source: 'file',
            ...(accountLabel ? { accountLabel } : {}),
        };
    }

    return expiredCredentialsStatus ?? { state: 'logged_out', reason: 'missing_credentials' };
}

export function detectClaudeCliAuthStatus(params: Readonly<{
    env: Readonly<Record<string, string | undefined>>;
}>): ClaudeCliAuthStatus {
    if (readEnvString(params.env, 'ANTHROPIC_API_KEY')) {
        return {
            state: 'logged_in',
            method: 'api_key_env',
            source: 'env',
            reason: null,
        };
    }

    if (readEnvString(params.env, 'ANTHROPIC_AUTH_TOKEN')) {
        return {
            state: 'logged_in',
            method: 'auth_token_env',
            source: 'env',
            reason: null,
        };
    }

    return readClaudeCredentialsStatus(params.env);
}
