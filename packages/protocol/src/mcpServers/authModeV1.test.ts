import { describe, expect, it } from 'vitest';

import { inferMcpServerAuthModeV1 } from './authModeV1.js';

describe('inferMcpServerAuthModeV1', () => {
  it('returns none when the server has no env or header values', () => {
    expect(
      inferMcpServerAuthModeV1({
        env: {},
        remote: undefined,
      } as any),
    ).toBe('none');
  });

  it('returns savedSecret when any value ref uses a saved secret', () => {
    expect(
      inferMcpServerAuthModeV1({
        env: {
          API_KEY: { t: 'savedSecret', secretId: 'secret-1' },
        },
      } as any),
    ).toBe('savedSecret');
  });

  it('returns machineEnv when all literals are env-template references', () => {
    expect(
      inferMcpServerAuthModeV1({
        env: {
          API_KEY: { t: 'literal', v: '${API_KEY}' },
        },
        remote: {
          url: 'https://example.com/mcp',
          headers: {
            Authorization: { t: 'literal', v: 'Bearer ${TOKEN}' },
          },
        },
      } as any),
    ).toBe('machineEnv');
  });

  it('returns plainText when any literal value is stored directly', () => {
    expect(
      inferMcpServerAuthModeV1({
        env: {
          API_KEY: { t: 'literal', v: 'sk-live' },
        },
      } as any),
    ).toBe('plainText');
  });
});
