export function buildSummaryShardLocalId(params: Readonly<{ seqFrom: number; seqTo: number }>): string {
  const seqFrom = Math.max(0, Math.trunc(params.seqFrom));
  const seqTo = Math.max(0, Math.trunc(params.seqTo));
  return `memory:summary_shard:v1:${seqFrom}-${seqTo}`;
}

export function buildSynopsisLocalId(params: Readonly<{ seqTo: number }>): string {
  const seqTo = Math.max(0, Math.trunc(params.seqTo));
  return `memory:synopsis:v1:${seqTo}`;
}

