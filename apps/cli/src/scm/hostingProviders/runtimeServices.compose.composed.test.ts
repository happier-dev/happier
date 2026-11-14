import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import nacl from 'tweetnacl';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1, ConnectedAccountCatalogRowMutationV1Schema, emptyConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { createExternalActionAuthorizedRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration, reloadConfiguration } from '@/configuration';
import { adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resolveAccountExecutionRuntime } from '@/plugins/runtime/accountExecutionRuntime';
import { ensureCliActionPolicySettings } from '@/session/actions/ensureCliActionPolicySettings';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createCommittedContributedActionInvoker, createCommittedContributedActionDefinitionLister,
  createCommittedContributedActionSchemaReader } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { executeScmActionOperation } from '@/scm/actions/executeScmActionOperation';
import { resolveDefaultScmBackendRegistry } from '@/scm/scmBackendCatalog';
import { createLocalScmRepositoryFixture } from '@/testkit/scm/scmBackendContractFixtures';
import { GITHUB_HOSTING_OPERATION_ACTION_IDS_V1 } from '../../../../../packages/plugins/scm-github/src/actions/hostingActionIds';
import { GITHUB_CONNECTED_ACCOUNT_ID, GITHUB_CONNECTED_ACCOUNT_PURPOSE } from '../../../../../packages/plugins/scm-github/src/observations/githubProviderContracts';
import { PLUGIN_MANIFEST as GIT_MANIFEST } from '../../../../../packages/plugins/scm-git/src/manifest';
import {
  PluginConnectedAccountDescriptorContributionV2Schema,
  ScmHostingProviderContributionSchema,
  type QualifiedConnectedAccountPurposeBindingsV1,
} from '@happier-dev/protocol';
import { ScmPullRequestOpenComposeResponseSchema } from '@happier-dev/protocol/scm/pullRequests';
import {
  GITHUB_SCM_HOSTING_PROVIDER_ID,
  PLUGIN_MANIFEST as COLD_PLUGIN_MANIFEST,
  githubHostingProviderAdapter,
  githubPullRequestAdapter,
} from '@happier-dev/plugins-scm-github';

import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createHostScmHostingProviderRuntimeServices } from './runtimeServices';
import { createGitPullRequestReadOperations } from '../../../../../packages/plugins/scm-git/src/operations/pullRequestReadOperations';
import { runWithRealGitScmRuntime } from '../../../../../packages/plugins/scm-git/src/testkit/scmRuntime.test-support';

const PLUGIN_MANIFEST = PluginManifestV2Schema.parse(COLD_PLUGIN_MANIFEST);

it('composes from one authorized hosting inventory observation through real Git and the host registry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-compose-inventory-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/happier-dev/happier.git'], { cwd: root });
    const service = { pluginId: PLUGIN_MANIFEST.id, localId: 'github-account' };
    const account = { service, accountId: 'bound-account' };
    let bindings: QualifiedConnectedAccountPurposeBindingsV1 = { v: 1, bindings: [{
      purpose: { consumer: { pluginId: PLUGIN_MANIFEST.id, localId: 'github' }, purpose: 'authentication' },
      target: { kind: 'account', account },
    }] };
    let metadataReads = 0;
    const owner = createConnectedAccountPurposeBindingOwner({
      // Only persistence and external Account metadata are substituted. The
      // purpose owner, host registry, forge routing and Git snapshot remain real.
      store: { read: async () => bindings,
        update: async mutate => { bindings = mutate(bindings); return bindings; },
        subscribe: () => ({ dispose() {} }) },
      selectTarget: async () => { throw new Error('Compose cannot select an Account'); },
      resolveTarget: async () => ({ displayName: 'Bound Account', account }),
      assertTargetAccountMaterializable: async () => undefined,
      materializeAccount: async () => { throw new Error('Compose cannot materialize credentials'); },
      projectTargetAccounts: async () => {
        metadataReads += 1;
        return { status: 'complete', accounts: [{ account, displayName: 'Bound Account', state: 'connected',
          connectedAccountOrigins: ['https://github.com'], connectedAccountBases: ['https://github.com'] }] };
      },
    });
    const services = createHostScmHostingProviderRuntimeServices({
      contributes: {
        scmHostingProviders: [{ id: 'github', provenance: 'external', source: { kind: 'path' },
          pluginId: PLUGIN_MANIFEST.id,
          definition: ScmHostingProviderContributionSchema.parse(PLUGIN_MANIFEST.contributes.scmHostingProviders![0]) }],
        connectedAccountDescriptors: [{ provenance: 'external', source: { kind: 'path' }, pluginId: PLUGIN_MANIFEST.id,
          definition: PluginConnectedAccountDescriptorContributionV2Schema.parse(PLUGIN_MANIFEST.contributes.connectedAccountDescriptors![0]) }],
      },
      scmHostingProvidersById: new Map([[GITHUB_SCM_HOSTING_PROVIDER_ID, { pluginId: PLUGIN_MANIFEST.id,
        occurrenceId: 'compose-fixture', registration: { id: 'github', adapter: {
          routing: githubHostingProviderAdapter, pullRequests: githubPullRequestAdapter,
        } } }]]),
      resolveConnectedAccountPurposeBindingOwner: () => owner,
    });
    const result = await runWithRealGitScmRuntime(() => createGitPullRequestReadOperations().openCompose({
      context: { cwd: root, projectKey: `compose:${root}`, detection: { isRepo: true, rootPath: root, mode: '.git' } },
      request: { base: 'main', head: 'feature/compose' },
    }), { hostingProviderRuntimeServices: services });
    expect(ScmPullRequestOpenComposeResponseSchema.parse(result)).toMatchObject({ success: true,
      composeUrl: 'https://github.com/happier-dev/happier/compare/main...feature%2Fcompose' });
    // This transport workload is the measured cost, not incidental helper calls.
    expect(metadataReads).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

