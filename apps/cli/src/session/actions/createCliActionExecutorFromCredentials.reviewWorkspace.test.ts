import type { ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionSurfaceSchema } from '@happier-dev/protocol/actions/metadata';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import axios from 'axios';
import Fastify from 'fastify';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { ActionApprovalRequestCreatedResultSchema, buildWorktreeRelativePath, createActionExecutor,
  readActionOperationTerminalResultV1 } from '@happier-dev/protocol';
import { ActionExecuteResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import { join } from 'node:path';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { ActionOperationDeclarationV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import nacl from 'tweetnacl';
import { configuration } from '@/configuration';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { updateSettings } from '@/persistence';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createLocalScmRepositoryFixture, runScmExecutable } from '@/testkit/scm/scmBackendContractFixtures';
import { removeTempDir } from '@/testkit/fs/tempDir';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { registerDaemonContributionRegistryProjectionHandler } from '@/rpc/handlers/daemonContributionRegistryProjection';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent } from '@/api/machine/machineRpcAuthorization';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { readStructuredMessageActionRoutingV1 } from '@happier-dev/protocol/plugins/actions/daemonInvocationV1';
import { createCliActionDeps } from './createCliActionDeps';
import { createPluginInvocationActionsService } from '@/plugins/runtime/invocation/services/actions';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { registerAccountHomeHttp, registerPlainArtifactRoutes } from './widgetApproval.testkit';
import { createConnectedServiceCredentialApi } from '@/api/client/connectedServiceCredentialApi';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { prepareGithubTriageReviewWorkspace, verifyGithubTriageReviewWorkspace } from '../../../../../packages/plugins/scm-github/src/triage/operations';
import { PLUGIN_MANIFEST as GITHUB_MANIFEST, GITHUB_TRIAGE_ACTION_IDS_V1 } from '../../../../../packages/plugins/scm-github/src/manifest';
import { encodeGithubTriageConfiguration } from '../../../../../packages/plugins/scm-github/src/triage/configuration';
import { createStubGithubTransport, GITHUB_TEST_ACCOUNT } from '../../../../../packages/plugins/scm-github/src/triage/testkit/githubTriage.test-support';
import { GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_PLUGIN_ID } from '../../../../../packages/plugins/scm-github/src/observations/githubProviderContracts';
import { GITHUB_PULL_REQUEST_RESPONSE } from '../../../../../packages/plugins/scm-github/src/triage/__fixtures__/githubResponses';

afterEach(() => vi.restoreAllMocks());
afterAll(() => pluginReloadController.shutdown());

