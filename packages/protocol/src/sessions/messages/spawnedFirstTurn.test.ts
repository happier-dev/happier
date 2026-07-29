import { describe, expect, it } from 'vitest';

import { buildSpawnedFirstTurnLocalId } from './spawnedFirstTurn.js';

describe('buildSpawnedFirstTurnLocalId', () => {
  it('derives one stable Pending identity from the spawn nonce', () => {
    expect(buildSpawnedFirstTurnLocalId(' launch-1 ')).toBe('spawn-first-turn:launch-1');
    expect(buildSpawnedFirstTurnLocalId('')).toBeNull();
    expect(buildSpawnedFirstTurnLocalId(null)).toBeNull();
  });
});
