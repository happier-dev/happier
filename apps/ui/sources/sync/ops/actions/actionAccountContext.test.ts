import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot, setActiveServer } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { captureActionAccountContext, captureLazyActionAccountContext } from './actionAccountContext';
import { Encryption } from '@/sync/encryption/encryption';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import { openArtifactPrivateRevisionMetadata, sealArtifactPrivateRevisionMetadata } from '@/sync/domains/artifacts/accountArtifactEnvelope';
import { createDeferred } from '@/dev/testkit';
import { encodeBase64, decodeBase64 } from '@/encryption/base64';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { computeContentPublicKeyFingerprint} from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { openEncryptedDataKeyEnvelopeV1} from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { signAccountContentKeyBindingV1 } from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';
import { ArtifactAccessActionOutputSchemasV1, ArtifactRecipientKeyEnvelopeCommitInputV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createWidgetDefinitionArtifactPortV1 } from '@happier-dev/protocol/widgets/widgetDefinitionArtifactV1';
import { createReviewRecordPortV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import type { WidgetDefinitionV1 } from '@happier-dev/protocol/widgets/widgetDefinitionV1';
import NativeAbortController from 'abort-controller';
import { createArtifact as createArtifactApi, fetchArtifact as fetchArtifactApi } from '@/sync/api/artifacts/apiArtifacts';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

// Collect the real Action graph outside the finite operation's deadline.
const { withDefaultActionExecuteContext } = await import('./defaultActionExecutor');

it.each(['inventory', 'launcher'] as const)('publishes %s catalog replies only into the captured current credential binding', async kind => {
    const inventory = await import('@/sync/domains/local/services/inventory/sharedStore');
    const launcher = await import('@/sync/domains/local/services/launch/sharedStore');
    const inventoryRpc = await import('@/sync/domains/local/services/inventory/machineRpc');
    const { resolveAuthCredentialsScopeKey } = await import('@/auth/storage/resolveAuthCredentialsScopeKey');
    // The daemon transport may deliver a reply after its Account signal was withdrawn.
    const watch = vi.spyOn(inventoryRpc, 'watchLocalServiceInventorySnapshotViaMachineRpc')
        .mockImplementation(async () => new Promise(() => {}));
    const entered = createDeferred<void>();
    const reply = createDeferred<void>();
    const transportAccounts: Array<string | null | undefined> = [];
    const inventorySnapshot = { v: 1 as const, machineId: 'catalog-machine', generatedAt: 1_500,
        refreshState: 'idle' as const, entries: [], diagnostics: [] };
    const launcherSnapshot = { v: 1 as const, machineId: 'catalog-machine', updatedAt: 2_000, targets: [] };
    const options = { runtimeActions: { localServices: {
        fetchInventorySnapshot: async (input: import('@/sync/domains/local/services/inventory/api').LocalServiceInventorySnapshotClientInput) => {
            transportAccounts.push(Reflect.get(input, 'accountId'));
            entered.resolve(); await reply.promise;
            return { ok: true as const, snapshot: { ...inventorySnapshot, generatedAt: 3_000 } };
        },
        fetchLauncherSnapshot: async (input: import('@/sync/domains/local/services/launch/api').LocalServiceLauncherSnapshotClientInput) => {
            transportAccounts.push(input.accountId);
            entered.resolve(); await reply.promise;
            return { ok: true as const, snapshot: { ...launcherSnapshot, updatedAt: 3_000 } };
        },
    } } };
    let cacheReads = 0;
    let release = () => {};
    let readVersion: () => number | null = () => null;
    const expectedInitial = kind === 'inventory' ? 1_500 : 2_000;
    const actionId = kind === 'inventory' ? 'localServices.inventory.list' : 'localServices.launcher.snapshot';
    const home = homes.homes.a!;
    const invoke = () => withDefaultActionExecuteContext(options, { serverId: home.id }, async (executor, account) => {
        const key = { machineId: 'catalog-machine', serverId: account.serverId, accountId: account.accountId,
            credentialKey: resolveAuthCredentialsScopeKey(account.credentials) };
        if (kind === 'inventory') {
            release = inventory.subscribeLocalServiceInventoryStore(key, () => {}, {
                snapshotClient: async () => { cacheReads++; return { ok: true, snapshot: inventorySnapshot }; },
                watchClient: async () => new Promise(() => {}),
            });
            readVersion = () => inventory.getLocalServiceInventoryState(key).generatedAt;
        } else {
            release = launcher.subscribeLocalServiceLauncherStore(key, () => {}, {
                snapshotClient: async () => { cacheReads++; return { ok: true, snapshot: launcherSnapshot }; },
            });
            readVersion = () => launcher.getLocalServiceLauncherState(key).updatedAt;
        }
        await vi.waitFor(() => expect(readVersion()).toBe(expectedInitial));
        // Finish the inventory's initial reconciliation before counting Action publication.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        return executor.execute(actionId, { machineId: 'catalog-machine' }, { serverId: account.serverId, surface: 'ui' });
    }, actionId);
    const stale = Promise.allSettled([invoke()]);
    try {
        await entered.promise;
        const readsBeforeReply = cacheReads;
        expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, {
            token: `e30.${Buffer.from(JSON.stringify({ sub: 'account-b' })).toString('base64url')}.signature`,
        })).toBe(true);
        reply.resolve();
        expect((await stale)[0]).toMatchObject({ status: 'rejected', reason: { code: 'action_account_scope_changed' } });
        // Actual credential retirement drops the old qualified cache; a late
        // captured reply must neither resurrect it nor start another read.
        expect(readVersion()).toBeNull();
        expect(cacheReads).toBe(readsBeforeReply);
        release();
        const current = await invoke();
        expect(current).toMatchObject({ ok: true });
        expect(readVersion()).toBe(3_000);
        expect(transportAccounts).toEqual(['account-a', 'account-b']);
    } finally {
        reply.resolve(); await stale;
        release(); watch.mockRestore();
        launcher.resetLocalServiceLauncherStoreForTests();
        inventory.resetLocalServiceInventoryStoreForTests();
    }
});

