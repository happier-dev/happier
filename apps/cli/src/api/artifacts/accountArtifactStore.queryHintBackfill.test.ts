import { InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry } from "@/daemon/connectedServices/accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator";
import type { SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { decodeArtifactKindV1, ArtifactKindWriteBatchInputV1Schema } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { isApprovalArtifactKindV1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';
import { ArtifactAccessRecipientCensusResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { AccountNoticeArtifactHeaderV1Schema, AccountNoticeArtifactBodyV1Schema } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { fetchServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { encodeBase64, encryptWithDataKey } from '@/api/encryption';
import { createAccountArtifactStore, createCredentialedAccountArtifactStore } from './accountArtifactStore';
import type { StoredCredentials } from '@/persistence';

const healthSwitchContext = { credentialHealthSwitchLeases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry<import("@happier-dev/protocol").QualifiedConnectedAccountServiceRef>(), };

const source = { kind: 'plugin' as const, pluginId: 'acme.tasks', itemId: 'retained' };
const noticeBody = AccountNoticeArtifactBodyV1Schema.parse({ v: 1, source, type: 'update', resolved: false });
const noticeHeader = AccountNoticeArtifactHeaderV1Schema.parse({ ...noticeBody, kind: 'account_notice.v1', title: 'Retained', status: 'dismissed' });

async function withHome(mode: 'plain' | 'e2ee', options: Readonly<{ supported?: boolean; refused?: boolean; unreadable?: boolean; oversizedKind?: boolean;
  unreadableIndex?: number; omitNotice?: boolean; classifiedNoticeInventory?: boolean; approvalInventory?: boolean; onFeaturesRequest?(): Promise<void>;
  onUnclassifiedPage?(): void }>,
  run: (home: Readonly<{ store: ReturnType<typeof createAccountArtifactStore>; requests: string[]; batches: string[][];
    bodyReads: string[]; approvalHints: unknown[]; credentials: StoredCredentials; serverUrl: string; remaining(): number;
    featureDecisions(): number; setAccountMode(mode: 'plain' | 'e2ee'): void }>) => Promise<void>) {
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
  const credentials = { token, encryption: mode === 'plain' ? null : { type: 'legacy' as const, secret: new Uint8Array(32).fill(21) } };
  const resource = await createResourceDataKey({ credentials, mode });
  const encode = (value: unknown) => resource.mode === 'plain' ? encodePlainArtifactStoredContent(value)
    : encodeBase64(encryptWithDataKey(value, resource.dataKey));
  const rows = Array.from({ length: 1001 }, (_, index) => ({
    id: index === 700 ? 'retained-notice-700' : `legacy-${index}`,
    kind: options.approvalInventory && index === 600 ? 'v1:other:approval_request.v1'
      : options.classifiedNoticeInventory ? 'v1:other:account_notice.v1' : index % 2 === 0 ? null as string | null : 'other',
    approvalState: null as string | null,
    approvalSessionId: null as string | null,
    ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', encryptionMode: mode,
    header: (options.unreadable && index === 1000) || options.unreadableIndex === index ? 'unreadable'
      : encode(options.approvalInventory && index === 600
        // Header produced by ../0.2 UI approvalsUpdate at 01107c0e7a6b2d4b521573c6d69b53070187e76a.
        ? { v: 1, kind: 'approval_request.v1', title: 'Retained review', approvalStatus: 'executed', actionId: 'session.list',
          sessions: ['session-legacy'], sessionId: 'session-legacy' }
        : index === 700 && !options.omitNotice ? noticeHeader
        : options.classifiedNoticeInventory ? { ...noticeHeader, source: { ...source, itemId: `unrelated-${index}` } }
          : { kind: options.oversizedKind && index === 1000 ? 'x'.repeat(192) : index % 3 === 0 ? 'prompt_doc.v2' : 'ordinary.v1' }),
    body: encode({ body: index === 700 ? JSON.stringify(noticeBody) : 'Private unrelated content' }),
    dataEncryptionKey: resource.mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : resource.dataEncryptionKey,
    headerVersion: 1, bodyVersion: 1, seq: 1001 - index, createdAt: 1001 - index, updatedAt: 1001 - index,
  }));
  const requests: string[] = [];
  let accountMode = mode;
  const batches: string[][] = [];
  const bodyReads: string[] = [];
  const approvalHints: unknown[] = [];
  let featureDecisions = 0;
  const unclassified = (row: typeof rows[number]) => !decodeArtifactKindV1(row.kind).classified
    || isApprovalArtifactKindV1(decodeArtifactKindV1(row.kind).kindHint) && row.approvalState === null;
  const remaining = () => rows.filter(unclassified).length;
  const coverage = () => remaining() === 0 ? { status: 'complete', unclassifiedCount: 0 }
    : { status: 'partial', unclassifiedCount: remaining(), reason: 'unclassified_legacy_rows' };
  const wire = (row: typeof rows[number]) => {
    const decoded = decodeArtifactKindV1(row.kind);
    return { ...row, kind: decoded.kind, ...(decoded.classified ? { kindHint: decoded.kindHint } : {}) };
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    const send = (value: unknown, status = 200) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    if (url.pathname === '/v1/features') {
      await options.onFeaturesRequest?.();
      return send({ features: options.supported === false ? {} : { artifacts: { queryHints: { enabled: true } } }, capabilities: {} });
    }
    if (url.pathname === '/v1/account/encryption') return send({ mode: accountMode, updatedAt: 0 });
    if (url.pathname === '/v1/account/encryption/currentness') return send({ mode: accountMode, version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 });
    if (url.pathname === '/v1/artifacts/query-hints/batch' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const input = ArtifactKindWriteBatchInputV1Schema.parse(JSON.parse(body));
      batches.push(input.items.map(item => item.artifactId));
      return send({ items: input.items.map(item => {
        const row = rows.find(row => row.id === item.artifactId);
        if (!row || options.refused || row.headerVersion !== item.expectedHeaderVersion) return { artifactId: item.artifactId, success: false, error: 'version-mismatch' };
        row.kind = item.kind;
        const state: unknown = Reflect.get(item, 'approvalState');
        const sessionId: unknown = Reflect.get(item, 'approvalSessionId');
        if (typeof state === 'string') row.approvalState = state;
        if (typeof sessionId === 'string') row.approvalSessionId = sessionId;
        if (item.artifactId === 'legacy-600') approvalHints.push({ approvalState: state, approvalSessionId: sessionId });
        return { artifactId: item.artifactId, success: true };
      }) });
    }
    if (url.pathname === '/v1/artifacts' && request.method === 'GET') {
      expect(url.searchParams.has('includeBody')).toBe(false);
      if (url.searchParams.has('unclassified')) options.onUnclassifiedPage?.();
      const kinds: unknown = url.searchParams.has('kinds') ? JSON.parse(url.searchParams.get('kinds')!) : undefined;
      const candidates = url.searchParams.has('unclassified') ? rows.filter(unclassified)
        : Array.isArray(kinds) ? rows.filter(row => kinds.includes(decodeArtifactKindV1(row.kind).kindHint)) : rows;
      const cursor = url.searchParams.get('cursor');
      const after = cursor ? JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { updatedAt: number; id: string } : null;
      const selected = candidates.filter(row => !after || row.updatedAt < after.updatedAt || row.updatedAt === after.updatedAt && row.id < after.id)
        .slice(0, Number(url.searchParams.get('limit') ?? 500));
      const headers = selected.map(row => { const { body: _body, ...head } = wire(row); return head; });
      return send(kinds !== undefined || url.searchParams.has('unclassified')
        ? { items: headers, hasUnclassified: remaining() > 0, coverage: coverage() } : headers);
    }
    if (request.method === 'GET' && url.pathname.endsWith('/access/recipients')) {
      const row = rows.find(row => row.id === decodeURIComponent(url.pathname.split('/')[3]!));
      return row ? send(ArtifactAccessRecipientCensusResponseV1Schema.parse({ artifactId: row.id, ownerAccountId: 'owner', access: 'owner',
        encryptionMode: mode, dataEncryptionKey: row.dataEncryptionKey, callerDataEncryptionKey: row.dataEncryptionKey, recipients: [] }))
        : send({ error: 'not_found' }, 404);
    }
    if (request.method === 'GET' && url.pathname.endsWith('/revisions')) {
      const row = rows.find(row => row.id === decodeURIComponent(url.pathname.split('/')[3]!));
      return row ? send({ revisions: [{ bodyVersion: 1, body: row.body, createdAt: 1, sizeBytes: 8 }], retentionCount: 10 })
        : send({ error: 'not_found' }, 404);
    }
    if (request.method === 'POST' && url.pathname === '/v1/artifacts') {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const input: unknown = JSON.parse(body);
      return send({ id: input && typeof input === 'object' ? Reflect.get(input, 'id') : undefined,
        success: true, headerVersion: 1, bodyVersion: 1 });
    }
    if (request.method === 'POST' && url.pathname.endsWith('/restore')) {
      return send({ success: true, headerVersion: 2, bodyVersion: 2 });
    }
    if (request.method === 'GET' && url.pathname.startsWith('/v1/artifacts/')) {
      const row = rows.find(row => row.id === decodeURIComponent(url.pathname.slice('/v1/artifacts/'.length)));
      if (row) bodyReads.push(row.id);
      return row ? send(wire(row)) : send({ error: 'not_found' }, 404);
    }
    return send({ error: 'unexpected_route' }, 400);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing_address');
    const serverUrl = `http://127.0.0.1:${address.port}`;
    await runWithServerHttpBaseUrl(serverUrl, async () => {
      const input = { credentials, getAccountEncryptionMode: async () => mode,
        resolveServerFeaturesSnapshot: () => { featureDecisions++; return fetchServerFeaturesSnapshot({ serverUrl }); } };
      await run({ store: createAccountArtifactStore(input), requests, batches, bodyReads, approvalHints, credentials, serverUrl, remaining,
        featureDecisions: () => featureDecisions, setAccountMode: value => { accountMode = value; } });
    });
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

async function backfill(store: ReturnType<typeof createAccountArtifactStore>, options = { signal: new AbortController().signal }) {
  return store.backfillQueryHints(options);
}

describe('explicit daemon Account Artifact query-hint backfill', () => {
  afterEach(() => { resetServerFeaturesClientForTests(); vi.unstubAllEnvs(); });
  it.each(['plain', 'e2ee'] as const)('backfills retained %s approval state through the canonical header CAS without bodies', async mode => {
    await withHome(mode, { approvalInventory: true }, async home => {
      expect(await backfill(home.store)).toMatchObject({ status: 'complete', unclassifiedCount: 0 });
      expect(home.approvalHints).toEqual([{ approvalState: 'executed', approvalSessionId: 'session-legacy' }]);
      expect(home.bodyReads).toEqual([]);
    });
  });
  it.each(['plain', 'e2ee'] as const)('labels all 1001 %s legacy headers with one framed write, then never rewrites completed inventory', async mode => {
    await withHome(mode, {}, async home => {
      expect(await backfill(home.store)).toMatchObject({ status: 'complete', unclassifiedCount: 0 });
      expect(home.featureDecisions()).toBe(1);
      expect(home.batches).toHaveLength(1);
      expect(home.batches[0]).toHaveLength(1001);
      expect(home.bodyReads).toEqual([]);
      expect(home.requests.filter(path => path.includes('unclassified=true'))).toHaveLength(3);
      expect(home.requests.filter(path => path.includes('unclassified=true')).every(path => new URL(path.slice(4), 'http://localhost').searchParams.get('ownerAccountId') === 'owner')).toBe(true);
      expect(home.requests.filter(path => path.includes('kinds=%5B%5D'))).toHaveLength(1);
      expect(await backfill(home.store)).toMatchObject({ status: 'complete', unclassifiedCount: 0 });
      expect(home.featureDecisions()).toBe(2);
      expect(home.batches).toHaveLength(1);
      expect(home.bodyReads).toEqual([]);
      const before = home.requests.length;
      await expect(home.store.create({ noticeAccountId: 'owner', header: { ...noticeHeader, status: 'open' }, body: JSON.stringify(noticeBody) }))
        .rejects.toMatchObject({ code: 'conflict' });
      expect(home.requests.slice(before).some(path => path.includes('kinds='))).toBe(true);
      expect(home.requests.slice(before).some(path => path.includes('unclassified=true'))).toBe(false);
      expect(home.bodyReads).toEqual(['retained-notice-700']);
    });
  });
  it('returns unsupported without any discovery or hint mutation on an older Home', async () => {
    await withHome('plain', { supported: false }, async home => {
      expect(await backfill(home.store)).toMatchObject({ status: 'unsupported' });
      expect(home.batches).toEqual([]);
      expect(home.requests.filter(path => path.includes('/v1/artifacts'))).toEqual([]);
    });
  });
  it.each([false, true])('finds a retained notice beyond 500 without hint writes (supported=%s)', async supported => {
    await withHome('plain', { supported }, async home => {
      await expect(home.store.create({ noticeAccountId: 'owner', header: { ...noticeHeader, status: 'open' }, body: JSON.stringify(noticeBody) }))
        .rejects.toMatchObject({ code: 'conflict' });
      expect(home.batches).toEqual([]);
      expect(home.bodyReads).toEqual(['retained-notice-700']);
      const queries = home.requests.filter(path => path.startsWith('GET /v1/artifacts?')).map(path => new URL(path.slice(4), 'http://localhost'));
      expect(queries.some(url => url.searchParams.has('cursor'))).toBe(true);
      expect(queries.every(url => url.searchParams.get('limit') === '500')).toBe(true);
      expect(queries.some(url => url.searchParams.has('kinds'))).toBe(supported);
      expect(queries.some(url => url.searchParams.has('unclassified'))).toBe(supported);
      if (!supported) expect(queries.every(url => !url.searchParams.has('ownerAccountId'))).toBe(true);
    });
  });
  it.each([false, true])('does not infer retained-notice absence after an earlier unreadable page (supported=%s)', async supported => {
    await withHome('plain', { supported, unreadableIndex: 0, omitNotice: true, classifiedNoticeInventory: supported }, async home => {
      await expect(home.store.create({ noticeAccountId: 'owner', header: { ...noticeHeader, status: 'open' }, body: JSON.stringify(noticeBody) }))
        .rejects.toMatchObject({ code: 'artifact_content_unavailable' });
      expect(home.requests.some(path => path.includes('cursor='))).toBe(true);
      expect(home.requests.filter(path => path.startsWith('POST '))).toEqual([]);
      expect(home.bodyReads).toEqual([]);
    });
  });
  it.each([false, true])('preserves a positive retained-notice match beyond an unreadable page (supported=%s)', async supported => {
    await withHome('plain', { supported, unreadableIndex: 0, classifiedNoticeInventory: supported }, async home => {
      await expect(home.store.create({ noticeAccountId: 'owner', header: { ...noticeHeader, status: 'open' }, body: JSON.stringify(noticeBody) }))
        .rejects.toMatchObject({ code: 'conflict' });
      expect(home.requests.some(path => path.includes('cursor='))).toBe(true);
      expect(home.requests.filter(path => path.startsWith('POST '))).toEqual([]);
      expect(home.bodyReads).toEqual(['retained-notice-700']);
    });
  });
  it('rechecks Account mode after a pending restore feature request before admitting its write', async () => {
    let releaseFeature!: () => void;
    let markFeatureRequested!: () => void;
    const heldFeature = new Promise<void>(resolve => { releaseFeature = resolve; });
    const featureRequested = new Promise<void>(resolve => { markFeatureRequested = resolve; });
    await withHome('plain', { onFeaturesRequest: async () => { markFeatureRequested(); await heldFeature; } }, async home => {
      const store = createCredentialedAccountArtifactStore(home.credentials);
      const restore = store.revisions.restore({ artifactId: 'legacy-0', bodyVersion: 1, expectedRevision: { headerVersion: 1, bodyVersion: 1 } })
        .then(result => ({ result }), error => ({ error }));
      try {
        await Promise.race([featureRequested, restore.then(outcome => { throw new Error('restore completed before feature admission', { cause: outcome }); })]);
        home.setAccountMode('e2ee');
      } finally { releaseFeature(); }
      expect(await restore).toMatchObject({ error: { code: 'artifact_account_mode_mismatch' } });
      expect(home.requests.filter(path => path.startsWith('POST '))).toEqual([]);
    });
  });
  it('retains unreadable legacy membership as typed partial instead of labeling guessed content', async () => {
    await withHome('e2ee', { unreadable: true }, async home => {
      expect(await backfill(home.store)).toMatchObject({ status: 'partial', unclassifiedCount: 1 });
      expect(home.batches).toHaveLength(1);
      expect(home.batches[0]).toHaveLength(1000);
      expect(home.remaining()).toBe(1);
      expect(home.bodyReads).toEqual([]);
    });
  });
  it('returns a terminal unavailable result for refused CAS without a transport retry', async () => {
    await withHome('plain', { refused: true }, async home => {
      expect(await backfill(home.store)).toMatchObject({ status: 'unavailable', reason: 'write_refused' });
      expect(home.batches).toHaveLength(1);
      expect(home.remaining()).toBe(1001);
      expect(home.bodyReads).toEqual([]);
    });
  });
  it.each(['plain', 'e2ee'] as const)('retires %s backfill before writing when its captured Account signal aborts during pagination', async mode => {
    const lifetime = new AbortController();
    let pages = 0;
    await withHome(mode, { onUnclassifiedPage: () => { if (++pages === 3) lifetime.abort(); } }, async home => {
      expect(await home.store.backfillQueryHints({ signal: lifetime.signal }))
        .toMatchObject({ status: 'retired' });
      expect(pages).toBe(3);
      expect(home.batches).toEqual([]);
      expect(home.bodyReads).toEqual([]);
    });
  });
  it('keeps an oversized discriminator unknown instead of truncating it or blocking other labels', async () => {
    await withHome('plain', { oversizedKind: true }, async home => {
      expect(await backfill(home.store)).toMatchObject({ status: 'partial', unclassifiedCount: 1 });
      expect(home.batches).toHaveLength(1);
      expect(home.batches[0]).toHaveLength(1000);
      expect(home.remaining()).toBe(1);
      expect(home.bodyReads).toEqual([]);
    });
  });
  it('holds one refused result for the real native bootstrap lifetime without repeating it on ordinary reads', async () => {
    vi.stubEnv('HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED', 'false');
    vi.stubEnv('HAPPIER_MACHINE_TRANSFER_TAILSCALE_SERVE_ENABLED', 'false');
    const { startDaemonRuntimeBootstrap } = await import('@/daemon/startup/startDaemonRuntimeBootstrap');
    const { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } = await import('@/daemon/connectedServices/accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore');
    const { createProviderAccountUsageStore } = await import('@/daemon/connectedServices/accountUsage/store');
    await withHome('plain', { refused: true }, async home => {
      const lifetime = new AbortController();
      const unsupported = async () => { throw new Error('Connected Services disabled'); };
      const warnings: unknown[][] = [];
      const input = {
        api: {} as never, credentials: home.credentials, logger: { debug() {}, info() {}, warn(...args: unknown[]) { warnings.push(args); } },
        processEnv: { HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: 'false' },
        controlPort: 43102, machineId: 'machine', machineIdProvider: () => 'machine', runtimeId: 'artifact-backfill-bootstrap', cliVersion: '0.0.0',
        runningRuntime: { entrypoint: null, tree: null, builtAt: null, manifestVerified: false },
        startupSource: 'manual' as const, serviceLabel: undefined, daemonLogPath: '/tmp/artifact-bootstrap.log', controlToken: 'control',
        publishDaemonState: () => true, happyHomeDir: '/tmp/artifact-bootstrap-home', activeServerDir: '/tmp/artifact-bootstrap-server',
        filesystemAccessPolicy: { kind: 'osUser' as const }, publicReleaseChannel: 'dev' as const,
        connectedServicesRestartRequestedSessions: new Set<SessionTrackingKey>(), trackedSessionsByKey: new Map(),
        connectedServiceAuthGroupPreTurnSwitchCoordinator: { ...healthSwitchContext, switchBeforeTurn: unsupported, applyCommittedGeneration: unsupported, applyCredentialUpdate: unsupported },
        connectedServiceRuntimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(), providerAccountUsageStore: createProviderAccountUsageStore(),
        artifactQueryHints: { signal: lifetime.signal,
          resolveServerFeaturesSnapshot: () => fetchServerFeaturesSnapshot({ serverUrl: home.serverUrl }) },
      };
      const runtime = await startDaemonRuntimeBootstrap(input);
      let successor: Awaited<ReturnType<typeof startDaemonRuntimeBootstrap>> | undefined;
      const nextLifetime = new AbortController();
      try {
        const task = runtime.artifactQueryHintBackfill;
        expect(task).toBeInstanceOf(Promise);
        expect(await task).toMatchObject({ status: 'unavailable', reason: 'write_refused' });
        expect(home.batches).toHaveLength(1);
        // A failed terminal attempt is visible on the daemon's default warn path, exactly once.
        await Promise.resolve();
        expect(warnings.filter(([message]) => String(message).includes('[Artifacts] Query-hint backfill')))
          .toEqual([[expect.any(String), { status: 'unavailable', reason: 'write_refused' }]]);
        await home.store.list({ kinds: ['account_notice.v1'] });
        expect(await task).toMatchObject({ status: 'unavailable', reason: 'write_refused' });
        expect(runtime.artifactQueryHintBackfill).toBe(task);
        expect(home.batches).toHaveLength(1);
        lifetime.abort();
        successor = await startDaemonRuntimeBootstrap({ ...input, runtimeId: 'artifact-backfill-next-bootstrap',
          artifactQueryHints: { ...input.artifactQueryHints, signal: nextLifetime.signal } });
        const nextTask = successor.artifactQueryHintBackfill;
        expect(nextTask).not.toBe(task);
        expect(await nextTask).toMatchObject({ status: 'unavailable', reason: 'write_refused' });
        expect(home.batches).toHaveLength(2);
      } finally {
        lifetime.abort();
        nextLifetime.abort();
        await runtime.stopDirectPeerServer();
        await runtime.stopTailscaleTransferServeLifecycle();
        await successor?.stopDirectPeerServer();
        await successor?.stopTailscaleTransferServeLifecycle();
      }
    });
  });
});
