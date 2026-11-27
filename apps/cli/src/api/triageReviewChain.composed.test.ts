import fastify from 'fastify';
import nacl from 'tweetnacl';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  accountSettingsParse,
  FeaturesResponseSchema,
  decodePlainArtifactStoredContent,
  MACHINE_PLAIN_DATA_KEY_MARKER,
  encodePlainMachineStoredContent,
  SessionTurnMutationV1Schema,
} from '@happier-dev/protocol';
import {
  SESSION_SYNC_PROTOCOL_VERSION_RUNTIME_ACTIVITY,
  CURRENT_PENDING_INPUT_PROTOCOL_VERSION,
} from '@happier-dev/protocol/clientCompatibility/primitives';
import {
  SESSION_TRANSCRIPT_OBSERVATION_BATCH_EVENT_V1,
  SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
} from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { HomeGovernanceGetInputV1Schema } from '@happier-dev/protocol/home/governance/actionsV1';
import { HomeSessionDefaultsProjectionV1Schema } from '@happier-dev/protocol/home/governance/projection';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import {
  indexAgentRoutingIdsByContributionIdentity,
  readAgentRoutingIdForContributionIdentity,
} from '@happier-dev/agents';
import { ReviewArtifactHeaderV1Schema } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import { ReviewEngineInventorySchema } from '@happier-dev/protocol/reviews/reviewEngines';
import { ReviewStartInputSchema } from '@happier-dev/protocol/reviews/reviewStart';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import {
  normalizeActionsSettingsV1,
  setActionApprovalOverride,
} from '@happier-dev/protocol/actions/actionSettings';
import { createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createSessionRpcAuthorization } from '@/api/session/client/sessionRpcAuthorization';
import { createSessionRunReportPolicyReader } from '@/api/sessionFollowCreationPreferences';
import {
  SessionAutoFollowPreferencesResponseSchema,
  SESSION_FOLLOW_HTTP_PATHS_V1,
} from '@happier-dev/protocol/sessions/follow/api';
import { DEFAULT_SESSION_AUTO_FOLLOW_PREFERENCES_V1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import {
  PROMPT_LIBRARY_ROWS_ROUTE_V1,
  PromptLibraryCatalogKeyV1Schema,
  PromptLibraryRowsListResponseV1Schema,
} from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { prepareActiveAccountRoleOverrides } from '@/settings/prompts/hydratePromptLibraryCatalog';
import type { PrepareExternalActionRequesterAccountContext } from '@/daemon/externalActions/executeExternalAction';
import { ExternalActionMachineRpcExecutionV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { verifyExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import {
  SOCKET_RPC_EVENTS,
  SocketRpcRequestIdSchema,
  projectSocketRpcTargetAcknowledgementV1,
  resolveSocketRpcSameAccountSessionAuthorizationV1,
  type SocketRpcRequestPayload,
} from '@happier-dev/protocol/socketRpc';
import { resolveExternalActionRootInvocationAuthority } from '@/api/externalActionExecutionAuthorization';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { dispatchOriginalAccountAction } from '@/api/externalActionExecutionAuthorization';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { configuration, reloadConfiguration } from '@/configuration';
import { adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import * as persistence from '@/persistence';
import {
  decodeJwtPayload,
  readAccountIdFromToken,
} from '@/cloud/decodeJwtPayload';
import { readAuthTokenProvenance } from '@happier-dev/protocol/auth/authToken';
import { readAgentIsolationSnapshot } from '@/daemon/agentIsolation/agentIsolationPolicy';
import { createDaemonExternalActionContributedInvoker } from '@/daemon/externalActions/createDaemonExternalActionContributedInvoker';
import {
  withConfiguredDaemonTestHome,
  writeDaemonSettingsFixture,
} from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import {
  createCommittedContributedActionDefinitionLister,
  createCommittedContributedActionSchemaReader,
} from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { executeContributedAction } from '@/plugins/runtime/invocation/actions/executeContributedAction';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createTriageGithubChainSource } from '@/plugins/runtime/triageReviewChain.composed.testkit';
import {
  createChainReviewerPluginRecipe,
  createChainParentSessionClient,
  CHAIN_REVIEWER_IDENTITY,
  CHAIN_SESSION_AGENT_IDENTITY,
  startChainReviewDaemonAdmission,
} from '@/plugins/runtime/triageReviewChainReviewer.composed.testkit';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import {
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { registerScmHandlers } from '@/rpc/handlers/scm';
import { registerCapabilitiesHandlers } from '@/rpc/handlers/capabilities';
import { registerDaemonContributionRegistryProjectionHandler } from '@/rpc/handlers/daemonContributionRegistryProjection';
import {
  createBareGitRemoteFixture,
  createLocalScmRepositoryFixture,
  runScmExecutable,
} from '@/testkit/scm/scmBackendContractFixtures';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import {
  registerAccountHomeHttp,
  registerMachineActionHomeHttp,
} from '@/session/actions/widgetApproval.testkit';
import { createSessionSpawnComposedBoundary } from '@/session/creation/sessionSpawnComposed.testkit';
import { createProjectAccountRowsHttpBoundary } from '@/workspaces/projectAccountRows.testkit';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import type { ExecutionRunHostBridge } from '@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';
import { registerExecutionRunRpcHandlers } from '@/rpc/handlers/executionRuns/registerExecutionRunRpcHandlers';
import { createExecutionRunRpcApprovalDeps } from '@/rpc/handlers/executionRuns/createExecutionRunRpcApprovalDeps';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/createHandler';
import { createCommittedExecutionRunTranscriptPublisher } from '@/agent/runtime/bridges/executionRun/executionRunTranscriptPublisher';
import {
  createSessionRuntimeActivityHomeStub,
  createSessionTranscriptHomeStub,
  createSessionTurnMutationAppliedSocketAck,
} from '@/testkit/backends/apiSessionSocketHarness';
import { submitTriageEntrySessionStart } from '../../../../packages/plugins/triage/src/ui/header/startEntrySessionCommand';
import {
  prepareTriagePullRequestReviewContinuationV1,
  settleTriagePullRequestReviewContinuationV1,
} from '../../../../packages/plugins/triage/src/sessions/pullRequestReviewContinuation';
import { TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1 } from '../../../../packages/plugins/triage/src/actions/entrySessionProtocol';

const accountId = 'triage-chain-owner';
const serverId = 'srv_triage_chain';
const machineId = 'triage-chain-machine';
const installationId = 'triage-chain-installation';
const origin = 'https://triage-review-chain.test';
const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
const tokenForAccount = (
  requesterAccountId: string,
  kind: 'account' | 'terminal' = 'account',
) =>
  `e30.${Buffer.from(
    JSON.stringify({
      sub: requesterAccountId,
      tokenEpoch: 0,
      provenance: {
        v: 1,
        kind,
        authority: kind === 'account' ? 'present_user' : 'account_automation',
      },
    }),
  ).toString('base64url')}.fixture`;
const token = tokenForAccount(accountId);
const credentials = {
  token,
  encryption: null,
  credentialProvenance: 'stored_session' as const,
};
const foreignCredentials = {
  ...credentials,
  token: tokenForAccount('another-account'),
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetActiveAccountSettingsSnapshotForTests();
});

it(
  'carries the Triage launcher through Session birth and Review, retaining requester custody and refusing foreign or absent custody',
  async () =>
    withConfiguredDaemonTestHome(
      {
        prefix: 'triage-review-chain-',
        machineId,
        env: {
          HAPPIER_ACTIVE_SERVER_ID: serverId,
          HAPPIER_SERVER_URL: origin,
          HAPPIER_WEBAPP_URL: origin,
        },
      },
      async ({ homeDir }) => {
        vi.stubEnv('HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED', '1');
        await writeDaemonSettingsFixture(homeDir, {
          activeServerId: serverId,
          servers: {
            [serverId]: {
              id: serverId,
              name: 'Triage chain Home',
              serverUrl: origin,
              webappUrl: origin,
              createdAt: 1,
              updatedAt: 1,
              lastUsedAt: 1,
            },
          },
          machineIdByServerId: { [serverId]: machineId },
        });
        reloadConfiguration();
        await adoptServerProfileHomeConnectionDescriptor({
          expectedProfileId: serverId,
          observation: 'exact',
          descriptor: {
            v: 1,
            homeServerIdentityId: serverId,
            canonicalServerUrl: origin,
            revision: 1,
            endpoints: [{ kind: 'https', url: origin }],
          },
        });
        expect(configuration.activeServerId).toBe(serverId);
        expect(configuration.apiServerUrl).toBe(origin);
        // The daemon stores its terminal sign-in; the UI requester retains
        // the distinct Account bearer delivered by the real Action ingress.
        await persistence.writeStoredCredentialsForServerId(serverId, {
          ...credentials,
          token: tokenForAccount(accountId, 'terminal'),
        });
        const repository = createLocalScmRepositoryFixture({
          executable: 'git',
          repoMode: '.git',
          prefix: 'triage-chain-repository-',
        });
        const remote = createBareGitRemoteFixture('triage-chain-remote-');
        const git = (...args: string[]) =>
          runScmExecutable(repository.rootPath, 'git', args);
        const baseSha = repository.headCommit;
        await writeFile(
          join(repository.rootPath, repository.trackedPath),
          'base\nreviewable change\n',
        );
        git('add', repository.trackedPath);
        git('commit', '-m', 'pull request change');
        const headSha = git('rev-parse', 'HEAD');
        git(
          'remote',
          'add',
          'origin',
          'https://github.com/octo-org/example-app.git',
        );
        git(
          'config',
          `url.${remote.remotePath}.insteadOf`,
          'https://github.com/octo-org/example-app.git',
        );
        git(
          'push',
          'origin',
          `${baseSha}:refs/heads/main`,
          `${headSha}:refs/heads/frame-pump`,
          `${headSha}:refs/pull/1284/head`,
        );
        // Fetch uses the local bare transport; Git's publish URL remains
        // recognizable to the real hosting-provider detector.
        git(
          'remote',
          'set-url',
          '--push',
          'origin',
          'git@github.com:octo-org/example-app.git',
        );
        git('checkout', '--detach', baseSha);

        const app = fastify();
        const homeErrors: unknown[] = [];
        app.addHook('onError', async (request, _reply, error) => {
          homeErrors.push({
            url: request.url,
            message: error.message,
            stack: error.stack,
          });
        });
        let settings = normalizeActionsSettingsV1(undefined);
        for (const actionId of [
          'session.spawn_new',
          'review.start',
          'action.invoke',
          'scm.reviewWorkspace.materializePrepared',
        ] as const) {
          for (const surface of ['cli', 'plugin'] as const) {
            settings = setActionApprovalOverride({
              settings,
              actionId,
              surface,
              approvalRequired: false,
            });
          }
        }
        const accountSettings = accountSettingsParse({
          actionsSettingsV1: settings,
        });
        setActiveAccountSettingsSnapshot({
          source: 'network',
          settings: accountSettings,
          rawSettings: accountSettings,
          settingsVersion: 1,
          loadedAtMs: 1,
          settingsSecretsReadKeys: [],
          scopeKey: resolveAccountSettingsScopeKeyForToken(token),
        });
        const actionsSettingsProvider = createActionSettingsProvider({
          accountSettings,
        });
        const homeFeatures = registerAccountHomeHttp(app, {
          accountId,
          serverId,
          settings: accountSettings,
        });
        const features = FeaturesResponseSchema.parse({
          ...homeFeatures,
          features: {
            ...homeFeatures.features,
            execution: { runs: { enabled: true } },
            connectedServices: { enabled: true },
            sharing: { session: { enabled: true } },
            plugins: { enabled: true },
          },
          capabilities: {
            ...homeFeatures.capabilities,
            encryption: {
              ...homeFeatures.capabilities.encryption,
              storagePolicy: 'optional',
              allowAccountOptOut: true,
              defaultAccountMode: 'plain',
            },
            connectedServices: { qualifiedAccounts: { protocolVersion: 4 } },
            session: {
              ...homeFeatures.capabilities.session,
              runtimeActivity: {
                protocolVersion: SESSION_SYNC_PROTOCOL_VERSION_RUNTIME_ACTIVITY,
              },
              pendingInput: {
                protocolVersion: CURRENT_PENDING_INPUT_PROTOCOL_VERSION,
              },
              publisherAuthority: { protocolVersion: 1 },
            },
          },
        });
        app.get('/v2/changes', async () => ({ changes: [], nextCursor: 0 }));
        app.get(SESSION_FOLLOW_HTTP_PATHS_V1.preferences, async () =>
          SessionAutoFollowPreferencesResponseSchema.parse({
            ...DEFAULT_SESSION_AUTO_FOLLOW_PREFERENCES_V1,
            runReportPolicy: { preset: 'important' },
          }),
        );
        app.get(PROMPT_LIBRARY_ROWS_ROUTE_V1, async () =>
          PromptLibraryRowsListResponseV1Schema.parse({
            status: 'listed',
            rows: PromptLibraryCatalogKeyV1Schema.options.map((key) => ({
              key,
              revision: 1,
              content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) },
            })),
          }),
        );
        app.get('/v1/features', async () => features);
        app.get('/v1/features/authenticated', async () => features);
        const projectRows = createProjectAccountRowsHttpBoundary([]);
        for (const operation of ['list', 'read', 'mutate']) {
          app.post(
            `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/${operation}`,
            async (request, reply) => {
              const result = await projectRows(request.url, request.body);
              return reply.code(result.status).send(result.data);
            },
          );
        }
        app.post('/v1/home/governance/get', async (request) => {
          expect(
            HomeGovernanceGetInputV1Schema.parse(request.body).projection,
          ).toBe('session_defaults');
          return HomeSessionDefaultsProjectionV1Schema.parse({
            homeDefaults: null,
          });
        });
        const nativeFetch = globalThis.fetch;
        vi.stubGlobal(
          'fetch',
          async (
            input: Parameters<typeof fetch>[0],
            init?: Parameters<typeof fetch>[1],
          ) => {
            const url = new URL(
              typeof input === 'object' && 'url' in input
                ? input.url
                : String(input),
            );
            if (
              url.origin === origin &&
              url.pathname.startsWith('/v1/features')
            )
              return Response.json(features);
            return nativeFetch(input, init);
          },
        );
        const machineMetadata = MachinePublishedMetadataV1Schema.parse({
          host: 'chain-fixture',
          platform: process.platform,
          happyCliVersion: '0.0.0-test',
          homeDir,
          happyHomeDir: homeDir,
        });
        const readAgentIsolation = () =>
          readAgentIsolationSnapshot({
            metadata: {
              status: 'ready',
              metadata: machineMetadata,
              metadataVersion: 1,
            },
            daemonState: null,
            runtimeId: undefined,
            platform: process.platform,
          });
        app.get(`/v1/machines/${machineId}`, async () => ({
          machine: {
            id: machineId,
            active: true,
            installationId,
            installationPublicKey: Buffer.from(keys.publicKey).toString(
              'base64',
            ),
            kind: 'persistent',
            managedMachineRef: null,
            storageMode: 'plain',
            dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            metadata: encodePlainMachineStoredContent(machineMetadata),
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 0,
            revokedAt: null,
            replacedByMachineId: null,
            access: {
              custodian: { accountId, displayName: 'Owner' },
              role: 'manage',
              resourceMode: 'plain',
              accessState: 'ready',
            },
            operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: {
              sessionSpawn: { protocolVersions: [1, 2, 3, 4] },
              sessionSpawnPlacementOrigin: { protocolVersions: [1] },
            },
          },
        }));
        const transcript: unknown[] = [];
        const transportFailures: unknown[] = [];
        const transportResults: unknown[] = [];
        const reviewActionOutcomes: unknown[] = [];
        const activityHome = createSessionRuntimeActivityHomeStub({
          machineId,
        });
        const transcriptHome = createSessionTranscriptHomeStub();
        const parentSessions: ReturnType<
          typeof createChainParentSessionClient
        >[] = [];
        let sessionSocketOrigin: string | undefined;
        const sessionNetworkPeers = new Map<string, RpcHandlerManager>();
        let prepareSessionRequesterAccountContext:
          | PrepareExternalActionRequesterAccountContext
          | undefined;
        const runManagers: ExecutionRunHostBridge[] = [];
        const spawn = createSessionSpawnComposedBoundary({
          machineId,
          serverId,
          accountId,
          credentials,
          onSpawn: async (request) => {
            expect(request.requesterWorkAttributionV1).toMatchObject({
              accountId,
              machineId,
              installationId,
              serverId,
            });
            const sessionId = request.existingSessionId!;
            if (!prepareSessionRequesterAccountContext)
              throw new Error('Missing Home Session requester custody owner');
            expect(
              await runWithServerHttpBaseUrl(origin, () =>
                prepareActiveAccountRoleOverrides({
                  credentials,
                  scopeKey: resolveAccountSettingsScopeKeyForToken(token),
                  lifetimeToken:
                    getActiveAccountSettingsSnapshotLifetimeToken(),
                }),
              ),
            ).toMatchObject({ status: 'ready' });
            const bornRow = spawn.sessions.get(sessionId);
            if (!bornRow || !sessionSocketOrigin)
              throw new Error(
                'Missing committed parent Session or Home socket',
              );
            const parentSession = createChainParentSessionClient({
              row: bornRow,
              credentials,
              machineId,
              socketOrigin: sessionSocketOrigin,
              actionsSettingsProvider,
            });
            parentSessions.push(parentSession);
            const permissionHandler = createProviderEnforcedPermissionHandler({
              session: parentSession,
              logPrefix: '[triage-review-chain]',
              getAccountSettings: () => accountSettings,
            });
            permissionHandler.setPermissionMode('read-only');
            parentSession.setSessionRuntimeControls({
              readPermissionHandler: () => permissionHandler,
            });
            // The real client owns parent custody and transcript publication.
            // Home routes Run RPC only to this observed receiver; the client's
            // ordinary Run registrar is unused and closes with the client.
            const sessionRpc = new RpcHandlerManager({
              scopePrefix: sessionId,
              scopeKind: 'session',
              localMachineId: machineId,
              encryptionMode: 'plain',
              authorizeRequest: createSessionRpcAuthorization({
                sessionId,
                localMachineId: machineId,
                serverUrl: origin,
                isClosed: () => false,
                readHomeServerIdentityId: () => serverId,
              }),
              prepareRequesterAccountContext:
                prepareSessionRequesterAccountContext,
              logger() {},
            });
            sessionNetworkPeers.set(sessionId, sessionRpc);
            registerExecutionRunRpcHandlers(sessionRpc, {
              sessionId,
              cwd: request.directory,
              machineId,
              serverId,
              serverUrl: origin,
              runtimeAccountId: accountId,
              parentProvider: readAgentRoutingIdForContributionIdentity(
                indexAgentRoutingIdsByContributionIdentity(
                  source!.runtime.registry.contributes.agentDefinitionsById.values(),
                ),
                CHAIN_SESSION_AGENT_IDENTITY,
              )!,
              readPromptCredentials: async () => credentials,
              actionApprovalDeps: createExecutionRunRpcApprovalDeps({
                readCredentials: async () => credentials,
              }),
              resolveRunReportPolicy: createSessionRunReportPolicyReader({
                serverId,
                serverHttpBaseUrl: origin,
                accountId,
                readCredentials: async () => credentials,
                isCurrent: () => sessionNetworkPeers.has(sessionId),
              }),
              resolveAccountSettings: async () => accountSettings,
              readRequesterWorkAttributionV1: async () =>
                request.requesterWorkAttributionV1 ?? null,
              sessionInteractionHost: {
                session: parentSession,
                machineId,
                permissionHandler,
                readOwnerAccountCredentials: async () => credentials,
              },
              getPermissionRequestStore: () =>
                parentSession.getAgentStateRequestStore(),
              sendAcp: createCommittedExecutionRunTranscriptPublisher({
                enqueueAgentMessageCommitted:
                  parentSession.enqueueAgentMessageCommitted.bind(
                    parentSession,
                  ),
                readParentToolNormalizationSource: () => null,
              }),
              onManagerCreated: (manager) => {
                runManagers.push(manager);
              },
            });
          },
        });
        spawn.installRoutes(app);
        const rpc = new RpcHandlerManager({
          scopePrefix: machineId,
          encryptionMode: 'plain',
          logger() {},
          authorizeRequest: (request) =>
            authorizeMachineRpcRequest(request, {
              machineId,
              resolveHomeServerIdentityId: async () => serverId,
              resolveCustodianAccountId: async () => accountId,
              resolveInstallationId: () => installationId,
              readAgentIsolation,
              verifyMachineAdmission: async ({ context: admission }) =>
                admission.actorAccountId === accountId &&
                admission.custodianAccountId === accountId,
            }),
        });
        const filesystem = createFilesystemEffectAdmission({
          readAgentIsolation,
          resolveHomeServerIdentityId: async () => serverId,
          resolveHostIdentity: async () => ({
            machineId,
            installationId,
            custodianAccountId: accountId,
          }),
        });
        registerScmHandlers(rpc, repository.rootPath, {
          machineId,
          selectWorkspaceSource: filesystem.selectWorkspaceSource,
          admitWorkspaceSource: filesystem.rpc,
          resolveRequester: filesystem.resolveRpcRequester,
        });
        spawn.registerHandlers(rpc, filesystem);
        registerCapabilitiesHandlers(rpc, {
          filesystemEffectAdmission: filesystem,
        });
        registerDaemonContributionRegistryProjectionHandler(rpc);
        const direct = { machineId, invoke: rpc.invokeLocal.bind(rpc) };
        const definitions = createCommittedContributedActionDefinitionLister();
        const root = createCliActionExecutorHarness(
          {
            token,
            credentials,
            mode: 'plain',
            ctx: null,
            sessionId: '',
            serverId,
            serverIdentityId: serverId,
            serverHttpBaseUrl: origin,
            runtimeActionMachineId: machineId,
            actionsSettingsProvider,
            machineActionDirectTargetTransport: direct,
            externalActionMachineInstallationId: installationId,
            externalActionMachineRequestPrivateKey: keys.secretKey,
            resolveServerFeaturesSnapshot: async () => ({
              status: 'ready',
              features,
            }),
          },
          {
            invokeContributedAction:
              createDaemonExternalActionContributedInvoker(),
            listContributedActionDefinitions: definitions,
            readContributedActionSchemas:
              createCommittedContributedActionSchemaReader(definitions),
          },
        );
        const daemon = await startChainReviewDaemonAdmission({
          happyHomeDir: homeDir,
          serverId,
          machineId,
        });
        // These are the actual daemon's published OS-boundary bytes.
        const daemonState = JSON.parse(
          await readFile(daemon.statePath, 'utf8'),
        ) as Record<string, unknown>;
        await writeFile(
          daemon.statePath,
          JSON.stringify({ ...daemonState, machineId, accountId }),
        );
        const restoreHttp = installAxiosFastifyAdapter({ app, origin });
        let source:
          | Awaited<ReturnType<typeof createTriageGithubChainSource>>
          | undefined;
        try {
          const accountExecutor = createCliActionExecutor({
            token,
            credentials,
            mode: 'plain',
            ctx: null,
            sessionId: '',
            serverId,
            serverIdentityId: serverId,
            serverHttpBaseUrl: origin,
            actionsSettingsProvider,
            resolveServerFeaturesSnapshot: async () => ({
              status: 'ready',
              features,
            }),
            // The placement owner tries real Account Actions first. Its remote
            // port models the UI's Home transport, using real signed admission.
            requestPluginActionExecution: async (
              request,
              options,
              invocation,
            ) => {
              if (!invocation)
                throw new Error('Missing original Action identity');
              const context = invocation.context;
              if (!context?.authority)
                throw new Error('Missing admitted caller authority');
              return {
                matched: true,
                result: await dispatchOriginalAccountAction({
                  actionId: ActionIdSchema.parse(invocation.actionId),
                  input: request.input,
                  requestId: request.actionRequestId ?? randomUUID(),
                  target: context?.externalActionTarget ?? {
                    kind: 'machine',
                    machineId,
                  },
                  credentials,
                  serverHttpBaseUrl: origin,
                  serverIdentityId: serverId,
                  authority: context?.authority,
                  signal: options?.signal,
                  invocation: {
                    caller: { kind: 'host' },
                    surface: request.surface,
                    authority: context.authority,
                  },
                }),
              };
            },
          });
          await registerMachineActionHomeHttp(app, {
            machineId,
            serverId,
            serverIdentityId: serverId,
            serverHttpBaseUrl: origin,
            accountId,
            credentials,
            executionAuthorizationRefusals: [
              {
                token: foreignCredentials.token,
                statusCode: 403,
                body: {
                  error: 'credential_scope_denied',
                  failureCause: {
                    phase: 'execution_authorization',
                    errorClass: 'Error',
                    errorCode: 'machine_manage_required',
                    httpStatus: null,
                  },
                },
              },
            ],
            actionId: 'action.invoke',
            executor: root.executor,
            configureScopedRpcNetwork: ({
              server,
              issued,
              prepareRequesterAccountContext,
            }) => {
              prepareSessionRequesterAccountContext =
                prepareRequesterAccountContext;
              const socketAddress = server.httpServer.address();
              if (!socketAddress || typeof socketAddress === 'string')
                throw new Error('Missing listening Home socket address');
              sessionSocketOrigin = `http://127.0.0.1:${socketAddress.port}`;
              server.use((peer, next) => {
                const bearer = peer.handshake.auth.token;
                next(
                  bearer === credentials.token ||
                    bearer === tokenForAccount(accountId, 'terminal')
                    ? undefined
                    : new Error('Fixture Home socket bearer refused'),
                );
              });
              server.on('connection', (peer) => {
                peer.onAny((event: string, ...args: unknown[]) => {
                  if (event === SOCKET_RPC_EVENTS.REGISTER) {
                    const registration = args[0];
                    if (
                      registration &&
                      typeof registration === 'object' &&
                      'method' in registration &&
                      typeof registration.method === 'string'
                    )
                      peer.emit(SOCKET_RPC_EVENTS.REGISTERED, {
                        method: registration.method,
                      });
                    return;
                  }
                  const acknowledge = args.at(-1);
                  try {
                    const answer =
                      event === 'session-turn-mutation'
                        ? createSessionTurnMutationAppliedSocketAck(
                            SessionTurnMutationV1Schema.parse(args[0]),
                          )
                        : (activityHome.answer(event, args[0]) ??
                          transcriptHome.answer(event, args[0]));
                    if (answer !== null && typeof acknowledge === 'function') {
                      if (
                        event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1 ||
                        event === SESSION_TRANSCRIPT_OBSERVATION_BATCH_EVENT_V1
                      )
                        transcript.push(args[0]);
                      acknowledge(answer);
                    }
                  } catch (error) {
                    transportFailures.push({
                      event,
                      code: 'fixture_parent_session_ack_failed',
                      error:
                        error instanceof Error ? error.message : String(error),
                    });
                    if (typeof acknowledge === 'function')
                      acknowledge({ ok: false, error: 'invalid_request' });
                  }
                });
                peer.on(
                  SOCKET_RPC_EVENTS.CALL,
                  (
                    packet: SocketRpcRequestPayload,
                    acknowledge: (response: unknown) => void,
                  ) => {
                    let phase = 'session_peer';
                    void (async () => {
                      const separator = packet.method.indexOf(':');
                      const sessionId = packet.method.slice(0, separator);
                      const method = packet.method.slice(separator + 1);
                      const manager = sessionNetworkPeers.get(sessionId);
                      if (!manager)
                        throw new Error('Home has no born Session RPC peer');
                      phase = 'signed_execution';
                      const execution =
                        packet.externalActionExecution === undefined
                          ? undefined
                          : ExternalActionMachineRpcExecutionV1Schema.parse(
                              packet.externalActionExecution,
                            );
                      if (execution) {
                        expect(
                          issued.get(execution.authorization.token)?.binding,
                        ).toEqual(execution.authorization.binding);
                        expect(
                          verifyExternalActionMachineRpcRequestV1({
                            authorizationToken: execution.authorization.token,
                            requesterAccountContext:
                              execution.authorization.requesterAccountContext,
                            reviewedChild: execution.reviewedChild,
                            effectActionId: execution.effectActionId,
                            target: execution.target,
                            installationId: execution.installationId,
                            event: SOCKET_RPC_EVENTS.CALL,
                            method: packet.method,
                            requestId: SocketRpcRequestIdSchema.parse(
                              packet.requestId,
                            ),
                            params: packet.params,
                            signature: execution.machineSignature,
                            publicKey: keys.publicKey,
                          }),
                        ).toBe(true);
                      }
                      phase = 'session_authorization';
                      const authorization =
                        resolveSocketRpcSameAccountSessionAuthorizationV1(
                          method,
                          sessionId,
                          { admittedAgentStart: execution !== undefined },
                        );
                      if (!authorization)
                        throw new Error(
                          'Session RPC requires a separate Home admission',
                        );
                      phase = 'session_receiver';
                      const result = await runWithServerHttpBaseUrl(
                        origin,
                        () =>
                          manager.handleRequest(
                            {
                              method: packet.method,
                              params: packet.params,
                              requestId: packet.requestId,
                              authorization,
                              ...(execution
                                ? {
                                    callerAuthority:
                                      resolveExternalActionRootInvocationAuthority(
                                        execution.authorization,
                                      ),
                                    callerInputAuthorization:
                                      execution.authorization,
                                    ...(execution.authorization.binding
                                      .sessionActionOrigin
                                      ? {
                                          sessionActionOrigin:
                                            execution.authorization.binding
                                              .sessionActionOrigin,
                                        }
                                      : {}),
                                  }
                                : {}),
                            },
                            undefined,
                            'authenticated_home_socket',
                          ),
                      );
                      transportResults.push({
                        method: packet.method,
                        ...(result &&
                        typeof result === 'object' &&
                        'errorCode' in result
                          ? { errorCode: result.errorCode }
                          : {}),
                      });
                      acknowledge(
                        projectSocketRpcTargetAcknowledgementV1(result),
                      );
                    })().catch(() => {
                      transportFailures.push({
                        method: packet.method,
                        phase,
                        code: 'fixture_session_rpc_delivery_failed',
                      });
                      acknowledge({
                        ok: false,
                        errorCode: 'fixture_session_rpc_delivery_failed',
                        error: 'Session RPC delivery failed',
                      });
                    });
                  },
                );
              });
            },
            installation: {
              version: 1,
              installationId,
              createdAt: 1,
              privateKey: Buffer.from(keys.secretKey).toString('base64url'),
              publicKey: Buffer.from(keys.publicKey).toString('base64url'),
            },
          });
          source = await createTriageGithubChainSource({
            app,
            origin,
            accountId,
            serverId,
            machineId,
            credentials,
            baseSha,
            headSha,
            happyHomeDir: homeDir,
            controller: pluginReloadController,
            additionalPlugins: [
              createChainReviewerPluginRecipe({
                observeReviewAction: (payload) =>
                  reviewActionOutcomes.push(payload.outcome),
              }),
            ],
            runtimeOptions: {
              resolveAuthenticatedAccountId: async () => accountId,
              externalActionHomeBinding: {
                serverId,
                serverIdentityId: serverId,
                externalActionMachineInstallationId: installationId,
                externalActionMachineRequestPrivateKey: keys.secretKey,
              },
              machineActionDirectTargetTransport: direct,
            },
          });
          const receiveMachine = async (
            params: Parameters<typeof machineRpc.callExactMachineRpc>[0],
          ) => {
            expect(params.machineId).toBe(machineId);
            const context = params.externalAction?.context;
            const authorization = context?.externalActionExecutionAuthorization;
            // Home also classifies ordinary authenticated Machine RPC. Native
            // folder preflight deliberately uses that route without an Action
            // envelope; no unsigned local custody crosses this boundary.
            const actorAccountId =
              authorization?.binding.accountId ??
              readAccountIdFromToken(params.credentials.token);
            if (!authorization)
              expect([
                credentials.token,
                tokenForAccount(accountId, 'terminal'),
              ]).toContain(params.credentials.token);
            expect(actorAccountId).toBe(accountId);
            return direct
              .invoke(
                params.method,
                params.prepareRequest
                  ? params.prepareRequest()
                  : params.request,
                {
                  signal: params.signal,
                  localActionContext: params.operationContext ?? context,
                  rpcContext: {
                    callerAuthority:
                      context?.authority ??
                      readAuthTokenProvenance(
                        decodeJwtPayload(params.credentials.token),
                        { allowLegacyHome: false },
                      )?.provenance.authority,
                    ...(authorization
                      ? {
                          callerInputAuthorization: authorization,
                        }
                      : {}),
                    machineAdmission: {
                      actorAccountId,
                      custodianAccountId: accountId,
                      machineId,
                      installationId,
                      role: 'manage',
                      encryptionMode: 'plain',
                    },
                    verifyMachineAdmissionCurrent: async () =>
                      actorAccountId === accountId,
                  },
                },
              )
              .then((result) => {
                transportResults.push({
                  method: params.method,
                  ...(result &&
                  typeof result === 'object' &&
                  'errorCode' in result
                    ? { errorCode: result.errorCode }
                    : {}),
                });
                return result;
              })
              .catch((error) => {
                transportFailures.push({
                  method: params.method,
                  error:
                    error instanceof Error
                      ? {
                          name: error.name,
                          message: error.message,
                          stack: error.stack,
                        }
                      : error,
                });
                throw error;
              });
          };
          vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(
            receiveMachine,
          );
          vi.spyOn(machineRpc, 'callMachineRpc').mockImplementation(
            receiveMachine,
          );
          await app.ready();
          await runWithServerHttpBaseUrl(origin, async () => {
            const sourceInstanceId =
              await source!.configureSource(accountExecutor);
            for (const scenario of [
              'other-account',
              'unauthenticated',
              'owner',
            ] as const) {
              const birthsBefore = spawn.births.length;
              const managersBefore = runManagers.length;
              const input = source!.buildStartInput({
                sourceInstanceId,
                directory: repository.rootPath,
                agentTarget: {
                  kind: 'agent',
                  identity: CHAIN_SESSION_AGENT_IDENTITY,
                },
              });
              const refusals: unknown[] = [];
              const executeAction = async (
                action: string | { pluginId: string; localId: string },
                actionInput: unknown,
              ) => {
                const ref =
                  typeof action === 'string'
                    ? { pluginId: 'happier.triage', localId: action }
                    : action;
                const wrapper = { action: ref, input: actionInput };
                const target = { kind: 'machine' as const, machineId };
                const requestId = randomUUID();
                if (scenario === 'other-account') {
                  // Another client's bearer is refused at Home before it can
                  // acquire this process's Account runtime or Machine custody.
                  const result = await dispatchOriginalAccountAction({
                    actionId: 'action.invoke',
                    input: wrapper,
                    requestId,
                    target,
                    credentials: foreignCredentials,
                    serverHttpBaseUrl: origin,
                    serverIdentityId: serverId,
                    authority: 'present_user',
                    invocation: {
                      caller: { kind: 'host' },
                      surface: 'cli',
                      authority: 'present_user',
                    },
                  });
                  refusals.push(result);
                  throw Object.assign(new Error('Action refused'), {
                    failure: result,
                  });
                }
                if (scenario !== 'unauthenticated') {
                  const result = await accountExecutor.execute(
                    'action.invoke',
                    wrapper,
                    {
                      surface: 'cli',
                      authority: 'present_user',
                      serverId,
                      serverIdentityId: serverId,
                      externalActionTarget: target,
                      actionRequestId: requestId,
                    },
                  );
                  if (!result.ok) {
                    refusals.push(result);
                    throw Object.assign(
                      new Error(
                        JSON.stringify({
                          action: ref,
                          result,
                          transportFailures,
                          homeErrors,
                        }),
                      ),
                      {
                        failure: result,
                      },
                    );
                  }
                  expect(result, JSON.stringify(result)).toMatchObject({
                    ok: true,
                  });
                  return result.result;
                }
                // A contribution has no person-host authority. The real reviewed
                // child port carries policy admission, never requester credentials.
                const context: ActionExecutorContext = {
                  surface: 'cli',
                  authority: 'account_automation',
                  serverId,
                  serverIdentityId: serverId,
                  actionRequestId: requestId,
                  externalActionTarget: target,
                };
                const result = (
                  await executeContributedAction({
                    runtimeRegistry: source!.runtime.registry,
                    actionId: `${ref.pluginId}/${ref.localId}`,
                    input: actionInput,
                    approvalContext: {
                      ...context,
                      hostReviewedChild: createHostReviewedChildPortV1({
                        actionId: 'action.invoke',
                        input: wrapper,
                        context,
                        reviewAdmitted: true,
                      }),
                    },
                    context: { surface: 'cli', invocationSurface: 'cli' },
                  })
                ).result;
                if (!result?.ok) {
                  refusals.push(result);
                  throw Object.assign(new Error('Action refused'), {
                    failure: result,
                  });
                }
                return result.result;
              };
              if (scenario !== 'owner') {
                await expect(
                  submitTriageEntrySessionStart({ executeAction }, input),
                ).rejects.toBeDefined();
                expect(refusals).toEqual(
                  scenario === 'other-account'
                    ? [
                        expect.objectContaining({
                          ok: false,
                          errorCode: 'credential_scope_denied',
                          failureCause: expect.objectContaining({
                            errorCode: 'machine_manage_required',
                          }),
                        }),
                      ]
                    : [
                        expect.objectContaining({
                          ok: false,
                          errorCode: 'filesystem_identity_custody_unavailable',
                          data: expect.objectContaining({
                            details: expect.objectContaining({
                              reason: 'requester_identity_unavailable',
                            }),
                          }),
                        }),
                      ],
                );
                expect(spawn.births).toHaveLength(birthsBefore);
                expect(runManagers).toHaveLength(managersBefore);
                continue;
              }
              const started = await submitTriageEntrySessionStart(
                { executeAction },
                input,
              );
              expect(
                started,
                JSON.stringify({
                  started,
                  acceptedWorkspaces: spawn.acceptedWorkspaces.map(
                    ({ sessionId, phase, metadata }) => ({
                      sessionId,
                      phase,
                      path: metadata.path,
                      workspaceId: metadata.workspaceId,
                    }),
                  ),
                  transportFailures,
                  nativeResults: spawn.nativeResults,
                  failures: spawn.failures.map((error) =>
                    error instanceof Error
                      ? {
                          name: error.name,
                          message: error.message,
                          stack: error.stack,
                        }
                      : error,
                  ),
                  httpFailures: spawn.httpFailures.map(({ url, error }) => ({
                    url,
                    error:
                      error instanceof Error
                        ? {
                            name: error.name,
                            message: error.message,
                            stack: error.stack,
                          }
                        : error,
                  })),
                }),
              ).toMatchObject({
                type: 'linked',
                disposition: 'created',
                review: {
                  observed: { baseSha, headSha },
                  workspace: { serverId, machineId },
                },
              });
              if (started.type !== 'linked' || !started.review)
                throw new Error('Expected the retained Review continuation');
              expect(spawn.births).toHaveLength(1);
              const engineId = buildBackendTargetKeyV2({
                kind: 'agent',
                identity: CHAIN_REVIEWER_IDENTITY,
              });
              const enginePicker = await root.executor.execute(
                'review.engines.list',
                {
                  sessionId: started.sessionId,
                  includeDisabled: true,
                  engineIds: [engineId],
                  scope: 'worktree',
                },
                {
                  surface: 'cli',
                  authority: 'present_user',
                  serverId,
                  serverIdentityId: serverId,
                  externalActionTarget: {
                    kind: 'session',
                    sessionId: started.sessionId,
                  },
                },
              );
              expect(
                enginePicker,
                JSON.stringify({ enginePicker, transportResults }),
              ).toMatchObject({ ok: true });
              if (!enginePicker.ok)
                throw new Error('Review engine picker refused');
              const inventory = ReviewEngineInventorySchema.parse(
                enginePicker.result,
              );
              expect(inventory.items, JSON.stringify(inventory)).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({
                    value: engineId,
                    enabled: true,
                    available: true,
                  }),
                ]),
              );
              // The mounted chooser uses the canonical Review composition;
              // this is the person's explicit selection at that UI boundary.
              const prepared =
                await prepareTriagePullRequestReviewContinuationV1(
                  {
                    executeAction,
                    selectActionInput: async (request) => {
                      expect(request).toMatchObject({
                        hostAction: {
                          action: 'review.start',
                          projection: 'composition',
                        },
                        sessionId: started.sessionId,
                      });
                      return {
                        kind: 'reviewComposition',
                        input: ReviewStartInputSchema.parse({
                          reviewers: [
                            {
                              kind: 'engine',
                              engineId,
                              modelSelection: null,
                            },
                          ],
                          instructions: 'Review this captured pull request.',
                        }),
                      };
                    },
                  },
                  {
                    actionId: 'review',
                    sessionId: started.sessionId,
                    review: started.review,
                    instructions: 'Review this captured pull request.',
                  },
                  undefined,
                );
              expect(prepared.kind).toBe('ready');
              if (prepared.kind !== 'ready')
                throw new Error('The mounted Review chooser did not prepare');
              const continuation = settleTriagePullRequestReviewContinuationV1(
                await executeAction(
                  TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1,
                  prepared.input,
                ),
              );
              expect(
                continuation,
                JSON.stringify({
                  continuation,
                  transportResults,
                  transportFailures,
                  reviewActionOutcomes,
                  homeErrors,
                }),
              ).toMatchObject({
                kind: 'settled',
                result: {
                  status: 'accepted',
                  reviewResult: { results: [{ ok: true }] },
                },
              });
              if (continuation.kind === 'settled')
                expect(continuation.result).not.toHaveProperty('failure');
              for (const manager of runManagers)
                for (const run of manager.listPublic())
                  await manager.waitForTerminal(run.runId);
              expect(
                runManagers.flatMap((manager) => manager.listPublic()),
              ).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({ status: 'succeeded' }),
                ]),
              );
              expect(daemon.admissionRequests).toEqual(
                expect.arrayContaining([{ status: 200 }]),
              );
              const relation = await source!.readRelation(accountExecutor, {
                sourceInstanceId,
                entryRef: input.entryRef,
              });
              if (
                continuation.kind !== 'settled' ||
                !('review' in continuation.result) ||
                !continuation.result.review
              ) {
                throw new Error(
                  'The launcher did not return an admitted Review',
                );
              }
              const review = continuation.result.review;
              expect(review.reviewId).toEqual(expect.any(String));
              expect(relation).toMatchObject({
                kind: 'read',
                admittedReview: review,
                linkedSessions: expect.arrayContaining([
                  expect.objectContaining({ sessionId: started.sessionId }),
                ]),
              });
              expect(transcript.length).toBeGreaterThan(0);
              const row = source!.artifacts.read(review.reviewId);
              expect(row?.ownerAccountId).toBe(accountId);
              if (!row)
                throw new Error('The admitted Review was not persisted');
              expect(
                ReviewArtifactHeaderV1Schema.parse(
                  decodePlainArtifactStoredContent(row.header),
                ),
              ).toMatchObject({
                reviewId: review.reviewId,
                requestedBy: { actorKind: 'person', accountId },
              });
              expect(refusals).toEqual([]);
              expect(transportFailures).toEqual([]);
              expect(spawn.failures).toEqual([]);
              expect(spawn.httpFailures).toEqual([]);
            }
          });
        } finally {
          sessionNetworkPeers.clear();
          for (const manager of runManagers) await manager.dispose();
          for (const session of parentSessions) await session.close();
          await spawn.close();
          await source?.dispose();
          restoreHttp();
          await daemon.close();
          await app.close();
          await rm(repository.rootPath, { recursive: true, force: true });
          await rm(remote.remotePath, { recursive: true, force: true });
        }
      },
    ),
  // Real authored Account runtime compilation and the full native chain exceed
  // the unit lane's budget; use the repository's composed-journey budget.
  240_000,
);
