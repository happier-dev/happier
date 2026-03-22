import { createCatalogCliAuthSpec } from '@/capabilities/cliAuth/createCatalogCliAuthSpec';
import { readJsonFileSafe, joinHomePath, readStringField } from '@/capabilities/cliAuth/shared';
import type { CliAuthSpec, CliAuthStatusDraft } from '@/backends/types';

function readClaudeCredentialsStatus(): CliAuthStatusDraft {
  const parsed = readJsonFileSafe(joinHomePath('.claude', '.credentials.json'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: 'logged_out', reason: 'missing_credentials' };
  }

  const record = parsed as Record<string, unknown>;
  const accessToken = readStringField(record, 'accessToken');
  const expiresAt = readStringField(record, 'expiresAt');
  if (!accessToken) {
    return { state: 'logged_out', reason: 'missing_credentials', source: 'file', method: 'credentials_file' };
  }

  if (expiresAt) {
    const expiryMs = Date.parse(expiresAt);
    if (Number.isFinite(expiryMs) && expiryMs <= Date.now()) {
      return { state: 'logged_out', reason: 'expired', source: 'file', method: 'credentials_file' };
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

export const claudeCliAuthSpec: CliAuthSpec = createCatalogCliAuthSpec('claude', {
  detectAuthStatus: async () => {
    const anthropicApiKey = typeof process.env.ANTHROPIC_API_KEY === 'string' ? process.env.ANTHROPIC_API_KEY.trim() : '';
    if (anthropicApiKey) {
      return {
        state: 'logged_in',
        method: 'api_key_env',
        source: 'env',
        reason: null,
      };
    }

    const anthropicAuthToken = typeof process.env.ANTHROPIC_AUTH_TOKEN === 'string' ? process.env.ANTHROPIC_AUTH_TOKEN.trim() : '';
    if (anthropicAuthToken) {
      return {
        state: 'logged_in',
        method: 'auth_token_env',
        source: 'env',
        reason: null,
      };
    }

    return readClaudeCredentialsStatus();
  },
});