let homes: Awaited<ReturnType<typeof serveAccountHomes>>;
let accountMode: 'plain' | 'e2ee';
const network = vi.fn<(url: URL, init?: RequestInit) => Promise<Response>>();
beforeEach(async () => {
    retireActiveServerAccountScopeLifetime();
    accountMode = 'plain';
    homes = await serveAccountHomes({ homes: [
        { key: 'e', serverUrl: 'https://home-e.example.test', accountId: 'account-a', accountMode: 'e2ee',
            credentials: { token: createAccountTokenForTests('account-a'), secret: Buffer.alloc(32, 7).toString('base64url') } },
        { key: 'c', serverUrl: 'https://home-c.example.test', accountId: 'account-a' },
        { key: 'b', serverUrl: 'https://home-b.example.test', accountId: 'account-a' },
        { key: 'a', serverUrl: 'https://home-a.example.test', accountId: 'account-a' },
    ], route: () => undefined });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    network.mockReset();
    network.mockImplementation(async (url, init) => url.pathname === '/v1/account/encryption'
        ? Response.json({ mode: url.origin === 'https://home-e.example.test' ? 'e2ee' : accountMode, updatedAt: 1 }) : homes.fetch(url, init));
    setRuntimeFetch(async (input, init) => network(new URL(String(input)), init));
});
afterEach(async () => {
    retireActiveServerAccountScopeLifetime();
    publishAppliedActiveServerRuntimeAvailability(false);
    await homes?.dispose();
});

it.each(['plain', 'e2ee'] as const)('persists Review start and settlement metadata on the captured Home (%s)', async mode => {
    const home = homes.homes[mode === 'plain' ? 'b' : 'e']!;
    const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: mode });
    const reviewId = '00000000-0000-4000-8000-000000000017';
    const writes: Array<{ origin: string; payload: Record<string, unknown> }> = [];
    network.mockImplementation(async (url, init) => {
        if ((url.pathname === '/v1/artifacts' || url.pathname === `/v1/artifacts/${reviewId}`) && init?.method === 'POST') {
            writes.push({ origin: url.origin, payload: JSON.parse(String(init.body)) });
        }
        return await artifacts.handle(url.pathname, init) ?? homes.fetch(url, init);
    });
    const account = await captureLazyActionAccountContext(home.id);
    try {
        const records = createReviewRecordPortV1(account.homeHubArtifactTransport);
        const round = await records.start({ reviewId, title: 'Captured Review',
            subjectKind: 'repository', sourceKind: 'direct', reviewerIds: ['codex'], startedAt: 100 });
        expect(writes[0]).toMatchObject({ origin: home.serverUrl, payload: { reviewMetadata: {
            projectSourceId: null, workflowId: null, subjectKind: 'repository', sourceKind: 'direct',
            currentRoundOrdinal: 1, state: 'running', startedAt: 100, finishedAt: null,
        } } });
        await records.settle({ ...round, outcome: 'completed', finishedAt: 200, runs: [] });
        expect(writes[1]).toMatchObject({ origin: home.serverUrl, payload: { reviewMetadata: {
            currentRoundOrdinal: 1, state: 'completed', finishedAt: 200,
        }, expectedBodyVersion: 1 } });
        expect(await records.read(round.reviewId)).toMatchObject({ title: 'Captured Review', rounds: [
            { ordinal: 1, state: 'completed', finishedAt: 200 },
        ] });
    } finally { account.dispose(); }
});

it('retains original Account-only cleanup custody after user cancellation, but not Account retirement', async () => {
    const cancellation = new AbortController();
    const account = await captureLazyActionAccountContext(homes.homes.a!.id, cancellation.signal);
    try {
        cancellation.abort();
        expect(account.accountLifetime.isCurrent()).toBe(false);
        expect(account.accountOnlyLifetime.isCurrent()).toBe(true);
        expect(() => account.assertAccountCurrent()).not.toThrow();
        await TokenStorage.removeCredentialsForServerUrl(homes.homes.a!.serverUrl, { serverId: homes.homes.a!.id });
        expect(account.accountOnlyLifetime.isCurrent()).toBe(false);
        expect(() => account.assertAccountCurrent()).toThrow('action_account_scope_changed');
    } finally { account.dispose(); }
});

