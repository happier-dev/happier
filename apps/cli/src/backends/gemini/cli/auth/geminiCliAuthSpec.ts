import { existsSync } from 'node:fs';

import { createCatalogCliAuthSpec } from '@/capabilities/cliAuth/createCatalogCliAuthSpec';
import { joinHomePath, readJsonFileSafe } from '@/capabilities/cliAuth/shared';
import type { CliAuthSpec } from '@/backends/types';

export const geminiCliAuthSpec: CliAuthSpec = createCatalogCliAuthSpec('gemini', {
  detectAuthStatus: async () => {
    const envApiKeyCandidates = [process.env.GEMINI_API_KEY, process.env.GOOGLE_API_KEY]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean);
    if (envApiKeyCandidates.length > 0) {
      return { state: 'logged_in', method: 'api_key_env', source: 'env' };
    }

    const candidatePaths = [
      joinHomePath('.gemini', 'oauth_creds.json'),
      joinHomePath('.gemini', 'config.json'),
      joinHomePath('.config', 'gemini', 'config.json'),
      joinHomePath('.gemini', 'auth.json'),
      joinHomePath('.config', 'gemini', 'auth.json'),
      joinHomePath('.config', 'gcloud', 'application_default_credentials.json'),
    ];

    const hasPlausibleCreds = (value: unknown): boolean => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const record = value as Record<string, unknown>;
      const strings = [
        record.access_token,
        record.refresh_token,
        record.token,
        record.apiKey,
        record.GEMINI_API_KEY,
      ].filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
      if (strings.length > 0) return true;
      return record.type === 'authorized_user'
        && typeof record.refresh_token === 'string'
        && record.refresh_token.trim().length > 0;
    };

    let sawAnyFile = false;
    let sawAnyParseable = false;
    for (const path of candidatePaths) {
      if (!existsSync(path)) continue;
      sawAnyFile = true;
      const parsed = readJsonFileSafe(path);
      if (!parsed) continue;
      sawAnyParseable = true;
      if (hasPlausibleCreds(parsed)) {
        return {
          state: 'logged_in',
          method: path.includes('gcloud') ? 'gcloud_adc' : 'credentials_file',
          source: 'file',
        };
      }
    }

    return sawAnyFile && !sawAnyParseable
      ? { state: 'unknown', reason: 'probe_failed', source: 'file' }
      : { state: 'logged_out', reason: 'missing_credentials' };
  },
});
