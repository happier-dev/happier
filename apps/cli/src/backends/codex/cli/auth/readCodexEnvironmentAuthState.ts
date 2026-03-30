import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { decodeJwtEmail, readJsonFileSafe } from '@/capabilities/cliAuth/shared';

export type CodexEnvironmentAuthMethod = 'api_key_env' | 'credentials_file';

export type CodexEnvironmentAuthState = Readonly<{
    method: CodexEnvironmentAuthMethod | null;
    accountLabel: string | null;
}>;

function readJwtExpMs(token: string | null): number | null {
    if (typeof token !== 'string' || !token.trim()) return null;
    const parts = token.split('.');
    if (parts.length < 2) return null;
    try {
        const payload = JSON.parse(
            Buffer.from((parts[1] ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
        ) as Record<string, unknown>;
        const exp = payload.exp;
        return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
    } catch {
        return null;
    }
}

function hasUsableJwtLifetime(token: string | null): boolean {
    if (typeof token !== 'string' || !token.trim()) return false;
    const expMs = readJwtExpMs(token);
    return expMs === null || expMs > Date.now();
}

function resolveAuthBaseHomeDir(env: NodeJS.ProcessEnv): string {
    const envHome = process.platform === 'win32'
        ? (env.USERPROFILE || env.HOME)
        : env.HOME;
    const trimmed = typeof envHome === 'string' ? envHome.trim() : '';
    return trimmed.length > 0 ? trimmed : homedir();
}

function resolveCodexAuthHomeDir(env: NodeJS.ProcessEnv): string {
    const rawCodexHome = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : '';
    if (rawCodexHome) {
        return resolve(rawCodexHome);
    }
    return resolve(join(resolveAuthBaseHomeDir(env), '.codex'));
}

function readCodexAuthFileTokens(env: NodeJS.ProcessEnv): Readonly<{
    idToken: string | null;
    accessToken: string | null;
    accountLabel: string | null;
}> {
    const parsed = readJsonFileSafe(join(resolveCodexAuthHomeDir(env), 'auth.json'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { idToken: null, accessToken: null, accountLabel: null };
    }

    const record = parsed as Record<string, unknown>;
    const tokens = record.tokens;
    if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) {
        return { idToken: null, accessToken: null, accountLabel: null };
    }

    const tokenRecord = tokens as Record<string, unknown>;
    const idToken = typeof tokenRecord.id_token === 'string' ? tokenRecord.id_token : null;
    const accessToken = typeof tokenRecord.access_token === 'string' ? tokenRecord.access_token : null;
    const hasUsableToken = hasUsableJwtLifetime(idToken) || hasUsableJwtLifetime(accessToken);

    return {
        idToken: hasUsableToken ? idToken : null,
        accessToken: hasUsableToken ? accessToken : null,
        accountLabel: hasUsableToken ? (decodeJwtEmail(idToken) ?? decodeJwtEmail(accessToken)) : null,
    };
}

export function readCodexEnvironmentAuthState(env: NodeJS.ProcessEnv = process.env): CodexEnvironmentAuthState {
    const authFileTokens = readCodexAuthFileTokens(env);
    const apiKey = typeof env.OPENAI_API_KEY === 'string' ? env.OPENAI_API_KEY.trim() : '';

    if (apiKey) {
        return { method: 'api_key_env', accountLabel: null };
    }

    if (authFileTokens.idToken || authFileTokens.accessToken) {
        return {
            method: 'credentials_file',
            accountLabel: authFileTokens.accountLabel,
        };
    }

    return { method: null, accountLabel: null };
}
