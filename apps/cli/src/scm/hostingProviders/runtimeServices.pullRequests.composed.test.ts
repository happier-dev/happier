import { execFileSync } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createLocalScmRepositoryFixture } from '@/testkit/scm/scmBackendContractFixtures';
import { GITHUB_PLUGIN_ID, GITHUB_CONNECTED_ACCOUNT_ID } from '../../../../../packages/plugins/scm-github/src/observations/githubProviderContracts';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as processBoundary from '@happier-dev/cli-common/process';
import { createRequesterConnectedAccountPurposeBindingRuntime } from '@/daemon/connectedServices/purposeBindings/createRequesterConnectedAccountPurposeBindingRuntime';
import { createConnectedServiceCredentialApi } from '@/api/client/connectedServiceCredentialApi';
import { resolveQualifiedConnectedAccountAtomicV4Negotiation } from '@/api/client/qualifiedConnectedAccountApi';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify from 'fastify';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { registerAccountHomeHttp } from '@/session/actions/widgetApproval.testkit';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { reloadConfiguration } from '@/configuration';
import { updateSettings } from '@/persistence';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveDefaultScmBackendRegistry } from '@/scm/scmBackendCatalog';
import { ensureCliActionPolicySettings } from '@/session/actions/ensureCliActionPolicySettings';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1, ConnectedAccountCatalogRowReadResponseV1Schema,
    emptyConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { registerScmHandlers } from '@/rpc/handlers/scm';
import type { RpcHandler } from '@/api/rpc/types';
import { createTargetedActionRpcRequestV1 } from '@happier-dev/protocol/actions/actionRpcTransport';

