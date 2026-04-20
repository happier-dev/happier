import { basename, join } from 'node:path';

import { getAgentAuthProbeConfig } from '@happier-dev/agents';
import { createCatalogCliAuthSpec } from '@/capabilities/cliAuth/createCatalogCliAuthSpec';
import { readJsonFileSafe, readStringField } from '@/capabilities/cliAuth/shared';
import type { CliAuthSpec, CliAuthStatusDraft } from '@/backends/types';
import { resolveConfiguredClaudeConfigDir } from '@/backends/claude/directSessions/resolveClaudeConfigDir';

function readClaudeCredentialsStatus(): CliAuthStatusDraft {
  const configDir = resolveConfiguredClaudeConfigDir({ env: process.env });
  const credentialFiles = getAgentAuthProbeConfig('claude').credentialPaths?.map((credentialPath) => basename(credentialPath)) ?? [
    '.credentials.json',
    '.claude.json',
  ];
  let expiredCredentialsStatus: CliAuthStatusDraft | null = null;

  for (const credentialFile of credentialFiles) {
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
        expiredCredentialsStatus = { state: 'logged_out', reason: 'expired', source: 'file', method: 'credentials_file' };
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

  if (expiredCredentialsStatus) {
    return expiredCredentialsStatus;
  }

  return { state: 'logged_out', reason: 'missing_credentials' };
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
