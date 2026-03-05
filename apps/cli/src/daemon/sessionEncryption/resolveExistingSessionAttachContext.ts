import type { SessionAttachFilePayload } from '@/agent/runtime/sessionAttachPayload';
import type { Credentials } from '@/persistence';
import { encodeBase64 } from '@/api/encryption';
import { resolveVendorResumeIdForExistingSession } from '@/daemon/spawn/resolveVendorResumeIdForExistingSession';
import {
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
} from '@/sessionControl/sessionEncryptionContext';
import { fetchSessionByIdCompat } from '@/sessionControl/sessionsHttp';

export type ExistingSessionAttachContext = Readonly<{
  attachPayload: SessionAttachFilePayload;
  rawSession: Readonly<{ metadata?: unknown; dataEncryptionKey?: unknown; encryptionMode?: unknown }>;
  vendorResumeId: string | null;
}>;

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export async function resolveExistingSessionAttachContext(_params: Readonly<{
  token: string;
  sessionId: string;
  agent: unknown;
  credentials: Credentials | null;
}>): Promise<ExistingSessionAttachContext | null> {
  const token = normalizeString(_params.token);
  const sessionId = normalizeString(_params.sessionId);
  if (!sessionId) return null;
  if (!token) return null;

  const raw = await fetchSessionByIdCompat({ token, sessionId });
  if (!raw) return null;

  const mode = resolveSessionStoredContentEncryptionMode(raw);
  if (mode === 'plain') {
    return {
      attachPayload: { v: 2, encryptionMode: 'plain' },
      rawSession: raw,
      vendorResumeId: resolveVendorResumeIdForExistingSession({
        agent: _params.agent,
        credentials: _params.credentials,
        rawSession: raw,
      }),
    };
  }

  const credentials = _params.credentials;
  if (!credentials) return null;

  const ctx = resolveSessionEncryptionContextFromCredentials(credentials, raw);
  if (ctx.encryptionKey.length !== 32) return null;

  return {
    attachPayload: {
      v: 2,
      encryptionMode: 'e2ee',
      encryptionKeyBase64: encodeBase64(ctx.encryptionKey, 'base64'),
      encryptionVariant: ctx.encryptionVariant,
    },
    rawSession: raw,
    vendorResumeId: resolveVendorResumeIdForExistingSession({ agent: _params.agent, credentials, rawSession: raw }),
  };
}
