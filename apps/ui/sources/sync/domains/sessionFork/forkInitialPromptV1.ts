import type { Metadata } from '@/sync/domains/state/storageTypes';

export type ForkInitialPromptV1 = Readonly<{
  v: 1;
  text: string;
  createdAtMs: number;
  sourceMessageId?: string;
  appliedAtMs?: number;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function readForkInitialPromptV1(metadata: Metadata | null | undefined): ForkInitialPromptV1 | null {
  const candidate = (metadata as any)?.forkInitialPromptV1;
  if (!isRecord(candidate)) return null;
  const text = typeof candidate.text === 'string' ? candidate.text : '';
  if (!text.trim()) return null;
  const createdAtMs = typeof candidate.createdAtMs === 'number' ? candidate.createdAtMs : 0;
  return {
    v: 1,
    text,
    createdAtMs,
    ...(typeof candidate.sourceMessageId === 'string' ? { sourceMessageId: candidate.sourceMessageId } : null),
    ...(typeof candidate.appliedAtMs === 'number' ? { appliedAtMs: candidate.appliedAtMs } : null),
  };
}

export function writeForkInitialPromptV1(params: Readonly<{
  metadata: Metadata;
  text: string;
  createdAtMs: number;
  sourceMessageId?: string | null;
}>): Metadata {
  const text = typeof params.text === 'string' ? params.text : String(params.text ?? '');
  if (!text.trim()) return params.metadata;
  return {
    ...params.metadata,
    forkInitialPromptV1: {
      v: 1,
      text,
      createdAtMs: params.createdAtMs,
      ...(typeof params.sourceMessageId === 'string' && params.sourceMessageId.trim().length > 0
        ? { sourceMessageId: params.sourceMessageId.trim() }
        : null),
    },
  } as Metadata;
}

export function clearForkInitialPromptV1(params: Readonly<{
  metadata: Metadata;
}>): Metadata {
  const current = readForkInitialPromptV1(params.metadata);
  if (!current) return params.metadata;
  const next = { ...(params.metadata as any) };
  delete next.forkInitialPromptV1;
  return next;
}