it('is a released reader only while no invocation holds its credential watch', async () => {
    const account = await captureLazyActionAccountContext(homes.homes.a!.id);
    try {
        expect(account.accountLifetime.isReleased?.()).toBe(false);
        account.dispose();
        expect(account.accountLifetime.isReleased?.()).toBe(true);
        expect(account.accountLifetime.isCurrent()).toBe(true);
        await account.runPrepared(async () => { expect(account.accountLifetime.isReleased?.()).toBe(false); });
        expect(account.accountLifetime.isReleased?.()).toBe(true);
    } finally { account.dispose(); }
});

it.each(['a', 'e'] as const)('retains captured Account authority through a same-Account bearer refresh (%s)', async homeKey => {
    const home = homes.homes[homeKey]!;
    const account = await captureLazyActionAccountContext(home.id);
    const retired = vi.fn();
    account.accountLifetime.onRetire(retired);
    const refreshed = { ...account.credentials, token: `e30.${Buffer.from(JSON.stringify({ sub: account.accountId,
        jti: 'newer-account-bearer' })).toString('base64url')}.signature` };
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
        expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, account.credentials)).toBe(true);
        expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, refreshed)).toBe(true);
        expect({ current: account.accountLifetime.isCurrent(), cleanup: account.accountOnlyLifetime.isCurrent(),
            retired: retired.mock.calls.length }).toEqual({ current: true, cleanup: true, retired: 0 });
        // Prepared approvals release listeners while idle. Their re-admission must
        // use the same credential-continuity rule as the live lifetime watcher.
        account.dispose();
        expect(logged).toHaveBeenCalledWith('[accountEncryptionCurrentness] observation ' + JSON.stringify({ event: 'action_capture_disposed' }));
        expect(account.accountLifetime.isCurrent()).toBe(true);
        await expect(account.runPrepared(async () => (await account.request('/v1/account/encryption')).status)).resolves.toBe(200);
        expect(account.credentials).not.toEqual(refreshed);
    } finally { account.dispose(); logged.mockRestore(); }
});

it.each(['removed', 'switched', 'switched-and-back'] as const)('a released reader stops reporting current after its Account leaves the Home: %s', async change => {
    const home = homes.homes.a!;
    const account = await captureLazyActionAccountContext(home.id);
    const other = { token: createAccountTokenForTests('account-b') };
    try {
        const original = account.credentials;
        account.dispose();
        expect(account.accountLifetime.isCurrent()).toBe(true);
        if (change === 'removed') await TokenStorage.removeCredentialsForServerUrl(home.serverUrl, { serverId: home.id });
        else expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, other)).toBe(true);
        if (change === 'switched-and-back') expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, original)).toBe(true);
        expect(account.accountLifetime.isCurrent()).toBe(false);
        expect(account.accountOnlyLifetime.isCurrent()).toBe(false);
        await expect(account.runPrepared(async () => 'forbidden')).rejects.toMatchObject({ code: 'action_account_scope_changed' });
    } finally { account.dispose(); }
});

it('a released reader stays current through a same-Account token refresh', async () => {
    const home = homes.homes.a!;
    const account = await captureLazyActionAccountContext(home.id);
    try {
        account.dispose();
        const refreshed = { ...account.credentials, token: account.credentials.token.replace(/\.[^.]*$/, '.refreshed-signature') };
        expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, refreshed)).toBe(true);
        expect(account.accountLifetime.isCurrent()).toBe(true);
        expect(account.accountLifetime.isReleased?.()).toBe(true);
    } finally { account.dispose(); }
});

it.each(['account', 'keys', 'authority', 'removed'] as const)('retires captured authority for a genuine credential change: %s', async change => {
    const home = homes.homes.e!;
    const account = await captureLazyActionAccountContext(home.id);
    const retired = vi.fn();
    account.accountLifetime.onRetire(retired);
    try {
        if (change === 'removed') {
            await TokenStorage.removeCredentialsForServerUrl(home.serverUrl, { serverId: home.id });
        } else {
            const next = change === 'keys' ? { ...account.credentials, secret: Buffer.alloc(32, 8).toString('base64url') }
                : { ...account.credentials, token: `e30.${Buffer.from(JSON.stringify(change === 'account'
                    ? { sub: 'account-b' } : { sub: 'account-a', session: 'restricted-terminal' })).toString('base64url')}.signature` };
            expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, next)).toBe(true);
        }
        expect({ current: account.accountLifetime.isCurrent(), cleanup: account.accountOnlyLifetime.isCurrent(),
            retired: retired.mock.calls.length }).toEqual({ current: false, cleanup: false, retired: 1 });
        await expect(account.runPrepared(async () => 'forbidden')).rejects.toMatchObject({ code: 'action_account_scope_changed' });
    } finally { account.dispose(); }
});

it.each([
    'workspace.sync.conflict.resolve', 'workspace.sync.relationship.create',
    'workspace.sync.relationship.terminate', 'workspace.sync.relationship.disable',
    'workspace.sync.relationship.enable', 'workspace.sync.relationship.flush',
] as const)('keeps the declared %s effect receipt after credential retirement while refusing new reads', async actionId => {
    const home = homes.homes.a!;
    const account = await captureLazyActionAccountContext(home.id);
    const committed = createDeferred<void>();
    const response = createDeferred<void>();
    const receipt = { v: 1, committed: true };
    const pending = account.runPrepared(async () => {
        committed.resolve();
        await response.promise;
        return receipt;
    }, getActionSpec(actionId).sideEffectClass);
    try {
        await committed.promise;
        await TokenStorage.removeCredentialsForServerUrl(home.serverUrl, { serverId: home.id });
        response.resolve();
        await expect(pending).resolves.toBe(receipt);
        await expect(account.runPrepared(async () => 'new read')).rejects.toMatchObject({ code: 'action_account_scope_changed' });
    } finally { response.resolve(); account.dispose(); }
});

