import { describe, expect, it } from 'vitest';

import {
  ProviderAgentTargetKeySchema,
  ProviderConnectionIdSchema,
  ProviderContributionKeySchema,
  ProviderLocalIdSchema,
  ProviderMachineIdSchema,
  ProviderModelIdSchema,
} from './ids.js';

describe('provider identifier schemas', () => {
  it.each(['__proto__', 'prototype', 'constructor'])(
    'rejects prototype-poison keys for provider-owned record identities: %s',
    (id) => {
      for (const schema of [
        ProviderAgentTargetKeySchema, ProviderConnectionIdSchema, ProviderContributionKeySchema,
        ProviderLocalIdSchema, ProviderMachineIdSchema,
      ]) expect(schema.safeParse(id).success).toBe(false);
    },
  );

  it('keeps arbitrary exact vendor model ids legal', () => {
    expect(ProviderModelIdSchema.parse('__proto__')).toBe('__proto__');
  });

  it.each(['Constructor', 'Prototype', '__Proto__'])('keeps harmless case variants legal: %s', (id) => {
    expect(ProviderConnectionIdSchema.parse(id)).toBe(id);
  });
});