it.each(['verify', 'prepare', 'approval-prepare', 'approval-verify', 'approval-reject', 'approval-cancel', 'owner-verify', 'owner-prepare', 'owner-foreign-use', 'owner-foreign-manage',
  'owner-unadmitted', 'owner-retarget', 'owner-home'] as const)('runs mounted source %s through its serving Machine SDK executor without minting an Account root', async shape => {
  const approvalShape = shape.startsWith('approval-');
  await withConfiguredDaemonTestHome({ prefix: 'review-workspace-child-',
    env: { HAPPIER_SERVER_URL: 'https://review-home.test', HAPPIER_WEBAPP_URL: 'https://review-home.test' } }, async ({ homeDir }) => {
    const machineId = 'review-machine';
    const accountId = 'review-account';
    const serverId = configuration.activeServerId;
    await updateSettings(settings => ({ ...settings, machineIdByServerId: {
      ...settings.machineIdByServerId, [serverId]: machineId,
    } }));
    const repository = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'review-child-' });
    const root = repository.rootPath;
    const sourceHeadSha = repository.headCommit;
    const sourceUrl = approvalShape ? 'https://github.com/octo-org/example-app.git' : 'https://github.com/example/repository.git';
    runScmExecutable(root, 'git', ['remote', 'add', 'source', sourceUrl]);
    runScmExecutable(root, 'git', ['config', `url.file://${root}.insteadOf`, sourceUrl]);
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
    const machine = { id: machineId, managedMachineRef: null, kind: 'persistent', active: true,
      installationId: 'review-installation', revokedAt: null, replacedByMachineId: null,
      dataEncryptionKey: null, runnerContentKeyBinding: null,
      installationPublicKey: Buffer.from(keys.publicKey).toString('base64'),
      access: { custodian: { accountId, displayName: 'Reviewer' }, role: 'manage',
        resourceMode: 'plain', accessState: 'ready' } };
    const approvalHome = approvalShape ? Fastify() : null;
    const approvalChannel = approvalHome ? await createRequesterCurrentnessSocketHarness() : null;
    const approvalPaths: string[] = [];
    let restoreHttp: (() => void) | undefined;
    if (approvalHome) {
      approvalHome.addHook('onRequest', async request => { approvalPaths.push(request.url); });
      const features = registerAccountHomeHttp(approvalHome, { accountId, serverId: 'srv_review_home' });
      registerPlainArtifactRoutes(approvalHome, accountId);
      approvalHome.get('/v1/features', async () => features);
      approvalHome.get('/v1/features/authenticated', async () => features);
      approvalHome.get('/v1/machines', async () => [machine]);
      approvalHome.get('/v1/machines/:id', async () => ({ machine }));
      approvalHome.post('/v1/machines/:id/admission/verify', async () => ({ v: 1, ok: true }));
      restoreHttp = installAxiosFastifyAdapter({ app: approvalHome, origin: 'https://review-home.test' });
    }
    const originalPost = axios.post.bind(axios);
    const originalGet = axios.get.bind(axios);
    // HTTP is the boundary. Mounted source dispatch, the runtime's SDK
    // executor, Machine selection and Git verification all remain real.
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, data, config) => {
      if (approvalHome) return originalPost(url, data, config);
      if (String(url).endsWith(`/v1/machines/${machineId}/admission/verify`)) return { status: 200, data: { v: 1, ok: true } };
      // The reported Home refuses an Account-root mint for this plugin-only
      // child. Local execution must consume the original Machine admission.
      return { status: 403, data: { error: 'invalid_request', code: 'credential_scope_denied' } };
    });
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => approvalHome ? originalGet(url, config) : String(url).includes('/v1/artifacts/')
      // This Account has no stored policy/approval artifacts. The real artifact
      // reader owns absence; a features-shaped success is an invalid artifact.
      ? { status: 404, data: { error: 'not_found' } }
      : String(url).endsWith('/v1/account/encryption')
      ? { status: 200, data: { mode: 'plain', updatedAt: 1 } }
      : String(url).endsWith('/v1/machines') ? { status: 200, data: [machine] }
      : String(url).includes('/v1/machines/') ? { status: 200, data: { machine } }
      : { status: 200, data: { features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_review_home' } } } });
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`,
      encryption: null, credentialProvenance: 'stored_session' as const };
    const input = { cwd: root, displayName: 'source', sourceTip: {
      repository: { kind: 'github' as const, deployment: 'github.com', repository: 'example/repository' },
      cloneUrl: sourceUrl, branch: 'source', sourceHeadSha, fetchRef: `refs/heads/${repository.branchName}`,
    }, ...(shape.endsWith('verify') ? { verification: { targetPath: root } } : {}) };
    if (approvalShape) runScmExecutable(root, 'git', ['branch', 'source']);
    const triage = createTriageSourceV1Fixture();
    const providerInput = { v: 1, instance: { ...triage.configuredInstance,
      instance: { ...triage.configuredInstance.instance, source: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' } },
      binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, account: GITHUB_TEST_ACCOUNT }, localInstanceKey: 'github.com',
      configuration: { v: 1, token: encodeGithubTriageConfiguration({ v: 1, scope: { kind: 'account' } }) } },
      entryRef: { source: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' }, kindId: 'pull-request', collisionScope: 'github:4210', entryId: '1284' },
      lastKnownLocator: { v: 1, routingToken: 'octo-org/example-app' },
      observed: { baseSha: sourceHeadSha, headSha: sourceHeadSha, nativeRevision: sourceHeadSha, observedAtMs: 1_700_000_000_000 },
      workspace: { serverId, machineId, rootPath: root },
      ...(shape === 'approval-verify' ? { prepared: { kind: 'acceptedCheckout' as const, repositoryPath: root } } : {}) };
    const github = createStubGithubTransport({ respond: request => request.url.endsWith('/pulls/1284')
      ? { status: 200, body: { ...GITHUB_PULL_REQUEST_RESPONSE,
        head: { ...(GITHUB_PULL_REQUEST_RESPONSE.head as Readonly<Record<string, unknown>>), ref: 'source', sha: sourceHeadSha,
          repo: { id: 4210, full_name: 'octo-org/example-app', name: 'example-app', owner: { login: 'octo-org' }, clone_url: sourceUrl } },
        base: { ...(GITHUB_PULL_REQUEST_RESPONSE.base as Readonly<Record<string, unknown>>), sha: sourceHeadSha },
      } } : undefined });
    let sourceEntered = false;
    const source = definePlugin({ id: 'example.review-source', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
      actions: { prepare: { title: 'Prepare review workspace', surfaces: ['ui'], dangerLevel: 'writesLocal',
        ...(approvalShape ? { operation: ActionOperationDeclarationV1Schema.parse(GITHUB_MANIFEST.contributes.actions?.find(
          action => action.id === (shape === 'approval-verify' ? GITHUB_TRIAGE_ACTION_IDS_V1.verifyReviewWorkspace
            : GITHUB_TRIAGE_ACTION_IDS_V1.prepareReviewWorkspace))?.operation) } : {}),
        confirmation: { title: 'Prepare workspace', confirmLabel: 'Prepare' }, confirmationWhen: { presentUserUi: false },
        inputSchema: { type: 'object', additionalProperties: approvalShape },
        run: async (_input, context) => {
          sourceEntered = true;
          if (approvalShape) expect(await createConnectedServiceCredentialApi(credentials)
            .getAccountEncryptionMode({ throwOnTransportError: true })).toBe('plain');
          if (approvalShape) return (shape === 'approval-verify' ? verifyGithubTriageReviewWorkspace : prepareGithubTriageReviewWorkspace)(_input, { ...github.context,
            signal: context.signal, services: { ...github.context.services, actions: context.services.actions } },
            { now: () => 1_700_000_000_000 });
          return context.services.actions.execute('scm.reviewWorkspace.materializePrepared', input);
        },
      } } });
    const runtime = await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir: homeDir, controller: pluginReloadController,
      plugins: [{ manifest: { ...source.manifest, contributes: { ...source.manifest.contributes,
        ui: { renderers: [{ id: 'panel', kind: 'declarative', root: { kind: 'text', text: 'Review' } }],
          views: [{ id: 'page', container: 'appPage', target: { kind: 'app' }, renderer: 'panel' }] } } }, files: { 'daemon.mjs': 'export function activate() {}' },
        instantiateCommittedModule: () => ({ activate: source.activate }) }],
      runtimeOptions: { pluginIds: [source.manifest.id, 'happier.scm.backend.git'],
        scopedActionRuntime: { credentials,
          // Approval persistence has its own composed tests. This Account has
          // deliberately waived the plugin child's confirmation, so this
          // fixture exercises Machine custody and real Git materialization.
          actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({
            actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: {
              'scm.reviewWorkspace.materializePrepared': approvalShape ? [] : ['plugin'],
            } },
          }) }) },
        resolveCurrentMachineId: () => machineId,
        resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'srv_review_home', machineId }),
        externalActionHomeBinding: { serverId, serverIdentityId: 'srv_review_home',
          externalActionMachineInstallationId: 'review-installation', externalActionMachineRequestPrivateKey: keys.secretKey },
      } });
    try {
      const operations = createHostActionOperationRuntime({ serverId, machineId, resolveAccountId: async () => accountId });
      const rpc = new RpcHandlerManager({ scopePrefix: machineId, encryptionMode: 'plain', logger: () => {},
        authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId,
          resolveHomeServerIdentityId: async () => 'srv_review_home',
          resolveCustodianAccountId: async () => accountId, resolveInstallationId: () => 'review-installation',
          verifyMachineAdmission: admission => verifyMachineRpcAdmissionCurrent({ ...admission,
            privateKey: keys.secretKey, daemonToken: credentials.token, serverHttpBaseUrl: 'https://review-home.test' }),
        }) });
      registerDaemonContributionRegistryProjectionHandler(rpc, {
        resolveRuntimeRegistry: async () => runtime.registry, resolveInstalledPackages: async () => [],
        resolvePluginProjectionExecutionOriginContext: () => ({ serverIdentityId: 'srv_review_home', machineId }),
        observePluginExecution: async request => {
          if (approvalShape) {
            // Observe the real mounted ingress before handing it unchanged to
            // the finite owner; no custody is supplied by the deciding caller.
            expect(request.rpcContext?.machineAdmission).toMatchObject({
              actorAccountId: accountId, custodianAccountId: accountId, machineId, role: 'manage',
            });
            expect(typeof request.rpcContext?.verifyMachineAdmissionCurrent).toBe('function');
            expect(request.rpcContext?.externalActionExecutionAuthorization).toBeUndefined();
            expect(request.rpcContext ?? {}).not.toHaveProperty('externalActionCredential');
          }
          return operations.observePluginExecution(request);
        },
      });
      const occurrenceId = runtime.registry.readPluginOccurrenceId?.(source.manifest.id);
      const sourceCustody = runtime.registry.readPluginSourceCustody?.(source.manifest.id);
      const materializationRef = runtime.registry.resolveCurrentPluginMaterializationRef?.(source.manifest.id);
      if (!occurrenceId || !sourceCustody || !materializationRef) throw new Error('Expected admitted mounted source');
      const request = { machineId, qualifiedActionId: `${source.manifest.id}/prepare`,
        requestId: 'mounted-review-workspace',
        expectedContributorOccurrenceId: occurrenceId, executionSurface: 'ui' as const, input: approvalShape ? providerInput : {},
        invocation: { kind: 'mountedPluginSurface' as const, mountedBinding: {
          pluginId: source.manifest.id, contributionLocalId: 'page', occurrenceId, sourceCustody, materializationRef,
        } } };
      const structuredMessageRouting = readStructuredMessageActionRoutingV1(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE, request);
      if (!structuredMessageRouting) throw new Error('Expected exact source Action routing');
      const packet = { method: `${machineId}:${RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE}`,
        params: request, callerAuthority: 'present_user' as const, machineAdmission: {
          actorAccountId: accountId, custodianAccountId: accountId, machineId, installationId: 'review-installation',
          role: 'manage' as const, encryptionMode: 'plain' as const, structuredMessageRouting,
        } };
      const service = createPluginInvocationActionsService({
        seed: { plugin: { id: source.manifest.id, version: source.manifest.version }, occurrenceId, sourceCustody,
          resolveCurrentPluginMaterializationRef: () => materializationRef,
          surface: 'plugin', signal: new AbortController().signal, isOccurrenceCurrent: () => true,
          approvalContext: { surface: 'ui', authority: 'present_user', runtimeAccountId: accountId,
            serverId: shape === 'owner-home' ? `${serverId}-other` : serverId,
            ...(shape === 'owner-unadmitted' ? {} : {
              machineAdmission: { ...packet.machineAdmission,
                actorAccountId: shape.startsWith('owner-foreign') ? 'another-account' : accountId,
                role: shape === 'owner-foreign-use' ? 'use' as const : 'manage' as const },
              verifyMachineAdmissionCurrent: async () => { throw new Error('Finite children must not re-admit the parent'); },
            }),
            externalActionTarget: { kind: 'machine', machineId: shape === 'owner-retarget' ? 'other-machine' : machineId },
          } satisfies RpcActionExecutorContext },
        actionExecutor: createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"scm.reviewWorkspace.materializePrepared": Object.keys(ActionSurfaceSchema.shape), "approval.request.decide": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }), ...createCliActionDeps({ token: credentials.token, credentials,
          serverId, serverIdentityId: 'srv_review_home', externalActionMachineInstallationId: 'review-installation',
          serverHttpBaseUrl: 'https://review-home.test', sessionId: '', mode: 'plain', ctx: null }) }),
        invokeContributedAction: async () => ({ status: 'unavailable', code: 'not_used', message: 'not_used' }),
      });
      const denial = shape === 'owner-foreign-use' || shape === 'owner-unadmitted' ? 'filesystem_identity_custody_unavailable'
        : shape === 'owner-retarget' ? 'target_unavailable' : shape === 'owner-home' ? 'server_scope_mismatch' : null;
      if (denial) {
        const before = runScmExecutable(root, 'git', ['worktree', 'list', '--porcelain']);
        await expect(service.execute('scm.reviewWorkspace.materializePrepared', input)).rejects.toMatchObject({ code: denial });
        expect(runScmExecutable(root, 'git', ['worktree', 'list', '--porcelain'])).toBe(before);
        expect(post.mock.calls).toHaveLength(0);
        return;
      }
      let result: ActionExecuteResult = ActionExecuteResultSchema.parse(shape.startsWith('owner-')
        ? { ok: true, result: await service.execute('scm.reviewWorkspace.materializePrepared', input) }
        : await rpc.handleRequest(packet));
      const targetPath = shape.endsWith('verify') ? root : join(root, buildWorktreeRelativePath('source'));
      if (approvalShape) {
        const receipt = ActionApprovalRequestCreatedResultSchema.parse(result.ok ? result.result : null);
        const held = operations.store.findByRequestIdentity({ accountId, machineId }, request.qualifiedActionId, request.requestId);
        expect(held).toMatchObject({ state: 'running', progress: { phase: 'waiting_for_approval', approval: receipt } });
        if (shape !== 'approval-verify') expect(runScmExecutable(root, 'git', ['worktree', 'list', '--porcelain'])).not.toContain(targetPath);
        const decider = createCliActionExecutorHarness({ token: credentials.token, credentials, sessionId: '', mode: 'plain', ctx: null,
          serverId, serverIdentityId: 'srv_review_home', serverHttpBaseUrl: 'https://review-home.test' });
        const decision = shape === 'approval-reject' ? 'reject' : shape === 'approval-cancel' ? 'cancel' : 'approve';
        const decided = await decider.executor.execute('approval.request.decide', { artifactId: receipt.artifactId, decision },
          { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, runtimeAccountId: accountId,
            serverId, serverIdentityId: 'srv_review_home', actionRequestId: 'approve-review-workspace' });
        expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true });
        if (!held) throw new Error('Expected retained source operation');
        const terminal = await operations.handlers.getV2({ operationId: held.operationId, waitForTerminal: true });
        if (decision !== 'approve') {
          expect(terminal, JSON.stringify({ decided, terminal })).toMatchObject({ kind: 'found', operation: {
            state: 'failed',
            error: { errorCode: decision === 'reject' ? 'approval_rejected' : 'approval_canceled' },
          } });
          expect(runScmExecutable(root, 'git', ['worktree', 'list', '--porcelain'])).not.toContain(targetPath);
          expect(post.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/v1/artifacts')).toHaveLength(1);
          return;
        }
        expect(terminal, JSON.stringify({ decided, terminal })).toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
        if (terminal.kind !== 'found') throw new Error('Expected settled source operation');
        const settled = readActionOperationTerminalResultV1(terminal.operation);
        if (!settled) throw new Error('Expected terminal source result');
        result = settled;
      }
      expect(result, JSON.stringify({ result, sourceEntered, approvalPaths,
        getPaths: get.mock.calls.map(([url]) => new URL(String(url)).pathname),
        postPaths: post.mock.calls.map(([url]) => new URL(String(url)).pathname) })).toMatchObject(approvalShape
          ? { ok: true, result: shape === 'approval-verify' ? { kind: 'verified' }
            : { kind: 'prepared', repositoryPath: targetPath, created: true } }
          : { ok: true, result: { success: true,
            ...(shape.endsWith('verify') ? { verification: { targetPath, sourceHeadSha } } : { targetPath, created: true }) } });
      expect(runScmExecutable(targetPath, 'git', ['rev-parse', 'HEAD'])).toBe(sourceHeadSha);
      if (shape.endsWith('prepare')) expect(runScmExecutable(targetPath, 'git', ['branch', '--show-current'])).toBe('source');
      if (approvalShape) expect(post.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/v1/artifacts')).toHaveLength(1);
      else expect(post.mock.calls.every(([url]) => String(url).endsWith(`/v1/machines/${machineId}/admission/verify`))).toBe(true);
    } finally {
      await runtime.dispose();
      await approvalChannel?.close();
      restoreHttp?.();
      await approvalHome?.close();
      await removeTempDir(root);
    }
  });
});