it('withholds a retained read after intent abort while its Account-only cleanup still commits', async () => {
    const cancellation = new AbortController();
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
    let heldPath: string | null = null;
    let artifactId = '';
    network.mockImplementation(async (url, init) => {
        // The genuine HTTP boundary deliberately ignores the read's abort.
        if (url.pathname === heldPath) { started.resolve(); await release.promise; }
        return await artifacts.handle(url.pathname, init) ?? homes.fetch(url, init);
    });
    const pending = withDefaultActionExecuteContext({ hostActionApprovalLifetime: {
        actionId: 'workspace.files.replace.preview', signal: cancellation.signal, surface: 'ui',
    } }, { serverId: homes.homes.a!.id, signal: cancellation.signal }, async (_executor, account) => {
        artifactId = await account.createArtifact({ title: 'Pending intent' }, 'pending');
        const basis = await account.fetchArtifact(artifactId);
        if (!basis) throw new Error('Missing created Artifact');
        heldPath = `/v1/artifacts/${artifactId}`;
        const response = await account.request(heldPath);
        heldPath = null;
        await account.updateArtifact(artifactId, { title: 'Withdrawn intent' }, 'canceled', basis);
        return response.json();
    }, 'workspace.files.replace.preview');
    const settled = Promise.allSettled([pending]);
    try {
        await started.promise;
        cancellation.abort();
        release.resolve();
        const [result] = await settled;
        expect(artifacts.readPlainBody(artifactId)).toBe('canceled');
        expect(result).toMatchObject({ status: 'rejected' });
    } finally { release.resolve(); await settled; }
});

describe('captureActionAccountContext encryption authority', () => {
    it('exposes no fabricated encryption material for a Plain Account', async () => {
        const context = await captureActionAccountContext(homes.homes.a!.id);
        try {
            expect(context.encryption).toBeNull();
            expect('secret' in context.credentials || 'encryption' in context.credentials).toBe(false);
        } finally { context.dispose(); }
    });
    it('exposes the exact encryption instance resolved for the captured E2EE Home', async () => {
        const context = await captureActionAccountContext(homes.homes.e!.id);
        try {
            expect(context.encryption).toBeInstanceOf(Encryption);
            if (!context.encryption) throw new Error('Missing Account encryption');
            const value = { literal: 'original Home', binary: [0, 255, 128] };
            expect(await context.encryption.decryptRaw(await context.encryption.encryptRaw(value))).toEqual(value);
        } finally { context.dispose(); }
    });
    it('fails an E2EE Account closed when its actual credential has no encryption material', async () => {
        accountMode = 'e2ee';
        await expect(captureActionAccountContext(homes.homes.a!.id)).rejects.toThrow('Account encryption material is unavailable');
    });
});

