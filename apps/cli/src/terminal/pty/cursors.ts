export function normalizeLegacyCursor(cursor: number): number {
  return Math.max(0, Math.trunc(Number.isFinite(cursor) ? cursor : 0));
}

export function normalizeByteOffset(byteOffset: number): number {
  return Math.max(0, Math.trunc(Number.isFinite(byteOffset) ? byteOffset : 0));
}
