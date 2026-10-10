import axios from 'axios';
import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildConnectedServiceCredentialRecord, FeaturesResponseSchema,
  openConnectedServiceCredentialCiphertext, SealedConnectedServiceCredentialV1Schema,
} from '@happier-dev/protocol';
import { ApiClient } from '@/api/api';
import { normalizeServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import type { StoredCredentials } from '@/persistence';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { storeConnectedServiceCredentialForAccount } from './storeConnectedServiceCredentialForAccount';

const revision = 'csr_abcdefghijklmnopqrstuv';
const currentFeatures = FeaturesResponseSchema.parse({ features: {}, capabilities: {
  connectedServices: { qualifiedAccounts: { protocolVersion: 4 }, credentialDelete: { revisionGuard: true } },
} });
const releasedFeatures = FeaturesResponseSchema.parse({ features: { sharing: {
  session: { enabled: true }, public: { enabled: true }, contentKeys: { enabled: true }, pendingQueueV2: { enabled: true },
} }, capabilities: {} });
const exactOldContract = { mode: 'released_server_v0_2_1', runtimeActivity: 'legacy', pendingInput: 'released_server_v0_2_1',
  publisherAuthority: 'indeterminate', sessionConnectionEpoch: 1, socket: { connected: true } } as const;
const currentContract = { mode: 'session_sync_v2_pending_input_v1', runtimeActivity: 'v2', pendingInput: 'v1',
  publisherAuthority: 'indeterminate', sessionConnectionEpoch: 2, socket: { connected: true } } as const;
function record(token = 'secret-token') {
  return buildConnectedServiceCredentialRecord({ now: 1_000, serviceId: 'github', profileId: 'work', kind: 'token',
    token: { token, providerAccountId: null, providerEmail: null } });
}
function credentials(): StoredCredentials {
  return { token: 'happy-token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) } };
}
type Options = Readonly<{
  mode?: 'plain' | 'e2ee'; features?: unknown; featureStatus?: number;
  credential?: unknown; credentialStatus?: number; mutation?: unknown;
}>;
type Write = Readonly<{ path: string; body: unknown }>;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** Actual client codecs and storage admission; only the exact Home HTTP boundary is replaced. */
async function withHome<T>(options: Options, run: (fixture: Readonly<{
  api: ApiClient; writes: Write[]; reads: string[];
  publishFeatures(value: unknown): void; publishCredential(value: unknown): void;
}>) => Promise<T>, auth: StoredCredentials = credentials()): Promise<T> {
  resetServerFeaturesClientForTests();
  const app = fastify();
  const writes: Write[] = [];
  const reads: string[] = [];
  let features = options.features ?? currentFeatures;
  let stored = options.credential;
  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/v1/features')) expect(request.headers.authorization).toBe(`Bearer ${auth.token}`);
    if (request.method === 'GET') reads.push(request.url);
  });
  app.get('/v1/account/encryption', async () => ({ mode: options.mode ?? 'e2ee', updatedAt: 1 }));
  app.get('/v1/features', async (_request, reply) => reply.code(options.featureStatus ?? 200).send(features));
  // The current server retains guarded scalar bridges alongside qualified V4;
  // connectRoutes and its real SQLite compatibility suite establish these paths.
  for (const version of ['v2', 'v3']) {
    const path = `/${version}/connect/github/profiles/work/credential`;
    app.get(path, async (_request, reply) => {
      if (options.credentialStatus) return reply.code(options.credentialStatus).send(stored);
      return stored === undefined ? reply.code(404).send({ error: 'not-found' }) : stored;
    });
    app.post(path, async (request) => {
      writes.push({ path, body: request.body });
      return options.mutation ?? { success: true, credentialRevision: revision };
    });
  }
  await app.ready();
  // Account reads and this ApiClient's feature discovery use the resolved API
  // destination, whose localhost normalization does not change Home identity.
  const origin = new URL(normalizeServerHttpBaseUrl(configuration.apiServerUrl)).origin;
  const restore = installAxiosFastifyAdapter({ app, origin });
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.origin).toBe(origin);
    const response = await app.inject({ method: 'GET', url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
  });
  try {
    return await run({ api: await ApiClient.create(auth), writes, reads,
      publishFeatures(value) { features = value; }, publishCredential(value) { stored = value; } });
  } finally { restore(); resetServerFeaturesClientForTests(); await app.close(); }
}
function sealedBody(write: Write | undefined) {
  if (!write || !write.body || typeof write.body !== 'object') throw new Error('Expected sealed Home HTTP write');
  const body = write.body;
  if (!('sealed' in body) || !('metadata' in body)) throw new Error('Missing sealed credential body');
  return { sealed: SealedConnectedServiceCredentialV1Schema.parse(body.sealed), metadata: body.metadata };
}

