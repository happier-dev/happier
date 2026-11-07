import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import fastify from 'fastify';
import * as undici from 'undici';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { QualifiedConnectedAccountProfileV4Schema, QualifiedConnectedAccountCredentialSnapshotV4Schema, sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { TriageSourceCredentialInputsV1, TriageSourceConnectedAccountInputsV1 } from '@happier-dev/triage-protocol/v1';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { registerAuthoredAccountActionRelease } from '@/plugins/runtime/accountPluginActions.testkit';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { PLUGIN_MANIFEST } from '../../../../../packages/plugins/scm-github/src/manifest';
import { GITHUB_CONNECTED_ACCOUNT_SERVICE as service, GITHUB_CONNECTED_ACCOUNT_PURPOSE } from '../../../../../packages/plugins/scm-github/src/observations/githubProviderContracts';
import { GITHUB_TRIAGE_ACTION_IDS_V1 } from '../../../../../packages/plugins/scm-github/src/triage/contribution';
import { githubNativeReadActionId } from '../../../../../packages/plugins/scm-github/src/triage/readActions';
import { encodeGithubTriageConfiguration } from '../../../../../packages/plugins/scm-github/src/triage/configuration';
import { PLUGIN_MANIFEST as BITBUCKET_MANIFEST, BITBUCKET_TRIAGE_CONTRIBUTION_ID } from '../../../../../packages/plugins/scm-bitbucket/src/manifest';
import { BITBUCKET_PLUGIN_ID } from '../../../../../packages/plugins/scm-bitbucket/src/bitbucketContracts';
import { BITBUCKET_CONNECTED_ACCOUNT_PURPOSE, BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID } from '../../../../../packages/plugins/scm-bitbucket/src/triage/source/descriptor';
import { encodeBitbucketConfiguration } from '../../../../../packages/plugins/scm-bitbucket/src/triage/instance';
import { createCliActionExecutor } from './createCliActionExecutor';
import { manifest } from './accountNestedPurpose.testkit';

// Only the provider HTTP boundary is replaced; purpose admission and portable materializers run.
vi.mock('undici', async importOriginal => ({ ...await importOriginal<typeof import('undici')>(), fetch: vi.fn() }));
type Scenario = 'native placement' | 'GitHub materialization' | 'Bitbucket materialization';

async function createFixture() {
    const home = await mkdtemp(join(tmpdir(), 'account-child-purpose-'));
    const app = fastify();
    const serverHttpBaseUrl = 'http://account-child-purpose.test';
    const accounts = ['account-a', 'account-b'].map(accountId => ({ accountId,
        credentials: { token: ['header', Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url'), 'signature'].join('.'),
            encryption: null, credentialProvenance: 'stored_session' as const },
        ref: { service, accountId: `${accountId}-github` } }));
    let currentAccount = accounts[0]!;
    const credentialReads: string[] = [];
    const materializedAccounts: string[] = [];
    const bitbucketService = { pluginId: BITBUCKET_PLUGIN_ID, localId: BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID };
    let unhealthy = false;
    const authored = await registerAuthoredAccountActionRelease(app, currentAccount.accountId, { primary: {
        manifest, projectRoot: resolve(import.meta.dirname, '../../..'), entryPath: resolve(import.meta.dirname, 'accountNestedPurpose.testkit.ts'),
    }, additional: [{ manifest: BITBUCKET_MANIFEST, projectRoot: resolve(import.meta.dirname, '../../../../../packages/plugins/scm-bitbucket'),
          entryPath: resolve(import.meta.dirname, '../../../../../packages/plugins/scm-bitbucket/src/accountRuntime.ts'),
          artifactId: 'bitbucket-account-runtime', activateExport: 'activate', manifestExport: null },
        { manifest: PLUGIN_MANIFEST, projectRoot: resolve(import.meta.dirname, '../../../../../packages/plugins/scm-github'),
          entryPath: resolve(import.meta.dirname, '../../../../../packages/plugins/scm-github/src/accountRuntime.ts'),
          artifactId: 'github-account-runtime', activateExport: 'activate', manifestExport: null }] });
    const declaration = normalizePluginManifestV2(PLUGIN_MANIFEST);
    const authenticationModeId = declaration.contributes.connectedAccountDescriptors.find(row => row.id === service.localId)!.authentication.defaultModeId;
    app.addHook('onRequest', async request => {
        expect(request.headers.authorization === `Bearer ${currentAccount.credentials.token}`).toBe(true);
    });
    app.get('/v1/account/profile', async () => ({ id: currentAccount.accountId }));
    app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
    app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1, settingsVersion: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
    app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
    app.get('/v4/connect/qualified/accounts', async request => {
        credentialReads.push(currentAccount.accountId);
        const requestedService = JSON.parse(new URL(request.url, serverHttpBaseUrl).searchParams.get('service') ?? 'null');
        const bitbucket = requestedService?.pluginId === BITBUCKET_PLUGIN_ID;
        const requested = bitbucket ? bitbucketService : service;
        const mode = bitbucket ? normalizePluginManifestV2(BITBUCKET_MANIFEST).contributes.connectedAccountDescriptors
            .find(row => row.id === bitbucketService.localId)!.authentication.defaultModeId : authenticationModeId;
        return { service: requested, accounts: [QualifiedConnectedAccountProfileV4Schema.parse({ ref: bitbucket
            ? { service: requested, accountId: `${currentAccount.accountId}-bitbucket` } : currentAccount.ref,
            status: unhealthy ? 'needs_reauth' : 'connected', authenticationModeId: mode, revisionSemantics: 'revisioned',
            credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationReady: true,
            configurationRevision: null, kind: 'token', expiresAt: null, displayName: currentAccount.accountId, scopes: [] })] };
    });
    app.get('/v4/connect/qualified/credential', async request => {
        const ref = JSON.parse(new URL(request.url, serverHttpBaseUrl).searchParams.get('ref') ?? 'null');
        const bitbucket = ref.service.pluginId === BITBUCKET_PLUGIN_ID;
        expect(ref.accountId).toBe(`${currentAccount.accountId}-${bitbucket ? 'bitbucket' : 'github'}`);
        materializedAccounts.push(ref.accountId);
        const mode = normalizePluginManifestV2(bitbucket ? BITBUCKET_MANIFEST : PLUGIN_MANIFEST).contributes.connectedAccountDescriptors
            .find(row => row.id === ref.service.localId)!.authentication.defaultModeId;
        return QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref, authenticationModeId: mode,
            revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationRevision: null,
            content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain',
                payload: { v: 1, values: { token: currentAccount.accountId, ...(bitbucket ? { identity: 'fixture@example.test' } : {}) } },
                randomBytes: length => new Uint8Array(length) }), metadata: { scopes: [] } });
    });
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin: serverHttpBaseUrl });
    const features = vi.fn(async () => Response.json({ features: { connectedServices: { enabled: true } },
        capabilities: { connectedServices: { qualifiedAccounts: { protocolVersion: 4 } } } }));
    vi.stubGlobal('fetch', features);
    const purposeFeatures = vi.fn(() => undefined);
    const providerPaths: string[] = [];
    vi.mocked(undici.fetch).mockImplementation(async (url, init) => {
        const expected = new URL(String(url)).hostname === 'api.github.com' ? `Bearer ${currentAccount.accountId}`
            : `Basic ${Buffer.from(`fixture@example.test:${currentAccount.accountId}`).toString('base64')}`;
        expect(new Headers(init?.headers).get('authorization') === expected).toBe(true);
        const path = new URL(String(url)).pathname;
        providerPaths.push(path);
        const body = path === '/user/repos' ? [] : path === '/2.0/user'
            ? { uuid: '{11111111-1111-1111-1111-111111111111}' } : { values: [] };
        return new undici.Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const machineCalls: string[] = [];
    vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async request => {
        expect(request.credentials.token === currentAccount.credentials.token).toBe(true);
        expect(request.machineId).toBe('selected-machine');
        machineCalls.push(request.method);
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ) return {
            status: 'sourceDeclarations', pluginId: service.pluginId, sourceDeclarations: [{
                manifest: { id: service.pluginId, contributes: { actions: declaration.contributes.actions,
                    pluginContributionPoints: [], targetedPluginContributions: [], ui: { renderers: [] } } },
                occurrenceId: 'native-source', sourceCustody: { kind: 'development', registeredRootId: 'native-source-root' },
            }],
        };
        expect(request.method).toBe(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
        expect(request.request).toMatchObject({ qualifiedActionId: buildQualifiedPluginContributionKey({ pluginId: service.pluginId,
            localId: githubNativeReadActionId(GITHUB_TRIAGE_ACTION_IDS_V1.listScopeUnits) }) });
        return { ok: true, result: { kind: 'page', status: 'complete', selection: { kind: 'all' }, units: [] } };
    });
    const configuration = encodeGithubTriageConfiguration({ v: 1, selection: { kind: 'all' } });
    if (!configuration) throw new Error('Expected GitHub source configuration');
    const sourceInput = (binding: unknown, scenario: Scenario) => TriageSourceCredentialInputsV1.listScopeUnits.parse({ v: 1,
        draft: { v: 1, localInstanceKey: 'github.com', configuration: { v: 1, token: configuration }, binding },
        mode: scenario === 'GitHub materialization' ? 'available' : 'configured' });
    return { run: async (scenario: Scenario, requesterAccountId: string) => {
      // Author the provider release once; each case still enters the real CLI
      // dispatcher independently with both invoking Account credentials.
      credentialReads.length = 0;
      materializedAccounts.length = 0;
      providerPaths.length = 0;
      machineCalls.length = 0;
      const selectedAccounts = accounts.filter(account => account.accountId === requesterAccountId);
      try {
        for (const account of selectedAccounts) {
            currentAccount = account;
            const executor = (machineId?: string) => createCliActionExecutor({ ...account.credentials, credentials: account.credentials,
                happyHomeDir: home, sessionId: 'cli-global', mode: 'plain', ctx: null,
                serverId: 'account-child-purpose-home', serverHttpBaseUrl, resolveServerFeaturesSnapshot: purposeFeatures,
                ...(machineId ? { runtimeActionMachineId: machineId } : {}) });
            const invoke = (binding: unknown, machineId?: string) => executor(machineId).execute('action.invoke', {
                action: { pluginId: authored.pluginId, localId: 'read' }, input: sourceInput(binding, scenario),
            }, { surface: 'cli' });
            if (scenario === 'native placement') {
                const native = { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, source: 'native', service };
                expect(await invoke(native)).toMatchObject({ ok: false, errorCode: 'plugin_action_machine_required' });
                expect(await invoke(native, 'selected-machine')).toMatchObject({ ok: true, result: { kind: 'page' } });
            }
            const foreign = accounts.find(row => row.accountId !== account.accountId)!;
            if (scenario === 'Bitbucket materialization') {
                const workspaceUuid = '{22222222-2222-2222-2222-222222222222}';
                const encoded = encodeBitbucketConfiguration({ v: 1, workspaceUuid });
                if (!encoded.ok) throw new Error('Expected Bitbucket source configuration');
                const input = TriageSourceConnectedAccountInputsV1.scan.parse({ v: 1, instance: { v: 1,
                    instance: { source: { pluginId: BITBUCKET_PLUGIN_ID, localId: BITBUCKET_TRIAGE_CONTRIBUTION_ID },
                        sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05' },
                    localInstanceKey: workspaceUuid, configuration: { v: 1, token: encoded.token },
                    binding: { purpose: BITBUCKET_CONNECTED_ACCOUNT_PURPOSE,
                        account: { service: bitbucketService, accountId: `${account.accountId}-bitbucket` } } },
                    page: { kind: 'initial', limit: 10 } });
                const scan = (accountId: string) => executor().execute('action.invoke', {
                    action: { pluginId: authored.pluginId, localId: 'scan' }, input: { ...input, instance: { ...input.instance,
                        binding: { ...input.instance.binding, account: { service: bitbucketService, accountId: `${accountId}-bitbucket` } } } },
                }, { surface: 'cli' });
                const outcome = await scan(account.accountId);
                expect(outcome, outcome.ok ? undefined : outcome.errorCode)
                    .toMatchObject({ ok: true, result: { kind: 'complete' } });
                expect(await scan(foreign.accountId)).toMatchObject({ ok: false });
                const before = materializedAccounts.length;
                const providerBefore = providerPaths.length;
                unhealthy = true;
                expect(await scan(account.accountId)).toMatchObject({ ok: false });
                expect(materializedAccounts).toHaveLength(before);
                expect(providerPaths).toHaveLength(providerBefore);
                unhealthy = false;
                continue;
            }
            const outcome = await invoke({ purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, account: account.ref });
            expect(outcome, outcome.ok ? undefined : outcome.errorCode)
                .toMatchObject({ ok: true, result: { kind: 'page' } });
            expect(await invoke({ purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, account: foreign.ref })).toMatchObject({ ok: false });
            if (scenario === 'GitHub materialization') {
                const before = materializedAccounts.length;
                const providerBefore = providerPaths.length;
                unhealthy = true;
                expect(await invoke({ purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, account: account.ref })).toMatchObject({ ok: false });
                expect(materializedAccounts).toHaveLength(before);
                expect(providerPaths).toHaveLength(providerBefore);
                unhealthy = false;
                continue;
            }
        }
        expect(new Set(credentialReads)).toEqual(new Set(selectedAccounts.map(row => row.accountId)));
        expect(machineCalls.filter(method => method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE)).toHaveLength(scenario === 'native placement' ? selectedAccounts.length : 0);
        if (scenario !== 'native placement') {
            const bitbucket = scenario === 'Bitbucket materialization';
            expect(new Set(materializedAccounts)).toEqual(new Set(selectedAccounts.map(row => `${row.accountId}-${bitbucket ? 'bitbucket' : 'github'}`)));
            expect(providerPaths).toContain(bitbucket ? '/2.0/user' : '/user/repos');
        }
        expect(purposeFeatures.mock.calls.length).toBe(0);
      } finally { unhealthy = false; }
    }, dispose: async () => { restore(); await app.close(); await rm(home, { recursive: true, force: true }); } };
}

let fixture: Awaited<ReturnType<typeof createFixture>>;
beforeAll(async () => { fixture = await createFixture(); });
afterAll(async () => {
    await fixture?.dispose();
    vi.restoreAllMocks(); vi.mocked(undici.fetch).mockReset(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests();
});
it.each((['native placement', 'GitHub materialization', 'Bitbucket materialization'] as const).flatMap(scenario =>
    ['account-a', 'account-b'].map(accountId => ({ scenario, accountId }))))(
    'admits a storage-only Account parent’s actual child purpose: $scenario / $accountId',
    ({ scenario, accountId }) => fixture.run(scenario, accountId),
);
