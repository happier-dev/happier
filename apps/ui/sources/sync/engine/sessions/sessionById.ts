import { V2SessionByIdResponseSchema, type V2SessionByIdResponse } from '@happier-dev/protocol';

import { AgentStateSchema, MetadataSchema, type Session } from '@/sync/domains/state/storageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';

type SessionEncryption = {
  decryptAgentState: (version: number, value: string | null) => Promise<any>;
  decryptMetadata: (version: number, value: string) => Promise<any>;
};

export type SessionByIdEncryption = {
  decryptEncryptionKey: (value: string) => Promise<Uint8Array | null>;
  initializeSessions: (sessionKeys: Map<string, Uint8Array | null>) => Promise<void>;
  getSessionEncryption: (sessionId: string) => SessionEncryption | null;
};

function parsePlainMetadata(value: string): Metadata | null {
  try {
    const parsedJson = JSON.parse(value);
    const parsed = MetadataSchema.safeParse(parsedJson);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parsePlainAgentState(value: string | null): unknown {
  if (!value) return {};
  try {
    const parsedJson = JSON.parse(value);
    const parsed = AgentStateSchema.safeParse(parsedJson);
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export async function fetchAndApplySessionById(params: Readonly<{
  sessionId: string;
  credentials: AuthCredentials;
  encryption: SessionByIdEncryption;
  sessionDataKeys: Map<string, Uint8Array>;
  request: (path: string, init: RequestInit) => Promise<Response>;
  applySessions: (sessions: Array<Omit<Session, 'presence'> & { presence?: 'online' | number }>) => void;
  log: { log: (message: string) => void };
  timeoutMs?: number;
}>): Promise<{ ok: boolean; session: (V2SessionByIdResponse['session'] & { metadata: Metadata | null }) | null }> {
  const sessionId = String(params.sessionId ?? '').trim();
  if (!sessionId) return { ok: false, session: null };

  const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : 10_000;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), Math.max(1, timeoutMs)) : null;

  let response: Response;
  try {
    response = await params.request(`/v2/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${params.credentials.token}`,
        'Content-Type': 'application/json',
      },
      ...(controller ? { signal: controller.signal } : null),
    });
  } catch (err) {
    params.log.log(`[sessionById] Failed to fetch session ${sessionId}: ${err instanceof Error ? err.message : 'unknown error'}`);
    return { ok: false, session: null };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  if (!response.ok) {
    return { ok: false, session: null };
  }

  const body = (await response.json().catch(() => null)) as unknown;
  const parsed = V2SessionByIdResponseSchema.safeParse(body);
  if (!parsed.success || !parsed.data.session) {
    return { ok: false, session: null };
  }

  const row = parsed.data.session;
  if (String(row.id ?? '').trim() !== sessionId) {
    return { ok: false, session: null };
  }

  const encryptionMode: 'e2ee' | 'plain' = row.encryptionMode === 'plain' ? 'plain' : 'e2ee';

  const sessionKeys = new Map<string, Uint8Array | null>();
  if (typeof row.dataEncryptionKey === 'string' && row.dataEncryptionKey.length > 0) {
    const decrypted = await params.encryption.decryptEncryptionKey(row.dataEncryptionKey);
    if (decrypted) {
      sessionKeys.set(sessionId, decrypted);
      params.sessionDataKeys.set(sessionId, decrypted);
    } else {
      sessionKeys.set(sessionId, null);
      params.sessionDataKeys.delete(sessionId);
    }
  } else {
    sessionKeys.set(sessionId, null);
    params.sessionDataKeys.delete(sessionId);
  }

  await params.encryption.initializeSessions(sessionKeys);

  const sessionEncryption = params.encryption.getSessionEncryption(sessionId);
  if (encryptionMode === 'e2ee' && !sessionEncryption) {
    params.log.log(`[sessionById] Session encryption not found for ${sessionId}`);
    return { ok: false, session: null };
  }

  const metadata =
    encryptionMode === 'plain'
      ? parsePlainMetadata(row.metadata)
      : await sessionEncryption!.decryptMetadata(row.metadataVersion, row.metadata);

  const agentState =
    encryptionMode === 'plain'
      ? parsePlainAgentState(row.agentState)
      : await sessionEncryption!.decryptAgentState(row.agentStateVersion, row.agentState);

  const accessLevel = row.share?.accessLevel;
  const normalizedAccessLevel = accessLevel === 'view' || accessLevel === 'edit' || accessLevel === 'admin' ? accessLevel : undefined;

  params.applySessions([
    {
      ...row,
      encryptionMode,
      thinking: false,
      thinkingAt: 0,
      metadata,
      agentState,
      accessLevel: normalizedAccessLevel,
      canApprovePermissions: row.share?.canApprovePermissions ?? undefined,
    },
  ]);

  return { ok: true, session: { ...row, metadata } };
}
