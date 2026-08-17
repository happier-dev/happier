import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { expandHomePath } from '@happier-dev/plugin-sdk/fs';

type CodexEnvironmentEnv = Readonly<Record<string, string | undefined>>;

export type CodexEnvironmentAuthMethod = 'api_key_env' | 'credentials_file';

export type CodexEnvironmentAuthState = Readonly<{
  method: CodexEnvironmentAuthMethod | null;
  accountLabel: string | null;
}>;

export type CodexEnvironmentAuthTokens = Readonly<{
  idToken: string | null;
  accessToken: string | null;
  accountId: string | null;
  accountLabel: string | null;
}>;

export function readCodexApiKey(env: CodexEnvironmentEnv): string {
  const openAiApiKey = typeof env.OPENAI_API_KEY === 'string' ? env.OPENAI_API_KEY.trim() : '';
  if (openAiApiKey) return openAiApiKey;

  const codexApiKey = typeof env.CODEX_API_KEY === 'string' ? env.CODEX_API_KEY.trim() : '';
  return codexApiKey;
}

export function resolveCodexApiKeyAuthMethodId(
  env: CodexEnvironmentEnv,
): 'openai-api-key' | 'codex-api-key' | undefined {
  const openAiApiKey = typeof env.OPENAI_API_KEY === 'string' ? env.OPENAI_API_KEY.trim() : '';
  if (openAiApiKey) return 'openai-api-key';

  const codexApiKey = typeof env.CODEX_API_KEY === 'string' ? env.CODEX_API_KEY.trim() : '';
  if (codexApiKey) return 'codex-api-key';

  return undefined;
}

function readJsonFileSafe(path: string): unknown | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function decodeJwtEmail(token: string | null | undefined): string | null {
  const parsed = decodeJwtPayload(token);
  const email = parsed?.email;
  return typeof email === 'string' && email.trim().length > 0 ? email.trim() : null;
}

function decodeJwtAccountId(token: string | null | undefined): string | null {
  const parsed = decodeJwtPayload(token);
  if (!parsed) return null;
  const direct = parsed.chatgpt_account_id;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const auth = parsed['https://api.openai.com/auth'];
  if (auth && typeof auth === 'object' && !Array.isArray(auth)) {
    const authRecord = auth as Record<string, unknown>;
    const nestedChatGptAccountId = authRecord.chatgpt_account_id;
    if (typeof nestedChatGptAccountId === 'string' && nestedChatGptAccountId.trim()) {
      return nestedChatGptAccountId.trim();
    }
    const nestedAccountId = authRecord.account_id;
    if (typeof nestedAccountId === 'string' && nestedAccountId.trim()) return nestedAccountId.trim();
  }
  return null;
}

function decodeJwtPayload(token: string | null | undefined): Record<string, unknown> | null {
  const raw = typeof token === 'string' ? token.trim() : '';
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = Buffer.from((parts[1] ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

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

function resolveAuthBaseHomeDir(env: CodexEnvironmentEnv): string {
  const envHome = process.platform === 'win32'
    ? (env.USERPROFILE || env.HOME)
    : env.HOME;
  const trimmed = typeof envHome === 'string' ? envHome.trim() : '';
  return trimmed.length > 0 ? trimmed : homedir();
}

function resolveCodexAuthHomeDir(env: CodexEnvironmentEnv): string {
  const rawCodexHome = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : '';
  if (rawCodexHome) {
    return resolve(expandHomePath(rawCodexHome, resolveAuthBaseHomeDir(env)));
  }
  return resolve(join(resolveAuthBaseHomeDir(env), '.codex'));
}

function readCodexAuthFileTokens(env: CodexEnvironmentEnv): Readonly<{
  idToken: string | null;
  accessToken: string | null;
  accountId: string | null;
  accountLabel: string | null;
}> {
  const parsed = readJsonFileSafe(join(resolveCodexAuthHomeDir(env), 'auth.json'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { idToken: null, accessToken: null, accountId: null, accountLabel: null };
  }

  const record = parsed as Record<string, unknown>;
  const tokens = record.tokens;
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) {
    return { idToken: null, accessToken: null, accountId: null, accountLabel: null };
  }

  const tokenRecord = tokens as Record<string, unknown>;
  const idToken = typeof tokenRecord.id_token === 'string' ? tokenRecord.id_token : null;
  const accessToken = typeof tokenRecord.access_token === 'string' ? tokenRecord.access_token : null;
  const authStoreAccountId = typeof tokenRecord.account_id === 'string' && tokenRecord.account_id.trim()
    ? tokenRecord.account_id.trim()
    : null;
  const hasUsableToken = hasUsableJwtLifetime(idToken) || hasUsableJwtLifetime(accessToken);

  return {
    idToken: hasUsableToken ? idToken : null,
    accessToken: hasUsableToken ? accessToken : null,
    accountId: hasUsableToken
      ? authStoreAccountId ?? decodeJwtAccountId(idToken) ?? decodeJwtAccountId(accessToken)
      : null,
    accountLabel: hasUsableToken ? (decodeJwtEmail(idToken) ?? decodeJwtEmail(accessToken)) : null,
  };
}

export function readCodexEnvironmentAuthTokens(env: CodexEnvironmentEnv = process.env): CodexEnvironmentAuthTokens {
  return readCodexAuthFileTokens(env);
}

export function readCodexEnvironmentAuthState(env: CodexEnvironmentEnv = process.env): CodexEnvironmentAuthState {
  const authFileTokens = readCodexAuthFileTokens(env);
  const apiKey = readCodexApiKey(env);

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
