import axios from 'axios';
import fastify from 'fastify';
import nacl from 'tweetnacl';
import * as undici from 'undici';
import * as gh from '@/capabilities/deps/gh';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { resolve } from 'node:path';
import { expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { PluginAvailabilityActionHttpPathsV1 } from '@happier-dev/protocol/plugins/availability';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeV1Schema,
    EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { registerAuthoredAccountActionRelease } from '@/plugins/runtime/accountPluginActions.testkit';
import { encodeStoredCredentials } from '@/persistence';
import { executeScmSourceReadForRequester } from '@/scm/hostingProviders/resolveRefForHost';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { QualifiedConnectedAccountConfigurationSnapshotV4Schema, QualifiedConnectedAccountCredentialSnapshotV4Schema, QualifiedConnectedAccountProfileV4Schema,
    sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol';
import { PLUGIN_MANIFEST as githubManifest } from '../../../../../packages/plugins/scm-github/src/manifest';
import { GITHUB_OVERVIEW_TARGET_ACTION_ID } from '../../../../../packages/plugins/scm-github/src/actions/overviewContracts';
import { GITHUB_CONNECTED_ACCOUNT_SERVICE, GITHUB_CONNECTED_ACCOUNT_PURPOSE } from '../../../../../packages/plugins/scm-github/src/observations/githubProviderContracts';
import { PLUGIN_MANIFEST as cloudflareManifest } from '../../../../../packages/plugins/deploy-cloudflare/src/manifest';
import { CLOUDFLARE_ACCOUNT_ID } from '../../../../../packages/plugins/deploy-cloudflare/src/connectedAccounts/runtime';
import { createLightSqliteHarness } from '../../../../server/sources/testkit/lightSqliteHarness';
import { auth } from '../../../../server/sources/app/auth/auth';
import { db } from '../../../../server/sources/storage/db';
import { verifyExternalActionDomainExecutionRequest } from '../../../../server/sources/app/auth/externalActionExecutionAuthorization';
import { enableExternalActionHttpBody } from '../../../../server/sources/app/api/utils/externalActionHttpBody';
import type { Fastify as AppFastify } from '../../../../server/sources/app/api/types';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol';

// Provider HTTP is a genuine boundary; installed ingress and Account services remain real.
vi.mock('undici', async importOriginal => {
    const runtime = await importOriginal<typeof import('undici')>();
    return { ...runtime, fetch: vi.fn(runtime.fetch) };
});

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
// Replace the private OS listener, retaining the installed ingress and executor factory.
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
    boundary.control = input;
    return { port: 43129, stop: async () => {} };
} }));

