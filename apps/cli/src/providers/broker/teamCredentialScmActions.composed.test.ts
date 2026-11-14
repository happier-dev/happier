import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { createHostReviewedChildPortV1, type ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { createExternalActionAuthorizedRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { reloadConfiguration } from '@/configuration';
import { adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resolveAccountExecutionRuntime } from '@/plugins/runtime/accountExecutionRuntime';
import { ensureCliActionPolicySettings } from '@/session/actions/ensureCliActionPolicySettings';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { PLUGIN_MANIFEST as COLD_PLUGIN_MANIFEST } from '../../../../../packages/plugins/scm-github/src/manifest';
import { GITHUB_HOSTING_OPERATION_ACTION_IDS_V1 } from '../../../../../packages/plugins/scm-github/src/actions/hostingActionIds';
import { GITHUB_CONNECTED_ACCOUNT_ID, GITHUB_CONNECTED_ACCOUNT_PURPOSE } from '../../../../../packages/plugins/scm-github/src/observations/githubProviderContracts';

afterEach(() => { vi.restoreAllMocks(); });

// This enters real Home admission and the bundled Account execution runtime.
// The native SCM root producer and broker carrier are separate composed gates.
const PLUGIN_MANIFEST = PluginManifestV2Schema.parse(COLD_PLUGIN_MANIFEST);

it('lets the recipient list and create pull requests using the custodian DIRECT share through declared SCM Actions', async () => {
    const server = '../../../../server/sources/';
    const { createLightSqliteHarness, createAccountTokenForTests }: typeof import('../../../../server/sources/testkit/lightSqliteHarness') = await import(server + 'testkit/lightSqliteHarness');
    const { createAuthenticatedTestApp }: typeof import('../../../../server/sources/app/api/testkit/sqliteFastify') = await import(server + 'app/api/testkit/sqliteFastify');
    const { db }: typeof import('../../../../server/sources/storage/db') = await import(server + 'storage/db');
    const { createTeamDirectActionMaterialFixture }: typeof import('../../../../server/sources/app/teams/credentials/directActionMaterial.testkit') = await import(server + 'app/teams/credentials/directActionMaterial.testkit');
    const { createReleaseLessDeclarationV1 }: typeof import('../../../../server/sources/app/plugins/availability/currentDeclaration') = await import(server + 'app/plugins/availability/currentDeclaration');
    const { registerTeamCredentialResourceRoutes }: typeof import('../../../../server/sources/app/teams/credentials/registerTeamCredentialResourceRoutes') = await import(server + 'app/teams/credentials/registerTeamCredentialResourceRoutes');
    const { registerExternalActionRoutes }: typeof import('../../../../server/sources/app/api/routes/actions/registerExternalActionRoutes') = await import(server + 'app/api/routes/actions/registerExternalActionRoutes');
    const { registerPluginAvailabilityRoutes }: typeof import('../../../../server/sources/app/plugins/availability/routes') = await import(server + 'app/plugins/availability/routes');
    const { accountRoutes }: typeof import('../../../../server/sources/app/api/routes/account/accountRoutes') = await import(server + 'app/api/routes/account/accountRoutes');
    const { featuresRoutes }: typeof import('../../../../server/sources/app/api/routes/features/featuresRoutes') = await import(server + 'app/api/routes/features/featuresRoutes');
    const { changesRoutes }: typeof import('../../../../server/sources/app/api/routes/changes/changesRoutes') = await import(server + 'app/api/routes/changes/changesRoutes');
    const { startTeamCredentialActionSocketPresence }: typeof import('../../../../server/sources/testkit/teamCredentialActionSocketPresence.testkit') = await import(server + 'testkit/teamCredentialActionSocketPresence.testkit');
    const homeId = 'srv_two_account_scm_action';
    const home = await createLightSqliteHarness({ tempDirPrefix: 'two-account-scm-action-', initAuth: true, initEncrypt: true, env: {
        HAPPIER_FEATURE_TEAMS__ENABLED: '1', HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1',
        HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: '1',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1',
        HAPPIER_SERVER_IDENTITY_ID: homeId,
    } });
    onTestFinished(home.close);
    const descriptor = PLUGIN_MANIFEST.contributes.connectedAccountDescriptors?.find(entry => entry.id === GITHUB_CONNECTED_ACCOUNT_ID);
    if (!descriptor) throw new Error('GitHub fixture is missing its connected Account descriptor');
    const selected = await createTeamDirectActionMaterialFixture({ manifest: PLUGIN_MANIFEST,
        actionId: GITHUB_HOSTING_OPERATION_ACTION_IDS_V1.listPullRequests, purposeId: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
        serviceId: descriptor.id, authenticationModeId: descriptor.authentication.defaultModeId, homeServerIdentityId: homeId });
    expect(selected.custodian.id).not.toBe(selected.recipient.id);
    const app = createAuthenticatedTestApp({ authentication: 'real' });
    onTestFinished(() => app.close());
    registerExternalActionRoutes(app);
    registerTeamCredentialResourceRoutes(app);
    registerPluginAvailabilityRoutes(app);
    accountRoutes(app);
    featuresRoutes(app);
    changesRoutes(app);
    const presence = startTeamCredentialActionSocketPresence(app);
    onTestFinished(presence.close);
    let materialReads = 0;
    app.addHook('onRequest', async request => { if (request.url.endsWith('/direct-material')) materialReads += 1; });
    const serverUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const token = await createAccountTokenForTests(selected.recipient.id, { kind: 'account', authority: 'present_user' });
    const signing = nacl.sign.keyPair();
    const installationId = crypto.randomUUID();
    await db.machine.update({ where: { id: selected.machine.id }, data: {
        installationId, installationPublicKey: signing.publicKey, operationProtocolCapabilitiesRevision: 1,
        pluginMaterializationRevision: BigInt(1),
        operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } },
    } });
    await db.pluginMachineMaterialization.create({ data: { accountId: selected.recipient.id, serverIdentityId: homeId,
        machineId: selected.machine.id, materializationId: installationId, pluginId: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version,
        sourceClass: 'bundledFirstParty', portableRelease: false,
        archiveDigestSha256: createReleaseLessDeclarationV1(PLUGIN_MANIFEST).manifestDigestSha256,
        uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: new Date() } });
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'two-account-scm-runtime-'));
    onTestFinished(() => rm(happyHomeDir, { recursive: true, force: true }));
    vi.stubEnv('HAPPIER_HOME_DIR', happyHomeDir);
    vi.stubEnv('HAPPIER_SERVER_URL', serverUrl);
    reloadConfiguration();
    onTestFinished(() => { vi.unstubAllEnvs(); reloadConfiguration(); });
    await adoptServerProfileHomeConnectionDescriptor({ descriptor: { v: 1, homeServerIdentityId: homeId,
        canonicalServerUrl: serverUrl, revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] },
        observation: 'exact', createIfMissing: true, use: true });
    reloadConfiguration();
    const credentials = { token, encryption: null } as const;
    await runWithServerHttpBaseUrl(serverUrl, async () => {
        await ensureCliActionPolicySettings(credentials, serverUrl);
        const settings = getActiveAccountSettingsSnapshot();
        if (!settings) throw new Error('Expected the real recipient Account settings');
        const savedSecretOperationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot: settings,
            serverHttpBaseUrl: serverUrl, isCurrent: async () => true });
        const runtime = await createAdmittedPluginRuntimeFixture({ happyHomeDir, runtimeOptions: {
            pluginIds: [PLUGIN_MANIFEST.id],
            scopedActionRuntime: { credentials, savedSecretOperationContext, actionsSettingsProvider: createActionSettingsProvider() },
        } });
        onTestFinished(runtime.dispose);
        const manifest = PLUGIN_MANIFEST;
        const account = await resolveAccountExecutionRuntime({ happyHomeDir, credentialRuntimeRegistry: runtime.registry,
            accountExecution: { credentials, serverUrl, serverId: 'two-account-scm-home', serverIdentityId: homeId,
                machineId: selected.machine.id, explicitMachineId: selected.machine.id,
                savedSecretOperationContext, isCurrent: () => true } });
        onTestFinished(() => account.registry.dispose());
        expect(account.registry.executionRealm).toBe('account');
        const registry = account.registry.targetActionInvocations;
        const provider = { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com', nameWithOwner: 'team/project' };
        const pullRequest = { number: 42, html_url: 'https://github.com/team/project/pull/42', title: 'Shared credential',
            state: 'open', draft: false, head: { ref: 'feature', sha: 'a'.repeat(40) }, base: { ref: 'main', sha: 'b'.repeat(40) } };
        const realFetch = globalThis.fetch;
        const providerRequests: Array<{ method: string; authorization: string | null }> = [];
        // The only substituted business boundary is GitHub HTTP. Home stays loopback HTTP.
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
            const target = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
            if (target.origin !== 'https://api.github.com') return realFetch(url, init);
            providerRequests.push({ method: init?.method ?? 'GET', authorization: new Headers(init?.headers).get('authorization') });
            return Response.json(init?.method === 'POST' ? pullRequest : [pullRequest], { status: init?.method === 'POST' ? 201 : 200 });
        });
        for (const localId of [GITHUB_HOSTING_OPERATION_ACTION_IDS_V1.listPullRequests, GITHUB_HOSTING_OPERATION_ACTION_IDS_V1.createPullRequest]) {
            const action = { pluginId: manifest.id, localId };
            const input = localId === GITHUB_HOSTING_OPERATION_ACTION_IDS_V1.listPullRequests
                ? { provider, head: 'feature' } : { provider, head: 'feature', base: 'main', title: 'Shared credential' };
            const requestId = crypto.randomUUID();
            const issued = await app.inject({ method: 'POST', url: '/v1/actions/action.invoke/execution-authorization',
                headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: selected.machine.id,
                    envelope: { v: 1, requestId, target: { kind: 'machine', machineId: selected.machine.id }, input: { action, input } } } });
            expect(issued.statusCode, issued.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            expect(root.binding.accountId).toBe(selected.recipient.id);
            Object.defineProperty(root, 'requesterHttpProjection', { value: {
                accountId: selected.recipient.id, serverId: 'two-account-scm-home', serverIdentityId: homeId, serverHttpBaseUrl: serverUrl,
                accountEncryptionMode: 'plain', isCurrent: async () => true,
                createRequestHeaders: async (request: Parameters<NonNullable<typeof root.requesterHttpProjection>['createRequestHeaders']>[0]) =>
                    createExternalActionAuthorizedRequestHeaders({ authorization: root, target: root.binding.target,
                        installationId, privateKey: signing.secretKey, ...request }),
            } satisfies NonNullable<typeof root.requesterHttpProjection> });
            const purpose = { consumer: action, purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE };
            const signal = new AbortController().signal;
            const activation = await account.registry.activateContributionsOnDemand([{ pluginId: manifest.id, family: 'actions', localId }]);
            const context: ActionExecutorContext = { surface: 'plugin', authority: 'present_user', signal,
                actionRequestId: requestId, runtimeAccountId: selected.recipient.id,
                serverId: 'two-account-scm-home', serverIdentityId: homeId,
                externalActionExecutionAuthorization: root, externalActionTarget: root.binding.target,
                invocationServices: { connectedAccountPurposeBindingSelection: { purposes: [purpose], purposeBindings: {
                    v: 1, bindings: [], teamResourceSelections: [{ purpose, teamId: selected.team.id,
                        selection: { source: 'team_resource', resourceId: selected.resource.id,
                            deliveryMode: 'direct', disclosedMember: selected.sourceAccount } }],
                } } } };
            const before = materialReads;
            const outcome = await registry.invoke({ ...action, input, surface: 'plugin', requestId, signal,
                approvalContext: { ...context, hostReviewedChild: createHostReviewedChildPortV1({ actionId: 'action.invoke',
                    input: { action, input }, context, reviewAdmitted: true }) } });
            expect(outcome, outcome.status === 'executed' ? undefined : JSON.stringify({ outcome, activation })).toMatchObject({ status: 'executed' });
            expect(outcome.status === 'executed' ? outcome.value : null).toMatchObject(
                localId === GITHUB_HOSTING_OPERATION_ACTION_IDS_V1.listPullRequests ? [{ number: 42 }] : { number: 42 });
            expect(JSON.stringify(outcome)).not.toContain('shared-token');
            expect(materialReads).toBe(before + 1);
        }
        expect(providerRequests.map(request => request.method)).toEqual(['GET', 'POST']);
        expect(providerRequests.every(request => request.authorization === 'Bearer shared-token')).toBe(true);
    });
}, 180_000);
