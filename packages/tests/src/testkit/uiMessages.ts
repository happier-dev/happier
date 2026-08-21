import { randomUUID } from 'node:crypto';

import { encryptLegacyBase64 } from './messageCrypto';
import { fetchJson } from './http';

type EncryptedUiTextMessageParams = {
  baseUrl: string;
  token: string;
  sessionId: string;
  secret: Uint8Array;
  text: string;
  metaExtras?: Record<string, unknown>;
  timeoutMs?: number;
};

async function sendEncryptedUiTextMessage(
  params: EncryptedUiTextMessageParams,
  endpoint: string,
  requestedAction?: { v: 1; kind: 'enqueue' },
): Promise<void> {
  const localId = randomUUID();
  const msg = {
    role: 'user',
    content: { type: 'text', text: params.text },
    localId,
    meta: { source: 'ui', sentFrom: 'e2e', ...(params.metaExtras ?? {}) },
  };
  const ciphertext = encryptLegacyBase64(msg, params.secret);
  try {
    const res = await fetchJson<unknown>(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${params.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ciphertext,
        localId,
        messageRole: 'user',
        ...(requestedAction ? { requestedAction } : {}),
      }),
      timeoutMs: params.timeoutMs ?? 20_000,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Failed to post UI message to ${endpoint} (status=${res.status})`);
    }
  } catch (error) {
    const name = error && typeof error === 'object' && 'name' in error ? String((error as { name?: unknown }).name ?? '') : '';
    if (name === 'AbortError') {
      throw new Error(`Failed to post UI message to ${endpoint}: timeout`);
    }
    throw error;
  }
}

export async function postEncryptedUiTextMessage(params: EncryptedUiTextMessageParams): Promise<void> {
  await sendEncryptedUiTextMessage(
    params,
    `${params.baseUrl}/v2/sessions/${params.sessionId}/messages`,
  );
}

export async function enqueueEncryptedUiTextMessage(params: EncryptedUiTextMessageParams): Promise<void> {
  await sendEncryptedUiTextMessage(
    params,
    `${params.baseUrl}/v2/sessions/${params.sessionId}/pending`,
    { v: 1, kind: 'enqueue' },
  );
}
