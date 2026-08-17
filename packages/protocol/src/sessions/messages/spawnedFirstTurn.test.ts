import { describe, expect, it } from 'vitest';

import {
  buildSessionSpawnInitialInputLocalIdV1,
  buildSpawnedFirstTurnLocalId,
} from './spawnedFirstTurn.js';

describe('buildSpawnedFirstTurnLocalId', () => {
  it('derives one stable Pending identity from the spawn nonce', () => {
    expect(buildSpawnedFirstTurnLocalId(' launch-1 ')).toBe('spawn-first-turn:launch-1');
    expect(buildSpawnedFirstTurnLocalId('')).toBeNull();
    expect(buildSpawnedFirstTurnLocalId(null)).toBeNull();
  });
});

describe('buildSessionSpawnInitialInputLocalIdV1', () => {
  const sessionCreationTag = `create:v1:${'a'.repeat(43)}`;

  it('derives a stable Message-owned identity from the Session creation tag, never the spawn nonce', () => {
    const first = buildSessionSpawnInitialInputLocalIdV1({
      sessionId: 'session-1',
      sessionCreationTag,
    });
    const retry = buildSessionSpawnInitialInputLocalIdV1({
      sessionId: 'session-1',
      sessionCreationTag,
    });
    const otherCreation = buildSessionSpawnInitialInputLocalIdV1({
      sessionId: 'session-1',
      sessionCreationTag: `create:v1:${'b'.repeat(43)}`,
    });

    expect(first).toBe(retry);
    expect(first).not.toBe(otherCreation);
    expect(first).toMatch(/^plugin-input-v1:[A-Za-z0-9_-]{43}$/u);
  });

  it('rejects malformed Session or creation identities', () => {
    expect(() => buildSessionSpawnInitialInputLocalIdV1({
      sessionId: '',
      sessionCreationTag,
    })).toThrow();
    expect(() => buildSessionSpawnInitialInputLocalIdV1({
      sessionId: 'session-1',
      sessionCreationTag: 'nonce-is-not-a-session-creation-tag',
    })).toThrow();
  });
});