describe('captureLazyActionAccountContext encryption on demand', () => {
    it('accepts the React Native AbortController signal without throwIfAborted', async () => {
        vi.stubGlobal('AbortController', NativeAbortController);
        const artifactId = '11111111-1111-4111-8111-111111111111';
        let stored: unknown;
        network.mockImplementation(async (url, init) => {
            if (url.pathname === '/v1/features') return Response.json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            if (url.pathname === '/v1/artifacts' && init?.method === 'POST') {
                const input: unknown = JSON.parse(String(init.body));
                if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected Artifact create object');
                stored = { ...input, ownerAccountId: 'account-a', access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
                    headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
                return Response.json(stored);
            }
            if (url.pathname === `/v1/artifacts/${artifactId}` && stored) return Response.json(stored);
            return homes.fetch(url, init);
        });
        let context: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | undefined;
        try {
            context = await captureLazyActionAccountContext(homes.homes.b!.id);
            expect('throwIfAborted' in new NativeAbortController().signal).toBe(false);
            await expect(context.resolveAccountMode()).resolves.toBe('plain');
            await expect(context.createArtifactDocument({ artifactId, header: { title: 'Native' }, body: 'Current',
                signal: new AbortController().signal })).resolves.toMatchObject({ artifactId });
            await expect(context.readArtifact(artifactId, { signal: new AbortController().signal })).resolves.toMatchObject({ body: 'Current' });
        } finally { context?.dispose(); vi.unstubAllGlobals(); }
    });
    it.each(['home', 'widget', 'widget-unknown-commit', 'ambient'] as const)('uses a fresh committed create receipt while a pre-create absence read is held (%s)', async kind => {
        const started = createDeferred<void>();
        const committed = createDeferred<void>();
        const release = createDeferred<void>();
        const artifactId = '11111111-1111-4111-8111-111111111111';
        let stored: unknown;
        let reads = 0;
        let reader: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | undefined;
        let oldRead: Promise<unknown> | undefined;
        network.mockImplementation(async (url, init) => {
            if (url.pathname === '/v1/features') return Response.json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            if (url.pathname === '/v1/artifacts' && init?.method === 'POST') {
                if (kind === 'widget' || kind === 'widget-unknown-commit') {
                    oldRead = reader!.readArtifact(artifactId);
                    await started.promise;
                }
                const input: unknown = JSON.parse(String(init.body));
                if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected Artifact create object');
                stored = { ...input, ownerAccountId: 'account-a', access: 'owner', encryptionMode: 'plain',
                    publicAudience: 'none', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
                committed.resolve();
                if (kind === 'widget-unknown-commit') return Response.json({ error: 'ack_unavailable' }, { status: 400 });
                return Response.json(stored);
            }
            if (url.pathname === `/v1/artifacts/${artifactId}/access/grants`) return Response.json({
                artifactId, ownerAccountId: 'account-a', access: 'owner', grants: [],
            });
            if (url.pathname !== `/v1/artifacts/${artifactId}`) return homes.fetch(url, init);
            reads++;
            const observed = stored;
            if (reads === (kind === 'home' || kind === 'ambient' ? 1 : 2)) { started.resolve(); await release.promise; }
            return observed ? Response.json(observed) : Response.json({ error: 'not_found' }, { status: 404 });
        });
        reader = await captureLazyActionAccountContext(homes.homes[kind === 'ambient' ? 'a' : 'b']!.id);
        const writer = await captureLazyActionAccountContext(homes.homes[kind === 'ambient' ? 'a' : 'b']!.id);
        let creation: Promise<unknown> | undefined;
        try {
            await Promise.all([reader.resolveAccountMode(), writer.resolveAccountMode()]);
            const definition: WidgetDefinitionV1 = { v: 1, id: artifactId, name: 'Committed',
                sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, inputs: { fields: [] },
                inputSchema: { type: 'object', additionalProperties: false },
                body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Current content' } } },
                provenance: { source: { kind: 'authored' }, authorAccountId: 'account-a' } };
            if (kind === 'ambient') {
                oldRead = fetchArtifactApi(reader.credentials, artifactId);
                await started.promise;
                creation = createArtifactApi(writer.credentials, { id: artifactId, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                    header: encodePlainArtifactStoredContent({ title: 'Committed' }), body: encodePlainArtifactStoredContent({ body: 'Current content' }) })
                    .then(() => fetchArtifactApi(writer.credentials, artifactId));
            } else if (kind === 'home') {
                oldRead = reader.readArtifact(artifactId);
                await started.promise;
                creation = writer.homeHubArtifactTransport.create({ artifactId, header: { title: 'Committed' }, body: 'Current content' });
            } else {
                creation = createWidgetDefinitionArtifactPortV1({ ...writer.workflowArtifacts,
                    read: async (...args) => { const row = await writer.workflowArtifacts.read(...args);
                        if (row && !row.ownerAccountId) throw new Error('Expected Artifact owner');
                        return row ? { ...row, ownerAccountId: row.ownerAccountId! } : null; },
                    list: async options => { const page = await writer.workflowArtifacts.list(options);
                        return { ...page, items: page.items.map(row => ({ ...row, ownerAccountId: row.ownerAccountId ?? '' })) }; },
                }, { accountId: 'account-a' }).create(definition);
            }
            // Assert this original promise below even if it rejects before the held-read count settles.
            void creation.catch(() => {});
            await committed.promise;
            await vi.waitFor(() => expect(reads).toBe(kind === 'home' || kind === 'ambient' ? 2 : 3));
            if (kind === 'ambient') {
                await expect(creation).resolves.toMatchObject({ id: artifactId });
            } else await expect(creation).resolves.toMatchObject(kind === 'home' ? { artifactId, body: 'Current content' } : definition);
        } finally {
            release.resolve();
            await Promise.allSettled([oldRead, creation]);
            reader.dispose(); writer.dispose();
        }
    });

    it('withdraws retired Account borrowers before a held neutral Artifact read responds', async () => {
        const started = createDeferred<AbortSignal>();
        const release = createDeferred<void>();
        const artifactId = '11111111-1111-4111-8111-111111111111';
        let reads = 0;
        network.mockImplementation(async (url, init) => {
            if (url.pathname === '/v1/features') return Response.json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            if (url.pathname !== `/v1/artifacts/${artifactId}`) return homes.fetch(url, init);
            reads++;
            if (!init?.signal) throw new Error('Expected physical read cancellation');
            started.resolve(init.signal);
            await release.promise;
            return Response.json({ id: artifactId, ownerAccountId: 'account-a', access: 'owner', encryptionMode: 'plain',
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, publicAudience: 'none',
                header: encodePlainArtifactStoredContent({ title: 'Private' }), body: encodePlainArtifactStoredContent({ body: 'Private' }),
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
        });
        const first = await captureLazyActionAccountContext(homes.homes.a!.id);
        const sibling = await captureLazyActionAccountContext(homes.homes.a!.id);
        let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
        try {
            await Promise.all([first.resolveAccountMode(), sibling.resolveAccountMode()]);
            let settled = false;
            pending = Promise.allSettled([first.readArtifact(artifactId), sibling.readArtifact(artifactId)]);
            void pending.then(() => { settled = true; });
            const physicalSignal = await started.promise;
            await TokenStorage.removeCredentialsForServerUrl(homes.homes.a!.serverUrl, { serverId: homes.homes.a!.id });
            await vi.waitFor(() => expect(settled).toBe(true));
            expect(physicalSignal.aborted).toBe(true);
            expect(reads).toBe(1);
            expect((await pending).every(result => result.status === 'rejected')).toBe(true);
        } finally {
            release.resolve();
            await pending;
            first.dispose(); sibling.dispose();
        }
    });

    it.each([false, true])('prepares Team recipient keys for current and retained content without losing committed grants on preparation failure: %s', async preparationFails => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));
        const dataKey = new Uint8Array(32).fill(52);
        const codec = new ArtifactEncryption(dataKey);
        const dataEncryptionKey = encodeBase64(await encryption.encryptEncryptionKey(dataKey));
        const artifactId = '11111111-1111-4111-8111-111111111111';
        const provenanceDataKey = new Uint8Array(32).fill(55);
        const provenanceDataEncryptionKey = encodeBase64(await encryption.encryptEncryptionKey(provenanceDataKey));
        const provenance = { savedBy: { kind: 'person' as const, accountId: 'account-a' } };
        const retainedBody = await codec.encryptBody({ body: 'Retained content' });
        const retainedProvenance = await sealArtifactPrivateRevisionMetadata({ mode: 'e2ee', artifactId, bodyVersion: 1,
            provenance, dataKey: provenanceDataKey });
        const artifact = { id: artifactId, ownerAccountId: 'account-a', access: 'owner', encryptionMode: 'e2ee',
            dataEncryptionKey, publicAudience: 'none', header: await codec.encryptHeader({ title: 'Shared document' }),
            body: await codec.encryptBody({ body: 'Current content' }), headerVersion: 1, bodyVersion: 2, seq: 1, createdAt: 1, updatedAt: 1,
            provenanceDataEncryptionKey, provenance: await sealArtifactPrivateRevisionMetadata({ mode: 'e2ee', artifactId,
                bodyVersion: 2, provenance, dataKey: provenanceDataKey }) };
        const signingSecret = new Uint8Array(32).fill(53);
        const signingPublic = ed25519.getPublicKey(signingSecret);
        const recipientSecret = new Uint8Array(32).fill(54);
        const recipientPublic = x25519.getPublicKey(recipientSecret);
        const fingerprint = computeContentPublicKeyFingerprint(recipientPublic);
        const signature = signAccountContentKeyBindingV1({ accountSigningSecretKey: new Uint8Array([...signingSecret, ...signingPublic]),
            contentPublicKey: recipientPublic });
        const recipient = { recipientAccountId: 'recipient', contentKey: { status: 'available',
            accountSigningPublicKey: Buffer.from(signingPublic).toString('hex'), contentPublicKey: encodeBase64(recipientPublic),
            contentPublicKeySignature: encodeBase64(signature) }, contentPublicKeyFingerprint: fingerprint,
            encryptedDataKey: null, encryptedProvenanceDataKey: null, recipientContentPublicKeyFingerprint: null };
        const oldReadStarted = createDeferred<void>();
        const releaseOldRead = createDeferred<void>();
        let granted = false;
        let reads = 0;
        let prepared = 0;
        let failPreparation = preparationFails;
        network.mockImplementation(async (url, init) => {
            const path = url.pathname;
            if (path === '/v1/features') return Response.json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            if (path === `/v1/artifacts/${artifactId}/access/grants` && init?.method === 'PUT') {
                expect(JSON.parse(String(init.body))).toMatchObject({ principal: { kind: 'team', teamId: 'move-team' }, accessLevel: 'admin' });
                granted = true;
                return Response.json({ artifactId, ownerAccountId: 'account-a', access: 'owner', changed: true, grants: [{
                    principal: { kind: 'team', teamId: 'move-team' }, accessLevel: 'admin', createdByAccountId: 'account-a',
                    createdAt: 1, display: { name: null },
                }] });
            }
            if (path === '/v1/artifacts/read') {
                reads++;
                const census = { artifactId, ownerAccountId: 'account-a', access: 'owner', encryptionMode: 'e2ee',
                    dataEncryptionKey, callerDataEncryptionKey: dataEncryptionKey,
                    provenanceDataEncryptionKey, callerProvenanceDataEncryptionKey: provenanceDataEncryptionKey,
                    recipients: granted ? [recipient] : [] };
                if (reads === 1) { oldReadStarted.resolve(); await releaseOldRead.promise; }
                return Response.json({ items: [{ artifactId, ok: true, artifact, recipientCensus: census }] });
            }
            if (path === `/v1/artifacts/${artifactId}/access/key-envelopes`) {
                if (failPreparation) return Response.json({ error: 'artifact_access_unavailable' }, { status: 503 });
                const commit = ArtifactRecipientKeyEnvelopeCommitInputV1Schema.parse(JSON.parse(String(init?.body)));
                expect(commit.recipientKeyEnvelopes.map(item => item.recipientAccountId)).toEqual(['recipient']);
                const recipientKey = openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(commit.recipientKeyEnvelopes[0]!.encryptedDataKey),
                    recipientSecretKeyOrSeed: recipientSecret });
                expect(recipientKey).toEqual(dataKey);
                const recipientProvenanceKey = openEncryptedDataKeyEnvelopeV1({
                    envelope: decodeBase64(commit.recipientKeyEnvelopes[0]!.encryptedProvenanceDataKey!),
                    recipientSecretKeyOrSeed: recipientSecret });
                expect(recipientProvenanceKey).toEqual(provenanceDataKey);
                expect(await new ArtifactEncryption(recipientKey!).decryptBody(retainedBody)).toEqual({ body: 'Retained content' });
                expect(await openArtifactPrivateRevisionMetadata({ mode: 'e2ee', artifactId, bodyVersion: 1,
                    provenance: retainedProvenance, dataKey: recipientProvenanceKey })).toEqual(provenance);
                prepared++;
                return Response.json({ appliedRecipientAccountIds: ['recipient'], skippedRecipientAccountIds: [] });
            }
            return homes.fetch(url, init);
        });
        const reader = await captureLazyActionAccountContext(homes.homes.e!.id);
        const writer = await captureLazyActionAccountContext(homes.homes.e!.id);
        let oldRead: Promise<unknown> | undefined;
        let grant: Promise<unknown> | undefined;
        try {
            await Promise.all([reader.resolveAccountEncryption(), writer.resolveAccountEncryption()]);
            oldRead = reader.readArtifact(artifactId);
            await oldReadStarted.promise;
            grant = writer.artifactAccessGrants.set({ artifactId, principal: { kind: 'team', teamId: 'move-team' }, accessLevel: 'admin' });
            await expect(grant).resolves.toMatchObject({ changed: true,
                ...(preparationFails ? { preparation: { status: 'pending' } } : {}) });
            expect(reads).toBe(2);
            const receipt = ArtifactAccessActionOutputSchemasV1['artifact.access.grants.set'].parse(await grant);
            expect(receipt.changed).toBe(true);
            expect(granted).toBe(true);
            if (preparationFails) {
                // A committed grant does not make a failed content read authoritative.
                await expect(writer.readArtifact(artifactId, { fresh: true })).rejects.toBeDefined();
                failPreparation = false;
                await expect(writer.readArtifact(artifactId, { fresh: true })).resolves.toMatchObject({ isDecrypted: true });
            }
            expect(prepared).toBe(1);
        } finally {
            releaseOldRead.resolve();
            await Promise.allSettled([oldRead, grant]);
            reader.dispose(); writer.dispose();
        }
    });

    it('returns committed self-revocation without opening the now-inaccessible Artifact', async () => {
        const revoked = { artifactId: 'artifact', ownerAccountId: 'owner', access: null, grants: [], changed: true };
        network.mockImplementation(async (url, init) => url.pathname.startsWith('/v1/artifacts/')
            ? init?.method === 'DELETE' ? Response.json(revoked) : Response.json({ error: 'Artifact not found' }, { status: 404 })
            : homes.fetch(url, init));
        const context = await captureLazyActionAccountContext(homes.homes.a!.id);
        try {
            await expect(context.artifactAccessGrants.remove({ artifactId: 'artifact', principal: { kind: 'account', accountId: 'account-a' } })).resolves.toEqual(revoked);
            const artifactCalls = network.mock.calls.filter(([url]) => url.pathname.startsWith('/v1/artifacts/'));
            expect(artifactCalls).toHaveLength(1);
            expect(artifactCalls[0]?.[1]?.method).toBe('DELETE');
            expect(storage.getState().artifacts.artifact).toBeUndefined();
        } finally { context.dispose(); }
    });
    it('binds the Home and Account without reading the encryption mode or deriving keys', async () => {
        const context = await captureLazyActionAccountContext(homes.homes.e!.id);
        try {
            expect(context.accountId).toBe('account-a');
            const encryptionReads = () => network.mock.calls.filter(([url]) =>
                url.origin === 'https://home-e.example.test' && url.pathname === '/v1/account/encryption');
            expect(encryptionReads()).toHaveLength(0);
            const first = await context.resolveAccountEncryption();
            expect(await context.resolveAccountEncryption()).toBe(first);
            expect(first.accountMode).toBe('e2ee');
            expect(first.encryption).toBeInstanceOf(Encryption);
            expect(encryptionReads()).toHaveLength(1);
        } finally { context.dispose(); }
    });
    it('waits for the Home to be reachable again instead of re-requesting the mode during an outage', async () => {
        const { readAccountEncryptionModeReadiness } = await import('@/sync/api/account/apiAccountEncryptionMode');
        let offline = true;
        network.mockImplementation(async (url, init) => {
            if (offline && url.origin === 'https://home-a.example.test') throw new TypeError('Failed to fetch');
            return url.pathname === '/v1/account/encryption' ? Response.json({ mode: accountMode, updatedAt: 1 }) : homes.fetch(url, init);
        });
        const modeReads = () => network.mock.calls.filter(([url]) =>
            url.origin === 'https://home-a.example.test' && url.pathname === '/v1/account/encryption').length;
        const context = await captureLazyActionAccountContext(homes.homes.a!.id);
        try {
            // The mounted readiness owner retries forever; while the Home is down
            // it must not turn into a request loop against the unreachable Home.
            const ready = readAccountEncryptionModeReadiness(() => context.resolveAccountMode(), () => true);
            await new Promise((resolve) => setTimeout(resolve, 2_000));
            expect(modeReads()).toBeLessThanOrEqual(1);
            offline = false;
            await expect(ready).resolves.toBe('plain');
            expect(modeReads()).toBeLessThanOrEqual(2);
        } finally { context.dispose(); }
    }, 60_000);
    it('fails a mode-dependent operation closed when the Account encryption mode cannot be read', async () => {
        network.mockImplementation(async (url, init) => {
            if (url.pathname === '/v1/account/encryption') throw new Error('encryption_mode_unavailable');
            return homes.fetch(url, init);
        });
        const context = await captureLazyActionAccountContext(homes.homes.a!.id);
        try {
            await expect(context.resolveAccountEncryption()).rejects.toThrow('encryption_mode_unavailable');
            await expect(context.fetchArtifact('artifact-a')).rejects.toThrow('encryption_mode_unavailable');
            expect(network.mock.calls.filter(([url]) => url.pathname.startsWith('/v1/artifacts/'))).toHaveLength(0);
        } finally { context.dispose(); }
    });
});

