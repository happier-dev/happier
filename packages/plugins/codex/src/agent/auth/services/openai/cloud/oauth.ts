import { OPENAI_CODEX_OAUTH_PROFILE } from '@happier-dev/plugin-sdk/connected-accounts';

export function buildCodexAuthorizationUrl(params: Readonly<{
  redirectUri: string;
  state: string;
  challenge: string;
}>): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: OPENAI_CODEX_OAUTH_PROFILE.clientId,
    redirect_uri: params.redirectUri,
    scope: OPENAI_CODEX_OAUTH_PROFILE.scope,
    code_challenge: params.challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state: params.state,
  });
  return `${OPENAI_CODEX_OAUTH_PROFILE.authorizeUrl}?${query.toString()}`;
}

export function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) {
    throw new Error('Invalid JWT format');
  }
  const parsed: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  return isRecord(parsed) ? parsed : {};
}

export function extractOpenAiAccountIdFromIdToken(idToken: string): string {
  const idTokenPayload = parseJwtPayload(idToken);
  const directAccountId = idTokenPayload.chatgpt_account_id;
  if (typeof directAccountId === 'string') return directAccountId;
  const authClaim = idTokenPayload['https://api.openai.com/auth'];
  if (isRecord(authClaim)) {
    const nestedChatGptAccountId = authClaim.chatgpt_account_id;
    if (typeof nestedChatGptAccountId === 'string') return nestedChatGptAccountId;
    const nestedAccountId = authClaim.account_id;
    if (typeof nestedAccountId === 'string') return nestedAccountId;
  }
  return '';
}

function readProviderErrorCode(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) return '';
    return typeof parsed.error === 'string' ? parsed.error.trim() : '';
  } catch {
    return '';
  }
}

export function buildSafeOauthProviderFailureMessage(params: Readonly<{
  operation: string;
  status: number;
  statusText?: string;
  body: string;
}>): string {
  const providerCode = readProviderErrorCode(params.body);
  const suffix = providerCode || params.statusText || 'request_failed';
  return `${params.operation} failed (${params.status}): ${suffix}`;
}
