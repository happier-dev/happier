import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { PluginServices } from '@happier-dev/plugin-sdk';
import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import { normalizePluginAccountCollectionContractV1 } from '@happier-dev/protocol/plugins/data/collectionsV1';
import { projectPluginAccountCollectionDeclaration } from '@happier-dev/plugin-sdk/collections';
import { PluginAccountCollectionContributionV1Schema } from '@happier-dev/protocol/plugins/data/collectionContributionV1';
import { createAccountPluginDataStorageHost } from '../../../../apps/cli/src/plugins/runtime/context/accountPluginDataStorage';
import { publishPluginAccountCollectionWatchInvalidation, readPluginAccountCollectionWatchInvalidations,
  retirePluginAccountCollectionWatchScope } from '../../../../apps/cli/src/plugins/runtime/context/pluginAccountSettingsChangeBroker';
import { CHANNEL_STATE_COLLECTION } from '../../../plugins/channels/src/collections';
import { createIngressCensusValue } from '../../../plugins/channels/src/ingress';
import { createIngressSupervisor } from '../../../plugins/channels/src/checkpointedPollSupervisor';
import { PLUGIN_MANIFEST } from '../../../plugins/channels/src/manifest';

interface DataServer {
  post(path: string, body: string): Promise<unknown>;
  changes(): Promise<readonly unknown[]>;
  full(collectionId: string): Promise<void>;
  close(): Promise<void>;
}
let server: DataServer;
beforeAll(async () => {
  // Server source and its aliases remain in the Server compiler program.
  const path = '../../../../apps/server/sources/testkit/pluginCollectionInvalidationServer.testkit';
  const module = await import(path) as { createPluginCollectionInvalidationServer(manifest: unknown): Promise<DataServer> };
  server = await module.createPluginCollectionInvalidationServer(PLUGIN_MANIFEST);
});
afterAll(async () => { await server?.close(); });

