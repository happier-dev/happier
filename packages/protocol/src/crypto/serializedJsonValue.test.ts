import { describe, expect, it } from 'vitest';

import { parseSerializedJsonValue, stringifySerializedJsonValue } from './serializedJsonValue.js';

describe('serializedJsonValue', () => {
  it('preserves top-level undefined values', () => {
    expect(parseSerializedJsonValue(stringifySerializedJsonValue(undefined))).toBeUndefined();
  });

  it('preserves legacy plain JSON payloads', () => {
    expect(parseSerializedJsonValue(JSON.stringify({ ok: true, count: 1 }))).toEqual({ ok: true, count: 1 });
  });

  it('preserves backwards compatibility with legacy undefined strings', () => {
    expect(parseSerializedJsonValue('undefined')).toBeUndefined();
  });

  it('preserves bigint fallback stringification', () => {
    expect(parseSerializedJsonValue(stringifySerializedJsonValue({ count: 42n }))).toEqual({ count: '42n' });
  });
});
