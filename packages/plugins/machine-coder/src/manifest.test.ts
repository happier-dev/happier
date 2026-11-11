import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { PLUGIN } from './manifest.js';
import { ACCOUNT_SERVICE } from './machine/schemas.js';
import { CODER_PORTABLE_ACCOUNT_RUNTIME } from './machine/connection.js';
import type { ConnectedAccountPortableAuthenticationContext } from '@happier-dev/plugin-sdk/connected-accounts';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function deployment(status = 200) {
  const paths: string[] = [];
  const server = createServer((req, res) => { paths.push(req.url!); res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url?.endsWith('/users/me') ? { id: 'user-a', username: 'alice' }
      : req.url?.endsWith('/templates') ? [{ id: 'template', name: 'Docker', organization_id: 'org', active_version_id: 'version' }]
      : req.url?.endsWith('/rich-parameters') ? [{ name: 'project', required: true, default_value: '' }]
      : { id: 'version', organization_id: 'org', template_id: 'template' })); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address');
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const endpoint = `http://127.0.0.1:${address.port}`;
  const http = { request: async (request: { url: string; method?: string; headers?: Readonly<Record<string, string>>; body?: Uint8Array; redirect?: RequestRedirect }, options?: { signal?: AbortSignal }) => {
    const response = await fetch(request.url, { ...request, signal: options?.signal });
    return { status: response.status, finalUrl: response.url, headers: Object.fromEntries(response.headers), body: new Uint8Array(await response.arrayBuffer()) };
  } };
  return { endpoint, http, paths };
}
describe('Coder public authoring entry and portable authentication', () => {
  it('runs the existing options action through the loaded declaration and selected account', async () => {
    const h = await deployment(); let materializations = 0;
    // Only the host service boundary is supplied; declaration parsing, action
    // registration, schemas, options and HTTP decoding remain real.
    const services = { http: h.http, connectedAccounts: {
      getBinding: async () => ({ account: { service: ACCOUNT_SERVICE, accountId: 'test-account' } }),
      materialize: async () => { materializations++; return { kind: 'environment', env: { CODER_URL: h.endpoint, CODER_SESSION_TOKEN: 'private-token' } }; },
    } } as unknown as PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: PLUGIN.manifest, module: PLUGIN, services });
    cleanup.push(() => kit.dispose());
    const result = await kit.invokeAction('options', { organizationId: 'org', templateId: 'template', agentName: 'main', parameterValues: [{ name: 'project', value: 'explicit' }] }, { surface: 'plugin' });
    expect(result).toMatchObject({ base: { launch: { templateVersionId: 'version', agentName: 'main', parameterValues: [{ name: 'project', value: 'explicit' }] } } });
    expect(materializations).toBe(1);
    expect(h.paths).toHaveLength(3);
  });
  it.each([200, 401])('portable token completion validates selected deployment before storing the token (%s)', async status => {
    const h = await deployment(status); const stored: string[] = [];
    const context = { signal: new AbortController().signal, configuration: { values: { endpoint: h.endpoint } },
      services: { http: h.http }, attempt: { kind: 'connect' }, attemptCredentials: { set: async (_key: string, value: string) => { stored.push(value); } },
    } as unknown as ConnectedAccountPortableAuthenticationContext;
    const mode = CODER_PORTABLE_ACCOUNT_RUNTIME.authentication.modes.token;
    if (!mode || mode.kind !== 'manual') throw new Error('Missing token authentication');
    const result = await mode.complete({ fields: { token: 'private-token' } }, context);
    expect(result.status).toBe(status === 200 ? 'connected' : 'rejected');
    expect(stored).toEqual(status === 200 ? ['private-token'] : []);
    expect(h.paths).toEqual(['/api/v2/users/me']);
    expect(JSON.stringify(result)).not.toContain('private-token');
  });
});
