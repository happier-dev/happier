import { describe, expect, it } from 'vitest';

import {
  containsProviderRegisteredSecret,
} from './index.js';

describe('provider registered sensitive-value detection', () => {
  it('detects an exact registered secret echoed under an innocuous field name', () => {
    expect(containsProviderRegisteredSecret('model-sk-secret', ['sk-secret'])).toBe(true);
    expect(containsProviderRegisteredSecret('/next?value=tenant%2Fsensitive%3Fvalue', ['tenant/sensitive?value'])).toBe(true);
    expect(containsProviderRegisteredSecret('/next?value=tenant+sensitive+value', ['tenant sensitive value'])).toBe(true);
    expect(containsProviderRegisteredSecret('ordinary-model', ['sk-secret'])).toBe(false);
    expect(containsProviderRegisteredSecret('ordinary-model', ['', ''])).toBe(false);
  });
});
