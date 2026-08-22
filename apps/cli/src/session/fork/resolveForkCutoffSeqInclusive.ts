import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import axios from 'axios';

import { createAuthenticationHttpStatusError, isAuthenticationStatus } from '@/api/client/httpStatusError';
import type { StoredCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveSessionEncryptionContextFromCredentials } from '@/session/transport/encryption/sessionEncryptionContext';
import { decryptTranscriptRows } from '@/session/replay/decryptTranscriptRows';
import { throwIfSessionTranscriptStoredContentUnavailableResponse } from '@/api/session/sessionTranscriptStoredContentUnavailable';

type RawTranscriptRow = Readonly<{
  seq?: unknown;
  localId?: unknown;
  createdAt?: unknown;
  content?: unknown;
}>;

function normalizePositiveInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const n = Math.trunc(value);
  return n >= 0 ? n : null;
}

export async function resolveForkCutoffSeqInclusive(params: Readonly<{
  credentials: StoredCredentials;
  parentSessionId: string;
  parentRawSession: Readonly<{ encryptionMode?: unknown; dataEncryptionKey?: unknown }>;
  targetSeqInclusive: number;
}>): Promise<Readonly<{ cutoffSeqInclusive: number; targetRole: 'user' | 'agent' | null }>> {
  const targetSeqInclusive = Math.max(0, Math.trunc(params.targetSeqInclusive));
  if (targetSeqInclusive <= 0) return { cutoffSeqInclusive: targetSeqInclusive, targetRole: null };

  const serverUrl = resolveServerHttpBaseUrl();
  const response = await axios.get(`${serverUrl}/v1/sessions/${params.parentSessionId}/messages`, {
    headers: {
      ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
      Authorization: `Bearer ${params.credentials.token}`,
      'Content-Type': 'application/json',
    },
    params: { limit: 1, beforeSeq: targetSeqInclusive + 1 },
    timeout: configuration.sessionControlHttpTimeoutMs,
    validateStatus: () => true,
  });

  if (isAuthenticationStatus(response.status)) {
    throw createAuthenticationHttpStatusError(response.status, 'Authentication failed while resolving fork cutoff');
  }
  throwIfSessionTranscriptStoredContentUnavailableResponse(response.status, response.data);
  if (response.status !== 200) {
    throw new Error(`Unexpected status from /v1/sessions/:id/messages: ${response.status}`);
  }

  const rowsValue = (() => {
    const data = response.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return (data as Record<string, unknown>).messages ?? null;
  })();
  const row = Array.isArray(rowsValue) && rowsValue.length > 0 ? (rowsValue[0] as RawTranscriptRow) : null;
  if (!row) return { cutoffSeqInclusive: targetSeqInclusive, targetRole: null };
  const seq = normalizePositiveInt(row?.seq);
  if (seq === null) return { cutoffSeqInclusive: targetSeqInclusive, targetRole: null };

  const ctx = resolveSessionEncryptionContextFromCredentials(params.credentials, params.parentRawSession);
  const decrypted = decryptTranscriptRows({ ctx, rows: [row] })[0] ?? null;
  if (!decrypted) return { cutoffSeqInclusive: targetSeqInclusive, targetRole: null };

  if (decrypted.role === 'user') {
    // Generic "branch and edit" semantics apply only when the clicked user message has at least one
    // prior committed message. If the user message is the first message in the session, keep the
    // inclusive cutoff so forks still retain the prompt context instead of producing an empty transcript.
    const cutoff = targetSeqInclusive >= 2 ? Math.max(0, targetSeqInclusive - 1) : targetSeqInclusive;
    return { cutoffSeqInclusive: cutoff, targetRole: 'user' };
  }
  return { cutoffSeqInclusive: targetSeqInclusive, targetRole: 'agent' };
}
