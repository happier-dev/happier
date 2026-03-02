import { buildSynopsisLocalId } from './buildMemoryArtifactLocalId';

export type MemorySynopsisPointerV1 = Readonly<{
  v: 1;
  localId: string;
  seqTo: number;
  updatedAtMs: number;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizePointerCandidate(value: unknown): MemorySynopsisPointerV1 | null {
  const rec = asRecord(value);
  if (!rec) return null;
  if (rec.v !== 1) return null;
  const localId = typeof rec.localId === 'string' ? rec.localId.trim() : '';
  const seqTo = typeof rec.seqTo === 'number' && Number.isFinite(rec.seqTo) ? Math.max(0, Math.floor(rec.seqTo)) : NaN;
  const updatedAtMs =
    typeof rec.updatedAtMs === 'number' && Number.isFinite(rec.updatedAtMs) ? Math.max(0, Math.floor(rec.updatedAtMs)) : NaN;
  if (!localId) return null;
  if (!Number.isFinite(seqTo)) return null;
  if (!Number.isFinite(updatedAtMs)) return null;
  return { v: 1, localId, seqTo, updatedAtMs };
}

export function readMemorySynopsisPointerV1FromSessionMetadata(metadata: Record<string, unknown>): MemorySynopsisPointerV1 | null {
  const value = (metadata as any)?.memorySynopsisPointerV1;
  return normalizePointerCandidate(value);
}

export function applyMemorySynopsisPointerV1ToSessionMetadata(params: Readonly<{
  metadata: Record<string, unknown>;
  next: Readonly<{ seqTo: number; updatedAtMs: number }>;
}>): Record<string, unknown> {
  const seqTo = typeof params.next.seqTo === 'number' && Number.isFinite(params.next.seqTo) ? Math.max(0, Math.floor(params.next.seqTo)) : NaN;
  const updatedAtMs =
    typeof params.next.updatedAtMs === 'number' && Number.isFinite(params.next.updatedAtMs) ? Math.max(0, Math.floor(params.next.updatedAtMs)) : NaN;
  if (!Number.isFinite(seqTo) || !Number.isFinite(updatedAtMs)) return params.metadata;

  const existing = readMemorySynopsisPointerV1FromSessionMetadata(params.metadata);
  if (existing) {
    if (existing.updatedAtMs > updatedAtMs) return params.metadata;
    if (existing.updatedAtMs === updatedAtMs && existing.seqTo >= seqTo) return params.metadata;
  }

  return {
    ...params.metadata,
    memorySynopsisPointerV1: {
      v: 1,
      localId: buildSynopsisLocalId({ seqTo }),
      seqTo,
      updatedAtMs,
    },
  };
}

