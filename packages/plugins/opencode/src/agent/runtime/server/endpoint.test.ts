import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import {
  createOpenCodeManagedServerCredential,
  OPENCODE_SERVER_PASSWORD_ENV_KEY,
  readOpenCodeManagedServerEndpointRegistration,
  readOpenCodeManagedServerEndpointRegistrationByGenerationToken,
  readOpenCodeManagedServerTransport,
  registerOpenCodeManagedServerEndpoint,
} from './endpoint.js';
import { createOpenCodeServerTransport } from './transport.js';

function createTransport(baseUrl: string, instanceId: string) {
  return createOpenCodeServerTransport({
    baseUrl,
    instanceId,
    readManagedServerSnapshot: () => ({
      instanceId,
      state: 'healthy',
      baseUrl,
    }),
    fetchImpl: async () => new Response('{}'),
  });
}

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

describe('managed OpenCode server credential registration', () => {
  it('exposes a non-secret ephemeral generation that changes on same-endpoint re-registration', () => {
    const baseUrl = 'http://127.0.0.1:49196/';
    const firstCredential = createOpenCodeManagedServerCredential();
    const firstRegistration = registerOpenCodeManagedServerEndpoint({
      baseUrl,
      credential: firstCredential,
      transport: createTransport(baseUrl, 'instance-1'),
    });
    const first = readOpenCodeManagedServerEndpointRegistration(baseUrl);

    const secondCredential = createOpenCodeManagedServerCredential();
    const secondRegistration = registerOpenCodeManagedServerEndpoint({
      baseUrl: 'http://127.0.0.1:49196',
      credential: secondCredential,
      transport: createTransport(baseUrl, 'instance-2'),
    });
    const second = readOpenCodeManagedServerEndpointRegistration(baseUrl);

    expect(first).toMatchObject({
      baseUrl: 'http://127.0.0.1:49196',
      headers: firstCredential.headers,
      generationToken: expect.any(String),
      transport: expect.any(Object),
    });
    expect(second).toMatchObject({
      baseUrl: 'http://127.0.0.1:49196',
      headers: secondCredential.headers,
      generationToken: expect.any(String),
      transport: expect.any(Object),
    });
    expect(second?.generationToken).not.toBe(first?.generationToken);
    expect(second?.generationToken).not.toContain(secondCredential.value);
    expect(JSON.stringify(second)).not.toContain(secondCredential.value);
    expect(readOpenCodeManagedServerEndpointRegistrationByGenerationToken(
      second?.generationToken ?? '',
    )).toMatchObject({
      baseUrl: 'http://127.0.0.1:49196',
      headers: secondCredential.headers,
      generationToken: second?.generationToken,
      transport: expect.any(Object),
    });

    firstRegistration.dispose();
    expect(readOpenCodeManagedServerEndpointRegistration(baseUrl)).toEqual(second);
    expect(readOpenCodeManagedServerEndpointRegistrationByGenerationToken(
      first?.generationToken ?? '',
    )).toBeNull();

    secondRegistration.dispose();
    expect(readOpenCodeManagedServerEndpointRegistration(baseUrl)).toBeNull();
  });

  it('registers an unauthenticated endpoint transport without inventing a credential generation', () => {
    const baseUrl = 'http://127.0.0.1:49197';
    const firstTransport = createTransport(baseUrl, 'instance-external-1');
    const firstRegistration = registerOpenCodeManagedServerEndpoint({
      baseUrl,
      credential: null,
      transport: firstTransport,
    });
    const firstEndpoint = readOpenCodeManagedServerEndpointRegistration(baseUrl);
    const secondTransport = createTransport(baseUrl, 'instance-external-2');
    const secondRegistration = registerOpenCodeManagedServerEndpoint({
      baseUrl,
      credential: null,
      transport: secondTransport,
    });
    const secondEndpoint = readOpenCodeManagedServerEndpointRegistration(baseUrl);

    expect(readOpenCodeManagedServerTransport(baseUrl)).toBe(secondTransport);
    expect(secondEndpoint?.headers).toBeUndefined();
    expect(firstEndpoint?.generationToken).not.toBe(secondEndpoint?.generationToken);
    expect(readOpenCodeManagedServerEndpointRegistrationByGenerationToken(
      firstEndpoint?.generationToken ?? '',
    )?.transport).toBe(firstTransport);
    expect(readOpenCodeManagedServerEndpointRegistrationByGenerationToken(
      secondEndpoint?.generationToken ?? '',
    )?.transport).toBe(secondTransport);
    expect(firstEndpoint?.headers).toBeUndefined();
    expect(secondEndpoint?.headers).toBeUndefined();

    secondRegistration.dispose();
    expect(readOpenCodeManagedServerTransport(baseUrl)).toBe(firstTransport);

    firstRegistration.dispose();
    expect(readOpenCodeManagedServerTransport(baseUrl)).toBeNull();
    expect(readOpenCodeManagedServerEndpointRegistrationByGenerationToken(
      firstEndpoint?.generationToken ?? '',
    )).toBeNull();
  });
});
