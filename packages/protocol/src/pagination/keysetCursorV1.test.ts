import { describe, expect, it } from 'vitest';

import {
  decodeKeysetCursorV1,
  encodeKeysetCursorV1,
  KEYSET_CURSOR_MAX_LENGTH_V1,
  readKeysetCursorIdV1,
  readKeysetCursorTimeV1,
} from './keysetCursorV1.js';

describe('query-bound keyset cursor', () => {
  it('keeps long filter bindings pageable within the cursor transport bound', () => {
    const queryKey = JSON.stringify({ accountId: 'account-1', runIds: Array.from({ length: 100 }, (_, index) => `run-${index}`) });
    const parts = ['2026-10-08T12:00:00.000Z', 'run-1'];
    const cursor = encodeKeysetCursorV1({ queryKey, parts });
    expect(cursor.length).toBeLessThanOrEqual(KEYSET_CURSOR_MAX_LENGTH_V1);
    expect(decodeKeysetCursorV1(cursor, queryKey)).toEqual({ status: 'ok', parts });
    expect(decodeKeysetCursorV1(cursor, `${queryKey}other`)).toEqual({ status: 'invalid' });
  });

  it('round-trips an ordering tuple only for the query that minted it', () => {
    const cursor = encodeKeysetCursorV1({ queryKey: 'home-accounts:v1', parts: [12, 'acc_1'] });
    const decoded = decodeKeysetCursorV1(cursor, 'home-accounts:v1');
    expect(decoded).toEqual({ status: 'ok', parts: [12, 'acc_1'] });
    if (decoded.status !== 'ok') throw new Error('expected decoded cursor');
    expect(readKeysetCursorTimeV1(decoded.parts[0])).toBe(12);
    expect(readKeysetCursorIdV1(decoded.parts[1])).toBe('acc_1');
    expect(decodeKeysetCursorV1(cursor, 'team-directory:v1')).toEqual({ status: 'invalid' });
  });

  it('rejects malformed and structurally invalid positions', () => {
    expect(decodeKeysetCursorV1('not-a-cursor', 'home-accounts:v1')).toEqual({ status: 'invalid' });
    const unsafeTime = encodeKeysetCursorV1({ queryKey: 'home-accounts:v1', parts: [Number.MAX_VALUE, 'acc_1'] });
    const decoded = decodeKeysetCursorV1(unsafeTime, 'home-accounts:v1');
    expect(decoded.status).toBe('ok');
    if (decoded.status !== 'ok') throw new Error('expected decoded cursor');
    expect(readKeysetCursorTimeV1(decoded.parts[0])).toBeNull();
  });
});
