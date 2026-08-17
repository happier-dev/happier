import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  ManagedServiceLocalIdSchema,
  type ManagedServiceLocalId,
} from './contributionIdentity.js';

describe('managed-service local ids', () => {
  it('uses the canonical bounded plugin-local-id grammar', () => {
    expectTypeOf<ManagedServiceLocalId>().toEqualTypeOf<string>();

    for (const valid of [
      'gateway',
      'gateway-v2',
      'providers/gateway',
      'a'.repeat(256),
    ]) {
      expect(ManagedServiceLocalIdSchema.safeParse(valid).success).toBe(true);
    }
    for (const invalid of [
      '',
      ' Gateway ',
      'gateway_v2',
      'gateway.v2',
      'providers//gateway',
      'a'.repeat(257),
    ]) {
      expect(ManagedServiceLocalIdSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
