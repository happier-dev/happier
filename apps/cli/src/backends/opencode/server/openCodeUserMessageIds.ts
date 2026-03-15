import { createHash } from 'node:crypto';

const BASE62_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export type OpenCodeUserMessageIdMapV1 = Readonly<{
  v: 1;
  byLocalId: Readonly<Record<string, string>>;
}>;

export function readOpenCodeUserMessageIdMapV1(metadata: unknown): OpenCodeUserMessageIdMapV1 | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const raw = (metadata as any).opencodeUserMessageIdMapV1;
  if (!raw || typeof raw !== 'object') return null;
  if ((raw as any).v !== 1) return null;
  const byLocalId = (raw as any).byLocalId;
  if (!byLocalId || typeof byLocalId !== 'object' || Array.isArray(byLocalId)) return null;
  return { v: 1, byLocalId } as OpenCodeUserMessageIdMapV1;
}

export function resolveOpenCodeUserMessageIdFromMetadata(metadata: unknown, localId: string): string | null {
  const trimmed = typeof localId === 'string' ? localId.trim() : '';
  if (!trimmed) return null;
  const map = readOpenCodeUserMessageIdMapV1(metadata);
  if (!map) return null;
  const candidate = (map.byLocalId as any)[trimmed];
  return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate.trim() : null;
}

export function upsertOpenCodeUserMessageIdInMetadata(params: Readonly<{
  metadata: Record<string, unknown>;
  localId: string;
  messageId: string;
}>): Record<string, unknown> {
  const localId = params.localId.trim();
  const messageId = params.messageId.trim();
  if (!localId || !messageId) return params.metadata;

  const existing = readOpenCodeUserMessageIdMapV1(params.metadata);
  const byLocalId = existing?.byLocalId ? { ...(existing.byLocalId as any) } : {};
  if (typeof byLocalId[localId] === 'string' && String(byLocalId[localId]).trim()) {
    return params.metadata;
  }
  byLocalId[localId] = messageId;
  return {
    ...params.metadata,
    opencodeUserMessageIdMapV1: {
      v: 1,
      byLocalId,
    },
  };
}

export function createOpenCodeAscendingMessageId(params: Readonly<{
  nowMs: number;
  counter: number;
  entropySeed: string;
}>): string {
  const nowMs = Number.isFinite(params.nowMs) ? Math.max(0, Math.trunc(params.nowMs)) : 0;
  const counter = Number.isFinite(params.counter)
    ? Math.min(0xfff, Math.max(1, Math.trunc(params.counter)))
    : 1;

  let now = BigInt(nowMs) * BigInt(0x1000) + BigInt(counter);
  const timeBytes = Buffer.alloc(6);
  for (let i = 0; i < 6; i += 1) {
    timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff));
  }
  const timeHex = timeBytes.toString('hex');

  const hash = createHash('sha256').update(params.entropySeed, 'utf8').digest();
  let entropy = '';
  for (let i = 0; i < 14; i += 1) {
    entropy += BASE62_CHARS[hash[i] % 62]!;
  }

  return `msg_${timeHex}${entropy}`;
}
