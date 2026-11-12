import { afterEach, expect, it, vi } from 'vitest';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { encodeBase64 } from '@/encryption/base64';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { answerAttemptTransaction, prepareAuthenticationInventory } from '@/dev/testkit/fixtures/connectedAccountAuthentication';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';

const packaged = vi.hoisted(() => ({
    artifacts: [] as unknown[], declarations: [] as unknown[], files: new Map<number, Uint8Array>(), reads: 0,
}));
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
// Packaged inventory and native asset IO are the boundaries. The universal
// compiler, availability, executable index, SDK activation and Actions stay real.
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
    get BUNDLED_PLUGIN_UI_APP_ARTIFACTS() { return packaged.artifacts; },
    get BUNDLED_PLUGIN_UI_APP_DECLARATIONS() { return packaged.declarations; },
    BUNDLED_PLUGIN_BRAND_MARKS: [], BUNDLED_PLUGIN_PACKAGED_RESOURCES: [],
}));
vi.mock('expo-asset', () => ({ Asset: { fromModule: (asset: number) => ({ localUri: `file:///auth-fixture/${asset}`, downloadAsync: async () => {} }) } }));
vi.mock('expo-file-system', () => ({ File: class {
    exists = true;
    constructor(private readonly uri: string) {}
    async bytes() {
        packaged.reads += 1;
        const bytes = packaged.files.get(Number(this.uri.split('/').at(-1)));
        if (!bytes) throw new Error('Missing packaged Codex authentication artifact');
        return bytes;
    }
} }));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;

afterEach(async () => {
    const { getInstalledPluginUiClientExecutableComposition } = await import('@/components/plugins/reactNative/clientExecutableContributions');
    await getInstalledPluginUiClientExecutableComposition().unload();
    await connection?.dispose();
    connection = undefined;
    await homes.reset();
    vi.restoreAllMocks();
    vi.useRealTimers();
    packaged.reads = 0;
});

async function prepareCodexInventory() {
    const { PLUGIN_MANIFEST } = await import('../../../../../../packages/plugins/codex/src/manifest');
    const descriptor = PLUGIN_MANIFEST.contributes.connectedAccountDescriptors?.find(value => value.id === 'openai-codex');
    const target = descriptor?.authentication.account;
    expect(target).toBeDefined();
    if (!descriptor || !target) throw new Error('Codex Account authentication declaration is missing');
    await prepareAuthenticationInventory(packaged, { manifest: PLUGIN_MANIFEST, target,
        projectPath: 'packages/plugins/codex', entryPath: 'packages/plugins/codex/src/connectedAccounts/account.ts',
        packageName: '@happier-dev/plugins-codex' });
    return { service: { pluginId: PLUGIN_MANIFEST.id, localId: descriptor.id }, descriptor };
}

// The packaged app inventory is immutable for this loaded process. Compile
// both Account and configuration graphs before timing authentication work.
const codexInventory = await prepareCodexInventory();

