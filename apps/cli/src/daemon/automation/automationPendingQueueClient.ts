import { randomUUID } from 'node:crypto';

import { readPendingLocalId } from '@happier-dev/protocol';
import { decodeBase64, encodeBase64, encrypt } from '@/api/encryption';
import { enqueuePendingQueueV2MessageViaHttp } from '@/api/session/pendingQueueV2Transport';

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

export async function enqueueAutomationPrompt(params: {
  token: string;
  sessionId: string;
  prompt: string;
  displayText?: string;
  sessionEncryptionMode: 'e2ee' | 'plain';
  sessionEncryptionKeyBase64?: string;
  localId?: string;
}): Promise<void> {
  const prompt = params.prompt.trim();
  if (!prompt) {
    return;
  }

  const localId = readPendingLocalId(params.localId) ?? randomUUID();
  const displayText = typeof params.displayText === 'string' ? params.displayText : undefined;

  const body = params.sessionEncryptionMode === 'plain'
    ? {
        localId,
        content: {
          t: 'plain' as const,
          v: {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: prompt,
            },
            meta: {
              sentFrom: 'cli' as const,
              source: 'automation' as const,
              ...(typeof displayText === 'string' && displayText.trim().length > 0
                ? { displayText }
                : {}),
            },
          },
        },
        messageRole: 'user' as const,
        requestedAction: { v: 1 as const, kind: 'enqueue' as const },
      }
    : {
        localId,
        messageRole: 'user' as const,
        ciphertext: buildPendingCiphertext({
          prompt,
          ...(displayText ? { displayText } : {}),
          sessionEncryptionKeyBase64: String(params.sessionEncryptionKeyBase64 ?? ''),
        }),
        requestedAction: { v: 1 as const, kind: 'enqueue' as const },
      };

  await enqueuePendingQueueV2MessageViaHttp({
    token: params.token,
    sessionId: params.sessionId,
    body,
  });
}
