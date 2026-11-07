import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';

import { handleMcpCommand } from '../mcp';
import { configuration, reloadConfiguration } from '@/configuration';
import { disableMcpStdioConsolePatch } from '@/mcp/server/mcpStdioConsolePatch';
import { writeStoredCredentialsForServerId } from '@/persistence';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { applyEphemeralServerSelectionFromPrefixArgs } from '@/server/serverSelection';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { withTempDir } from '@/testkit/fs/tempDir';

// Load the real MCP graph before the network workload, as in the daemon-pinning suite.
await import('@/mcp/createExternalMcpServer');

describe('mcp serve saved same-Home local route', () => {
  const originalEnv = process.env;

  afterEach(() => {
    disableMcpStdioConsolePatch();
    vi.unstubAllGlobals();
    resetInMemoryAccountSettingsContextForTests();
    process.env = originalEnv;
    reloadConfiguration();
  });

  it.each(['same', 'different', 'unobserved'] as const)(
    'serves only after the saved forward reports the selected Home (%s identity)',
    async (identity) => {
      await withTempDir('happier-mcp-saved-route-', async (homeDir) => {
        const canonicalUrl = 'https://canonical-home.example.test';
        const advertisedUrl = 'https://advertised-home.example.test';
        const homeIdentity = 'srv_saved_forward_home';
        const requests: Array<{ path: string; authenticated: boolean }> = [];
        const home = createServer((request, response) => {
          const path = request.url ?? '';
          requests.push({ path, authenticated: Boolean(request.headers.authorization) });
          response.setHeader('content-type', 'application/json');
          if (path === '/v1/features' || path === '/v1/features/authenticated') {
            response.end(JSON.stringify(FeaturesResponseSchema.parse({
              features: {},
              capabilities: identity === 'unobserved' ? {} : {
                serverIdentity: { serverIdentityId: identity === 'same' ? homeIdentity : 'srv_other_home' },
              },
            })));
          } else if (path === '/v2/account/settings') {
            response.end(JSON.stringify({ version: 1, content: { t: 'plain', v: {} } }));
          } else {
            response.writeHead(404).end();
          }
        });
        await new Promise<void>((resolve) => home.listen(0, '127.0.0.1', resolve));
        const address = home.address();
        if (!address || typeof address === 'string') throw new Error('Expected a TCP Home forward');
        const localServerUrl = `http://127.0.0.1:${address.port}`;
        const realFetch = globalThis.fetch;
        const unreachableRequests: string[] = [];
        // Only the network boundary is substituted; canonical/advertised origins
        // are unreachable while the saved SSH-forward equivalent serves real HTTP.
        vi.stubGlobal('fetch', (async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (url.origin !== localServerUrl) {
            unreachableRequests.push(url.origin);
            throw new TypeError('Fixture Home origin is unreachable');
          }
          return await realFetch(input, init);
        }) satisfies typeof fetch);
        process.env = { ...originalEnv, HAPPIER_HOME_DIR: homeDir };
        for (const key of ['HAPPIER_SERVER_URL', 'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL',
          'HAPPIER_WEBAPP_URL', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE']) {
          delete process.env[key];
        }
        reloadConfiguration();
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'saved-home-route', version: '1.0.0' }, { capabilities: {} });
        let connected = false;
        try {
          const profile = await addServerProfile({ name: 'forwarded-home', serverUrl: canonicalUrl,
            localServerUrl, webappUrl: canonicalUrl, use: false });
          await adoptServerProfileHomeConnectionDescriptor({
            descriptor: { v: 1, homeServerIdentityId: homeIdentity, canonicalServerUrl: canonicalUrl,
              revision: 1, endpoints: [{ kind: 'https', url: advertisedUrl }] },
            expectedProfileId: profile.id, observation: 'exact',
          });
          await writeStoredCredentialsForServerId(profile.id, { token: 'fixture-forward-credential', encryption: null });
          const persistedBefore = await readFile(join(homeDir, 'settings.json'), 'utf8');
          const resolution = await applyEphemeralServerSelectionFromPrefixArgs(['--server', profile.id, 'mcp', 'serve']);
          if (!resolution.selection) throw new Error('Expected a saved Home selection');
          const serve = handleMcpCommand(resolution.rest.slice(1), {
            // MCP stdio is a transport boundary; the server, credentials,
            // machine identity, Settings bootstrap and feature parser stay real.
            connectMcpStdio: async (server) => {
              await server.connect(serverTransport);
              connected = true;
            },
          }, resolution.selection);
          if (identity === 'same') {
            await serve;
            await client.connect(clientTransport);
            expect((await client.listTools()).tools.length).toBeGreaterThan(0);
            expect(connected).toBe(true);
            expect(configuration.serverUrl).toBe(canonicalUrl);
            expect(configuration.apiServerUrl).toBe(localServerUrl);
            expect(configuration.activeServerId).toBe(profile.id);
            const after = JSON.parse(await readFile(join(homeDir, 'settings.json'), 'utf8'));
            const before = JSON.parse(persistedBefore);
            expect(after.activeServerId).toBe(before.activeServerId);
            expect(after.servers).toEqual(before.servers);
            expect(requests).toEqual([
              { path: '/v1/features', authenticated: false },
              { path: '/v2/account/settings', authenticated: true },
              { path: '/v1/features/authenticated', authenticated: true },
            ]);
          } else {
            await expect(serve).rejects.toMatchObject({
              code: identity === 'different' ? 'identity_mismatch' : 'identity_unobserved',
            });
            expect(connected).toBe(false);
            expect(requests).toEqual([{ path: '/v1/features', authenticated: false }]);
            expect(await readFile(join(homeDir, 'settings.json'), 'utf8')).toBe(persistedBefore);
          }
          expect(unreachableRequests).toEqual([]);
        } finally {
          await client.close();
          await serverTransport.close();
          home.closeAllConnections();
          await new Promise<void>((resolve, reject) => home.close((error) => error ? reject(error) : resolve()));
        }
      });
    },
  );
});