it.each([{ mode: 'plain', surface: 'ui' }, { mode: 'e2ee', surface: 'agent' }] as const)(
    'signs in through the actual Codex Account artifact and fresh $surface Actions with no Machine ($mode)', async ({ mode, surface }) => {
    const { service } = codexInventory;
    const { OPENAI_CODEX_OAUTH_PROFILE } = await import('@happier-dev/protocol/agents/codex/oauth-profile');
    const { QualifiedConnectedAccountCredentialMutationV4Schema, QualifiedConnectedAccountCredentialSnapshotV4Schema } =
        await import('@happier-dev/protocol/connect/qualifiedConnectedAccountsV4');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { replacePluginAccountAvailabilityProjection, readPluginAccountAvailability } = await import('@/sync/domains/plugins/availability/projection');
    const { reconcileProjectedPluginUiClientExecutables } = await import('@/components/plugins/reactNative/clientExecutableActivation');
    const { createPluginUiCommonJsLoaderBackend } = await import('@/components/plugins/reactNative/commonJsLoaderBackend');
    const { decideApprovalAsInbox } = await import('@/dev/testkit/harness/approvalInbox');
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const { createUiConnectedAccountCredentialPersistence } = await import('./connectedAccountCredentialPersistence');
    const accountId = `codex-${mode}`;
    const credentials = { token: createAccountTokenForTests(accountId),
        ...(mode === 'e2ee' ? { secret: encodeBase64(new Uint8Array(32).fill(29), 'base64url') } : {}) };
    const url = `https://codex-auth-${mode}.test`;
    const serverId = await homes.addHome({ name: 'Codex auth', serverUrl: url, accountId, credentials, accountEncryptionMode: mode });
    if (mode === 'e2ee') {
        const { createAccountEncryptionCurrentnessFixtureForCredentials } = await import('@/dev/testkit/fixtures/accountEncryptionCurrentness');
        homes.answer(serverId, '/v1/account/encryption/currentness', {
            body: createAccountEncryptionCurrentnessFixtureForCredentials(credentials),
        });
    }
    const sentinel = 'codex-auth-fixture-sensitive-token';
    const tokenPayload = encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'provider-account', email: 'fixture@example.test',
        'https://api.openai.com/auth': { chatgpt_account_id: 'provider-account' } })), 'base64url');
    const idToken = `e30.${tokenPayload}.signature`;
    const transactions: Parameters<typeof answerAttemptTransaction>[2] = new Map();
    const saved: { current: ReturnType<typeof QualifiedConnectedAccountCredentialSnapshotV4Schema.parse> | null } = { current: null };
    let vendorPolls = 0;
    let exchanges = 0;
    let writes = 0;
    let machineReads = 0;
    const bootstrapMachineRead = createDeferred<void>();
    const observations: unknown[][] = [];
    for (const method of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation((...values) => { observations.push(values); });
    connection = await restoreServerAccountForTest({ serverUrl: url, accountId, credentials,
        additionalRequestOrigins: [OPENAI_CODEX_OAUTH_PROFILE.authBaseUrl],
        configureSocket: socket => {
            configureConnectedServerSocketBoundary(socket);
            vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event: string) => {
                if (event.includes('rpc')) throw new Error('Portable authentication must not invoke Machine RPC');
                return { ok: true };
            });
        },
        request: async (input, init) => {
            const request = new URL(String(input));
            const method = init?.method ?? 'GET';
            if (request.href === OPENAI_CODEX_OAUTH_PROFILE.device.userCodeUrl) {
                return Response.json({ device_auth_id: 'device-id', user_code: 'CODE-X', interval: 1, expires_in: 600 });
            }
            if (request.href === OPENAI_CODEX_OAUTH_PROFILE.device.tokenUrl) {
                vendorPolls += 1;
                return vendorPolls < 3 ? Response.json({}, { status: 403 })
                    : Response.json({ authorization_code: 'approved-code', code_verifier: 'v'.repeat(43) });
            }
            if (request.href === OPENAI_CODEX_OAUTH_PROFILE.tokenUrl) {
                exchanges += 1;
                return Response.json({ access_token: sentinel, refresh_token: `${sentinel}-refresh`, id_token: idToken, expires_in: 3600 });
            }
            if (request.pathname.startsWith('/v1/machines')) {
                machineReads += 1;
                if (request.pathname === '/v1/machines') bootstrapMachineRead.resolve();
                return Response.json([]);
            }
            const transaction = await answerAttemptTransaction(request, init, transactions);
            if (transaction) return transaction;
            if (request.pathname === '/v4/connect/qualified/credential') {
                if (method === 'GET') return saved.current ? Response.json(saved.current)
                    : Response.json({ error: 'connect_credential_not_found' }, { status: 404 });
                const mutation = QualifiedConnectedAccountCredentialMutationV4Schema.parse(await new Response(init?.body).json());
                writes += 1;
                saved.current = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: mutation.ref,
                    authenticationModeId: mutation.authenticationModeId, revisionSemantics: 'revisioned',
                    credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationRevision: null,
                    content: mutation.content, metadata: mutation.metadata });
                // Commit then lose the ACK. Recovery must reopen this exact
                // envelope rather than exchange or write the token again.
                throw new TypeError('Fixture response lost after credential commit');
            }
            return await homes.request(input, init);
        } });
    await bootstrapMachineRead.promise;
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Missing restored Account lifetime');
    replacePluginAccountAvailabilityProjection({ scope: lifetime.scope,
        snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
    const reader = readPluginAccountAvailability(lifetime.scope);
    const admission = await reader.ensureCurrentAccountExecution(service.pluginId);
    expect(admission.kind).toBe('available');
    const projection = reader.readAccountUiProjection();
    if (!projection) throw new Error('Missing Account projection');
    const executableInput = { actionProjection: { projection }, platform: 'web' as const,
        reader, accountLifetime: lifetime, loaderBackend: createPluginUiCommonJsLoaderBackend() };
    await reconcileProjectedPluginUiClientExecutables(executableInput);
    expect(packaged.reads).toBe(0);
    machineReads = 0;
    const context = { surface, authority: surface === 'ui' ? 'present_user' as const : 'account_automation' as const,
        serverId, expectedAccountId: accountId,
        ...(surface === 'agent' ? { actionCaller: { kind: 'host' as const }, actionRequestId: 'codex-device-agent-sign-in' } : {}) };
    let approvals = 0;
    const executor = () => createDefaultActionExecutor({ onBlockingApprovalPending: async ({ artifactId }) => {
        approvals += 1;
        expect(vendorPolls).toBe(0);
        expect(await decideApprovalAsInbox(serverId, artifactId, 'approve')).toMatchObject({ ok: true });
    } });
    if (surface === 'agent') {
        const { PUBLIC_ACTION_OUTPUT_SCHEMAS } = await import('@happier-dev/protocol/actions/actionSpecs');
        for (const id of ['connectedServices.authentication.beginConnect', 'connectedServices.authentication.pollDevice']) {
            const discovery = await executor().execute('action.spec.get', { id }, context);
            expect(discovery).toMatchObject({ ok: true });
            if (!discovery.ok) throw new Error('Authentication Action was not discoverable');
            const published = PUBLIC_ACTION_OUTPUT_SCHEMAS['action.spec.get'].parse(discovery.result).actionSpec;
            expect(published).not.toBeNull();
            if (id.endsWith('pollDevice')) expect(published?.inputSchema).not.toHaveProperty('properties.machineId');
        }
    }
    const begin = await executor().execute('connectedServices.authentication.beginConnect', { service, modeId: 'device' }, context);
    const diagnostic = begin.ok && begin.result && typeof begin.result === 'object'
        ? { ok: true, ...('status' in begin.result ? { status: begin.result.status } : {}), ...('code' in begin.result ? { code: begin.result.code } : {}) }
        : { ok: begin.ok, ...('errorCode' in begin ? { code: begin.errorCode } : {}) };
    expect(diagnostic).toEqual({ ok: true, status: 'awaitingDeviceAuthorization' });
    if (!begin.ok || !begin.result || typeof begin.result !== 'object' || !('attemptId' in begin.result)
        || typeof begin.result.attemptId !== 'string') throw new Error('Missing begun device attempt');
    const attemptId = begin.result.attemptId;
    expect(transactions.size).toBe(1);
    // A new registration has a new shared attempt owner: the next Action must
    // restore the acknowledged opaque transaction, not borrow process memory.
    const { getInstalledPluginUiClientExecutableComposition } = await import('@/components/plugins/reactNative/clientExecutableContributions');
    await getInstalledPluginUiClientExecutableComposition().unload();
    await reconcileProjectedPluginUiClientExecutables(executableInput);
    vi.useFakeTimers({ toFake: ['Date'] });
    let outcome: unknown;
    for (let index = 0; index < 3; index += 1) {
        vi.setSystemTime(Date.now() + 10_000);
        outcome = await executor().execute('connectedServices.authentication.pollDevice', { attemptId }, context);
        expect(outcome).toMatchObject({ ok: true, result: { status: index < 2 ? 'pending' : 'connected' } });
    }
    expect(vendorPolls).toBe(3);
    expect(exchanges).toBe(1);
    expect(writes).toBe(1);
    expect(approvals).toBe(surface === 'agent' ? 1 : 0);
    expect(machineReads).toBe(0);
    expect(JSON.stringify([begin, outcome, observations])).not.toContain(sentinel);
    expect(saved.current?.content.t).toBe(mode === 'plain' ? 'plain' : 'encrypted');
    if (!saved.current) throw new Error('Credential was not saved');
    const tested = await createDefaultActionExecutor().execute('connectedServices.accounts.testConnection',
        { account: saved.current.ref }, { surface: 'ui', serverId });
    expect(tested).toMatchObject({ ok: true, result: { status: 'unsupported' } });
    const fresh = await captureLazyActionAccountContext(serverId);
    try {
        const persistence = createUiConnectedAccountCredentialPersistence(fresh);
        if (!saved.current) throw new Error('Credential was not saved');
        const reopened = await persistence.readCredential(saved.current.ref);
        if (!reopened || reopened.authenticationModeId === null) throw new Error('Credential could not be reopened');
        const { parseQualifiedConnectedAccountCredentialPlaintextV1 } = await import('@happier-dev/protocol/connect/legacyConnectedServiceCompatibility');
        expect(parseQualifiedConnectedAccountCredentialPlaintextV1({ ref: reopened.ref,
            authenticationModeId: reopened.authenticationModeId,
            plaintext: persistence.content.open('credential', await persistence.content.resolveAccountMode(), reopened.content),
            metadata: reopened.metadata }).values).toEqual(expect.objectContaining({ accessToken: sentinel }));
    } finally { fresh.dispose(); }
});

