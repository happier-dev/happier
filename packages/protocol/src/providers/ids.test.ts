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

  it.each(['__proto__', 'prototype', 'constructor'])(
    'preserves reserved-looking strings as exact vendor model ids: %s',
    (id) => expect(ProviderModelIdSchema.parse(id)).toBe(id),
  );

  it.each([' model', 'model ', 'org / model', 'org\tmodel', 'org\nmodel'])(
    'rejects non-canonical persisted vendor model ids instead of silently rewriting them: %j',
    (id) => {
      expect(ProviderModelIdSchema.safeParse(id).success).toBe(false);
    },
  );

  it('preserves exact case and punctuation for canonical vendor model ids', () => {
    expect(ProviderModelIdSchema.parse('Org/Model.V2:Latest')).toBe('Org/Model.V2:Latest');
  });

  it.each(['bad\0id', 'bad\u0001id', 'bad\u001fid', 'bad\u007fid'])(
    'rejects control-bearing persisted model ids: %j',
    (id) => expect(ProviderModelIdSchema.safeParse(id).success).toBe(false),
  );

  it.each(['Constructor', 'Prototype', '__Proto__'])('keeps harmless case variants legal: %s', (id) => {
    expect(ProviderConnectionIdSchema.parse(id)).toBe(id);
  });
});
