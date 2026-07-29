import { describe, expect, it } from 'vitest';

import { selectGrokAuthentication } from './auth.js';

describe('Grok ACP authentication', () => {
  it('prefers advertised xAI API-key auth when the declared environment value is nonblank', () => {
    expect(selectGrokAuthentication({
      advertisedMethodIds: ['cached_token', 'xai.api_key'], initializeMetadata: null,
    }, { XAI_API_KEY: ' key ' })).toEqual({ methodId: 'xai.api_key', metadata: { headless: true } });
  });

  it('uses an advertised initialized cached default, then deterministic cached fallbacks', () => {
    expect(selectGrokAuthentication({
      advertisedMethodIds: ['grok.com'], initializeMetadata: { defaultAuthMethodId: 'grok.com' },
    }, {})).toEqual({ methodId: 'grok.com', metadata: { headless: true } });
    expect(selectGrokAuthentication({
      advertisedMethodIds: ['cached_token'], initializeMetadata: null,
    }, {})).toEqual({ methodId: 'cached_token', metadata: { headless: true } });
    expect(() => selectGrokAuthentication({
      advertisedMethodIds: ['grok.com'], initializeMetadata: null,
    }, {})).toThrow('Run `grok login`');
  });
});
