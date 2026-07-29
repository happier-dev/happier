export function buildSpawnedFirstTurnLocalId(spawnNonce: unknown): string | null {
  if (typeof spawnNonce !== 'string') return null;
  const normalizedSpawnNonce = spawnNonce.trim();
  return normalizedSpawnNonce.length > 0
    ? `spawn-first-turn:${normalizedSpawnNonce}`
    : null;
}
