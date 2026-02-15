import axios from 'axios';
import { randomUUID } from 'node:crypto';

import { configuration } from '@/configuration';
import { decodeBase64, encodeBase64, encrypt } from '@/api/encryption';

type PendingMessageCiphertextPayload = Readonly<{
  role: 'user';
  content: {
    type: 'text';
    text: string;
  };
  meta: {
    sentFrom: 'cli';
    source: 'automation';
    displayText?: string;
  };
}>;

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function buildPendingCiphertext(params: {
  prompt: string;
  displayText?: string;
  sessionEncryptionKeyBase64: string;
}): string {
  const message: PendingMessageCiphertextPayload = {
    role: 'user',
    content: {
      type: 'text',
      text: params.prompt,
    },
    meta: {
      sentFrom: 'cli',
      source: 'automation',
      ...(typeof params.displayText === 'string' && params.displayText.trim().length > 0
        ? { displayText: params.displayText }
        : {}),
    },
  };

  const dataKey = decodeBase64(params.sessionEncryptionKeyBase64);
  const encrypted = encrypt(dataKey, 'dataKey', message);
  return encodeBase64(encrypted);
}

export async function enqueueAndMaterializeAutomationPrompt(params: {
  token: string;
  sessionId: string;
  prompt: string;
  displayText?: string;
  sessionEncryptionKeyBase64: string;
}): Promise<void> {
  const prompt = params.prompt.trim();
  if (!prompt) {
    return;
  }

  const ciphertext = buildPendingCiphertext({
    prompt,
    ...(typeof params.displayText === 'string' ? { displayText: params.displayText } : {}),
    sessionEncryptionKeyBase64: params.sessionEncryptionKeyBase64,
  });
  const localId = randomUUID();

  await axios.post(
    `${configuration.serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/pending`,
    {
      localId,
      ciphertext,
    },
    {
      headers: authHeaders(params.token),
      timeout: 15_000,
    },
  );

  await axios.post(
    `${configuration.serverUrl}/v2/sessions/${encodeURIComponent(params.sessionId)}/pending/materialize-next`,
    {},
    {
      headers: authHeaders(params.token),
      timeout: 15_000,
    },
  );
}
