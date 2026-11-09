import type { AgentSessionHostServices } from '@happier-dev/plugin-sdk/agents/runtime';
import { readCodexAccessTokenExpiresAtMs } from '../../auth/services/openai/cloud/oauth.js';

type CodexEnvironmentEnv = Readonly<Record<string, string | undefined>>;

export type CodexEnvironmentAuthTokens = Readonly<{
  idToken: string | null;
  accessToken: string | null;
  accountId: string | null;
  accountLabel: string | null;
}>;

/** Reads only the host-declared native auth file; never opens a user home directly. */
export async function readCodexAuthTokensFromNativeHome(
  nativeHome: AgentSessionHostServices['nativeHome'],
): Promise<CodexEnvironmentAuthTokens> {
  try {
    const bytes = (await nativeHome?.readFiles(['auth.json']))?.['auth.json'];
    return readCodexAuthTokensFromJson(bytes ? JSON.parse(new TextDecoder().decode(bytes)) as unknown : null);
  } catch {
    return readCodexAuthTokensFromJson(null);
  }
}

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

function hasUsableJwtLifetime(token: string | null): boolean {
  if (typeof token !== 'string' || !token.trim()) return false;
  const expMs = readCodexAccessTokenExpiresAtMs(token);
  return expMs === null || expMs > Date.now();
}

export function readCodexAuthTokensFromJson(parsed: unknown): CodexEnvironmentAuthTokens {
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
  // External auth must retain expired access material and identity for host-owned recovery.
  const hasUsableToken = (record.auth_mode === 'chatgptAuthTokens' && Boolean(accessToken?.trim()))
    || hasUsableJwtLifetime(idToken) || hasUsableJwtLifetime(accessToken);

  return {
    idToken: hasUsableToken ? idToken : null,
    accessToken: hasUsableToken ? accessToken : null,
    accountId: hasUsableToken
      ? authStoreAccountId ?? decodeJwtAccountId(idToken) ?? decodeJwtAccountId(accessToken)
      : null,
    accountLabel: hasUsableToken ? (decodeJwtEmail(idToken) ?? decodeJwtEmail(accessToken)) : null,
  };
}

export type CodexNativeAuthCredentials = Readonly<{
  idToken: string;
  accessToken: string;
  refreshToken: string;
  accountId: string;
  expiresAt: number | null;
}>;

/** Strict native import policy; ordinary external auth retains host-owned recovery material. */
export function readCodexNativeAuthCredentialsFromJson(parsed: unknown): CodexNativeAuthCredentials | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if ((record.auth_mode != null && record.auth_mode !== 'chatgpt')
    || (record.auth_mode == null && typeof record.OPENAI_API_KEY === 'string' && record.OPENAI_API_KEY.trim())) {
    return null;
  }
  const { idToken, accessToken, accountId } = readCodexAuthTokensFromJson(parsed);
  const tokens = record.tokens;
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return null;
  const refresh = (tokens as Record<string, unknown>).refresh_token;
  const refreshToken = typeof refresh === 'string' ? refresh.trim() : '';
  if (!idToken?.trim() || !accessToken?.trim() || !refreshToken || !accountId || !hasUsableJwtLifetime(accessToken)) {
    return null;
  }
  return {
    idToken: idToken.trim(), accessToken: accessToken.trim(), refreshToken, accountId,
    expiresAt: readCodexAccessTokenExpiresAtMs(accessToken),
  };
}
