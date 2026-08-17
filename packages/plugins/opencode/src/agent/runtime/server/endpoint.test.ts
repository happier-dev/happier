import { describe, expect, it } from 'vitest';
import {
  OPENCODE_SERVER_PASSWORD_ENV_KEY,
} from './endpoint.js';

describe('managed OpenCode endpoint configuration', () => {
  it('publishes only the host password-injection destination', () => {
    expect(OPENCODE_SERVER_PASSWORD_ENV_KEY).toBe('OPENCODE_SERVER_PASSWORD');
  });
});