it('completes a pasted Codex OAuth callback on a fresh encrypted Account lifetime without a Machine', async () => {
    const { service, descriptor } = codexInventory;
    const { OPENAI_CODEX_OAUTH_PROFILE } = await import('@happier-dev/protocol/agents/codex/oauth-profile');
    const { createHash } = await import('node:crypto');
    const { createAccountEncryptionCurrentnessFixtureForCredentials } = await import('@/dev/testkit/fixtures/accountEncryptionCurrentness');
    const { QualifiedConnectedAccountCredentialMutationV4Schema, QualifiedConnectedAccountCredentialSnapshotV4Schema,
        QualifiedConnectedAccountCredentialMutationSuccessV4Schema } = await import('@happier-dev/protocol/connect/qualifiedConnectedAccountsV4');
    const { captureActiveServerAccountScopeLifetime, captureActiveServerAccountScopeCurrentness } =
        await import('@/sync/domains/scope/activeServerAccountScope');
    const { replacePluginAccountAvailabilityProjection, readPluginAccountAvailability } = await import('@/sync/domains/plugins/availability/projection');
    const { reconcileProjectedPluginUiClientExecutables } = await import('@/components/plugins/reactNative/clientExecutableActivation');
    const { getInstalledPluginUiClientExecutableComposition } = await import('@/components/plugins/reactNative/clientExecutableContributions');
    const { createPluginUiCommonJsLoaderBackend } = await import('@/components/plugins/reactNative/commonJsLoaderBackend');
    const { runConnectedAccountAuthenticationAction } = await import('./connectedAccountDaemon');
    const { parseOauthCallbackUrl } = await import('@/utils/auth/oauthCore');
    const { decideApprovalAsInbox } = await import('@/dev/testkit/harness/approvalInbox');
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const { createUiConnectedAccountCredentialPersistence } = await import('./connectedAccountCredentialPersistence');
    const oauthMode = descriptor.authentication.modes.find(mode => mode.id === 'oauth');
    if (oauthMode?.kind !== 'oauthAuthorizationCode') throw new Error('Actual Codex OAuth declaration is missing');
    const accountId = 'codex-callback-e2ee';
    const credentials = { token: createAccountTokenForTests(accountId),
        secret: encodeBase64(new Uint8Array(32).fill(53), 'base64url') };
    const url = 'https://codex-callback-e2ee.test';
    const serverId = await homes.addHome({ name: 'Codex callback', serverUrl: url, accountId, credentials, accountEncryptionMode: 'e2ee' });
    homes.answer(serverId, '/v1/account/encryption/currentness', {
        body: createAccountEncryptionCurrentnessFixtureForCredentials(credentials),
    });
    const sentinel = 'codex-callback-fixture-sensitive-token';
    const authorizationCode = 'codex-callback-fixture-authorization-code';
    const tokenPayload = encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'callback-provider-account',
        email: 'callback-fixture@example.test', 'https://api.openai.com/auth': { chatgpt_account_id: 'callback-provider-account' } })), 'base64url');
    const idToken = `e30.${tokenPayload}.signature`;
    const transactions: Parameters<typeof answerAttemptTransaction>[2] = new Map();
    const saved: { current: ReturnType<typeof QualifiedConnectedAccountCredentialSnapshotV4Schema.parse> | null } = { current: null };
    const transactionRequests: Array<{ method: string; path: string; exchanges: number }> = [];
    const observations: unknown[][] = [];
    let challenge = '';
    let exchanges = 0;
    let writes = 0;
    let machineReads = 0;
    let machineRpcs = 0;
    let markMachineBootstrapRead: (() => void) | undefined;
    for (const method of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation((...values) => { observations.push(values); });
    const request: NonNullable<Parameters<typeof restoreServerAccountForTest>[0]['request']> = async (input, init) => {
        const incoming = new URL(String(input));
        const method = init?.method ?? 'GET';
        if (incoming.href === OPENAI_CODEX_OAUTH_PROFILE.tokenUrl) {
            const body = new URLSearchParams(await new Response(init?.body).text());
            expect(body.get('grant_type')).toBe('authorization_code');
            expect(body.get('code') === authorizationCode).toBe(true);
            expect(body.get('redirect_uri')).toBe(oauthMode.callbackUrl);
            const verifier = body.get('code_verifier');
            if (!verifier) throw new Error('Codex OAuth exchange omitted its PKCE verifier');
            expect(createHash('sha256').update(verifier).digest('base64url') === challenge).toBe(true);
            exchanges += 1;
            return Response.json({ access_token: sentinel, refresh_token: `${sentinel}-refresh`, id_token: idToken, expires_in: 3600 });
        }
        if (incoming.pathname.startsWith('/v1/machines')) {
            machineReads += 1;
            if (incoming.pathname === '/v1/machines') markMachineBootstrapRead?.();
            return Response.json([]);
        }
        if (incoming.pathname.startsWith('/v2/connect/connected-account-attempt-transactions/')) {
            transactionRequests.push({ method, path: incoming.pathname, exchanges });
        }
        const transaction = await answerAttemptTransaction(incoming, init, transactions);
        if (transaction) return transaction;
        if (incoming.pathname === '/v4/connect/qualified/credential') {
            if (method === 'GET') return saved.current ? Response.json(saved.current)
                : Response.json({ error: 'connect_credential_not_found' }, { status: 404 });
            const mutation = QualifiedConnectedAccountCredentialMutationV4Schema.parse(await new Response(init?.body).json());
            writes += 1;
            saved.current = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: mutation.ref,
                authenticationModeId: mutation.authenticationModeId, revisionSemantics: 'revisioned',
                credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationRevision: null,
                content: mutation.content, metadata: mutation.metadata });
            return Response.json(QualifiedConnectedAccountCredentialMutationSuccessV4Schema.parse({ success: true,
                credentialRevision: saved.current.credentialRevision, configurationRevision: null }));
        }
        return homes.request(input, init);
    };
    const restore = async () => {
        const machineBootstrapRead = new Promise<void>(resolve => { markMachineBootstrapRead = resolve; });
        connection = await restoreServerAccountForTest({ serverUrl: url, accountId, credentials,
            additionalRequestOrigins: [OPENAI_CODEX_OAUTH_PROFILE.authBaseUrl], request,
            configureSocket: socket => {
                configureConnectedServerSocketBoundary(socket);
                vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event: string) => {
                    if (event.includes('rpc')) { machineRpcs += 1; throw new Error('Codex OAuth must not invoke Machine RPC'); }
                    return { ok: true };
                });
            } });
        await machineBootstrapRead;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Missing restored Codex callback Account lifetime');
        replacePluginAccountAvailabilityProjection({ scope: lifetime.scope,
            snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
        const reader = readPluginAccountAvailability(lifetime.scope);
        expect((await reader.ensureCurrentAccountExecution(service.pluginId)).kind).toBe('available');
        const projection = reader.readAccountUiProjection();
        if (!projection) throw new Error('Missing Codex callback Account projection');
        await reconcileProjectedPluginUiClientExecutables({ actionProjection: { projection }, platform: 'web',
            reader, accountLifetime: lifetime, loaderBackend: createPluginUiCommonJsLoaderBackend() });
        // The cold Account connection, separately from authentication, reads its
        // initial Machine inventory. Each auth phase starts after that boundary.
        machineReads = 0;
        machineRpcs = 0;
        return lifetime;
    };
    const action = (command: Parameters<typeof runConnectedAccountAuthenticationAction>[0]['command']) => {
        const current = captureActiveServerAccountScopeCurrentness();
        return runConnectedAccountAuthenticationAction({ serverId, expectedAccountId: accountId, command,
            assertCurrent() { if (!current.isCurrent()) throw new Error('Codex callback Account was retired'); },
            executeAction: (actionId, input, operation) => createDefaultActionExecutor({ onBlockingApprovalPending: async ({ artifactId }) => {
                expect(await decideApprovalAsInbox(serverId, artifactId, 'approve')).toMatchObject({ ok: true });
            } }).execute(actionId, input, { surface: 'ui', authority: 'present_user', serverId,
                expectedAccountId: accountId, ...(operation?.signal ? { signal: operation.signal } : {}) }),
        });
    };
    const originalLifetime = await restore();
    const begin = await action({ operation: 'beginConnect', service, modeId: 'oauth' });
    expect({ status: begin.status, ...('code' in begin ? { code: begin.code } : {}) }).toEqual({ status: 'awaitingOAuth' });
    if (typeof begin.attemptId !== 'string') throw new Error('Missing begun Codex OAuth attempt');
    const attemptId = begin.attemptId;
    const initial = await action({ operation: 'read', attemptId, waitForProviderStart: true });
    if (initial.status !== 'awaitingOAuth' || !initial.authorizationUrl) throw new Error('Codex OAuth authorization URL is unavailable');
    expect(initial.callbackUrl).toBe(oauthMode.callbackUrl);
    const authorization = new URL(initial.authorizationUrl);
    const state = authorization.searchParams.get('state');
    challenge = authorization.searchParams.get('code_challenge') ?? '';
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    if (!state || !challenge) throw new Error('Codex OAuth did not produce its PKCE-bound state');
    expect(transactions.get(attemptId)).toMatchObject({ kind: 'oauth', content: { t: 'encrypted' } });
    expect(transactions.get(attemptId)?.scope).not.toHaveProperty('machineId');
    expect(machineReads).toBe(0);
    expect(machineRpcs).toBe(0);
    await getInstalledPluginUiClientExecutableComposition().unload();
    await connection?.dispose();
    connection = undefined;
    expect(originalLifetime.isCurrent()).toBe(false);
    const receivingLifetime = await restore();
    expect(receivingLifetime.isCurrent()).toBe(true);
    const restored = await action({ operation: 'read', attemptId, waitForProviderStart: true });
    if (restored.status !== 'awaitingOAuth' || !restored.authorizationUrl) throw new Error('The receiving Account could not restore Codex OAuth');
    expect(restored.callbackUrl).toBe(initial.callbackUrl);
    expect(new URL(restored.authorizationUrl).searchParams.get('state')).toBe(state);
    const callback = new URL(restored.callbackUrl);
    callback.searchParams.set('code', authorizationCode);
    callback.searchParams.set('state', state);
    // This is the same full-URL parser used by ConnectedAccountOAuthForm. The
    // actual Codex localhost redirect is retained rather than replaced by an app callback.
    const pasted = parseOauthCallbackUrl({ url: callback.toString(), redirectUri: restored.callbackUrl });
    if (!pasted.code || !pasted.state || pasted.error) throw new Error('The declared Codex callback could not be pasted');
    transactionRequests.length = 0;
    const complete = await action({ operation: 'completeOAuth', attemptId, completion: {
        code: pasted.code, state: pasted.state, callbackUrl: restored.callbackUrl,
        ...(pasted.iss === undefined ? {} : { iss: pasted.iss }),
    } });
    expect(complete).toMatchObject({ status: 'connected', attemptId });
    expect(exchanges).toBe(1);
    expect(writes).toBe(1);
    // R is the addressed routing read. Consumption, prepared settlement and
    // cleanup remain the existing changed transaction transitions T.
    expect(transactionRequests.filter(value => value.method === 'GET')).toEqual([{
        method: 'GET', path: `/v2/connect/connected-account-attempt-transactions/${encodeURIComponent(attemptId)}`, exchanges: 0,
    }]);
    const transitions = transactionRequests.filter(value => value.method !== 'GET');
    expect(transitions[0]).toMatchObject({ method: 'PATCH', exchanges: 0 });
    expect(transitions.some(value => value.exchanges === 1)).toBe(true);
    expect(saved.current?.content.t).toBe('encrypted');
    expect(JSON.stringify([begin, initial, restored, complete, observations])).not.toContain(sentinel);
    expect(JSON.stringify([saved.current, ...transactions.values()])).not.toContain(sentinel);
    const fresh = await captureLazyActionAccountContext(serverId);
    try {
        const persistence = createUiConnectedAccountCredentialPersistence(fresh);
        if (!saved.current) throw new Error('Codex callback credential was not saved');
        const reopened = await persistence.readCredential(saved.current.ref);
        if (!reopened || reopened.authenticationModeId === null) throw new Error('Codex callback credential could not be reopened');
        const { parseQualifiedConnectedAccountCredentialPlaintextV1 } = await import('@happier-dev/protocol/connect/legacyConnectedServiceCompatibility');
        const payload = parseQualifiedConnectedAccountCredentialPlaintextV1({ ref: reopened.ref,
            authenticationModeId: reopened.authenticationModeId,
            plaintext: persistence.content.open('credential', await persistence.content.resolveAccountMode(), reopened.content),
            metadata: reopened.metadata });
        expect(payload.values.accessToken === sentinel).toBe(true);
        expect(payload.values.refreshToken === `${sentinel}-refresh`).toBe(true);
        expect(payload.values.providerAccountId).toBe('callback-provider-account');
    } finally { fresh.dispose(); }
    expect(machineReads).toBe(0);
    expect(machineRpcs).toBe(0);
});
