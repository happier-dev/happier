import { describe, expect, it, vi } from 'vitest';

import { readSessionBotV1, SessionBotV1Schema, SessionBotV1StoredSchema } from './sessionBotV1.js';

describe('readSessionBotV1', () => {
  it('does not allocate validation errors for the absent marker on ordinary sessions', () => {
    const parse = vi.spyOn(SessionBotV1StoredSchema, 'safeParse'); // Call-through instrumentation of the hot read boundary.
    try {
      expect(readSessionBotV1(undefined)).toBeNull();
      expect(readSessionBotV1(null)).toBeNull();
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
    expect(readSessionBotV1({ kind: 'bot', future: true })).toEqual({ kind: 'bot' });
    expect(readSessionBotV1({ kind: 'agent' })).toBeNull();
    expect(readSessionBotV1({})).toBeNull();
    expect(SessionBotV1Schema.safeParse({ kind: 'bot', future: true }).success).toBe(false);
  });

  it.runIf(process.env.HAPPIER_MEASURE_UI_HOT_LOOPS === '1')('measures 2,000 ordinary sessions across 20 reads', () => {
    const start = performance.now();
    for (let tick = 0; tick < 20; tick++) {
      for (let index = 0; index < 2_000; index++) {
        if (readSessionBotV1(undefined) !== null) throw new Error('ordinary session became a bot');
      }
    }
    console.log(JSON.stringify({ measurement: 'absent-bot-marker', sessions: 2_000, ticks: 20,
      elapsedMs: performance.now() - start }));
  });
});