afterEach(() => vi.restoreAllMocks());

it('preserves Team admission failures through the real native SCM entry after a successful recipient read', async () => {
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
    const { startTeamCredentialActionSocketPresence }: typeof import('../../../../server/sources/testkit/teamCredentialActionSocketPresence.testkit') = await import(server + 'testkit/teamCredentialActionSocketPresence.testkit');
    const homeId = 'srv_two_account_scm_outer';
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
    const presence = startTeamCredentialActionSocketPresence(app);
    onTestFinished(presence.close);
    let materialReads = 0;
    app.addHook('onRequest', async request => { if (request.url.endsWith('/direct-material')) materialReads += 1; });
    const serverUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const token = await createAccountTokenForTests(selected.recipient.id, { kind: 'account', authority: 'present_user' });
    // This recipient already uses the current catalog; migration is a separate owner corridor.
    const sourceSettings = await app.inject({ method: 'GET', url: '/v2/account/settings',
        headers: { authorization: `Bearer ${token}` } });
    expect(sourceSettings.statusCode, sourceSettings.body).toBe(200);
    const initializedCatalog = await app.inject({ method: 'POST', url: `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`,
        headers: { authorization: `Bearer ${token}` }, payload: ConnectedAccountCatalogRowMutationV1Schema.parse({ expectedRevision: 'absent',
            sourceSettingsVersion: AccountSettingsV2GetResponseSchema.parse(sourceSettings.json()).version,
            content: { t: 'plain', v: emptyConnectedAccountCatalogRecordV1('purposes') },
            referencedSavedSecretIds: [], savedSecretRevisions: [] }) });
    expect(initializedCatalog.statusCode, initializedCatalog.body).toBe(200);
    expect(initializedCatalog.json()).toMatchObject({ status: 'updated' });
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
            pluginIds: [GIT_MANIFEST.id, PLUGIN_MANIFEST.id],
            scopedActionRuntime: { credentials, savedSecretOperationContext, actionsSettingsProvider: createActionSettingsProvider() },
        } });
        onTestFinished(runtime.dispose);
        const account = await resolveAccountExecutionRuntime({ happyHomeDir, credentialRuntimeRegistry: runtime.registry,
            accountExecution: { credentials, serverUrl, serverId: configuration.activeServerId, serverIdentityId: homeId,
                machineId: selected.machine.id, explicitMachineId: selected.machine.id,
                savedSecretOperationContext, isCurrent: () => true } });
        onTestFinished(() => account.registry.dispose());
        if (!account.purposeRuntime) throw new Error('Expected the real recipient purpose runtime');
        const repository = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'two-account-scm-outer-' });
        onTestFinished(() => rm(repository.rootPath, { recursive: true, force: true }));
        execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/team/project.git'], { cwd: repository.rootPath });
        const hostingPurpose = { consumer: { pluginId: PLUGIN_MANIFEST.id, localId: 'github' }, purpose: 'authentication' };
        await account.purposeRuntime.store.update(current => ({ ...current, bindings: [], teamResourceSelections: [{
          purpose: hostingPurpose, teamId: selected.team.id, selection: { source: 'team_resource', resourceId: selected.resource.id,
            deliveryMode: 'direct', disclosedMember: selected.sourceAccount },
        }] }));
        // Both registries and the durable selection use their actual production owners.
        const backendRegistry = await resolveDefaultScmBackendRegistry({ pluginRuntimeRegistry: {
          ...runtime.registry, resolveConnectedAccountPurposeBindingOwner: () => account.purposeRuntime!.purposes.owner,
        } });
        const accountLease = { registry: account.registry, source: 'ephemeral' as const, durableRevision: -1, release: async () => {} };
        const definitions = createCommittedContributedActionDefinitionLister({ tryAcquireRuntimeRegistryLease: () => accountLease });
        const signal = new AbortController().signal;
        const native = createCliActionExecutorHarness({ token, credentials, happyHomeDir, sessionId: '', mode: 'plain', ctx: null,
          serverId: configuration.activeServerId, serverHttpBaseUrl: serverUrl, serverIdentityId: homeId,
          savedSecretOperationContext, actionsSettingsProvider: createActionSettingsProvider(),
        }, {
          listContributedActionDefinitions: definitions,
          readContributedActionSchemas: createCommittedContributedActionSchemaReader(definitions),
          invokeContributedAction: createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: async () => accountLease }),
          // This adapter binds the real receiving native owner to its admitted local repository.
          scmActionExecute: request => executeScmActionOperation({ actionId: request.actionId, input: request.input,
            workingDirectory: repository.rootPath, accessPolicy: { kind: 'restrictedRoots', roots: [repository.rootPath] },
            registry: backendRegistry, signal: request.context.signal, actionContext: request.context,
            executeCanonicalAction: request.executeCanonicalAction, executeHostingProviderAction: request.executeHostingProviderAction }),
        }).executor;
        const pullRequest = { number: 42, html_url: 'https://github.com/team/project/pull/42', title: 'Shared credential',
          state: 'open', draft: false, head: { ref: repository.branchName, sha: 'a'.repeat(40) }, base: { ref: 'main', sha: 'b'.repeat(40) } };
        const realFetch = globalThis.fetch;
        const providerRequests: Array<{ path: string; authorization: string | null }> = [];
        // GitHub HTTP is the only substituted business boundary. Home and Git remain real.
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
          const target = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
          if (target.origin !== 'https://api.github.com') return realFetch(url, init);
          providerRequests.push({ path: target.pathname, authorization: new Headers(init?.headers).get('authorization') });
          return Response.json(target.pathname.endsWith('/pulls') ? [pullRequest]
            : { full_name: 'team/project', name: 'project', default_branch: 'main', private: false,
                html_url: 'https://github.com/team/project', clone_url: 'https://github.com/team/project.git',
                ssh_url: 'git@github.com:team/project.git', owner: { login: 'team' } });
        });
        const executeNativeRead = async (head: string) => {
          const input = { cwd: repository.rootPath, head };
          const requestId = crypto.randomUUID();
          const issued = await app.inject({ method: 'POST', url: '/v1/actions/scm.pullRequest.list/execution-authorization',
            headers: { authorization: `Bearer ${token}` }, payload: { v: 1, machineId: selected.machine.id,
              envelope: { v: 1, requestId, target: { kind: 'machine', machineId: selected.machine.id }, input } } });
          expect(issued.statusCode, issued.body).toBe(200);
          const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
          Object.defineProperty(authorization, 'requesterHttpProjection', { value: {
            accountId: selected.recipient.id, serverId: configuration.activeServerId, serverIdentityId: homeId, serverHttpBaseUrl: serverUrl,
            accountEncryptionMode: 'plain', isCurrent: async () => true,
            createRequestHeaders: async (request: Parameters<NonNullable<typeof authorization.requesterHttpProjection>['createRequestHeaders']>[0]) =>
              createExternalActionAuthorizedRequestHeaders({ authorization, target: authorization.binding.target,
                installationId, privateKey: signing.secretKey, ...request }),
          } satisfies NonNullable<typeof authorization.requesterHttpProjection> });
          const context: ActionExecutorContext = { surface: 'cli', authority: 'present_user', signal,
            actionRequestId: requestId, runtimeAccountId: selected.recipient.id,
            serverId: configuration.activeServerId, serverIdentityId: homeId,
            externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target,
            signExternalActionApprovalInput: ({ actionId, input, target, authorization }) => signExternalActionApprovalInputV1({
              authorizationToken: authorization.token, actionId, input, target, privateKey: signing.secretKey }),
          };
          return await native.execute('scm.pullRequest.list', input, context);
        };
        const positive = await executeNativeRead(repository.branchName);
        expect(positive, JSON.stringify(positive)).toMatchObject({ ok: true, result: { success: true, pullRequests: [{ number: 42 }] } });
        expect(providerRequests.length).toBeGreaterThan(0);
        expect(providerRequests.every(request => request.authorization === 'Bearer shared-token')).toBe(true);
        const beforeWithdrawal = { provider: providerRequests.length, material: materialReads };
        // Revoke actual Home access while retaining the same durable local Team choice.
        await db.teamCredentialResource.update({ where: { id: selected.resource.id }, data: { memberGrants: { deleteMany: {} } } });
        // A distinct reviewed head is a fresh operation and cannot reuse the prior PR observation.
        const refused = await executeNativeRead('after-withdrawal');
        expect(refused, JSON.stringify(refused)).toMatchObject({ ok: true, result: { success: false,
          errorCode: 'COMMAND_FAILED', failureCause: { errorCode: 'plugin_connected_account_direct_access_removed' } } });
        expect(materialReads).toBe(beforeWithdrawal.material + 1);
        expect(providerRequests).toHaveLength(beforeWithdrawal.provider);
        expect(JSON.stringify([positive, refused])).not.toContain('shared-token');
    });
}, 180_000);
