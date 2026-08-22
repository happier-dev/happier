import type { MetadataUpdatePort } from '@happier-dev/agents';

import type { StoredCredentials } from '@/persistence';
import { updateSessionMetadataForTarget } from '@/session/services/updateSessionMetadataForTarget';

function isForbiddenMetadataUpdateError(error: unknown): boolean {
  const record = error && typeof error === 'object'
    ? error as Record<string, unknown>
    : null;
  if (!record) return false;
  if (record.code === 'forbidden' || record.code === 'not_authenticated' || record.code === 'unauthorized') {
    return true;
  }
  if (record.status === 403 || record.statusCode === 403) {
    return true;
  }
  const response = record.response && typeof record.response === 'object'
    ? record.response as Record<string, unknown>
    : null;
  return response?.status === 403 || response?.statusCode === 403;
}

export function createCliSessionStateMetadataUpdatePort(params: Readonly<{
  credentials: StoredCredentials;
}>): MetadataUpdatePort {
  return {
    update: async (sessionId, updater, opts) => {
      try {
        const result = await updateSessionMetadataForTarget({
          credentials: params.credentials,
          idOrPrefix: sessionId,
          updater,
          ...(typeof opts.maxAttempts === 'number' ? { maxAttempts: opts.maxAttempts } : {}),
        });
        if (result.ok) {
          return { ok: true, version: result.version };
        }
        if (result.code === 'unsupported' || result.code === 'conflict' || result.code === 'forbidden' || result.code === 'unknown_error') {
          return { ok: false, reason: result.code };
        }
        return { ok: false, reason: 'unknown_error' };
      } catch (error) {
        if (isForbiddenMetadataUpdateError(error)) {
          return { ok: false, reason: 'forbidden' };
        }
        const code = typeof (error as { code?: unknown } | null)?.code === 'string'
          ? (error as { code: string }).code
          : 'unknown_error';
        if (code === 'unsupported' || code === 'conflict' || code === 'forbidden' || code === 'unknown_error') {
          return { ok: false, reason: code };
        }
        return { ok: false, reason: 'unknown_error' };
      }
    },
  };
}
