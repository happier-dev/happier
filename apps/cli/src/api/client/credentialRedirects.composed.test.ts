import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';

import { fetchAccountEncryptionCurrentnessFromServer } from './accountEncryptionCurrentness';
import { createTerminalAuthRequest } from '@/auth/terminalAuthEnrollmentClient';
import { classifyServerEndpointError } from './classifyServerEndpointError';
import axios from './credentialAxios';
import { fetchWithCredentialRedirectRefusal } from '@happier-dev/cli-common/homeTarget';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { AccountEncryptionCurrentnessErrorResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { reloadConfiguration } from '@/configuration';
import { writeCredentialsLegacy } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('credential-bearing Home HTTP redirects', () => {
  it('preserves the terminal refusal during legacy credential recovery', async () => {
    const paths: string[] = [];
    const server = createServer((request, response) => {
      paths.push(request.url ?? '');
      response.setHeader('content-type', 'application/json');
      if (request.url === '/v1/account/encryption/currentness') {
        response.writeHead(400).end(JSON.stringify(AccountEncryptionCurrentnessErrorResponseSchema.parse({
          error: 'migration-required', recipientEnvelopeReadiness: { status: 'unavailable', reason: 'encryption_setup_required' },
        })));
      } else if (request.url === '/v1/features/authenticated') {
        response.end(JSON.stringify(FeaturesResponseSchema.parse({ features: {}, capabilities: {
          serverIdentity: { serverIdentityId: 'synthetic-recovery-home' },
        } })));
      } else if (request.url === '/v1/auth/challenge') {
        response.writeHead(307, { location: '/forbidden-recovery-hop?private=synthetic-location' }).end();
      } else response.end('{}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    const origin = `http://127.0.0.1:${address.port}`;
    const scope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_ACTIVE_SERVER_ID']);
    try {
      await withTempDir('happier-redirect-recovery-', async home => {
        scope.patch({ HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: origin,
          HAPPIER_LOCAL_SERVER_URL: '', HAPPIER_ACTIVE_SERVER_ID: '' });
        reloadConfiguration();
        const token = `synthetic.${Buffer.from(JSON.stringify({ sub: 'synthetic-recovery-account' })).toString('base64url')}.signature`;
        await writeCredentialsLegacy({ token, secret: new Uint8Array(32).fill(9) });
        await expect(fetchAccountEncryptionCurrentnessFromServer({ token, serverBaseUrl: origin }))
          .rejects.toMatchObject({ code: 'credential_request_redirect_refused', retryable: false, status: 307 });
        expect(paths).toEqual(['/v1/account/encryption/currentness', '/v1/features/authenticated', '/v1/auth/challenge']);
      });
    } finally {
      scope.restore(); reloadConfiguration();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it.each([302, 307])('refuses HTTP %s before any second-hop header or body is sent', async status => {
    let secondHopRequests = 0;
    let secondHopAuthorization = false;
    let secondHopBodyBytes = 0;
    let firstHopRequests = 0;
    const server = createServer((request, response) => {
      if (request.url?.startsWith('/second-hop')) {
        secondHopRequests++;
        secondHopAuthorization ||= Boolean(request.headers.authorization);
        request.on('data', chunk => { secondHopBodyBytes += chunk.length; });
        request.on('end', () => response.writeHead(200, { 'content-type': 'application/json' }).end('{}'));
        return;
      }
      firstHopRequests++;
      if (request.url === '/not-modified') {
        response.writeHead(304).end();
        return;
      }
      if (request.url === '/ordinary') {
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"accepted":true}');
        return;
      }
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test listener');
      // A different host on the same listener distinguishes refusal from Axios
      // merely stripping an Authorization header on a cross-origin follow.
      response.writeHead(status, { location: `http://127.0.0.2:${address.port}/second-hop?private=synthetic-location` }).end();
    });
    await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      for (const send of [
        () => fetchAccountEncryptionCurrentnessFromServer({ token: 'synthetic-account-bearer', serverBaseUrl: origin, allowCredentialRecovery: false }),
        () => createTerminalAuthRequest({ runtime: { runtimeOrigin: origin, carrier: 'https', authenticatedCredentialDestination: null },
          publicKey: 'synthetic-public-key', claimSecretHash: 'synthetic-claim-body', headers: { Authorization: 'Bearer synthetic-account-bearer' } }),
        () => axios.create({ maxRedirects: 5 }).post(`${origin}/factory`, 'synthetic-claim-body', {
          maxRedirects: 5, validateStatus: () => true, headers: { Authorization: 'Bearer synthetic-account-bearer' },
        }),
        () => axios({ url: `${origin}/callable`, maxRedirects: 5, headers: { Authorization: 'Bearer synthetic-account-bearer' } }),
        () => axios.request({ url: `${origin}/request`, maxRedirects: 5, headers: { Authorization: 'Bearer synthetic-account-bearer' } }),
      ]) {
        const error = await send().then(() => null, (failure: unknown) => failure);
        expect(error).toMatchObject({ code: 'credential_request_redirect_refused', retryable: false, response: { status } });
        expect(classifyServerEndpointError(error).retryable).toBe(false);
        expect(JSON.stringify(error)).not.toMatch(/synthetic-account-bearer|synthetic-claim-body|synthetic-location|second-hop/);
      }
      await expect(axios.post(`${origin}/ordinary`, 'synthetic-claim-body', {
        headers: { Authorization: 'Bearer synthetic-account-bearer' },
      })).resolves.toMatchObject({ status: 200, data: { accepted: true } });
      const parentClient = axios.create({ baseURL: origin });
      await expect(parentClient.create().get('/ordinary')).resolves.toMatchObject({ status: 200 });
      await expect(axios.get(`${origin}/not-modified`, { validateStatus: () => true,
        headers: { Authorization: 'Bearer synthetic-account-bearer' },
      })).resolves.toMatchObject({ status: 304 });
      await expect(fetchWithCredentialRedirectRefusal(`${origin}/not-modified`, {
        headers: { Authorization: 'Bearer synthetic-account-bearer' },
      })).resolves.toMatchObject({ status: 304 });
      expect(firstHopRequests).toBe(9);
      expect(secondHopRequests).toBe(0);
      expect(secondHopAuthorization).toBe(false);
      expect(secondHopBodyBytes).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
