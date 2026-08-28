import { describe, expect, it } from 'vitest';

import {
  buildSpawnedFirstTurnLocalId,
  buildSessionSpawnInitialInputLocalIdV1,
} from './spawnedFirstTurn.js';
import { deriveSessionCreationTagV1 } from '../creation/sessionCreationIdentityV1.js';

describe('buildSpawnedFirstTurnLocalId', () => {
  it('derives one stable Pending identity from the spawn nonce', () => {
    expect(buildSpawnedFirstTurnLocalId(' launch-1 ')).toBe('spawn-first-turn:launch-1');
    expect(buildSpawnedFirstTurnLocalId('')).toBeNull();
    expect(buildSpawnedFirstTurnLocalId(null)).toBeNull();
  });
});

describe('buildSessionSpawnInitialInputLocalIdV1', () => {
  it('derives one Message identity from the durable creation identity', () => {
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'user',
      creationKey: 'manual:attempt-a',
    });

    const first = buildSessionSpawnInitialInputLocalIdV1({ sessionCreationTag });
    expect(first).toMatch(/^plugin-input-v1:[A-Za-z0-9_-]{43}$/u);
    expect(buildSessionSpawnInitialInputLocalIdV1({ sessionCreationTag })).toBe(first);
    expect(buildSessionSpawnInitialInputLocalIdV1({
      sessionCreationTag: deriveSessionCreationTagV1({
        callerCreationNamespace: 'user',
        creationKey: 'manual:attempt-b',
      }),
    })).not.toBe(first);
  });
});
