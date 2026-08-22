import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveClaudeConfigDir } from '../../environment.js';
import { readClaudeNativeAccountIdentity } from './native/accountIdentity.js';

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

function readObjectField(record: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> | null {
    if (!record) return null;
    const value = record[key];
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readNumberField(record: Record<string, unknown>, key: string): number | null {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
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

function readClaudeAccountLabel(configDir: string, fallbackRecord: Record<string, unknown>): string | undefined {
    const rootConfig = readJsonFileSafe(join(configDir, '.claude.json'));
    const accountLabel =
        readClaudeNativeAccountIdentity(rootConfig)?.accountLabel
        ?? readClaudeNativeAccountIdentity(fallbackRecord)?.accountLabel
        ?? readStringField(fallbackRecord, 'email')
        ?? readStringField(fallbackRecord, 'accountEmail')
        ?? readStringField(fallbackRecord, 'userEmail');

    return accountLabel ?? undefined;
}

function readClaudeCredentialFileState(record: Record<string, unknown>): Readonly<{
    hasAccessToken: boolean;
    expiresAt: number | null;
}> {
    const currentCredential = readObjectField(record, 'claudeAiOauth');
    if (currentCredential) {
        return {
            hasAccessToken: Boolean(readStringField(currentCredential, 'accessToken')),
            expiresAt: readNumberField(currentCredential, 'expiresAt'),
        };
    }

    const legacyAccessToken = readStringField(record, 'accessToken');
    const legacyExpiresAt = readStringField(record, 'expiresAt');
    const legacyExpiryMs = legacyExpiresAt ? Date.parse(legacyExpiresAt) : Number.NaN;
    return {
        hasAccessToken: Boolean(legacyAccessToken),
        expiresAt: Number.isFinite(legacyExpiryMs) ? legacyExpiryMs : null,
    };
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
        const credential = readClaudeCredentialFileState(record);
        if (!credential.hasAccessToken) {
            continue;
        }

        if (credential.expiresAt !== null && credential.expiresAt <= Date.now()) {
            expiredCredentialsStatus = {
                state: 'logged_out',
                reason: 'expired',
                source: 'file',
                method: 'credentials_file',
            };
            continue;
        }

        const accountLabel = readClaudeAccountLabel(configDir, record);

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
