import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { grokCliAuthSpec } from './grokCliAuthSpec';

describe('Grok CLI auth status', () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.XAI_API_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = originalKey;
  });

  it('reports a non-empty API key as ready without exposing the value', async () => {
    process.env.XAI_API_KEY = '  secret-value  ';
    const result = await grokCliAuthSpec.detectAuthStatus?.({ resolvedPath: '/tmp/grok' });
    expect(result).toEqual({ state: 'logged_in', method: 'api_key_env', source: 'env' });
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });

  it.each([undefined, '', '   '])('keeps cached login truthfully unknown for key %j', async (value) => {
    if (value === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = value;
    await expect(grokCliAuthSpec.detectAuthStatus?.({ resolvedPath: '/tmp/grok' })).resolves.toEqual({
      state: 'unknown',
      reason: 'unsupported',
    });
  });
});
