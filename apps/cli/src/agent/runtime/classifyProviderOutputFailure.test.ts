import { describe, expect, it } from 'vitest';

import { classifyProviderOutputFailure } from './classifyProviderOutputFailure';

describe('provider output authentication evidence', () => {
  it('keeps vendor environment-variable mentions separate from an authentication refusal', () => {
    expect(classifyProviderOutputFailure('Inspect OPENAI_API_KEY before documenting the environment.'))
      .toEqual({ authenticationError: false, providerStatusFailure: false });
    expect(classifyProviderOutputFailure('Request failed with status code 401'))
      .toEqual({ authenticationError: true, providerStatusFailure: true });
    expect(classifyProviderOutputFailure('API key is invalid'))
      .toEqual({ authenticationError: true, providerStatusFailure: false });
  });
});
