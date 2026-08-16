import { describe, expect, it } from 'vitest';

import { AuthErrorCodeSchema } from './errors.js';

describe('AuthErrorCodeSchema', () => {
  it('recognizes the server signup-disabled policy code', () => {
    expect(AuthErrorCodeSchema.parse('signup-disabled')).toBe('signup-disabled');
  });

  it('rejects unknown auth error codes', () => {
    expect(AuthErrorCodeSchema.safeParse('signup_disable').success).toBe(false);
  });
});
