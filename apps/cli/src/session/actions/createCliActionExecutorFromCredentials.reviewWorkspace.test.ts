import axios from 'axios';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { buildWorktreeRelativePath, createActionExecutor } from '@happier-dev/protocol';
import { join } from 'node:path';
import { definePlugin } from '@happier-dev/plugin-sdk';
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

afterEach(() => vi.restoreAllMocks());
afterAll(() => pluginReloadController.shutdown());

it.each(['verify', 'prepare', 'owner-verify', 'owner-prepare', 'owner-foreign-use', 'owner-foreign-manage',
  'owner-unadmitted', 'owner-retarget', 'owner-home'] as const)('runs mounted source %s through its serving Machine SDK executor without minting an Account root', async shape => {
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
    const sourceUrl = 'https://github.com/example/repository.git';
    runScmExecutable(root, 'git', ['remote', 'add', 'source', sourceUrl]);
    runScmExecutable(root, 'git', ['config', `url.file://${root}.insteadOf`, sourceUrl]);
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
    const machine = { id: machineId, managedMachineRef: null, kind: 'persistent', active: true,
      installationId: 'review-installation', revokedAt: null, replacedByMachineId: null,
      dataEncryptionKey: null, runnerContentKeyBinding: null,
      installationPublicKey: Buffer.from(keys.publicKey).toString('base64'),
      access: { custodian: { accountId, displayName: 'Reviewer' }, role: 'manage',
        resourceMode: 'plain', accessState: 'ready' } };
    // HTTP is the boundary. Mounted source dispatch, the runtime's SDK
    // executor, Machine selection and Git verification all remain real.
    const post = vi.spyOn(axios, 'post').mockImplementation(async url => {
      if (String(url).endsWith(`/v1/machines/${machineId}/admission/verify`)) return { status: 200, data: { v: 1, ok: true } };
      // The reported Home refuses an Account-root mint for this plugin-only
      // child. Local execution must consume the original Machine admission.
      return { status: 403, data: { error: 'invalid_request', code: 'credential_scope_denied' } };
    });
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => String(url).includes('/v1/artifacts/')
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
    let sourceEntered = false;
    const source = definePlugin({ id: 'example.review-source', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
      actions: { prepare: { title: 'Prepare review workspace', surfaces: ['ui'], dangerLevel: 'writesLocal',
        confirmation: { title: 'Prepare workspace', confirmLabel: 'Prepare' }, confirmationWhen: { presentUserUi: false },
        inputSchema: { type: 'object', additionalProperties: false },
        run: async (_input, context) => {
          sourceEntered = true;
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
              'scm.reviewWorkspace.materializePrepared': ['plugin'],
            } },
          }) }) },
        resolveCurrentMachineId: () => machineId,
        resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'srv_review_home', machineId }),
        externalActionHomeBinding: { serverId, serverIdentityId: 'srv_review_home',
          externalActionMachineInstallationId: 'review-installation', externalActionMachineRequestPrivateKey: keys.secretKey },
      } });
    try {
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
      });
      const occurrenceId = runtime.registry.readPluginOccurrenceId?.(source.manifest.id);
      const sourceCustody = runtime.registry.readPluginSourceCustody?.(source.manifest.id);
      const materializationRef = runtime.registry.resolveCurrentPluginMaterializationRef?.(source.manifest.id);
      if (!occurrenceId || !sourceCustody || !materializationRef) throw new Error('Expected admitted mounted source');
      const request = { machineId, qualifiedActionId: `${source.manifest.id}/prepare`,
        expectedContributorOccurrenceId: occurrenceId, executionSurface: 'ui' as const, input: {},
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
        actionExecutor: createActionExecutor({ ...createCliActionDeps({ token: credentials.token, credentials,
          serverId, serverIdentityId: 'srv_review_home', externalActionMachineInstallationId: 'review-installation',
          serverHttpBaseUrl: 'https://review-home.test', sessionId: '', mode: 'plain', ctx: null }), isActionApprovalRequired: () => false }),
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
      const result = shape.startsWith('owner-')
        ? { ok: true, result: await service.execute('scm.reviewWorkspace.materializePrepared', input) }
        : await rpc.handleRequest(packet);
      const targetPath = shape.endsWith('verify') ? root : join(root, buildWorktreeRelativePath('source'));
      expect(result, JSON.stringify({ result, sourceEntered,
        getPaths: get.mock.calls.map(([url]) => new URL(String(url)).pathname),
        postPaths: post.mock.calls.map(([url]) => new URL(String(url)).pathname) })).toMatchObject({ ok: true, result: { success: true,
        ...(shape.endsWith('verify') ? { verification: { targetPath, sourceHeadSha } } : { targetPath, created: true }) } });
      expect(runScmExecutable(targetPath, 'git', ['rev-parse', 'HEAD'])).toBe(sourceHeadSha);
      if (shape.endsWith('prepare')) expect(runScmExecutable(targetPath, 'git', ['branch', '--show-current'])).toBe('source');
      expect(post.mock.calls.every(([url]) => String(url).endsWith(`/v1/machines/${machineId}/admission/verify`))).toBe(true);
    } finally {
      await runtime.dispose();
      await removeTempDir(root);
    }
  });
});
