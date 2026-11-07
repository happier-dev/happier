import axios from 'axios';
import fastify from 'fastify';
import nacl from 'tweetnacl';
import * as undici from 'undici';
import * as gh from '@/capabilities/deps/gh';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { resolve } from 'node:path';
import { expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { PluginAvailabilityActionHttpPathsV1 } from '@happier-dev/protocol/plugins/availability';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { registerAuthoredAccountActionRelease } from '@/plugins/runtime/accountPluginActions.testkit';
import { encodeStoredCredentials } from '@/persistence';
import { executeScmSourceReadForRequester } from '@/scm/hostingProviders/resolveRefForHost';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { QualifiedConnectedAccountCredentialSnapshotV4Schema, QualifiedConnectedAccountProfileV4Schema,
    sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol';
import { PLUGIN_MANIFEST as githubManifest } from '../../../../../packages/plugins/scm-github/src/manifest';
import { GITHUB_OVERVIEW_TARGET_ACTION_ID } from '../../../../../packages/plugins/scm-github/src/actions/overviewContracts';
import { GITHUB_CONNECTED_ACCOUNT_SERVICE, GITHUB_CONNECTED_ACCOUNT_PURPOSE } from '../../../../../packages/plugins/scm-github/src/observations/githubProviderContracts';

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

it.each(['authored', 'github', 'native-custodian-use', 'native-foreign-use'] as const)('runs a %s preparation source read in the admitted requester Account through the installed daemon factory', async source => {
    onTestFinished(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); boundary.control = null; });
    const github = source !== 'authored';
    const native = source.startsWith('native-');
    const custodianAccountId = source === 'native-foreign-use' ? 'machine-owner' : 'requester';
    const homeId = 'srv_account_placement';
    const serverUrl = 'https://session-home.test';
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 0,
        provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`, encryption: null };
    const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, undefined, undefined, {
        credentials, accountActionCredentials: credentials, requesterCredentials: credentials,
        externalActionAccountId: 'requester', ordinaryAccountSession: true, homeServerIdentityId: homeId,
        machineAccess: { custodianAccountId, role: native ? 'use' : 'manage' },
        resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId: 'machine' }),
    });
    const app = fastify();
    const homeRequests: string[] = [];
    app.addHook('onRequest', async request => { homeRequests.push(request.url); });
    onTestFailed(() => console.info({ accountPlacementHomeRequests: homeRequests }));
    onTestFinished(() => app.close());
    const authored = await registerAuthoredAccountActionRelease(app, 'requester', github ? { primary: {
        manifest: githubManifest, projectRoot: resolve(import.meta.dirname, '../../../../../packages/plugins/scm-github'),
        entryPath: resolve(import.meta.dirname, '../../../../../packages/plugins/scm-github/src/accountRuntime.ts'),
        artifactId: 'github-account-runtime', activateExport: 'activate', manifestExport: null,
    } } : {});
    const action = { pluginId: authored.pluginId, localId: github ? GITHUB_OVERVIEW_TARGET_ACTION_ID : 'echo' };
    const service = GITHUB_CONNECTED_ACCOUNT_SERVICE;
    const account = { service, accountId: 'requester-github' };
    const revision = 'csr_0123456789ABCDEFGHJKMNPQRS';
    const authenticationModeId = authored.manifest.contributes.connectedAccountDescriptors
        .find(descriptor => descriptor.id === service.localId)?.authentication.defaultModeId ?? 'token';
    const sentinel = 'synthetic-admitted-requester-github';
    // The native gh credential reader is the OS boundary; requester admission stays real.
    const nativeCredential = vi.spyOn(gh, 'resolveGhNativeToken').mockResolvedValue({ ok: true, token: sentinel });
    const sha = 'a'.repeat(40);
    app.get('/v1/account/entity-rows/connected-accounts/purposes', async () => ({ status: 'present', revision: 1,
        content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: native ? [] : [{
            purpose: { consumer: action, purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE }, target: { kind: 'account', account },
        }] } } } }));
    app.get('/v4/connect/qualified/accounts', async request => {
        expect(request.headers.authorization === `Bearer ${credentials.token}`).toBe(true);
        return { service, accounts: native ? [] : [QualifiedConnectedAccountProfileV4Schema.parse({ ref: account, status: 'connected',
            authenticationModeId, revisionSemantics: 'revisioned', credentialRevision: revision,
            configurationReady: true, configurationRevision: null, kind: 'token', expiresAt: null, displayName: 'Requester GitHub', scopes: [] })] };
    });
    app.get('/v4/connect/qualified/credential', async request => {
        expect(request.headers.authorization === `Bearer ${credentials.token}`).toBe(true);
        return QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: account, authenticationModeId,
            revisionSemantics: 'revisioned', credentialRevision: revision, configurationRevision: null,
            content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain',
                payload: { v: 1, values: { token: sentinel } }, randomBytes: length => new Uint8Array(length) }), metadata: { scopes: [] } });
    });
    vi.mocked(undici.fetch).mockImplementation(async (url, init) => {
        expect(new Headers(init?.headers as HeadersInit).get('authorization') === `Bearer ${sentinel}`).toBe(true);
        return new undici.Response(JSON.stringify(String(url).endsWith('/commits/main') ? { sha }
            : { full_name: 'example/project', default_branch: 'main' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const restoreHttp = installAxiosFastifyAdapter({ app, origin: serverUrl });
    onTestFinished(restoreHttp);
    const portableHome = axios.create();
    const readHome = vi.mocked(axios.get).getMockImplementation();
    const writeHome = vi.mocked(axios.post).getMockImplementation();
    if (!readHome || !writeHome) throw new Error('Missing installed Home HTTP fixture');
    const pluginPaths = new Set<string>(Object.values(PluginAvailabilityActionHttpPathsV1));
    const isPortableRead = (url: string) => {
        const path = new URL(url).pathname;
        return pluginPaths.has(path) || path.startsWith('/v1/artifacts')
            || path.startsWith('/v1/account/entity-rows/connected-accounts/') || path.startsWith('/v4/connect/qualified/');
    };
    // Both Homes are HTTP boundaries; preserve the installed fixture's ordinary routes.
    vi.mocked(axios.get).mockImplementation((...args) => isPortableRead(String(args[0]))
        ? portableHome.get(...args) : readHome(...args));
    vi.mocked(axios.post).mockImplementation((...args) => {
        if (new URL(String(args[0])).pathname.endsWith('/verify')) return Promise.resolve({ status: 200, data: { ok: true } });
        return isPortableRead(String(args[0])) ? portableHome.post(...args) : writeHome(...args);
    });
    const target = { kind: 'machine' as const, machineId: 'machine' };
    const input = { serverId: homeId, environmentId: 'environment', targetLinkId: 'target-link' };
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: 'prepare-deploy', target, input });
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-root', binding: {
        serverIdentityId: homeId, accountId: 'requester', custodianAccountId, ...(native ? { admittedMachineRole: 'use' as const } : {}), authentication: { kind: 'account', tokenEpoch: 0 },
        accountEncryptionMode: 'plain', actionId: 'deployments.deploy', requestId: envelope.requestId,
        machineId: 'machine', installationId: h.f.installation.installationId, target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } });
    const authorization = sealExternalActionRequesterAccountContextV1({ authorization: root,
        credentials: encodeStoredCredentials(credentials), purpose: { kind: 'external_action' },
        installationPublicKey: Buffer.from(h.f.installation.publicKey, 'base64url'), randomBytes: nacl.randomBytes,
        invocation: { surface: 'ui', authority: 'present_user', caller: { kind: 'host' }, presentUserConfirmation: {
            actionId: 'deployments.deploy', requestId: envelope.requestId, accountId: 'requester', serverId: homeId, target,
            inputDigest: computeActionInputApprovalDigestV1('deployments.deploy', input),
        } } });
    const owner = h.daemon.externalActionIngressOwner;
    if (!owner?.prepareRequesterAccountContext) throw new Error('Missing installed requester ingress');
    const prepared = await owner.prepareRequesterAccountContext({ authorization, purpose: { kind: 'external_action' }, signal: h.signal });
    if (!prepared) throw new Error('Requester Account admission failed');
    onTestFinished(() => prepared.dispose());
    if (native) expect(readRequesterAccountActionContext(prepared.authorization)?.savedSecretOperationContext.machineAdmission)
        .toMatchObject({ actorAccountId: 'requester', custodianAccountId, role: 'use' });
    const result = await executeScmSourceReadForRequester(prepared.executor,
        action, github ? { repository: { kind: 'github', deployment: 'https://github.com', repository: 'example/project' }, ref: 'main' } : { key: 'repository-ref' },
        { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId: 'session-home', serverIdentityId: homeId, actionRequestId: envelope.requestId,
            defaultSessionMachineId: 'machine', externalActionTarget: target,
            externalActionExecutionAuthorization: prepared.authorization });
    if (source === 'native-foreign-use') {
        expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'plugin_connected_account_native_unavailable' });
        expect(nativeCredential).not.toHaveBeenCalled();
        return;
    }
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: github
        ? { kind: 'value', value: { branch: 'main', headSha: sha } } : { key: 'repository-ref', surface: 'ui' } });
    if (native) expect(nativeCredential).toHaveBeenCalledOnce();
    else expect(nativeCredential).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(sentinel);
});
