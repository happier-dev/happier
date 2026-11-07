import { describe, expect, it } from 'vitest';
import { EphemeralUpdateSchema } from './index.js';

describe('credential usage wake', () => {
  const resourceWake = { type: 'team-credential-usage-changed', resourceId: 'resource-a' };

  it('accepts the resource-only producer shape and retains authoritative Team identity when present', () => {
    expect(EphemeralUpdateSchema.parse(resourceWake)).toEqual(resourceWake);
    const teamWake = { ...resourceWake, teamId: 'team-a' };
    expect(EphemeralUpdateSchema.parse(teamWake)).toEqual(teamWake);
  });

  it('rejects malformed Team identity and undeclared routing fields', () => {
    expect(EphemeralUpdateSchema.safeParse({ ...resourceWake, teamId: '' }).success).toBe(false);
    expect(EphemeralUpdateSchema.safeParse({ ...resourceWake, teamId: 42 }).success).toBe(false);
    expect(EphemeralUpdateSchema.safeParse({ ...resourceWake, accountId: 'another-account' }).success).toBe(false);
  });
});
