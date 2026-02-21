import axios from 'axios';

import { resolveLatestPermissionIntent } from '@happier-dev/agents';

import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { resolveLoopbackHttpUrl } from '../client/loopbackUrl';

import { decodeBase64, decrypt } from '../encryption';
import { SessionMessageContentSchema, type PermissionMode } from '../types';

type EncryptionVariant = 'legacy' | 'dataKey';

type SessionTranscriptQueryParams = {
  token: string;
  sessionId: string;
  encryptionKey: Uint8Array;
  encryptionVariant: EncryptionVariant;
};

function normalizeTake(value: number | undefined, max: number): number {
  if (typeof value !== 'number' || value <= 0) return max;
  return Math.min(value, max);
}

export async function fetchRecentTranscriptTextItemsForAcpImportFromServer(
  params: SessionTranscriptQueryParams & { take?: number },
): Promise<Array<{ role: 'user' | 'agent'; text: string }>> {
  const take = normalizeTake(params.take, 150);
  const serverUrl = resolveLoopbackHttpUrl(configuration.serverUrl).replace(/\/+$/, '');

  try {
    const response = await axios.get(`${serverUrl}/v1/sessions/${params.sessionId}/messages`, {
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      timeout: 10_000,
    });

    const data = response?.data as unknown;
    const raw = data && typeof data === 'object' ? (data as Record<string, unknown>).messages : null;
    if (!Array.isArray(raw)) return [];

    const sliced = raw.slice(0, take);
    const items: Array<{ role: 'user' | 'agent'; text: string; createdAt: number }> = [];

    for (const msg of sliced) {
      const content = msg?.content;
      const parsedContent = SessionMessageContentSchema.safeParse(content);
      if (!parsedContent.success) continue;

      let decrypted: unknown;
      if (parsedContent.data.t === 'plain') {
        decrypted = parsedContent.data.v;
      } else {
        decrypted = decrypt(
          params.encryptionKey,
          params.encryptionVariant,
          decodeBase64(parsedContent.data.c),
        );
      }
      const decryptedObj = decrypted && typeof decrypted === 'object' ? (decrypted as Record<string, unknown>) : null;
      const role = decryptedObj?.role;
      if (role !== 'user' && role !== 'agent') continue;

      let text: string | null = null;
      const body = decryptedObj?.content;
      const bodyObj = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
      const bodyType = bodyObj?.type;
      if (role === 'user') {
        if (bodyType === 'text') {
          const rawText = bodyObj?.text;
          if (typeof rawText === 'string') {
            text = rawText;
          }
        }
      } else if (bodyType === 'text') {
        const rawText = bodyObj?.text;
        if (typeof rawText === 'string') {
          text = rawText;
        }
      } else if (bodyType === 'acp') {
        const data = bodyObj?.data;
        const dataObj = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
        const dataType = dataObj?.type;
        const dataMessage = dataObj?.message;
        if ((dataType === 'message' || dataType === 'reasoning') && typeof dataMessage === 'string') {
          text = dataMessage;
        }
      }

      if (!text || text.trim().length === 0) continue;
      items.push({
        role,
        text,
        createdAt: typeof msg.createdAt === 'number' ? msg.createdAt : 0,
      });
    }

    // API returns newest first; normalize to chronological.
    items.sort((a, b) => a.createdAt - b.createdAt);
    return items.map((item) => ({ role: item.role, text: item.text }));
  } catch (error) {
    logger.debug('[API] Failed to fetch transcript messages for ACP import', { error });
    return [];
  }
}

export async function fetchLatestUserPermissionIntentFromEncryptedTranscript(
  params: SessionTranscriptQueryParams & { take?: number },
): Promise<{ intent: PermissionMode; updatedAt: number } | null> {
  const take = normalizeTake(params.take, 200);
  const serverUrl = resolveLoopbackHttpUrl(configuration.serverUrl).replace(/\/+$/, '');

  try {
    const response = await axios.get(`${serverUrl}/v1/sessions/${params.sessionId}/messages`, {
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      params: { limit: take },
      timeout: 10_000,
    });

    const data = response?.data as unknown;
    const raw = data && typeof data === 'object' ? (data as Record<string, unknown>).messages : null;
    if (!Array.isArray(raw)) return null;

    const sliced = raw.slice(0, take);
    const candidates: Array<{ rawMode: unknown; updatedAt: unknown }> = [];

    for (const msg of sliced) {
      const createdAt = typeof msg?.createdAt === 'number' ? msg.createdAt : null;
      if (createdAt === null) continue;
      const content = msg?.content;
      const parsedContent = SessionMessageContentSchema.safeParse(content);
      if (!parsedContent.success) continue;

      let decrypted: unknown;
      if (parsedContent.data.t === 'plain') {
        decrypted = parsedContent.data.v;
      } else {
        decrypted = decrypt(
          params.encryptionKey,
          params.encryptionVariant,
          decodeBase64(parsedContent.data.c),
        );
      }
      const decryptedObj = decrypted && typeof decrypted === 'object' ? (decrypted as Record<string, unknown>) : null;
      if (decryptedObj?.role !== 'user') continue;

      const meta = decryptedObj?.meta;
      const rawMode = meta && typeof meta === 'object' ? (meta as Record<string, unknown>).permissionMode : null;
      if (typeof rawMode !== 'string' || rawMode.trim().length === 0) continue;

      candidates.push({ rawMode, updatedAt: createdAt });
    }

    const resolved = resolveLatestPermissionIntent(candidates);
    if (!resolved) return null;
    return { intent: resolved.intent as PermissionMode, updatedAt: resolved.updatedAt };
  } catch (error) {
    logger.debug('[API] Failed to fetch transcript messages for permission intent resolution', { error });
    return null;
  }
}
