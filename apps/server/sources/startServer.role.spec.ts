import { describe, it, expect } from 'vitest';
import { getServerRoleFromEnv } from './startServer';

describe('getServerRoleFromEnv', () => {
  it('defaults to all when SERVER_ROLE is unset', () => {
    expect(getServerRoleFromEnv({})).toBe('all');
  });

  it('accepts api and worker', () => {
    expect(getServerRoleFromEnv({ SERVER_ROLE: 'api' })).toBe('api');
    expect(getServerRoleFromEnv({ SERVER_ROLE: 'worker' })).toBe('worker');
  });

  it('treats unknown values as all', () => {
    expect(getServerRoleFromEnv({ SERVER_ROLE: 'nope' })).toBe('all');
  });
});

