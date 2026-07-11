import { describe, expect, it } from 'vitest';

import { extractTokensFromAcpTokenCountMessage } from './acpTokenCountUsage';

describe('acp token_count usage extraction', () => {
  it('extracts common token fields from top-level keys', () => {
    const res = extractTokensFromAcpTokenCountMessage({
      type: 'token_count',
      input_tokens: 10,
      output_tokens: 4,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
      thought_tokens: 5,
      model: 'openai/gpt-4o-mini',
      key: 'turn-1',
    });

    expect(res).toEqual({
      key: 'turn-1',
      modelId: 'openai/gpt-4o-mini',
      tokens: {
        total: 24,
        input: 10,
        output: 4,
        cacheWrite: 2,
        cacheRead: 3,
        reasoning: 5,
      },
    });
  });

  it('extracts tokens from nested tokens map when present', () => {
    const res = extractTokensFromAcpTokenCountMessage({
      type: 'token_count',
      tokens: { total: 12, input: 7, output: 5 },
    });

    expect(res).toEqual({
      key: null,
      modelId: null,
      tokens: { total: 12, input: 7, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it('computes total for nested tokens maps that omit total', () => {
    const res = extractTokensFromAcpTokenCountMessage({
      type: 'token_count',
      tokens: { input: 7, output: 5, thought: 2 },
    });

    expect(res).toEqual({
      key: null,
      modelId: null,
      tokens: { total: 14, input: 7, output: 5, reasoning: 2, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it('returns null when no usable numeric token fields exist', () => {
    const res = extractTokensFromAcpTokenCountMessage({ type: 'token_count', tokens: { total: 'x' } });
    expect(res).toBeNull();
  });

  it('extracts tokens from nested Codex info.total_token_usage payloads', () => {
    const res = extractTokensFromAcpTokenCountMessage({
      type: 'token_count',
      info: {
        total_token_usage: {
          total_tokens: 184,
          input_tokens: 120,
          cached_input_tokens: 20,
          output_tokens: 35,
          reasoning_output_tokens: 9,
        },
      },
    });

    expect(res).toEqual({
      key: null,
      modelId: null,
      tokens: {
        total: 184,
        input: 120,
        cacheRead: 20,
        cacheWrite: 0,
        output: 35,
        reasoning: 9,
      },
    });
  });

  it('does not allow __proto__ token keys to mutate the resulting map prototype', () => {
    const res = extractTokensFromAcpTokenCountMessage({
      type: 'token_count',
      tokens: { input: 1, output: 2, __proto__: 123 },
    });

    expect(res).toBeTruthy();
    expect(Object.getPrototypeOf((res as any).tokens)).toBe(Object.prototype);
    expect((res as any).tokens.input).toBe(1);
    expect((res as any).tokens.output).toBe(2);
    expect((res as any).tokens).not.toHaveProperty('__proto__', 123);
    expect((res as any).tokens.polluted).toBeUndefined();
  });
});
