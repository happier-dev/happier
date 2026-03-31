import { describe, expect, it } from 'vitest';

import { buildSshTarget, parseSshTarget } from './sshTarget.js';

describe('parseSshTarget', () => {
  it('splits a user@host target into username and host', () => {
    expect(parseSshTarget('dev@example.test')).toEqual({
      username: 'dev',
      host: 'example.test',
    });
  });

  it('keeps bare hosts intact when no username is present', () => {
    expect(parseSshTarget('example.test')).toEqual({
      username: '',
      host: 'example.test',
    });
  });
});

describe('buildSshTarget', () => {
  it('reconstructs a target from split username and host fields', () => {
    expect(buildSshTarget({
      username: 'dev',
      host: 'example.test',
    })).toBe('dev@example.test');
  });

  it('falls back to the host when no username is provided', () => {
    expect(buildSshTarget({
      username: '',
      host: 'example.test',
    })).toBe('example.test');
  });
});
