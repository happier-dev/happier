import { describe, expect, it } from 'vitest';

import { parseBooleanEnv, parseOptionalBooleanEnv } from './parseBooleanEnv';

describe('parseBooleanEnv', () => {
  it('returns fallback when unset', () => {
    expect(parseBooleanEnv(undefined, true)).toBe(true);
    expect(parseBooleanEnv(undefined, false)).toBe(false);
    expect(parseBooleanEnv('', true)).toBe(true);
    expect(parseBooleanEnv('   ', false)).toBe(false);
  });

  it('parses truthy tokens', () => {
    for (const token of ['1', 'true', 'TRUE', ' yes ', 'on', 'Y']) {
      expect(parseBooleanEnv(token, false)).toBe(true);
    }
  });

  it('parses falsey tokens', () => {
    for (const token of ['0', 'false', 'FALSE', ' no ', 'off', 'n']) {
      expect(parseBooleanEnv(token, true)).toBe(false);
    }
  });

  it('falls back when invalid', () => {
    expect(parseBooleanEnv('nope', true)).toBe(true);
    expect(parseBooleanEnv('nope', false)).toBe(false);
  });
});

describe('parseOptionalBooleanEnv', () => {
  it('returns null for unset or invalid', () => {
    expect(parseOptionalBooleanEnv(undefined)).toBeNull();
    expect(parseOptionalBooleanEnv('')).toBeNull();
    expect(parseOptionalBooleanEnv('nope')).toBeNull();
  });
});