it('reuses a GitHub pull request through raw SCM RPC without aliasing the null auth-profile callback', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hosting-pr-account-'));
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL', 'PATH']);
    const repository = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'hosting-pr-native-' });
    const serverUrl = 'http://hosting-pr-account.test';
    const serverId = 'hosting-pr-account-home';
    const accountId = 'qa-account';
    const machineId = 'qa-machine';
    const branch = 'fin-fix-builtins-1113';
    const nameWithOwner = 'leeroybrun/happier-qa-pr-sandbox';
    const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
    const app = fastify();
    const { createRequesterCurrentnessSocketHarness } = await import('@/testkit/backends/requesterCurrentnessSocketHarness');
    const channel = await createRequesterCurrentnessSocketHarness();
    let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
    let restore: (() => void) | undefined;
    try {
        execFileSync('git', ['branch', '-m', branch], { cwd: repository.rootPath });
        execFileSync('git', ['remote', 'add', 'origin', `https://github.com/${nameWithOwner}.git`], { cwd: repository.rootPath });
        execFileSync('git', ['update-ref', `refs/remotes/origin/${branch}`, repository.headCommit], { cwd: repository.rootPath });
        execFileSync('git', ['branch', '--set-upstream-to', `origin/${branch}`, branch], { cwd: repository.rootPath });
        {
            const nativeBin = join(home, process.platform === 'win32' ? 'gh.exe' : 'gh');
            await writeFile(nativeBin, 'fixture'); await chmod(nativeBin, 0o755);
            env.patch({ PATH: `${home}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}` });
            const realExec = processBoundary.execFileWithDeadline;
            vi.spyOn(processBoundary, 'execFileWithDeadline').mockImplementation(async (bin, args, options) => {
                if (bin === nativeBin) {
                    expect(args).toEqual(['auth', 'token', '--hostname', 'github.com']);
                    return { stdout: 'qa-fixture-token\n', stderr: '' };
                }
                return realExec(bin, args, options);
            });
        }
        env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: serverId, HAPPIER_SERVER_URL: serverUrl });
        reloadConfiguration();
        await updateSettings(settings => ({ ...settings, machineIdByServerId: { [serverId]: machineId } }));
        const features = registerAccountHomeHttp(app, { accountId, serverId });
        const serverFeatures = { ...features, features: { ...features.features, connectedServices: { enabled: true } },
            capabilities: { ...features.capabilities, connectedServices: { qualifiedAccounts: { protocolVersion: 4 } } } };
        app.get('/v1/features', async () => serverFeatures);
        const service = { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_CONNECTED_ACCOUNT_ID };
        app.get('/v4/connect/qualified/accounts', async () => ({ service, accounts: [] }));
        app.get(`${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/:key`, async request => {
            const { key } = request.params as { key: 'purposes' | 'configurations' };
            const record = emptyConnectedAccountCatalogRecordV1(key);
            return ConnectedAccountCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 1,
                content: { t: 'plain', v: record } });
        });
        await app.ready();
        restore = installAxiosFastifyAdapter({ app, origin: serverUrl });
        let hasPullRequest = true;
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
            const request = new Request(input, init);
            if (new URL(request.url).origin !== 'https://api.github.com') {
                expect(new URL(request.url).pathname).toBe('/v1/features');
                return Response.json(serverFeatures);
            }
            expect(request.method).toBe('GET');
            expect(request.headers.get('authorization')).toBe('Bearer qa-fixture-token');
            return Response.json(hasPullRequest ? [{ number: 42, title: 'QA existing pull request', state: 'open', draft: false,
                html_url: `https://github.com/${nameWithOwner}/pull/42`,
                head: { ref: branch, sha: repository.headCommit, repo: { full_name: nameWithOwner } },
                base: { ref: 'main', sha: repository.headCommit, repo: { full_name: nameWithOwner } },
            }] : []);
        });
        await ensureCliActionPolicySettings(credentials, serverUrl);
        const settings = getActiveAccountSettingsSnapshot();
        if (!settings) throw new Error('Expected the Account settings fixture');
        const savedSecretOperationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot: settings,
            serverHttpBaseUrl: serverUrl, isCurrent: async () => true });
        runtime = await createAdmittedPluginRuntimeFixture({ happyHomeDir: home, controller: pluginReloadController,
            runtimeOptions: { pluginIds: ['happier.scm.backend.git', GITHUB_PLUGIN_ID], scopedActionRuntime: {
                credentials, savedSecretOperationContext, actionsSettingsProvider: createActionSettingsProvider(),
            } } });
        const held = { acquireRuntimeRegistry: async () => ({ registry: runtime!.registry, source: 'ephemeral' as const,
            durableRevision: -1, release: async () => {} }),
            tryAcquireRuntimeRegistry: () => ({ registry: runtime!.registry, source: 'ephemeral' as const,
                durableRevision: -1, release: async () => {} }),
            isRuntimeRegistryCurrent: candidate => candidate === runtime!.registry,
            subscribe: () => () => {} } satisfies Parameters<typeof createRequesterConnectedAccountPurposeBindingRuntime>[0]['reloadController'];
        const credentialApi = createConnectedServiceCredentialApi(credentials);
        // This local Machine owner holds its own native login; no requester
        // admission is fabricated.
        const localNative = createRequesterConnectedAccountPurposeBindingRuntime({
            operationContext: savedSecretOperationContext, accountId, serverId, machineId,
            reloadController: held, nativeReloadController: held, allowNativeAccountCredentials: true,
            isCurrent: async () => true, getAccountEncryptionMode: options => credentialApi.getAccountEncryptionMode(options),
            resolveQualifiedConnectedAccountV4Support: async () => resolveQualifiedConnectedAccountAtomicV4Negotiation({
                status: 'ready', provenance: 'authenticated', features: serverFeatures,
            }),
        });
        const owner = localNative.purposes.owner;
        const backendRegistry = await resolveDefaultScmBackendRegistry({ pluginRuntimeRegistry: {
            ...runtime.registry, resolveConnectedAccountPurposeBindingOwner: () => owner,
        } });
        const target = { kind: 'machine' as const, machineId, project: { machineId, directory: repository.rootPath } };
        const handlers = new Map<string, RpcHandler>();
        registerScmHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, repository.rootPath,
            { machineId, registry: backendRegistry, accessPolicy: { kind: 'restrictedRoots', roots: [repository.rootPath] } });
        const rawOpened = await handlers.get('scm.pullRequest.openOrReuse')!(createTargetedActionRpcRequestV1({
            cwd: repository.rootPath, base: 'main', title: 'QA sandbox only', body: 'QA fixture',
        }, target), { signal: new AbortController().signal });
        expect(rawOpened, JSON.stringify(rawOpened)).toMatchObject({
            success: true, reused: true, pullRequest: { number: 42 },
        });
        hasPullRequest = false;
        const rawListed = await handlers.get('scm.pullRequest.list')!(createTargetedActionRpcRequestV1({
            cwd: repository.rootPath, base: 'main', head: branch,
        }, target), { signal: new AbortController().signal });
        expect(rawListed, JSON.stringify(rawListed)).toMatchObject({ success: true, pullRequests: [] });
    } finally {
        await runtime?.dispose(); await channel.close(); restore?.(); await app.close(); vi.restoreAllMocks();
        resetActiveAccountSettingsSnapshotForTests(); env.restore(); reloadConfiguration();
        await Promise.all([rm(home, { recursive: true, force: true }), rm(repository.rootPath, { recursive: true, force: true })]);
    }
});
