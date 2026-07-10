import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import {
  createOpenCodeManagedServerCredential,
  OPENCODE_SERVER_PASSWORD_ENV_KEY,
} from './endpoint.js';

describe('createOpenCodeManagedServerCredential', () => {
  it('uses the OpenCode server password as HTTP Basic auth for managed server requests', () => {
    const credential = createOpenCodeManagedServerCredential();
    const authorization = credential.headers.authorization;

    expect(credential.envKey).toBe(OPENCODE_SERVER_PASSWORD_ENV_KEY);
    expect(credential.value).toMatch(/^[a-f0-9]{48}$/u);
    expect(authorization).toMatch(/^Basic /u);
    expect(authorization).not.toMatch(/^Bearer /u);

    const encoded = authorization.slice('Basic '.length);
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe(`opencode:${credential.value}`);
  });
});
