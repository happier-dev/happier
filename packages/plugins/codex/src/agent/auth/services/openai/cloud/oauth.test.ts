import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractOpenAiAccountIdFromIdToken, readOpenAiIdentityFromIdToken } from './oauth.js';

afterEach(() => vi.unstubAllGlobals());

describe('portable Codex token identity', () => {
  it('reads provider identity without Node Buffer', () => {
    const payloadBytes = new TextEncoder().encode(JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: 'portable-account' },
      name: 'Portable 日本語', email: 'portable@example.test',
    }));
    const payload = btoa(String.fromCharCode(...payloadBytes))
      .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    const token = `header.${payload}.signature`;
    vi.stubGlobal('Buffer', undefined);
    expect(extractOpenAiAccountIdFromIdToken(token)).toBe('portable-account');
    expect(readOpenAiIdentityFromIdToken(token)).toEqual({ name: 'Portable 日本語', email: 'portable@example.test' });
  });
});
