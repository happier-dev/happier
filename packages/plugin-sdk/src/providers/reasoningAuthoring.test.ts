import { describe, expect, it } from 'vitest';
import * as providers from './index.public.js';

describe('public Provider reasoning authoring', () => {
  it('lets external catalog parsers use the canonical effort vocabulary and descriptor builder', () => {
    expect(providers).toHaveProperty('PROVIDER_REASONING_EFFORT_LEVELS_V1', ['low', 'medium', 'high', 'xhigh', 'max']);
    expect(providers).toHaveProperty('buildProviderReasoningModelOptions', expect.any(Function));
    expect(providers.buildProviderReasoningModelOptions({ supportedLevels: ['low', 'high'] }))
      .toMatchObject([{ id: 'reasoning_effort', currentValue: 'high', options: [{ value: 'low' }, { value: 'high' }] }]);
  });
});
