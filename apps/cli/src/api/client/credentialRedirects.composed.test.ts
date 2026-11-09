import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';

import { fetchAccountEncryptionCurrentnessFromServer } from './accountEncryptionCurrentness';
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
  it('preserves a caller redirect refusal for same-origin HTTP 307', async () => {
    let redirectedRequests = 0;
    const server = createServer((request, response) => {
      if (request.url === '/signed-path') response.writeHead(307, { location: '/other-path' }).end();
      else {
        redirectedRequests++;
        response.end('{}');
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      for (const send of [
        () => axios.request({ url: `${origin}/signed-path`, maxRedirects: 0, validateStatus: () => true,
          headers: { Authorization: 'Bearer synthetic-path-bound-credential' } }),
        () => axios.create({ baseURL: origin, maxRedirects: 0 }).get('/signed-path', {
          headers: { Authorization: 'Bearer synthetic-path-bound-credential' },
        }),
      ]) {
        await expect(send()).rejects.toMatchObject({ code: 'credential_request_redirect_refused', status: 307 });
      }
      expect(redirectedRequests).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

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
          serverIdentity: { serverIdentityId: 'srv_synthetic_recovery_home' },
        } })));
      } else if (request.url === '/v1/auth/challenge') {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing test listener');
        response.writeHead(307, { location: `http://127.0.0.2:${address.port}/forbidden-recovery-hop?private=synthetic-location` }).end();
      } else response.end('{}');
    });
    await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    const origin = `http://127.0.0.1:${address.port}`;
    const scope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_ACTIVE_SERVER_ID']);
    try {
      await withTempDir('happier-redirect-recovery-', async home => {
        scope.patch({ HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: origin,
          HAPPIER_LOCAL_SERVER_URL: '', HAPPIER_ACTIVE_SERVER_ID: '' });
        reloadConfiguration();
        // A stored terminal credential can repair its legacy key binding. The
        // persistence owner intentionally retires old Account-kind CLI bearers.
        const token = `synthetic.${Buffer.from(JSON.stringify({ sub: 'synthetic-recovery-account',
          session: 'synthetic-recovery-terminal' })).toString('base64url')}.signature`;
        await writeCredentialsLegacy({ token, secret: new Uint8Array(32).fill(9) });
        const result = fetchAccountEncryptionCurrentnessFromServer({ token, serverBaseUrl: origin });
        const failure = await result.catch((error: unknown) => error);
        expect(paths).toEqual(['/v1/account/encryption/currentness', '/v1/features/authenticated', '/v1/auth/challenge']);
        expect(failure)
          .toMatchObject({ code: 'credential_request_redirect_refused', retryable: false, status: 307 });
      });
    } finally {
      scope.restore(); reloadConfiguration();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it.each([302, 307, 308])('scopes credentials and secret-body replay on cross-origin HTTP %s', async status => {
    let secondHopRequests = 0;
    let secondHopAuthorization = false;
    let secondHopBodyBytes = 0;
    let firstHopRequests = 0;
    const server = createServer(async (request, response) => {
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
        let body = '';
        for await (const chunk of request) body += String(chunk);
        const accepted = request.headers.authorization === 'Bearer synthetic-account-bearer' && body === 'synthetic-claim-body';
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ accepted }));
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
        () => axios.create({ maxRedirects: 5 }).post(`${origin}/factory`, 'synthetic-claim-body', {
          maxRedirects: 5, validateStatus: () => true, headers: { Authorization: 'Bearer synthetic-account-bearer' },
        }),
        () => axios({ url: `${origin}/callable`, method: 'POST', data: 'synthetic-claim-body',
          headers: { Authorization: 'Bearer synthetic-account-bearer' } }),
        () => axios.request({ url: `${origin}/request`, method: 'POST', data: 'synthetic-claim-body',
          headers: { Authorization: 'Bearer synthetic-account-bearer' } }),
        () => axios.create({ method: 'POST', headers: { Authorization: 'Bearer synthetic-account-bearer' } })(
          `${origin}/factory-method`, { data: 'synthetic-claim-body' }),
        () => fetchWithCredentialRedirectRefusal(`${origin}/fetch`, {
          method: 'POST', headers: { Authorization: 'Bearer synthetic-account-bearer' }, body: 'synthetic-claim-body',
        }),
      ]) {
        const error = await send().then(() => null, (failure: unknown) => failure);
        if (status === 302) {
          expect(error).toBeNull();
          continue;
        }
        expect(error).toMatchObject({ code: 'credential_request_redirect_refused', retryable: false, response: { status } });
        expect(classifyServerEndpointError(error).retryable).toBe(false);
        expect(JSON.stringify(error)).not.toMatch(/synthetic-account-bearer|synthetic-claim-body|synthetic-location|second-hop/);
      }
      await expect(axios.post(`${origin}/ordinary`, 'synthetic-claim-body', {
        headers: { Authorization: 'Bearer synthetic-account-bearer' },
      })).resolves.toMatchObject({ status: 200, data: { accepted: true } });
      const ordinaryFetch = await fetchWithCredentialRedirectRefusal(`${origin}/ordinary`, {
        method: 'POST', headers: { Authorization: 'Bearer synthetic-account-bearer' }, body: 'synthetic-claim-body',
      });
      expect(await ordinaryFetch.json()).toEqual({ accepted: true });
      const parentClient = axios.create({ baseURL: origin });
      await expect(parentClient.create().get('/ordinary')).resolves.toMatchObject({ status: 200 });
      await expect(axios.get(`${origin}/not-modified`, { validateStatus: () => true,
        headers: { Authorization: 'Bearer synthetic-account-bearer' },
      })).resolves.toMatchObject({ status: 304 });
      await expect(fetchWithCredentialRedirectRefusal(`${origin}/not-modified`, {
        headers: { Authorization: 'Bearer synthetic-account-bearer' },
      })).resolves.toMatchObject({ status: 304 });
      expect(firstHopRequests).toBe(10);
      expect(secondHopRequests).toBe(status === 302 ? 5 : 0);
      expect(secondHopAuthorization).toBe(false);
      expect(secondHopBodyBytes).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('follows same-origin redirects with credentials and body, then strips credentials on bodyless cross-origin hops', async () => {
    const received: { authorization?: string; body: string }[] = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test listener');
      if (request.url === '/same') response.writeHead(307, { location: '/result' }).end();
      else if (request.url === '/cross') response.writeHead(307, { location: `http://127.0.0.2:${address.port}/result` }).end();
      else { received.push({ authorization: request.headers.authorization, body }); response.end('{}'); }
    });
    await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const client = axios.create({ baseURL: origin });
      await client.post('/same', 'synthetic-body', { headers: { Authorization: 'Bearer fixture' } });
      await client.get('/cross', { headers: { Authorization: 'Bearer fixture' } });
      expect(received).toEqual([{ authorization: 'Bearer fixture', body: 'synthetic-body' },
        { authorization: undefined, body: '' }]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
