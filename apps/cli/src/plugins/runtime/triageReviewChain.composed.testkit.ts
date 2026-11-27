import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { vi } from 'vitest';
import {
  QualifiedConnectedAccountCredentialSnapshotV4Schema,
  QualifiedConnectedAccountProfileV4Schema,
  sealQualifiedConnectedAccountContentEnvelope,
  PLUGIN_COLLECTION_GET_HTTP_PATH_V1,
  PLUGIN_COLLECTION_QUERY_HTTP_PATH_V1,
  PLUGIN_COLLECTION_MUTATION_HTTP_PATH_V1,
} from '@happier-dev/protocol';
import { projectAdmittedTargetedContributionSnapshot } from '@happier-dev/cli-common/plugins/registration';
import type { createActionExecutor } from '@happier-dev/protocol/actions';
import {
  QualifiedConnectedAccountCredentialHealthPatchV4Schema,
  QualifiedConnectedAccountCredentialMutationSuccessV4Schema,
} from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { PluginAccountStorageReadResponseV1Schema } from '@happier-dev/protocol/plugins/data/accountKvV1';
import {
  TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1,
  TriageSourceAdministrationActionResultV1Schema,
  TriageSourceInstanceDraftV1Schema,
  projectTriagePrepareReviewWorkspaceInputV1,
} from '@happier-dev/triage-protocol/v1';
import type { StoredCredentials } from '@/persistence';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createConnectedServiceCredentialApi } from '@/api/client/connectedServiceCredentialApi';
import { resolveQualifiedConnectedAccountAtomicV4Negotiation } from '@/api/client/qualifiedConnectedAccountApi';
import { createRequesterConnectedAccountPurposeBindingRuntime } from '@/daemon/connectedServices/purposeBindings/createRequesterConnectedAccountPurposeBindingRuntime';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import {
  createAuthoredAdmittedPluginRuntimeFixture,
  requireDaemonEntrypoint,
} from '@/plugins/testkit/admittedRuntime';
import { createHttpCollectionBoundary } from '@/plugins/runtime/context/accountPluginDataStorage.testkit';
import type { AccountPluginDataStorageHostDependencies } from '@/plugins/runtime/context/accountPluginDataStorage';
import { registerAuthoredAccountActionRelease } from '@/plugins/runtime/accountPluginActions.testkit';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import {
  getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import * as nativeHttp from '@/utils/loadUndici';
import {
  TRIAGE_PLUGIN,
  TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1,
} from '../../../../../packages/plugins/triage/src/manifest';
import { CORPUS_ACCOUNT_COLLECTIONS } from '../../../../../packages/plugins/triage/src/corpus/collections/definitions';
import {
  TriageStartEntrySessionInputV1Schema,
  type TriageStartEntrySessionInputV1,
} from '../../../../../packages/plugins/triage/src/actions/entrySessionProtocol';
import {
  TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1,
  TriageReadEntryDetailResultV1Schema,
} from '../../../../../packages/plugins/triage/src/actions/entryDetailProtocol';
import { GITHUB_PLUGIN } from '../../../../../packages/plugins/scm-github/src/manifest';
import { GIT_PLUGIN } from '../../../../../packages/plugins/scm-git/src/manifest';
import { CHANNELS_PLUGIN } from '../../../../../packages/plugins/channels/src/manifest';
import { CHANNEL_STATE_COLLECTION } from '../../../../../packages/plugins/channels/src/collections';
import {
  GITHUB_CONNECTED_ACCOUNT_PURPOSE,
  GITHUB_CONNECTED_ACCOUNT_SERVICE,
} from '../../../../../packages/plugins/scm-github/src/observations/githubProviderContracts';
import { GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1 } from '../../../../../packages/plugins/scm-github/src/triage/contribution';
import {
  encodeGithubTriageConfiguration,
  GITHUB_TRIAGE_ACCOUNT_SCOPE_V1,
} from '../../../../../packages/plugins/scm-github/src/triage/configuration';
import { buildGithubEntryLocator } from '../../../../../packages/plugins/scm-github/src/triage/locator';
import { toTriageLocator } from '../../../../../packages/plugins/scm-github/src/triage/mapping/protocol';
import {
  GITHUB_FIXTURE_OWNER,
  GITHUB_FIXTURE_REPOSITORY,
  GITHUB_FIXTURE_REPOSITORY_ID,
  GITHUB_AUTHENTICATED_USER_RESPONSE,
  GITHUB_PULL_REQUEST_RESPONSE,
  GITHUB_REPOSITORY_RESPONSE,
} from '../../../../../packages/plugins/scm-github/src/triage/__fixtures__/githubResponses';

type RuntimeOptions = NonNullable<
  Parameters<
    typeof createAuthoredAdmittedPluginRuntimeFixture
  >[0]['runtimeOptions']
>;

/** Real admitted Triage/GitHub/Git/Channels runtime; substitute Home persistence and GitHub HTTP only. */
export async function createTriageGithubChainSource(
  options: Readonly<{
    app: FastifyInstance;
    origin: string;
    accountId: string;
    serverId: string;
    machineId: string;
    credentials: StoredCredentials;
    baseSha: string;
    headSha: string;
    runtimeOptions?: RuntimeOptions;
    happyHomeDir?: string;
    controller?: Parameters<
      typeof createAuthoredAdmittedPluginRuntimeFixture
    >[0]['controller'];
    additionalPlugins?: Parameters<
      typeof createAuthoredAdmittedPluginRuntimeFixture
    >[0]['plugins'];
  }>,
) {
  const { app, origin, accountId, serverId, machineId, credentials } = options;
  const controller =
    options.controller ??
    createPluginReloadController({ happyHomeDir: options.happyHomeDir });
  const snapshot = getActiveAccountSettingsSnapshot();
  if (!snapshot)
    throw new Error(
      'The chain fixture requires its active Account settings snapshot',
    );
  const accountLifetime = getActiveAccountSettingsSnapshotLifetimeToken();
  const isAccountCurrent = async () =>
    accountLifetime === getActiveAccountSettingsSnapshotLifetimeToken();
  const operationContext = createInvocationSavedSecretOperationContextV1({
    credentials,
    snapshot,
    readSourceSnapshot: getActiveAccountSettingsSnapshot,
    serverHttpBaseUrl: origin,
    isCurrent: isAccountCurrent,
  });
  const credentialApi = createConnectedServiceCredentialApi(credentials);
  const purposeRuntime = createRequesterConnectedAccountPurposeBindingRuntime({
    operationContext,
    accountId,
    serverId,
    machineId,
    reloadController: controller,
    getAccountEncryptionMode: (input) =>
      runWithServerHttpBaseUrl(origin, () =>
        credentialApi.getAccountEncryptionMode(input),
      ),
    isCurrent: isAccountCurrent,
    allowNativeAccountCredentials: false,
    resolveQualifiedConnectedAccountV4Support: async () =>
      resolveQualifiedConnectedAccountAtomicV4Negotiation(
        await fetchServerFeaturesSnapshot({
          serverUrl: origin,
          token: credentials.token,
        }),
      ),
  });
  const credentialRef = {
    service: GITHUB_CONNECTED_ACCOUNT_SERVICE,
    accountId: 'fixture-github-account',
  };
  const source = {
    pluginId: GITHUB_PLUGIN.manifest.id,
    localId: GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1,
  };
  const configurationToken = encodeGithubTriageConfiguration(
    GITHUB_TRIAGE_ACCOUNT_SCOPE_V1,
  );
  if (configurationToken === null)
    throw new Error('Invalid GitHub source configuration');
  const draft = TriageSourceInstanceDraftV1Schema.parse({
    v: 1,
    binding: {
      purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
      account: credentialRef,
    },
    localInstanceKey: 'github.com',
    keyStability: 'stable',
    configuration: { v: 1, token: configurationToken },
    locator: { v: 1, displayLabel: 'Fixture GitHub' },
  });
  const collectionBoundaries = new Map([
    ...CORPUS_ACCOUNT_COLLECTIONS.map(
      (definition) =>
        [
          `${TRIAGE_PLUGIN.manifest.id}/${definition.id}`,
          createHttpCollectionBoundary(definition.indexes, 'plain'),
        ] as const,
    ),
    [
      `${CHANNELS_PLUGIN.manifest.id}/${CHANNEL_STATE_COLLECTION.id}`,
      createHttpCollectionBoundary(CHANNEL_STATE_COLLECTION.indexes, 'plain'),
    ] as const,
  ]);
  const currentness = createAccountEncryptionCurrentnessFixture({
    mode: 'plain',
  });
  // This fresh Account has no plugin KV rows. The real host supplies logical
  // reads and the Triage owner supplies Action configuration defaults.
  const absentAccountKv = PluginAccountStorageReadResponseV1Schema.parse({
    status: 'absent',
  });
  const accountKvPath = `/v1/account/plugin-storage/${encodeURIComponent(TRIAGE_PLUGIN.manifest.id)}`;
  app.get(accountKvPath, async () => absentAccountKv);
  const accountStorageDependencies: AccountPluginDataStorageHostDependencies = {
    readCredentials: async () => credentials,
    resolveBaseUrl: () => origin,
    resolveAccountEncryptionCurrentness: async () => currentness,
    http: {
      async get(url) {
        const path = new URL(url).pathname;
        if (path === accountKvPath)
          return { status: 200, data: absentAccountKv };
        if (!url.endsWith('/v1/account/encryption'))
          throw new Error(`Unexpected storage GET ${url}`);
        return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      },
      async post(url, body) {
        const address = JSON.parse(body) as {
          pluginId: string;
          collectionId: string;
        };
        const boundary = collectionBoundaries.get(
          `${address.pluginId}/${address.collectionId}`,
        );
        if (!boundary)
          throw new Error(
            `Unexpected Collection ${address.pluginId}/${address.collectionId} at ${url}`,
          );
        return boundary.http.post(url, body);
      },
    },
  };

  const descriptor = normalizePluginManifestV2(
    GITHUB_PLUGIN.manifest,
  ).contributes.connectedAccountDescriptors.find(
    ({ id }) => id === credentialRef.service.localId,
  );
  if (!descriptor)
    throw new Error('Missing GitHub Connected Account descriptor');
  const credentialVersion = {
    ref: credentialRef,
    authenticationModeId: descriptor.authentication.defaultModeId,
    revisionSemantics: 'revisioned',
    credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    configurationRevision: null,
  } as const;
  const account = QualifiedConnectedAccountProfileV4Schema.parse({
    ...credentialVersion,
    status: 'connected',
    configurationReady: true,
    kind: 'token',
    expiresAt: null,
    displayName: 'Fixture GitHub',
    scopes: [],
  });
  app.get('/v1/account/entity-rows/connected-accounts/purposes', async () => ({
    status: 'present',
    revision: 1,
    content: {
      t: 'plain',
      v: { key: 'purposes', value: { v: 1, bindings: [] } },
    },
  }));
  app.get('/v4/connect/qualified/accounts', async () => ({
    service: credentialRef.service,
    accounts: [account],
  }));
  app.get('/v4/connect/qualified/credential', async () =>
    QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
      ...credentialVersion,
      metadata: { scopes: [] },
      content: sealQualifiedConnectedAccountContentEnvelope({
        kind: 'credential',
        accountMode: 'plain',
        payload: {
          v: 1,
          values: { token: 'chain-synthetic-token-no-account-overlap' },
        },
        randomBytes: (length) => new Uint8Array(length),
      }),
    }),
  );
  app.patch('/v4/connect/qualified/credential/health', async (request) => {
    const patch = QualifiedConnectedAccountCredentialHealthPatchV4Schema.parse(
      request.body,
    );
    return QualifiedConnectedAccountCredentialMutationSuccessV4Schema.parse({
      success: true,
      credentialRevision: patch.expectedCredentialRevision,
      configurationRevision: patch.expectedConfigurationRevision,
    });
  });
  // Account Actions use Home HTTP directly; the daemon uses the same opaque store adapter.
  for (const path of [
    PLUGIN_COLLECTION_GET_HTTP_PATH_V1,
    PLUGIN_COLLECTION_QUERY_HTTP_PATH_V1,
    PLUGIN_COLLECTION_MUTATION_HTTP_PATH_V1,
  ]) {
    app.post(path, async (request, reply) => {
      const result = await accountStorageDependencies.http!.post(
        `${origin}${path}`,
        JSON.stringify(request.body),
        {},
      );
      return reply.code(result.status).send(result.data);
    });
  }
  const packagesRoot = resolve(
    import.meta.dirname,
    '../../../../../packages/plugins',
  );
  const artifact = (
    plugin:
      | typeof TRIAGE_PLUGIN
      | typeof GITHUB_PLUGIN
      | typeof CHANNELS_PLUGIN,
    directory: string,
    artifactId: string,
  ) => ({
    manifest: plugin.manifest,
    projectRoot: resolve(packagesRoot, directory),
    entryPath: resolve(packagesRoot, directory, 'src/accountRuntime.ts'),
    artifactId,
    activateExport: 'activate',
    manifestExport: null,
  });
  const accountRelease = await registerAuthoredAccountActionRelease(
    app,
    accountId,
    {
      primary: artifact(TRIAGE_PLUGIN, 'triage', 'triage-account-runtime'),
      additional: [
        artifact(GITHUB_PLUGIN, 'scm-github', 'github-account-runtime'),
        artifact(CHANNELS_PLUGIN, 'channels', 'channels-account-runtime'),
      ],
    },
  );
  const http = await nativeHttp.loadUndici();
  const githubRequests: string[] = [];
  const pullRequest = {
    ...GITHUB_PULL_REQUEST_RESPONSE,
    head: {
      ...GITHUB_PULL_REQUEST_RESPONSE.head,
      sha: options.headSha,
      repo: {
        ...GITHUB_PULL_REQUEST_RESPONSE.head.repo,
        clone_url: `https://github.com/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}.git`,
      },
    },
    base: { ...GITHUB_PULL_REQUEST_RESPONSE.base, sha: options.baseSha },
  };
  const githubFetch = vi.spyOn(nativeHttp, 'loadUndici').mockResolvedValue({
    ...http,
    async fetch(input, init) {
      const url = new URL(
        typeof input === 'object' && 'url' in input ? input.url : String(input),
      );
      if (url.hostname !== 'api.github.com') return http.fetch(input, init);
      githubRequests.push(url.pathname);
      if (
        url.pathname === `/repositories/${GITHUB_FIXTURE_REPOSITORY_ID}` ||
        url.pathname ===
          `/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}`
      )
        return http.Response.json(GITHUB_REPOSITORY_RESPONSE);
      if (url.pathname === '/user')
        return http.Response.json(GITHUB_AUTHENTICATED_USER_RESPONSE);
      if (url.pathname === '/search/users')
        return http.Response.json({
          items: [GITHUB_AUTHENTICATED_USER_RESPONSE],
        });
      if (
        url.pathname ===
        `/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/issues/comments`
      )
        return http.Response.json([]);
      if (
        url.pathname ===
        `/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/issues/${pullRequest.number}`
      )
        return http.Response.json({ ...pullRequest, pull_request: {} });
      if (
        url.pathname ===
        `/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/pulls/${pullRequest.number}`
      ) {
        return http.Response.json(pullRequest);
      }
      if (url.pathname === '/graphql')
        return http.Response.json({ data: { nodes: [] } });
      throw new Error(`Unexpected GitHub fixture URL ${url.pathname}`);
    },
  });
  const plugins = await Promise.all(
    [
      { plugin: TRIAGE_PLUGIN, directory: 'triage' },
      { plugin: GITHUB_PLUGIN, directory: 'scm-github' },
      { plugin: GIT_PLUGIN, directory: 'scm-git' },
      { plugin: CHANNELS_PLUGIN, directory: 'channels' },
    ].map(async ({ plugin, directory }) => {
      const files: Record<string, string | Uint8Array> = {
        [requireDaemonEntrypoint(plugin.manifest)]:
          'export function activate() {}',
      };
      await Promise.all(
        normalizePluginManifestV2(plugin.manifest).contributes.resources.map(
          async (resource) => {
            if ('path' in resource && typeof resource.path === 'string')
              files[resource.path] = await readFile(
                resolve(packagesRoot, directory, resource.path),
              );
          },
        ),
      );
      return {
        manifest: plugin.manifest,
        files,
        instantiateCommittedModule: () => ({ activate: plugin.activate }),
      };
    }),
  );
  const runtime = await runWithServerHttpBaseUrl(origin, () =>
    createAuthoredAdmittedPluginRuntimeFixture({
      plugins: [...plugins, ...(options.additionalPlugins ?? [])],
      ...(options.happyHomeDir ? { happyHomeDir: options.happyHomeDir } : {}),
      controller,
      async resolveContributes(happyHomeDir) {
        return createResolvedContributionRegistry(
          projectLoadedPluginContributes({
            loadResult: await loadInstalledPlugins({ happyHomeDir }),
            provenance: 'first_party',
          }),
        );
      },
      runtimeOptions: {
        ...options.runtimeOptions,
        accountStorageDependencies,
        connectedAccounts: purposeRuntime.purposes.owner,
        actionFormConnectedAccounts: purposeRuntime.purposes,
        resolveCurrentMachineId: () => machineId,
        resolveCurrentMachineExecutionOriginContext: async () => ({
          serverIdentityId: serverId,
          machineId,
        }),
      },
    }),
  );
  return {
    runtime,
    accountStorageDependencies,
    collectionBoundaries,
    githubRequests,
    pullRequest,
    artifacts: accountRelease.artifacts,
    async configureSource(
      executor: Pick<ReturnType<typeof createActionExecutor>, 'execute'>,
    ) {
      const result = await executor.execute(
        'action.invoke',
        {
          action: {
            pluginId: TRIAGE_PLUGIN.manifest.id,
            localId: TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1,
          },
          input: { v: 1, kind: 'create', source, draft },
        },
        {
          surface: 'cli',
          authority: 'present_user',
          runtimeAccountId: accountId,
          serverId,
          serverIdentityId: serverId,
        },
      );
      if (!result.ok)
        throw new Error(
          `Source administration failed: ${JSON.stringify(result)}`,
        );
      const configured = TriageSourceAdministrationActionResultV1Schema.parse(
        result.result,
      );
      if (configured.kind !== 'active' && configured.kind !== 'reused')
        throw new Error(
          `Source administration refused: ${JSON.stringify(configured)}`,
        );
      return configured.sourceInstanceId;
    },
    buildStartInput(
      input: Readonly<{
        sourceInstanceId: string;
        directory: string;
        agentTarget: Extract<
          TriageStartEntrySessionInputV1['destination'],
          { kind: 'new' }
        >['spawn']['agentTarget'];
      }>,
    ) {
      const point = TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1;
      const admitted = runtime.registry.readAdmittedTargetedContributions?.({
        targetPluginId: TRIAGE_PLUGIN.manifest.id,
        pointId: point.id,
        protocol: point.protocol,
      });
      if (!admitted || !runtime.registry.readPluginSourceCustody)
        throw new Error('Real Triage source snapshot unavailable');
      const snapshot = projectAdmittedTargetedContributionSnapshot(
        point,
        admitted,
        runtime.registry.readPluginSourceCustody,
      );
      const contributor = snapshot.contributions.find(
        (item) =>
          item.contributor.pluginId === source.pluginId &&
          item.contributor.contributionId === source.localId,
      );
      if (!contributor?.operations.prepareReviewWorkspace)
        throw new Error('GitHub preparation not admitted');
      const instance = {
        v: 1 as const,
        instance: { source, sourceInstanceId: input.sourceInstanceId },
        binding: draft.binding,
        localInstanceKey: draft.localInstanceKey,
        configuration: draft.configuration,
      };
      const entryRef = {
        source,
        kindId: 'pull-request',
        collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`,
        entryId: String(pullRequest.number),
      };
      const locator = buildGithubEntryLocator({
        owner: GITHUB_FIXTURE_OWNER,
        name: GITHUB_FIXTURE_REPOSITORY,
        entryNumber: entryRef.entryId,
        webUrl: pullRequest.html_url,
      });
      if (!locator) throw new Error('Expected a routable GitHub PR');
      const lastKnownLocator = toTriageLocator(locator);
      const request = {
        instance,
        entryRef,
        workflowSubject: 'pullRequest' as const,
        lastKnownLocator,
        observed: {
          baseSha: options.baseSha,
          headSha: options.headSha,
          nativeRevision: options.headSha,
          observedAtMs: Date.now(),
        },
        workspace: { serverId, machineId, rootPath: input.directory },
      };
      const raw = projectTriagePrepareReviewWorkspaceInputV1(request);
      const { account: _account, ...binding } = instance.binding;
      return TriageStartEntrySessionInputV1Schema.parse({
        v: 1,
        workspaceMode: 'pull_request',
        finalOpen: 'deferred',
        entryRef,
        display: {
          locator: lastKnownLocator,
          scopeLabel: `${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}`,
        },
        destination: {
          kind: 'new',
          creationKey: randomUUID(),
          spawn: {
            executionTarget: { serverId, machineId },
            agentTarget: input.agentTarget,
          },
          materialization: { kind: 'reviewWorkspace', request },
        },
        prepareReviewWorkspaceSelection: {
          credentialRef,
          input: { ...raw, instance: { ...raw.instance, binding } },
          selection: {
            target: {
              pluginId: TRIAGE_PLUGIN.manifest.id,
              sourceCustody: snapshot.sourceCustody,
            },
            point: { pointId: point.id, protocol: point.protocol },
            contributor: {
              pluginId: source.pluginId,
              contributionId: source.localId,
              sourceCustody: contributor.contributor.sourceCustody,
            },
          },
        },
      });
    },
    async readRelation(
      executor: Pick<ReturnType<typeof createActionExecutor>, 'execute'>,
      input: Readonly<{
        sourceInstanceId: string;
        entryRef: TriageStartEntrySessionInputV1['entryRef'];
      }>,
    ) {
      const result = await executor.execute(
        'action.invoke',
        {
          action: {
            pluginId: TRIAGE_PLUGIN.manifest.id,
            localId: TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1,
          },
          input: {
            v: 1,
            sourceInstanceId: input.sourceInstanceId,
            entryRef: input.entryRef,
          },
        },
        {
          surface: 'cli',
          authority: 'present_user',
          runtimeAccountId: accountId,
          serverId,
          serverIdentityId: serverId,
        },
      );
      if (!result.ok)
        throw new Error(
          `Reading entry relation failed: ${JSON.stringify(result)}`,
        );
      return TriageReadEntryDetailResultV1Schema.parse(result.result);
    },
    async dispose() {
      try {
        await runtime.dispose();
      } finally {
        githubFetch.mockRestore();
        if (!options.controller) await controller.shutdown();
      }
    },
  };
}
