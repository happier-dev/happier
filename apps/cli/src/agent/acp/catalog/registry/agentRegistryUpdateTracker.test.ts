import { once } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { AcpCatalogRecordV1Schema, AcpCatalogRowMutationV1Schema, openAcpCatalogContentV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/registries';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot, subscribeActiveAccountSettingsKeys } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createCliRegistryUpdateCheck } from '@/registries/updates/createCliRegistryUpdateCheck';

afterEach(() => { resetActiveAccountSettingsSnapshotForTests(); vi.unstubAllGlobals(); });

describe('Agent tracker registered in the one production update checker', () => {
  it('persists strict upstream observations with CAS, preserves launch and env, and absorbs duplicate checks', async () => {
    let catalog = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{ id: 'registry-agent', name: 'registry-agent', title: 'Registry Agent',
      launch: { kind: 'uv', package: 'agent', version: '1.0', command: 'agent' }, env: { KEEP: { t: 'literal', v: 'mine' } },
      origin: { kind: 'registry', provenance: { sourceId: 'builtin:acp-registry', format: 'acp-registry',
        sourceUrl: 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json', itemId: 'agent',
        ref: { kind: 'version', version: '1.0' }, importedAt: 1 } }, createdAt: 1, updatedAt: 1 },
      { id: 'command', name: 'command', title: 'Command', launch: { kind: 'command', command: 'echo' }, createdAt: 1, updatedAt: 1 }] });
    catalog = AcpCatalogRecordV1Schema.parse({ ...catalog, definitions: [...catalog.definitions,
      { ...catalog.definitions[0], id: 'registry-peer', name: 'registry-peer' }] });
    const original = catalog;
    let revision = 1; let writes = 0; let reads = 0; let publications = 0; let race: (() => void) | undefined;
    const errors: unknown[] = [];
    // Substitute only the Home HTTP/database boundary; production mode
    // admission, catalog store, strict producer/consumer and CAS stay real.
    const http = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json');
      try {
        if (request.url === '/v1/account/encryption/currentness') response.end(JSON.stringify({ mode: 'plain', version: 1,
          settingsVersion: 7, updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null }));
        else if (request.url === '/v1/account/entity-rows/acp' && request.method === 'GET') {
          reads++;
          response.end(JSON.stringify({ status: 'present', revision, content: { t: 'plain', v: catalog } }));
        } else if (request.url === '/v1/account/entity-rows/acp' && request.method === 'POST') {
          const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const mutation = AcpCatalogRowMutationV1Schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          const concurrent = race; race = undefined; concurrent?.();
          if (mutation.expectedRevision !== revision) {
            response.statusCode = 409; response.end(JSON.stringify({ status: 'conflict', revision })); return;
          }
          const opened = openAcpCatalogContentV1({ mode: 'plain', material: null, content: mutation.content });
          if (opened.status !== 'opened') throw new Error('Bad producer content');
          catalog = opened.record; writes++;
          response.end(JSON.stringify({ status: 'updated', revision: ++revision, cursor: revision }));
        } else if (request.url === '/v1/account/entity-rows/prompt-library') {
          response.end(JSON.stringify({ status: 'listed', rows: [{ key: 'registry-sources', revision: 1, content: { t: 'plain', v: {
            key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] },
          } } }] }));
        } else if (request.url?.startsWith('/v2/account/settings/history')) response.end(JSON.stringify({ snapshots: [] }));
        else if (request.url === '/v2/account/settings') response.end(JSON.stringify({ content: { t: 'plain', v: {} }, version: 7 }));
        else { response.statusCode = 404; response.end('{}'); }
      } catch (error) { errors.push(error); response.statusCode = 500; response.end('{}'); }
    });
    http.listen(0, '127.0.0.1'); await once(http, 'listening');
    const address = http.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'tracker-account' })).toString('base64url')}.sig`, encryption: null };
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
      settingsVersion: 7, settingsSecretsReadKeys: [], loadedAtMs: 1, scopeKey: resolveAccountSettingsScopeKey(credentials) });
    const release = subscribeActiveAccountSettingsKeys({ facets: ['acpCatalog'] }, () => { publications++; });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ version: '1.0.0', agents: [{ id: 'agent', name: 'Agent',
      description: 'Agent', version: '2.0', distribution: { uvx: { package: 'agent==2.0.0', args: [] } } }] })));
    try {
      await runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, async () => {
        const checker = createCliRegistryUpdateCheck({ credentials });
        const result = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.updates.check'].parse(await checker.checkNow({ kind: 'agent' }));
        expect(result.results).toMatchObject([{ kind: 'agent', key: 'registry-agent', upstream: {
          state: 'update_available', latest: { kind: 'version', version: '2.0' },
        } }, { kind: 'agent', key: 'registry-peer', upstream: {
          state: 'update_available', latest: { kind: 'version', version: '2.0' },
        } }]);
        expect(catalog.definitions[0]).toEqual({ ...original.definitions[0], origin: {
          ...original.definitions[0]!.origin, upstream: result.results[0]!.upstream,
        } });
        expect(catalog.definitions[1]).toEqual(original.definitions[1]);
        expect(catalog.definitions[2]!.origin!.upstream).toEqual(result.results[0]!.upstream);
        expect(writes).toBe(1);
        expect(reads).toBe(2); // list plus the existing store's one CAS admission
        expect(publications).toBe(1);
        await checker.checkNow({ kind: 'agent' });
        expect(writes).toBe(1);
        expect(publications).toBe(1);
        vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('', { status: 429 })));
        const failed = await checker.checkNow({ kind: 'agent' });
        expect(failed.results[0]?.upstream.state).toBe('unchecked');
        expect(writes).toBe(1);
        vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ version: '1.0.0', agents: [{ id: 'agent', name: 'Agent',
          description: 'Agent', version: '3.0', distribution: { uvx: { package: 'agent==3.0.0', args: [] } } }] })));
        race = () => {
          const entry = original.definitions[0]!;
          catalog = AcpCatalogRecordV1Schema.parse({ ...original, definitions: [{ ...entry, title: 'Concurrent edit',
            launch: { ...entry.launch, version: '2.0' }, origin: { ...entry.origin,
              provenance: { ...entry.origin!.provenance, ref: { kind: 'version', version: '2.0' } } },
          }, original.definitions[1]] });
          revision++;
        };
        await checker.checkNow({ kind: 'agent' });
        expect(writes).toBe(1);
        expect(catalog.definitions[0]).toMatchObject({ title: 'Concurrent edit', launch: { version: '2.0' },
          origin: { provenance: { ref: { version: '2.0' } } } });
        expect(catalog.definitions[0]!.origin!.upstream).toBeUndefined();
      });
      expect(errors).toEqual([]);
    } finally { release(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); }
  });
});