describe('storeConnectedServiceCredentialForAccount', () => {
  it('does not overwrite an unsupported authoritative plaintext credential', async () => {
    await withHome({ mode: 'plain', credentialStatus: 409, credential: { error: 'connect_credential_unsupported_format' } }, async (fixture) => {
      await expect(storeConnectedServiceCredentialForAccount({ api: fixture.api, credentials: credentials(), record: record('replacement') }))
        .rejects.toMatchObject({ name: 'ConnectedServiceCredentialUnsupportedFormatError', serviceId: 'github', profileId: 'work' });
      expect(fixture.writes).toEqual([]);
    });
  });
  it('refuses a missing plaintext mutation without a qualified credential contract or Account key material', async () => {
    const auth: StoredCredentials = { token: 'token-only', encryption: null };
    await withHome({ mode: 'plain', features: releasedFeatures }, async (fixture) => {
      // A legacy Session contract does not authorize a credential mutation
      // when this Home has not declared the qualified credential contract.
      await expect(storeConnectedServiceCredentialForAccount({ api: fixture.api, credentials: auth, record: record(), serverContract: exactOldContract }))
        .rejects.toThrow('server credential mutation contract is indeterminate');
      expect(fixture.writes).toEqual([]);
      expect(fixture.reads).toContain('/v1/features');
    }, auth);
  });
  it('creates missing plaintext through the retained guarded contract without Account key material', async () => {
    const auth: StoredCredentials = { token: 'token-only', encryption: null };
    await withHome({ mode: 'plain' }, async (fixture) => {
      await expect(storeConnectedServiceCredentialForAccount({ api: fixture.api, credentials: auth, record: record() }))
        .resolves.toEqual({ revisionSemantics: 'revisioned', credentialRevision: revision });
      expect(fixture.writes).toEqual([{ path: '/v3/connect/github/profiles/work/credential', body: {
        content: { t: 'plain', v: { ...record(), oauth: null } }, expectedCredentialRevision: null,
      } }]);
    }, auth);
  });
  it('rejects a mutation response that omits the committed revision', async () => {
    await withHome({ mode: 'plain', mutation: { success: true } }, async (fixture) => {
      await expect(storeConnectedServiceCredentialForAccount({ api: fixture.api, credentials: credentials(), record: record() }))
        .rejects.toMatchObject({ code: 'connected_service_credential_revision_required' });
      expect(fixture.writes).toHaveLength(1);
    });
  });
  it.each(['current-to-old', 'old-to-current'] as const)('refreshes real feature discovery across a warm %s transition', async (direction) => {
    await withHome({ mode: 'plain', features: direction === 'current-to-old' ? currentFeatures : releasedFeatures }, async (fixture) => {
      await fixture.api.getServerFeaturesSnapshot({ refresh: true });
      fixture.publishFeatures(direction === 'current-to-old' ? releasedFeatures : currentFeatures);
      const store = storeConnectedServiceCredentialForAccount({ api: fixture.api, credentials: credentials(), record: record(),
        serverContract: direction === 'current-to-old' ? exactOldContract : currentContract });
      if (direction === 'current-to-old') {
        await expect(store).rejects.toThrow('server credential mutation contract is indeterminate');
        expect(fixture.writes).toEqual([]);
      } else {
        await expect(store).resolves.toEqual({ revisionSemantics: 'revisioned', credentialRevision: revision });
        expect(fixture.writes).toHaveLength(1);
      }
    });
  });
  it('keeps a higher Session protocol envelope on the current Connected Account write contract', async () => {
    await withHome({ mode: 'plain', features: FeaturesResponseSchema.parse({ ...currentFeatures, capabilities: {
      ...currentFeatures.capabilities, session: { runtimeActivity: { protocolVersion: 3 }, pendingInput: { protocolVersion: 2 }, publisherAuthority: { protocolVersion: 2 } },
    } }) }, async (fixture) => {
      await storeConnectedServiceCredentialForAccount({ api: fixture.api, credentials: credentials(), record: record() });
      expect(fixture.writes[0]?.body).toMatchObject({ expectedCredentialRevision: null });
    });
  });
  it.each(['ready-without-qualified-contract', 'discovery-unavailable'] as const)('fails closed before writing for %s', async (condition) => {
    await withHome({ mode: 'plain', features: releasedFeatures, ...(condition === 'discovery-unavailable' ? { featureStatus: 503 } : {}) }, async (fixture) => {
      await expect(storeConnectedServiceCredentialForAccount({ api: fixture.api, credentials: credentials(), record: record() }))
        .rejects.toThrow('server credential mutation contract is indeterminate');
      expect(fixture.writes).toEqual([]);
    });
  });
  it('reuses identical sealed bytes after an ambiguous unchanged HTTP result', async () => {
    await withHome({}, async (fixture) => {
      const post = axios.post.bind(axios);
      let first = true;
      vi.spyOn(axios, 'post').mockImplementation(async (...args) => {
        const response = await post(...args);
        if (first) { first = false; throw new Error('connection closed after request'); }
        return response;
      });
      await expect(storeConnectedServiceCredentialForAccount({ api: fixture.api, credentials: credentials(), record: record(),
        randomBytes: (length) => new Uint8Array(length).fill(4) })).resolves.toEqual({ revisionSemantics: 'revisioned', credentialRevision: revision });
      expect(fixture.writes).toHaveLength(2);
      expect(fixture.writes[0]).toEqual(fixture.writes[1]);
      expect(openConnectedServiceCredentialCiphertext({ material: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
        ciphertext: sealedBody(fixture.writes[0]).sealed.ciphertext })?.value).toMatchObject({ kind: 'token', oauth: null });
    });
  });
  it('seals the released token discriminator with real data-key Account crypto', async () => {
    const machineKey = new Uint8Array(32).fill(8);
    const auth: StoredCredentials = { token: 'happy-token', encryption: { type: 'dataKey', publicKey: new Uint8Array(32).fill(7), machineKey } };
    await withHome({}, async (fixture) => {
      await storeConnectedServiceCredentialForAccount({ api: fixture.api, credentials: auth, record: record(), randomBytes: (length) => new Uint8Array(length).fill(4) });
      expect(openConnectedServiceCredentialCiphertext({ material: { type: 'dataKey', machineKey }, ciphertext: sealedBody(fixture.writes[0]).sealed.ciphertext })?.value)
        .toMatchObject({ kind: 'token', oauth: null });
    }, auth);
  });
  it('preserves the mutation failure when its settlement HTTP read also fails', async () => {
    await withHome({}, async (fixture) => {
      const get = axios.get.bind(axios);
      let credentialReads = 0;
      vi.spyOn(axios, 'get').mockImplementation(async (...args) => {
        if (String(args[0]).includes('/credential') && ++credentialReads > 1) throw new Error('settlement read unavailable');
        return await get(...args);
      });
      const post = vi.spyOn(axios, 'post').mockRejectedValue(new Error('connection closed after request'));
      await expect(storeConnectedServiceCredentialForAccount({ api: fixture.api, credentials: credentials(), record: record() }))
        .rejects.toThrow('Failed to register connected service credential: connection closed after request');
      expect(post).toHaveBeenCalledTimes(1);
      expect(fixture.writes).toEqual([]);
    });
  });
  it.each([true, false])('settles exact committed sealed bytes with revision present=%s without a second POST', async (hasRevision) => {
    await withHome({}, async (fixture) => {
      const post = axios.post.bind(axios);
      vi.spyOn(axios, 'post').mockImplementation(async (...args) => {
        await post(...args);
        fixture.publishCredential({ ...sealedBody(fixture.writes[0]), ...(hasRevision ? { credentialRevision: revision } : {}) });
        throw new Error('connection closed after commit');
      });
      const store = storeConnectedServiceCredentialForAccount({ api: fixture.api, credentials: credentials(), record: record() });
      if (hasRevision) await expect(store).resolves.toEqual({ revisionSemantics: 'revisioned', credentialRevision: revision });
      else await expect(store).rejects.toMatchObject({ code: 'connected_service_credential_revision_required' });
      expect(fixture.writes).toHaveLength(1);
    });
  });
  it.each(['plain', 'e2ee'] as const)('refuses an existing unfenced %s credential before feature discovery or mutation', async (mode) => {
    const stored = mode === 'plain' ? { content: { t: 'plain', v: { ...record('previous'), oauth: null } } }
      : { sealed: { format: 'account_scoped_v1', ciphertext: 'old-ciphertext' }, metadata: { kind: 'token' } };
    await withHome({ mode, credential: stored }, async (fixture) => {
      await expect(storeConnectedServiceCredentialForAccount({ api: fixture.api, credentials: credentials(), record: record() }))
        .rejects.toMatchObject({ code: 'connected_service_credential_legacy_unfenced_mutation_unsupported' });
      expect(fixture.writes).toEqual([]);
      expect(fixture.reads).not.toContain('/v1/features');
    });
  });
  it('reports supersession without retry when a different revision appears during settlement', async () => {
    await withHome({}, async (fixture) => {
      const post = axios.post.bind(axios);
      const nextRevision = 'csr_bcdefghijklmnopqrstuvw';
      vi.spyOn(axios, 'post').mockImplementation(async (...args) => {
        await post(...args);
        fixture.publishCredential({ credentialRevision: nextRevision, sealed: { format: 'account_scoped_v1', ciphertext: 'other' }, metadata: { kind: 'token' } });
        throw new Error('connection closed while another writer committed');
      });
      await expect(storeConnectedServiceCredentialForAccount({ api: fixture.api, credentials: credentials(), record: record() }))
        .rejects.toMatchObject({ name: 'ConnectedServiceCredentialStorageSupersededError', reason: 'revision_mismatch', credentialRevision: nextRevision });
      expect(fixture.writes).toHaveLength(1);
    });
  });
});