describe('captureActionAccountContext transport authority', () => {
    it('keeps caller cancellation for a dispatched mutation', async () => {
        const cancellation = new AbortController();
        network.mockImplementation(async (url, init) => {
            if (url.pathname !== '/v1/artifacts' || init?.method !== 'POST') return homes.fetch(url, init);
            cancellation.abort();
            init.signal?.throwIfAborted();
            return Response.json({ committed: true });
        });
        const context = await captureLazyActionAccountContext(homes.homes.a!.id, cancellation.signal);
        try {
            await expect(context.request('/v1/artifacts', { method: 'POST', body: '{}' })).rejects.toMatchObject({ name: 'AbortError' });
        } finally { context.dispose(); }
    });
    it('preserves a mutation acknowledgement when retirement arrives during the response', async () => {
        const response = Response.json({ committed: true });
        network.mockImplementation(async (url, init) => {
            if (url.pathname !== '/v1/artifacts' || init?.method !== 'POST') return homes.fetch(url, init);
            await TokenStorage.removeCredentialsForServerUrl(homes.homes.a!.serverUrl, { serverId: homes.homes.a!.id });
            // Real fetch rejects an aborted request before delivering its acknowledgement.
            init.signal?.throwIfAborted();
            return response;
        });
        const context = await captureLazyActionAccountContext(homes.homes.a!.id);
        try {
            await expect(context.request('/v1/artifacts', { method: 'POST', body: '{}' })).resolves.toBe(response);
            expect(context.accountLifetime.isCurrent()).toBe(false);
            await expect(context.request('/v1/artifacts', { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'action_account_scope_changed' });
        } finally { context.dispose(); }
    });
    it('does not return read content when its Account retires while awaiting the response', async () => {
        const path = '/v1/artifacts/11111111-1111-4111-8111-111111111111';
        network.mockImplementation(async (url, init) => {
            if (url.pathname !== path) return homes.fetch(url, init);
            await TokenStorage.removeCredentialsForServerUrl(homes.homes.a!.serverUrl, { serverId: homes.homes.a!.id });
            return Response.json({ private: true });
        });
        const context = await captureLazyActionAccountContext(homes.homes.a!.id);
        try { await expect(context.request(path)).rejects.toMatchObject({ code: 'action_account_scope_changed' }); }
        finally { context.dispose(); }
    });
    it('does not retire the mounted Home lifetime while the next Home is only staged', async () => {
        const mountedA = captureActiveServerAccountScopeLifetime();
        expect(mountedA?.isCurrent()).toBe(true);
        await setActiveServer({ serverId: homes.homes.b!.id });
        const stagedB = await captureLazyActionAccountContext(homes.homes.b!.id);
        const appliedA = await captureLazyActionAccountContext(homes.homes.a!.id);
        try {
            expect(captureActiveServerAccountScopeLifetime()).toBe(mountedA);
            expect(() => appliedA.assertCurrent()).not.toThrow();
            storage.setState({ profileScope: { serverId: homes.homes.b!.id, accountId: 'account-a' } });
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
            const establishedB = await captureLazyActionAccountContext(homes.homes.b!.id);
            try {
                await setActiveServer({ serverId: homes.homes.a!.id });
                expect(() => establishedB.assertCurrent()).not.toThrow();
                publishAppliedActiveServerRuntimeAvailability(false);
                expect(() => establishedB.assertCurrent()).not.toThrow();
                await TokenStorage.removeCredentialsForServerUrl(homes.homes.b!.serverUrl, { serverId: homes.homes.b!.id });
                expect(() => establishedB.assertCurrent()).toThrow('action_account_scope_changed');
            } finally { establishedB.dispose(); }
        } finally { stagedB.dispose(); appliedA.dispose(); }
    });
    it('keeps applied, staged, and background Homes on their scoped target transport during a focus switch', async () => {
        await setActiveServer({ serverId: homes.homes.b!.id });
        const contexts = await Promise.all(['a', 'b', 'c'].map(key => captureLazyActionAccountContext(homes.homes[key]!.id)));
        try {
            await Promise.all(contexts.map((context, i) => context.request('/action-' + i)));
            expect(network.mock.calls.filter(([url]) => url.pathname.startsWith('/action-')).map(([url]) => url.origin).sort())
                .toEqual(['https://home-a.example.test', 'https://home-b.example.test', 'https://home-c.example.test']);
            expect(network.mock.calls.filter(([url]) => url.pathname.startsWith('/action-')).every(([, init]) => new Headers(init?.headers).get('Authorization')?.startsWith('Bearer '))).toBe(true);
        } finally { contexts.forEach(context => context.dispose()); }
    });
});