it('keeps checkpoint writes out of settled Channels retention and catches up members, full hints, resets and missed changes', async () => {
  const scope = 'channels-collection-invalidation';
  const lifetime = new AbortController();
  const declaration = projectPluginAccountCollectionDeclaration(CHANNEL_STATE_COLLECTION.id, CHANNEL_STATE_COLLECTION);
  const contract = normalizePluginAccountCollectionContractV1({ pluginId: 'happier.channels', contribution: PluginAccountCollectionContributionV1Schema.parse(declaration) });
  let gets = 0;
  let censusWalks = 0;
  const requests = new Set<Promise<unknown>>();
  const settle = async () => {
    do {
      await Promise.all([...requests]);
      await new Promise<void>(resolve => setImmediate(resolve));
    } while (requests.size > 0);
  };
  const host = createAccountPluginDataStorageHost({ contracts: [contract],
    readCredentials: async () => ({ token: 'constructed-http-boundary', encryption: null }),
    isCurrentAccount: () => true, resolveAccountScopeKey: () => scope, resolveBaseUrl: () => 'https://data.test',
    resolveAccountEncryptionCurrentness: async () => ({ mode: 'plain', version: 1, signingKeyFingerprint: null,
      contentKeyFingerprint: null, updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } }),
    // Only the HTTP transport is substituted. Actual Data mutations, index
    // selection, AccountChange coalescing, broker and Channels logic run.
    http: { get: async () => { throw new Error('Unexpected HTTP GET'); }, post: async (url, body) => {
      if (url.endsWith('/get')) gets += 1;
      const request = JSON.parse(body) as { prefix?: string[] };
      if (url.endsWith('/query') && request.prefix?.[0] === 'ingress-census') censusWalks += 1;
      const requestPromise = server.post(url, body);
      requests.add(requestPromise);
      try { return { status: 200, data: await requestPromise }; }
      finally { requests.delete(requestPromise); }
    } },
  });
  const account = host.bind({ pluginId: 'happier.channels', occurrenceId: 'test', signal: lifetime.signal, isOccurrenceCurrent: () => true });
  if (!account) throw new Error('Missing Data binding');
  const collection = account.collection(CHANNEL_STATE_COLLECTION);
  const censusId = 'C'.repeat(43);
  const census = createIngressCensusValue({ censusId, connectionId: 'absent-connection',
    ingress: { kind: 'fullText', observation: { v: 1, occurrenceId: 'message-1', occurredAt: 1_000,
      transport: { kind: 'poll' }, endpoint: { kind: 'direct', audience: 'direct', id: 'direct-1' },
      actor: { principalId: 'human-1', kind: 'human', isIntegrationSelf: false },
      message: { id: 'message-1', revision: '1', text: 'retained', addressingEvidence: 'none', contentProvenance: 'original', providerTimestamp: 1_000 } } },
    connectionAuthorityEpoch: 1, maximumObservationAgeMs: 60_000, matchedBindings: [], now: 1_000 });
  const payload = census.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Missing census payload');
  const value = { ...census, payload: { ...payload, phase: 'prepared' } };
  await collection.put(value, { expectedRevision: 'absent' });
  const checkpoint = { id: 'checkpoint-1', 'record-kind': 'checkpoint', v: 1, 'connection-id': 'absent-connection',
    'created-at': 1_000, 'updated-at': 1_000, payload: { authorityEpoch: 1, opaqueToken: { cursor: 'unchanged' },
      lastOccurrenceId: null, revision: 1, nextPollNotBeforeMs: null } };
  let checkpointRow = await collection.put(checkpoint, { expectedRevision: 'absent' });
  const context = { surface: 'background', invokedAtMs: 1_000, plugin: { id: 'happier.channels', version: '0.0.0' },
    contribution: { id: 'ingress-supervisor', qualifiedId: 'happier.channels/backgroundServices/ingress-supervisor' },
    signal: lifetime.signal,
    services: { storage: { account }, logger: { info() {}, warn() {} },
      events: { plugin: { emit: async () => ({ status: 'admitted', sequence: 1, subscriberCount: 0 }) } } } as unknown as PluginServices,
  } satisfies BackgroundServiceContext;
  const supervisor = createIngressSupervisor();
  const running = supervisor.run(context);
  let after = 0;
  const publish = async () => {
    const changes = await server.changes();
    for (const hint of readPluginAccountCollectionWatchInvalidations(changes.filter(change => {
      return (change as { cursor: number }).cursor > after;
    }) as Parameters<typeof readPluginAccountCollectionWatchInvalidations>[0])) {
      publishPluginAccountCollectionWatchInvalidation({ ...hint, accountScopeKey: scope });
      after = Math.max(after, hint.changeCursor);
    }
    // Drain actual transport work, including reads started by the broker's
    // microtask delivery. No timing threshold stands in for the cost count.
    await settle();
  };
  try {
    await vi.waitFor(() => expect(gets).toBeGreaterThan(0));
    await server.full(CHANNEL_STATE_COLLECTION.id);
    await publish();
    await vi.waitFor(() => expect(censusWalks).toBeGreaterThan(1));
    await settle();
    const settled = { gets, censusWalks };
    const startedAt = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    for (let minute = 0; minute < 3; minute += 1) {
      vi.setSystemTime(startedAt + (minute + 1) * 60_000);
      checkpointRow = await collection.put(checkpoint, { expectedRevision: checkpointRow.revision });
      await publish();
    }
    expect(checkpointRow.revision).toBe(4);
    expect({ gets: gets - settled.gets, censusWalks: censusWalks - settled.censusWalks }).toEqual({ gets: 0, censusWalks: 0 });
    // A genuine census-member change reaches the real retention consumer.
    await collection.put({ ...value, 'updated-at': 2_000 }, { expectedRevision: 1 });
    await publish();
    await vi.waitFor(() => expect(censusWalks - settled.censusWalks).toBe(1));
    expect(gets - settled.gets).toBe(1);
    const memberWalks = censusWalks;
    await server.full(CHANNEL_STATE_COLLECTION.id);
    await publish();
    await vi.waitFor(() => expect(censusWalks).toBe(memberWalks + 1));
    publishPluginAccountCollectionWatchInvalidation({ kind: 'reset', accountScopeKey: scope, changeCursor: after });
    await vi.waitFor(() => expect(censusWalks).toBe(memberWalks + 2));
    // Miss a relevant change followed by an unrelated checkpoint update in
    // the coalesced feed: predecessor coverage must force a broad catch-up.
    await collection.put({ ...value, 'updated-at': 3_000 }, { expectedRevision: 2 });
    checkpointRow = await collection.put(checkpoint, { expectedRevision: checkpointRow.revision });
    await publish();
    await vi.waitFor(() => expect(censusWalks).toBe(memberWalks + 3));
    // Both sides matter: leaving a watched prefix, re-entering it, and
    // deleting its last member must all invalidate exactly once.
    const moved = { gets, censusWalks };
    await collection.put({ ...checkpoint, id: censusId }, { expectedRevision: 3 });
    await publish();
    expect({ gets: gets - moved.gets, censusWalks: censusWalks - moved.censusWalks }).toEqual({ gets: 0, censusWalks: 1 });
    await collection.put(value, { expectedRevision: 4 });
    await publish();
    expect({ gets: gets - moved.gets, censusWalks: censusWalks - moved.censusWalks }).toEqual({ gets: 1, censusWalks: 2 });
    await collection.delete(censusId, { expectedRevision: 5 });
    await publish();
    expect({ gets: gets - moved.gets, censusWalks: censusWalks - moved.censusWalks }).toEqual({ gets: 1, censusWalks: 3 });
  } finally {
    lifetime.abort(); await running; await supervisor.dispose(); retirePluginAccountCollectionWatchScope(scope); vi.useRealTimers();
  }
});