it.each(['authored', 'github', 'native-custodian-use', 'native-foreign-use', 'cloudflare-action-invoke'] as const)('runs a %s Account read in the admitted requester Account through the installed daemon factory', async source => {
    onTestFinished(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); boundary.control = null; });
    const cloudflare = source === 'cloudflare-action-invoke';
    const github = source !== 'authored' && !cloudflare;
    const native = source.startsWith('native-');
    const custodianAccountId = source === 'native-foreign-use' ? 'machine-owner' : 'requester';
    const homeId = 'srv_account_placement';
    const serverUrl = 'https://session-home.test';
    if (cloudflare) {
        const home = await createLightSqliteHarness({ tempDirPrefix: 'happier-cloudflare-action-', initAuth: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: homeId, AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true' } });
        onTestFinished(() => home.close());
        await db.account.create({ data: { id: 'requester', encryptionMode: 'plain' } });
    }
    const credentials = { token: cloudflare ? await auth.createToken('requester', undefined, { kind: 'account', authority: 'present_user' })
        : `e30.${Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 0,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`, encryption: null };
    const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, undefined, undefined, {
        credentials, accountActionCredentials: credentials, requesterCredentials: credentials,
        externalActionAccountId: 'requester', ordinaryAccountSession: true, homeServerIdentityId: homeId,
        machineAccess: { custodianAccountId, role: native ? 'use' : 'manage' },
        resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId: 'machine' }),
    });
    const app = fastify() as unknown as AppFastify;
    if (cloudflare) enableExternalActionHttpBody(app);
    if (cloudflare) await db.machine.create({ data: { id: 'machine', accountId: 'requester',
        metadata: encodePlainMachineStoredContent({ host: 'controller', platform: 'linux', happyCliVersion: 'test',
            homeDir: '/home/controller', happyHomeDir: '/home/controller/.happier' }),
        dataEncryptionKey: Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
        installationId: h.f.installation.installationId, installationPublicKey: Buffer.from(h.f.installation.publicKey, 'base64url'),
        active: true, operationProtocolCapabilitiesRevision: 1,
        operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } } } });
    const homeRequests: string[] = [];
    app.addHook('onRequest', async request => { homeRequests.push(request.url); });
    onTestFailed(() => console.info({ accountPlacementHomeRequests: homeRequests }));
    onTestFinished(() => app.close());
    const authored = await registerAuthoredAccountActionRelease(app, 'requester', cloudflare ? { primary: {
        manifest: cloudflareManifest, projectRoot: resolve(import.meta.dirname, '../../../../../packages/plugins/deploy-cloudflare'),
        entryPath: resolve(import.meta.dirname, '../../../../../packages/plugins/deploy-cloudflare/src/accountRuntime.ts'),
        artifactId: 'account-runtime', activateExport: 'activateAccount', manifestExport: null,
    } } : github ? { primary: {
        manifest: githubManifest, projectRoot: resolve(import.meta.dirname, '../../../../../packages/plugins/scm-github'),
        entryPath: resolve(import.meta.dirname, '../../../../../packages/plugins/scm-github/src/accountRuntime.ts'),
        artifactId: 'github-account-runtime', activateExport: 'activate', manifestExport: null,
    } } : {});
    const action = { pluginId: authored.pluginId, localId: cloudflare ? 'cloudflare-named/selections-read' : github ? GITHUB_OVERVIEW_TARGET_ACTION_ID : 'echo' };
    const service = cloudflare ? { pluginId: cloudflareManifest.id, localId: CLOUDFLARE_ACCOUNT_ID } : GITHUB_CONNECTED_ACCOUNT_SERVICE;
    const account = { service, accountId: cloudflare ? 'requester-cloudflare-selected' : 'requester-github' };
    const revision = 'csr_0123456789ABCDEFGHJKMNPQRS';
    const configurationRevision = cloudflare ? 'fixture-cloudflare-configuration' : null;
    const authenticationModeId = cloudflare ? 'token' : authored.manifest.contributes.connectedAccountDescriptors
        .find(descriptor => descriptor.id === service.localId)?.authentication.defaultModeId ?? 'token';
    const sentinel = cloudflare ? 'synthetic-admitted-requester-cloudflare' : 'synthetic-admitted-requester-github';
    const providerRequests: Array<Readonly<{ url: string; selectedCredential: boolean }>> = [];
    onTestFailed(() => { if (cloudflare) console.info({ cloudflareProviderRequests: providerRequests }); });
    // The native gh credential reader is the OS boundary; requester admission stays real.
    const nativeCredential = vi.spyOn(gh, 'resolveGhNativeToken').mockResolvedValue({ ok: true, token: sentinel });
    const sha = 'a'.repeat(40);
    let requesterSignedAccountRead = false;
    const accountProfile = QualifiedConnectedAccountProfileV4Schema.parse({ ref: account, status: 'connected',
        authenticationModeId, revisionSemantics: 'revisioned', credentialRevision: revision,
        configurationReady: true, configurationRevision, kind: 'token', expiresAt: null, displayName: 'Requester account', scopes: [],
        ...(cloudflare ? { providerIdentity: { accountId: 'c'.repeat(32) } } : {}) });
    app.get('/v1/account/entity-rows/connected-accounts/purposes', async () => ({ status: 'present', revision: 1,
        content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: native || cloudflare ? [] : [{
            purpose: { consumer: action, purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE }, target: { kind: 'account', account },
        }] } } } }));
    if (cloudflare) app.get('/v1/account/profile', async request => {
        if (request.headers.authorization === `Bearer ${credentials.token}`) {
            return { id: 'requester', encryptionMode: 'plain', connectedAccountsV4: [accountProfile], connectedAccountGroupsV4: [] };
        }
        expect(request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] === root.token).toBe(true);
        expect(request.headers[EXTERNAL_ACTION_EFFECT_ACTION_HEADER]).toBe('connectedServices.accounts.list');
        const signature = request.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER];
        const encodedTarget = request.headers[EXTERNAL_ACTION_RESOLVED_TARGET_HEADER];
        if (typeof signature !== 'string' || typeof encodedTarget !== 'string') throw new Error('Missing signed Account read');
        const admitted = await verifyExternalActionDomainExecutionRequest({ authorizationToken: root.token,
            effectActionId: 'connectedServices.accounts.list', encodedTarget, method: request.method, path: request.url,
            body: request.body, routeInput: request.query, machineSignature: signature });
        requesterSignedAccountRead = admitted?.principal.accountId === 'requester';
        expect(requesterSignedAccountRead).toBe(true);
        return { id: 'requester', connectedAccountsV4: [accountProfile], connectedAccountGroupsV4: [] };
    });
    app.get('/v4/connect/qualified/accounts', async request => {
        expect(request.headers.authorization === `Bearer ${credentials.token}`).toBe(true);
        return { service, accounts: native ? [] : [accountProfile] };
    });
    app.get('/v4/connect/qualified/credential', async request => {
        expect(request.headers.authorization === `Bearer ${credentials.token}`).toBe(true);
        expect(JSON.parse(new URL(request.url, serverUrl).searchParams.get('ref') ?? 'null')).toEqual(account);
        return QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: account, authenticationModeId,
            revisionSemantics: 'revisioned', credentialRevision: revision, configurationRevision,
            content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain',
                payload: { v: 1, values: { token: sentinel } }, randomBytes: length => new Uint8Array(length) }), metadata: { scopes: [] } });
    });
    if (cloudflare) app.get('/v4/connect/qualified/configuration', async request => {
        expect(request.headers.authorization === `Bearer ${credentials.token}`).toBe(true);
        return QualifiedConnectedAccountConfigurationSnapshotV4Schema.parse({ target: { kind: 'account', ref: account },
            authenticationModeId, revisionSemantics: 'revisioned', credentialRevision: revision, configurationRevision,
            configurationContent: sealQualifiedConnectedAccountContentEnvelope({ kind: 'configuration', accountMode: 'plain',
                payload: { values: { accountId: 'c'.repeat(32), features: [], tokenOwner: 'user' }, secretRefs: {} },
                randomBytes: length => new Uint8Array(length) }) });
    });
    vi.mocked(undici.fetch).mockImplementation(async (url, init) => {
        if (cloudflare) {
            providerRequests.push({ url: String(url),
                selectedCredential: new Headers(init?.headers as HeadersInit).get('authorization') === `Bearer ${sentinel}` });
            return new undici.Response(JSON.stringify({ success: true, result: [{ id: 'd'.repeat(32), name: 'example.test' }],
                result_info: { page: 1, per_page: 20, total_count: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        expect(new Headers(init?.headers as HeadersInit).get('authorization') === `Bearer ${sentinel}`).toBe(true);
        return new undici.Response(JSON.stringify(String(url).endsWith('/commits/main') ? { sha }
            : { full_name: 'example/project', default_branch: 'main' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const restoreHttp = installAxiosFastifyAdapter({ app, origin: serverUrl });
    onTestFinished(restoreHttp);
    const portableHome = axios.create();
    const readHome = vi.mocked(axios.get).getMockImplementation();
    const writeHome = vi.mocked(axios.post).getMockImplementation();
    const requestHome = vi.mocked(axios.request).getMockImplementation();
    if (!readHome || !writeHome || !requestHome) throw new Error('Missing installed Home HTTP fixture');
    const pluginPaths = new Set<string>(Object.values(PluginAvailabilityActionHttpPathsV1));
    const isPortableRead = (url: string) => {
        const path = new URL(url).pathname;
        return pluginPaths.has(path) || path.startsWith('/v1/artifacts') || cloudflare && path === '/v1/account/profile'
            || path.startsWith('/v1/account/entity-rows/connected-accounts/') || path.startsWith('/v4/connect/qualified/');
    };
    // Both Homes are HTTP boundaries; preserve the installed fixture's ordinary routes.
    vi.mocked(axios.get).mockImplementation((...args) => isPortableRead(String(args[0]))
        ? portableHome.get(...args) : readHome(...args));
    vi.mocked(axios.post).mockImplementation((...args) => {
        if (new URL(String(args[0])).pathname.endsWith('/verify')) return Promise.resolve({ status: 200, data: { ok: true } });
        return isPortableRead(String(args[0])) ? portableHome.post(...args) : writeHome(...args);
    });
    vi.mocked(axios.request).mockImplementation(config => isPortableRead(String(config.url))
        ? portableHome.request(config) : requestHome(config));
    const target = { kind: 'machine' as const, machineId: 'machine' };
    const actionId = cloudflare ? 'action.invoke' : 'deployments.deploy';
    const input = cloudflare ? { action, input: { credentialRef: account, hostname: 'example.test' } }
        : { serverId: homeId, environmentId: 'environment', targetLinkId: 'target-link' };
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: 'prepare-deploy', target, input });
    const root = cloudflare ? await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: homeId,
        accountId: 'requester', authentication: { kind: 'account', tokenEpoch: 0 }, actionId,
        machineId: 'machine', target, requestId: envelope.requestId,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input })
        : ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-root', binding: {
        serverIdentityId: homeId, accountId: 'requester', custodianAccountId, ...(native ? { admittedMachineRole: 'use' as const } : {}), authentication: { kind: 'account', tokenEpoch: 0 },
        accountEncryptionMode: 'plain', actionId, requestId: envelope.requestId,
        machineId: 'machine', installationId: h.f.installation.installationId, target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } });
    const authorization = sealExternalActionRequesterAccountContextV1({ authorization: root,
        credentials: encodeStoredCredentials(credentials), purpose: { kind: 'external_action' },
        installationPublicKey: Buffer.from(h.f.installation.publicKey, 'base64url'), randomBytes: nacl.randomBytes,
        invocation: { surface: 'ui', authority: 'present_user', caller: { kind: 'host' }, presentUserConfirmation: {
            actionId, requestId: envelope.requestId, accountId: 'requester', serverId: homeId, target,
            inputDigest: computeActionInputApprovalDigestV1(actionId, input),
        } } });
    const owner = h.daemon.externalActionIngressOwner;
    if (!owner?.prepareRequesterAccountContext) throw new Error('Missing installed requester ingress');
    const prepared = await owner.prepareRequesterAccountContext({ authorization, purpose: { kind: 'external_action' }, signal: h.signal });
    if (!prepared) throw new Error('Requester Account admission failed');
    onTestFinished(() => prepared.dispose());
    if (native) expect(readRequesterAccountActionContext(prepared.authorization)?.savedSecretOperationContext.machineAdmission)
        .toMatchObject({ actorAccountId: 'requester', custodianAccountId, role: 'use' });
    const context = { surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const },
            serverId: 'session-home', serverIdentityId: homeId, actionRequestId: envelope.requestId,
            defaultSessionMachineId: 'machine', externalActionTarget: target,
            externalActionExecutionAuthorization: prepared.authorization };
    const result = cloudflare ? await prepared.executor.execute('action.invoke', input, context)
        : await executeScmSourceReadForRequester(prepared.executor,
            action, github ? { repository: { kind: 'github', deployment: 'https://github.com', repository: 'example/project' }, ref: 'main' } : { key: 'repository-ref' }, context);
    if (source === 'native-foreign-use') {
        expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'plugin_connected_account_native_unavailable' });
        expect(nativeCredential).not.toHaveBeenCalled();
        return;
    }
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: cloudflare
        ? { kind: 'ready', zones: [{ zoneId: 'd'.repeat(32), name: 'example.test' }], defaults: { accountId: 'c'.repeat(32) } } : github
        ? { kind: 'value', value: { branch: 'main', headSha: sha } } : { key: 'repository-ref', surface: 'ui' } });
    if (native) expect(nativeCredential).toHaveBeenCalledOnce();
    else expect(nativeCredential).not.toHaveBeenCalled();
    if (cloudflare) {
        expect(requesterSignedAccountRead).toBe(true);
        expect(providerRequests).toHaveLength(1);
        expect(providerRequests[0].selectedCredential).toBe(true);
        const providerUrl = new URL(providerRequests[0].url);
        expect(providerUrl.origin + providerUrl.pathname).toBe('https://api.cloudflare.com/client/v4/zones');
        expect(providerUrl.searchParams.get('account.id')).toBe('c'.repeat(32));
    }
    expect(JSON.stringify(result)).not.toContain(sentinel);
});
