import axios from 'axios';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { ProjectAccountRowMutationRequestV1Schema, type ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { projectAccountRowReadResponse } from '@/testkit/http/projectAccountRows';
import { createProjectAccountRowsHttpBoundary } from '@/workspaces/projectAccountRows.testkit';
import { readProjectAccountRows, withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import type { ProjectOpenRuntime } from '@/workspaces/activation/openProject';
import { readSettings, readStoredCredentialsForServerId, updateSettings } from '@/persistence';
import { registerProjectOpenRpcHandlers } from './registerProjectOpenRpcHandlers';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { OpenProjectResultV1Schema, type OpenProjectInputV1 } from '@happier-dev/protocol/projects/openProjectV1';
import { AccountEncryptionModeResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { WorkspaceSyncController } from '@/workspaces/sync/workspaceSyncController';
import { createWorkspaceSyncHandoffAdapter } from '@/workspaces/sync/workspaceSyncHandoffAdapter';
import { createWorkspaceRootOwnershipManager } from '@/workspaces/sync/workspaceSyncRootOwnership';
import { resolveWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { FeaturesResponseSchema, ScmHostingProviderContributionSchema } from '@happier-dev/protocol';
import { PluginConnectedAccountDescriptorContributionV2Schema } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { createProjectSetupTrustRowCipher } from '@/workspaces/projectSetup/projectSetupTrust';
import { configuration, reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { openProject, materializeProjectSyncOnSource } from '@/workspaces/activation/openProject';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPluginRegistrationScope } from '@happier-dev/plugin-sdk/host/registration';
import { createGithubRepositoryProvisioningAdapter } from '../../../../../../packages/plugins/scm-github/src/repositoryProvisioning/createRepositoryWithAuthFallback';
import { createGithubRepositoryRestAdapter } from '../../../../../../packages/plugins/scm-github/src/repositoryProvisioning/githubRepositoryRestAdapter';
import { createHostScmHostingProviderRuntimeServices } from '@/scm/hostingProviders/runtimeServices';
import { githubHostingProviderAdapter } from '../../../../../../packages/plugins/scm-github/src/adapter';
import { PLUGIN_MANIFEST as GITHUB_PLUGIN_MANIFEST } from '../../../../../../packages/plugins/scm-github/src/manifest';
import { createRegisteredScmBackendRegistry } from '@/scm/pluginBackends/registeredScmBackendRegistry';
import { GIT_PLUGIN, GIT_SCM_BACKEND_CONTRIBUTION } from '../../../../../../packages/plugins/scm-git/src/manifest';
import { createScmBackendRegistry } from '@/scm/registry';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { logger } from '@/ui/logger';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { applyDaemonHomeDescriptorRefresh, prepareDaemonHomeIrohTransport } from '@/daemon/peer/iroh/daemonHomeIrohTransport';
import { getServerProfile } from '@/server/serverProfiles';
import { resolveCurrentCliHomeTarget } from '@/server/homeTarget';
import { resolvePublishedMachineEncryptionContext } from '@/api/machine/machineDataEncryptionKey';
import { ApiMachineClient } from '@/api/apiMachine';
import { writeCredentialsTokenOnlyForServerId } from '@/persistence';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { createGitScmBackendRuntimeRegistration } from '../../../../../../packages/plugins/scm-git/src/backend';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createInstalledFilesystemMachineFixture } from '@/daemon/testkit/installedFilesystemMachineFixture';
import { createAgentIsolationMemberPreparationBoundary } from '@/daemon/agentIsolation/agentIsolationEffects.testkit';
import { deriveAgentIsolationMemberIdentity, buildAgentIsolationProvisioningSteps } from '@/daemon/agentIsolation/provisioning';
import { writeAgentIsolationMemberBinding } from '@/daemon/agentIsolation/memberBindings';
import { readAgentLaunchFrame } from '@/daemon/agentIsolation/agentLaunchFrame';
import { runWorkspaceEffectWorker } from '@/workspaces/activation/workspaceEffectWorker';
import { workspaceCheckoutNativeBoundary as nativeBoundary } from '@/workspaces/activation/workspaceCheckoutNative.testkit';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createProductionDaemonWorkspaceSyncRuntime } from '@/daemon/startup/createProductionDaemonWorkspaceSyncRuntime';
import { createWorkspaceSyncNativeProcessTestBoundary } from '@/daemon/startup/createProductionDaemonWorkspaceSyncRuntime.testkit';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { registerMachineWorkspaceSyncRpcHandlers, resolvePrivateWorkspaceSyncTargetExecution } from '@/api/machine/rpcHandlers.workspaceSync';
import { deriveWorkspaceSyncRelationshipId } from '@/workspaces/sync/workspaceSyncRelationshipIdentity';

const socketIo = vi.hoisted(() => vi.fn());
const nativeSyncFiles = vi.hoisted(() => ({ source: '' }));
vi.mock('socket.io-client', () => ({ io: socketIo }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  const { workspaceCheckoutFilesystemBoundary } = await import('@/workspaces/activation/workspaceCheckoutNative.testkit');
  return workspaceCheckoutFilesystemBoundary(actual);
});
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  const { workspaceCheckoutNativeBoundary, spawnWorkspaceCheckoutNativeBoundary } = await import('@/workspaces/activation/workspaceCheckoutNative.testkit');
  const execFileBoundary = (...args: unknown[]) => {
    if (args[0] === 'sudo' && Array.isArray(args[1]) && args[1].at(-1) === 'agent-launch'
      && workspaceCheckoutNativeBoundary.launch) {
      const commandArgs = args[1];
      const callback = args.at(-1);
      const home = workspaceCheckoutNativeBoundary.mounts[0];
      if (typeof callback !== 'function' || !home) throw new Error('Missing native readiness fixture');
      // Retain the real stdin/physical-settlement path and validate its frame
      // through the canonical OS readiness boundary instead of invoking sudo.
      // The frame header is binary; UTF-8 decoding can corrupt its uint32 length.
      return Reflect.apply(actual.execFile, actual, ['/bin/cat', [], {
        ...(typeof args[2] === 'object' && args[2] !== null ? args[2] : {}), encoding: 'buffer',
      },
        (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => {
          if (error) { callback(error, stdout, stderr); return; }
          void import('@/daemon/agentIsolation/agentIsolationEffects.testkit').then(({ runAgentIsolationMemberReadinessBoundary }) =>
            runAgentIsolationMemberReadinessBoundary({ request: ['sudo', commandArgs, { inputBytes: Buffer.from(stdout) }],
              nativeHome: { path: home.path, uid: home.uid } })).then(result => {
            if (!result) throw new Error('Missing native readiness result');
            callback(null, result.stdout, result.stderr);
          }).catch(error => callback(error, '', ''));
        }]);
    }
    const lookup = args[0] === 'getent' && Array.isArray(args[1])
      ? workspaceCheckoutNativeBoundary.accountLookups.get(JSON.stringify(args[1])) : undefined;
    // Exact passwd/group observations are an OS boundary. Retain a real
    // child and the ordinary Node callback/physical-settlement contract.
    return Reflect.apply(actual.execFile, actual, lookup === undefined ? args
      : ['/usr/bin/printf', ['%s', lookup], ...args.slice(2)]);
  };
  // Existing real git tests use Node's { stdout, stderr } promisified adapter.
  Object.defineProperties(execFileBoundary, Object.getOwnPropertyDescriptors(actual.execFile));
  return { ...actual,
    spawn: (command: string, args: readonly string[], options: import('node:child_process').SpawnOptions) => {
      if (workspaceCheckoutNativeBoundary.launch && (command === '/fixture-engine/agent' || args.includes('/fixture-engine/agent'))) {
        expect(workspaceCheckoutNativeBoundary.identity.getStore()).toBe('member');
        const root = args.at(-1);
        expect([nativeSyncFiles.source, workspaceCheckoutNativeBoundary.privateRoot]).toContain(root);
        expect(args.slice(-4)).toEqual(['synchronizer', '--external', '--root', root]);
        workspaceCheckoutNativeBoundary.runAsUsers.push(root === nativeSyncFiles.source ? 'mutagen-member-source' : 'mutagen-member-target');
        if (root === nativeSyncFiles.source) return actual.spawn('/bin/cat', [], options);
        const mount = workspaceCheckoutNativeBoundary.mounts.find(entry => nativeSyncFiles.source.startsWith(`${entry.path}/`));
        if (!mount) throw new Error('Missing native agent filesystem boundary');
        const source = `${mount.backing}${nativeSyncFiles.source.slice(mount.path.length)}`;
        const target = `${mount.backing}${workspaceCheckoutNativeBoundary.privateRoot.slice(mount.path.length)}`;
        // This is the external engine executable boundary. The real member
        // worker opens it only after canonical target/bootstrap admission.
        return actual.spawn('/bin/sh', ['-c', 'cp -a -- "$1"/. "$2"/ && exec /bin/cat', 'native-sync-fixture', source, target], options);
      }
      if (command !== 'sudo' || !workspaceCheckoutNativeBoundary.launch) return actual.spawn(command, args, options);
      expect(args.slice(-2)).toEqual(['/opt/happier/cli/current/happier', 'agent-launch']);
      workspaceCheckoutNativeBoundary.runAsUsers.push(args[2]!);
      return spawnWorkspaceCheckoutNativeBoundary();
    },
    execFile: execFileBoundary,
  };
});
// Real API composition is daemon startup, not part of an individual RPC deadline.
await import('@/api/api');

async function plainMachineRead(url: string) {
  if (!url.includes('/v1/machines/')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
  const id = url.slice(url.lastIndexOf('/') + 1);
  return { status: 200, data: { machine: { id, active: true, installationId: 'installation',
    metadataVersion: 1, daemonStateVersion: 0, daemonState: null, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
    metadata: encodePlainMachineStoredContent({ host: id, platform: 'linux', homeDir: '/home/user', happyCliVersion: 'test', happyHomeDir: '/home/user/.happier' }) } } };
}

function register(method: string = RPC_METHODS.PROJECTS_OPEN, runtime?: ProjectOpenRuntime,
  target = { serverId: runtime?.serverId ?? 'srv_test_home', machineId: runtime?.machineId ?? 'machine' }) {
  const handlers = new Map<string, RpcHandler<unknown, unknown>>();
  // The RPC transport receives untyped JSON; the real registered owner validates it.
  const registrar: RpcHandlerRegistrar = { registerHandler: (method, handler) => { handlers.set(method, handler as RpcHandler<unknown, unknown>); } };
  registerProjectOpenRpcHandlers(registrar, { ...target, ...(runtime ? { runtime } : {}) });
  const handler = handlers.get(method);
  if (!handler) throw new Error('Open is not registered');
  return handler;
}

describe('Project Open RPC', () => {
  beforeEach(async () => {
    await seedTestServerProfile({ id: 'srv_test_home', homeId: 'srv_test_home', serverUrl: 'https://home.example' });
  });
  afterEach(() => { nativeBoundary.reset(); nativeSyncFiles.source = ''; vi.restoreAllMocks(); vi.unstubAllGlobals(); socketIo.mockReset(); withdrawActiveProjectAccountRowsSnapshot(); });

  it('refuses a deleted worktree branch or missing base ref before creating files or accepting rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-open-missing-ref-'));
    const source = join(root, 'source');
    const git = promisify(execFile);
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    const registration = createGitScmBackendRuntimeRegistration();
    if (!registration.runtime) throw new Error('Git runtime unavailable');
    const backend = createRegisteredScmBackendAdapter({ definition: { id: 'git', kind: 'git' },
      qualifiedId: 'happier.scm.git/git', executableDefinition: registration.runtime, registration });
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
      machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: 'machine',
        installationId: 'installation', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
    vi.spyOn(axios, 'get').mockImplementation(plainMachineRead);
    const writes: unknown[] = [];
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (url.endsWith('/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows: [] } };
      writes.push(body);
      throw new Error('Missing ref must not accept a row');
    });
    const handler = register(RPC_METHODS.PROJECTS_OPEN, { serverId: 'srv_test_home', machineId: 'machine',
      serverHttpBaseUrl: 'https://home.example', accountId: 'account', registry: createScmBackendRegistry([backend]),
      readCredentials: async () => ({ token, encryption: null }) });
    try {
      await mkdir(source);
      await git('git', ['init', '-b', 'main'], { cwd: source });
      await git('git', ['-c', 'user.name=Open test', '-c', 'user.email=open@example.invalid', 'commit', '--allow-empty', '-m', 'initial'], { cwd: source });
      await git('git', ['branch', 'gone'], { cwd: source });
      await git('git', ['branch', '-D', 'gone'], { cwd: source });
      for (const branchMode of ['existing', 'new'] as const) {
        const target = join(root, branchMode, 'checkout');
        const result = await handler({ serverId: 'srv_test_home', machineId: 'machine', source: { kind: 'folder', path: source },
          ref: 'gone', materialization: { kind: 'worktree', targetPath: target,
            checkout: { kind: 'git_worktree', displayName: 'gone', baseRef: 'gone', branchMode } } }, context);
        expect(OpenProjectResultV1Schema.parse(result)).toEqual({ kind: 'refused', code: 'ref_unavailable' });
        await expect(access(join(root, branchMode))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      // A later add failure can already have created the parent directory.
      // Only the explicit pre-effect ref refusal may bypass unknown settlement.
      const uncertainTarget = join(root, 'uncertain', 'checkout');
      expect(await handler({ serverId: 'srv_test_home', machineId: 'machine', source: { kind: 'folder', path: source },
        ref: 'main', materialization: { kind: 'worktree', targetPath: uncertainTarget,
          checkout: { kind: 'git_worktree', displayName: 'main', baseRef: 'main', branchMode: 'new' } } }, context))
        .toEqual({ kind: 'outcomeUnknown' });
      await access(join(root, 'uncertain'));
      expect(writes).toEqual([]);
      expect((await git('git', ['branch', '--show-current'], { cwd: source })).stdout.trim()).toBe('main');
      expect((await git('git', ['worktree', 'list', '--porcelain'], { cwd: source })).stdout.match(/^worktree /gm)).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['opened', 'refused', 'outcomeUnknown'] as const)('retains the original Open settlement in Action Operations (%s)', async settlement => {
    const root = await mkdtemp(join(tmpdir(), 'happier-open-operation-'));
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
      transportRequestId: 'original-open-request',
      machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: 'machine',
        installationId: 'installation', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
    const operations = createHostActionOperationRuntime({ serverId: 'srv_test_home', machineId: 'machine',
      resolveAccountId: async () => 'account', generateOperationId: () => 'original-open-operation' });
    const runtime: ProjectOpenRuntime = { serverId: 'srv_test_home', serverHttpBaseUrl: 'https://home.example', machineId: 'machine',
      accountId: 'account', readCredentials: async () => ({ token, encryption: null }) };
    const rows: ProjectAccountRowV1[] = [];
    let mutations = 0;
    vi.spyOn(axios, 'get').mockImplementation(plainMachineRead);
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (url.endsWith('/list')) {
        expect(await operations.handlers.getV2({ operationId: 'original-open-operation' }, context))
          .toMatchObject({ kind: 'found', operation: { requestId: 'original-open-request', state: 'running',
            cancellation: 'unsupported' } });
        expect(await operations.handlers.cancel({ operationId: 'original-open-operation' }, context)).toEqual({ kind: 'unsupported' });
        return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
      }
      mutations += 1;
      const request = ProjectAccountRowMutationRequestV1Schema.parse(body);
      const changed = request.mutations.map(mutation => ({ key: mutation.key, revision: 0, content: mutation.content }));
      rows.push(...changed);
      if (settlement === 'outcomeUnknown') throw new Error('Accepted row acknowledgement lost');
      return { status: 200, data: { status: 'updated', rows: changed, cursor: 1 } };
    });
    const handlers = new Map<string, RpcHandler<unknown, unknown>>();
    const registrar: RpcHandlerRegistrar = { registerHandler: (method, handler) => { handlers.set(method, handler as RpcHandler<unknown, unknown>); } };
    const registration = { serverId: 'srv_test_home', machineId: 'machine', runtime, observeExecution: operations.observeExecution };
    registerProjectOpenRpcHandlers(registrar, registration);
    try {
      const handler = handlers.get(RPC_METHODS.PROJECTS_OPEN)!;
      const input = { serverId: 'srv_test_home', machineId: 'machine', source: { kind: 'folder' as const,
        path: settlement === 'refused' ? join(root, 'missing') : root }, materialization: { kind: 'attach' as const } };
      const observed = await operations.runActionOperation({ actionId: 'projects.open', input,
        context: { actionRequestId: context.transportRequestId, signal: context.signal },
        // Machine relay calls carry authenticated ingress, not the invoking
        // adapter's private local Action context. Installed signed calls are
        // exercised by the composed external Action approval keepers.
        execute: async () => ({ ok: true, result: await handler(input, context) }),
      });
      expect(observed.ok).toBe(true);
      if (!observed.ok) throw new Error(observed.errorCode);
      const result = observed.result;
      expect(result).toMatchObject({ kind: settlement, ...(settlement === 'outcomeUnknown' ? { operationId: 'original-open-operation' } : {}) });
      const found = await operations.handlers.getV2({ operationId: 'original-open-operation' }, context);
      expect(found).toMatchObject({ kind: 'found', operation: { actionId: 'projects.open', scope: { accountId: 'account', machineId: 'machine' },
        result } });
      expect((await operations.handlers.listV2({}, context)).items).toHaveLength(1);
      const beforeCheck = mutations;
      await operations.handlers.getV2({ operationId: 'original-open-operation' }, context);
      expect(mutations).toBe(beforeCheck);
      expect(await operations.handlers.getV2({ operationId: 'original-open-operation' }, { ...context,
        machineAdmission: { ...context.machineAdmission!, actorAccountId: 'other-account' } })).toEqual({ kind: 'not_found' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('settles a public Source clone for host browsing despite an unenrolled Devcontainer, preserving refusals and uncertainty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-qf4-open-'));
    const git = promisify(execFile);
    const remote = join(root, 'remote.git');
    const seed = join(root, 'seed');
    const scope = createEnvKeyScope(['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']);
    const provider = { id: 'happier.scm.forge.github/github', kind: 'github' as const, displayName: 'GitHub', baseUrl: 'https://github.com' };
    const source: ProjectSourceV1 = { id: 'cmv06f8oh0002tm6db61h8svg', revision: 2, name: 'Q1 Round 4 Source',
      createdByAccountId: 'account', audience: [], defaultRef: 'master', subdir: '.',
      repository: { provider, repository: { nameWithOwner: 'octocat/Hello-World',
        webUrl: 'https://github.com/octocat/Hello-World', cloneUrl: 'https://github.com/octocat/Hello-World' }, protocol: 'https' } };
    // GitHub HTTP and Git's remote are the system boundaries; discovery, dispatch,
    // clone/publication, Source admission and Account row acceptance remain real.
    let rateLimited: 'timed' | 'unhinted' | null = null;
    const retryAt = Math.ceil(Date.now() / 1000) * 1000 + 3600_000;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
      if (rateLimited) return { ok: false, status: 403, statusText: 'Forbidden',
        headers: new Headers({ 'x-ratelimit-remaining': '0', ...(rateLimited === 'timed'
          ? { 'x-ratelimit-reset': String(retryAt / 1000) } : {}) }),
        json: async () => ({ message: 'API rate limit exceeded' }), text: async (): Promise<string> => '' };
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ full_name: 'octocat/Hello-World',
        html_url: 'https://github.com/octocat/Hello-World', clone_url: 'https://github.com/octocat/Hello-World.git',
        visibility: 'public', default_branch: 'master' }), text: async (): Promise<string> => '' };
    });
    const hostingDefinition = GITHUB_PLUGIN_MANIFEST.contributes.scmHostingProviders?.[0];
    if (!hostingDefinition) throw new Error('GitHub did not declare its hosting provider');
    const bindingOwner = createConnectedAccountPurposeBindingOwner({
      store: { read: async () => ({ v: 1, bindings: [] }),
        update: async mutate => mutate({ v: 1, bindings: [] }), subscribe: () => ({ dispose() {} }) },
      selectTarget: async () => { throw new Error('Read-only Open cannot select an account'); },
      resolveTarget: async () => null,
      projectTargetAccounts: async () => ({ status: 'complete', accounts: [] }),
      materializeAccount: async () => { throw new Error('An unbound public clone must not materialize credentials'); },
      assertTargetAccountMaterializable: async () => undefined,
    });
    const accountDefinition = GITHUB_PLUGIN_MANIFEST.contributes.connectedAccountDescriptors?.[0];
    if (!accountDefinition) throw new Error('GitHub did not declare its Connected Account');
    // Keep the real registry and auth producer: an absent binding is proved by
    // the purpose owner, not inferred from an unavailable token service.
    const hostingRuntimeServices = createHostScmHostingProviderRuntimeServices({
      contributes: { scmHostingProviders: [{ id: provider.id, pluginId: GITHUB_PLUGIN_MANIFEST.id,
        provenance: 'first_party', source: { kind: 'bundled' }, definition: ScmHostingProviderContributionSchema.parse(hostingDefinition) }],
        connectedAccountDescriptors: [{ pluginId: GITHUB_PLUGIN_MANIFEST.id,
          provenance: 'first_party', source: { kind: 'bundled' }, definition: PluginConnectedAccountDescriptorContributionV2Schema.parse(accountDefinition) }] },
      scmHostingProvidersById: new Map([[provider.id, { pluginId: GITHUB_PLUGIN_MANIFEST.id, occurrenceId: 'github-test',
        registration: { id: 'github', adapter: { routing: githubHostingProviderAdapter,
          repositoryClone: createGithubRepositoryProvisioningAdapter({ restAdapter: createGithubRepositoryRestAdapter({ fetcher }) }) } } }]]),
      resolveConnectedAccountPurposeBindingOwner: () => bindingOwner,
    });
    const scopeRegistration = createPluginRegistrationScope({ pluginId: 'happier.scm.backend.git',
      target: { realm: 'daemon' }, rights: [{ family: 'scmBackends', localId: 'git', target: { realm: 'daemon' } }] });
    await GIT_PLUGIN.activate(scopeRegistration.api);
    const [capturedRegistration] = scopeRegistration.commit();
    if (capturedRegistration?.family !== 'scmBackends') throw new Error('Git did not register its declared backend');
    const registration = { id: capturedRegistration.localId, ...capturedRegistration.value };
    const activated = createRegisteredScmBackendRegistry({ definitions: [{ pluginId: 'happier.scm.backend.git',
      contributionId: 'git', definition: GIT_SCM_BACKEND_CONTRIBUTION }],
      registrations: [{ pluginId: 'happier.scm.backend.git', registration }],
      hostingProviderRuntimeServices: hostingRuntimeServices });
    expect(activated.diagnostics).toEqual([]);
    const registry = createScmBackendRegistry(activated.backends);
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    const runtime: ProjectOpenRuntime = { serverId: 'srv_test_home', serverHttpBaseUrl: 'https://home.example', machineId: 'machine',
      accountId: 'account', registry, readCredentials: async () => ({ token, encryption: null }) };
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
      machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: 'machine',
        installationId: 'installation', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
    const rows: ProjectAccountRowV1[] = [];
    let loseAcknowledgement = false;
    const accountRowsHttp = createProjectAccountRowsHttpBoundary(rows);
    vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: { ok: true, source, canManage: true } });
    vi.spyOn(axios, 'get').mockImplementation(plainMachineRead);
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (url.endsWith('/machines/managed/actions/list')) return { status: 200, data: { machines: [] } };
      const response = await accountRowsHttp(url, body);
      if (loseAcknowledgement && !url.endsWith('/list') && !url.endsWith('/read')) throw new Error('Accepted row acknowledgement lost');
      return response;
    });
    const diagnostic = vi.spyOn(logger, 'warnLocalFile');
    const handler = register(RPC_METHODS.PROJECTS_OPEN, runtime);
    const input = { serverId: 'srv_test_home', machineId: 'machine', source: { kind: 'source' as const, id: source.id, revision: 2,
      selector: source.repository, defaultRef: 'master', subdir: '.' },
      materialization: { kind: 'clone' as const, destinationParentPath: root, destinationDirectoryName: 'checkout' } };
    try {
      await mkdir(seed);
      await git('git', ['init', '-b', 'master'], { cwd: seed });
      await writeFile(join(seed, 'README.md'), 'hello');
      await mkdir(join(seed, '.happier'));
      await writeFile(join(seed, '.happier/project.json'), JSON.stringify({ version: 1, devcontainer: {} }));
      await git('git', ['add', '.'], { cwd: seed });
      await git('git', ['-c', 'user.name=Open test', '-c', 'user.email=open@example.invalid', 'commit', '-m', 'initial'], { cwd: seed });
      expect(await activated.backends[0]?.commitCaptureTarget?.({ context: { cwd: seed, projectKey: 'seed',
        detection: { isRepo: true, rootPath: seed, mode: '.git' } } })).toMatchObject({ success: true,
        target: { ref: 'refs/heads/master', headOid: expect.any(String), baseTreeOid: expect.any(String) } });
      const pin = (await git('git', ['rev-parse', 'HEAD'], { cwd: seed })).stdout.trim();
      await writeFile(join(seed, 'README.md'), 'upstream advanced beyond the reviewed starter pin');
      await git('git', ['add', 'README.md'], { cwd: seed });
      await git('git', ['-c', 'user.name=Open test', '-c', 'user.email=open@example.invalid', 'commit', '-m', 'advance upstream'], { cwd: seed });
      await git('git', ['branch', 'main'], { cwd: seed });
      const upstreamHead = (await git('git', ['rev-parse', 'main'], { cwd: seed })).stdout.trim();
      await git('git', ['clone', '--bare', seed, remote]);
      scope.patch({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${remote}.insteadOf`,
        GIT_CONFIG_VALUE_0: 'https://github.com/octocat/Hello-World.git' });
      const missingParent = { ...input, materialization: { ...input.materialization, destinationParentPath: join(root, 'missing') } };
      expect(await handler(missingParent, context)).toEqual({ kind: 'refused', code: 'invalid_directory' });
      await expect(access(join(root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(diagnostic.mock.calls.length).toBeGreaterThan(0);
      const noBackend = register(RPC_METHODS.PROJECTS_OPEN, { ...runtime, registry: createScmBackendRegistry([]) });
      expect(await noBackend(input, context)).toEqual({ kind: 'refused', code: 'FEATURE_UNSUPPORTED' });
      for (const limit of ['timed', 'unhinted'] as const) {
        rateLimited = limit;
        const refusal = await handler(input, context);
        expect(refusal).toEqual({ kind: 'refused', code: 'REMOTE_RATE_LIMITED',
          ...(limit === 'timed' ? { retryNotBeforeMs: retryAt } : {}),
          remediation: { kind: 'retry', action: 'connect_github' } });
        expect(OpenProjectResultV1Schema.parse(refusal)).toEqual(refusal);
        await expect(access(join(root, 'checkout'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(rows).toEqual([]);
      }
      rateLimited = null;
      scope.patch({ GIT_CONFIG_KEY_0: `url.${join(root, 'absent.git')}.insteadOf` });
      expect(await handler(input, context)).toMatchObject({ kind: 'refused' });
      await expect(access(join(root, 'checkout'))).rejects.toMatchObject({ code: 'ENOENT' });
      scope.patch({ GIT_CONFIG_KEY_0: `url.${remote}.insteadOf` });
      const opened = await handler(input, context);
      expect(opened, JSON.stringify(diagnostic.mock.calls)).toMatchObject({ kind: 'opened', directory: join(root, 'checkout'),
        workspace: { serverId: 'srv_test_home', machineId: 'machine', rootPath: join(root, 'checkout') },
        facts: { source: { sourceId: source.id, revision: 2 } } });
      expect(rows.some(row => row.key.kind === 'workspace-ref')).toBe(true);
      await access(join(root, 'checkout', '.happier/project.json'));
      expect(vi.mocked(axios.post).mock.calls.some(([url]) => url.includes('/sessions') || url.includes('/machines/managed/'))).toBe(false);
      expect((await git('git', ['branch', '--show-current'], { cwd: join(root, 'checkout') })).stdout.trim()).toBe('master');
      const starter = join(root, 'starter');
      const starterResult = await handler({ ...input, source: { kind: 'repository', selector: source.repository }, ref: pin,
        materialization: { ...input.materialization, destinationDirectoryName: 'starter',
          initialCheckout: { branch: 'main', commit: pin } } }, context);
      expect(starterResult).toMatchObject({ kind: 'opened', directory: starter });
      expect((await git('git', ['branch', '--show-current'], { cwd: starter })).stdout.trim()).toBe('main');
      expect((await git('git', ['rev-parse', 'HEAD'], { cwd: starter })).stdout.trim()).toBe(pin);
      expect((await git('git', ['rev-parse', 'main'], { cwd: starter })).stdout.trim()).toBe(pin);
      expect((await git('git', ['rev-parse', 'main'], { cwd: seed })).stdout.trim()).toBe(upstreamHead);
      diagnostic.mockClear();
      expect(await handler({ ...input, ref: 'missing-ref', materialization: { ...input.materialization, destinationDirectoryName: 'missing-ref' } }, context))
        .toEqual({ kind: 'outcomeUnknown' });
      await access(join(root, 'missing-ref', '.git'));
      expect(diagnostic.mock.calls.flatMap(([, details]) => details)).toEqual(expect.arrayContaining([
        expect.objectContaining({ effectsIssued: true, error: expect.stringContaining('missing-ref') }),
      ]));
      loseAcknowledgement = true;
      expect(await handler({ ...input, materialization: { ...input.materialization, destinationDirectoryName: 'lost-ack' } }, context))
        .toEqual({ kind: 'outcomeUnknown' });
      await access(join(root, 'lost-ack', '.git'));
    } finally { scope.restore(); await rm(root, { recursive: true, force: true }); }
  });

  it('establishes a credential-seeded profile identity before Project Open while refusing wrong targets', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-open-home-identity-'));
    const root = join(home, 'checkout');
    const scope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID']);
    const profileId = 'stack_agent-qa-l12-a__id_default';
    const serverId = 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN';
    const machineId = '931c4d58-b484-4284-b5b8-f3ef2500d7ec';
    const serverUrl = 'http://happier-agent-qa-l12-a.localhost:3010';
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    const source: ProjectSourceV1 = { id: 'cmv06f8oh0002tm6db61h8svg', revision: 2,
      name: 'Q1 Round 4 Source', createdByAccountId: 'account', audience: [], defaultRef: 'master', subdir: '.',
      repository: { provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
        repository: { nameWithOwner: 'octocat/Hello-World', cloneUrl: 'https://github.com/octocat/Hello-World', webUrl: 'https://github.com/octocat/Hello-World' }, protocol: 'https' } };
    const rows: ProjectAccountRowV1[] = [];
    const read = vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: { ok: true, source, canManage: true } });
    vi.spyOn(axios, 'get').mockImplementation(plainMachineRead);
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (url.endsWith('/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
      if (url.endsWith('/read')) return projectAccountRowReadResponse(rows, body);
      const request = ProjectAccountRowMutationRequestV1Schema.parse(body);
      const changed = request.mutations.map(mutation => ({ key: mutation.key,
        revision: mutation.expectedRevision === 'absent' ? 0 : mutation.expectedRevision + 1, content: mutation.content }));
      for (const row of changed) { const index = rows.findIndex(existing => JSON.stringify(existing.key) === JSON.stringify(row.key));
        if (index < 0) rows.push(row); else rows[index] = row; }
      return { status: 200, data: { status: 'updated', rows: changed, cursor: 1 } };
    });
    try {
      scope.patch({ HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: profileId });
      reloadConfiguration();
      await mkdir(root);
      await writeCredentialsTokenOnlyForServerId(profileId, { token });
      const runtime: ProjectOpenRuntime = { serverId: profileId, machineId, serverHttpBaseUrl: serverUrl,
        accountId: 'account', readCredentials: async () => ({ token, encryption: null }) };
      const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
        machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId,
          installationId: 'installation', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
      const target = { serverId: profileId, machineId };
      const handler = register(RPC_METHODS.PROJECTS_OPEN, runtime, target);
      const folder = { serverId, machineId, source: { kind: 'folder' as const, path: root }, materialization: { kind: 'attach' as const } };
      expect(await handler(folder, context)).toEqual({ kind: 'refused', code: 'target_mismatch' });
      expect(await handler({ ...folder, serverId: profileId }, context)).toEqual({ kind: 'refused', code: 'target_mismatch' });
      // Only the Home HTTP boundary is mocked. Start from the predecessor/Stack
      // URL-only profile and pass the provisioned credential through real startup verification.
      const features = FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId: serverId } },
        homeConnectionDescriptor: { v: 1, homeServerIdentityId: serverId, canonicalServerUrl: serverUrl,
          revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] } });
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
        expect(String(url)).toBe(`${serverUrl}/v1/features/authenticated`);
        expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
        return Response.json(features);
      }));
      const startupTarget = await resolveCurrentCliHomeTarget();
      expect(startupTarget).toMatchObject({ profileId: null, authority: 'manual_url' });
      const transport = await prepareDaemonHomeIrohTransport({ runtime: null, profile: { serverUrl },
        applicationCarrierEligibility: 'standard_only' });
      try {
        expect(await transport.verifyAuthenticated(token)).toEqual({ status: 'ready' });
      } finally { await transport.release(); vi.unstubAllGlobals(); }
      await expect(getServerProfile(profileId)).rejects.toThrow('not found');
      await updateSettings(settings => ({ ...settings, activeServerId: profileId,
        servers: { [profileId]: { id: profileId, name: 'QA', serverUrl, webappUrl: serverUrl,
          createdAt: 1, updatedAt: 1, lastUsedAt: 1 } } }));
      const reconnect = vi.fn();
      expect(await applyDaemonHomeDescriptorRefresh({ features, homeTarget: startupTarget,
        requestReconnect: reconnect })).toBe('updated');
      expect(reconnect).toHaveBeenCalledOnce();
      expect(await getServerProfile(profileId)).toMatchObject({ homeConnectionDescriptor: features.homeConnectionDescriptor,
        homeConnectionDescriptorAuthority: 'exact' });
      // Consume the real machine composition, not a hand-supplied Project runtime.
      const client = new ApiMachineClient(token, { id: machineId, encryptionMode: 'plain', metadata: null,
        metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
      const registration = client.setRPCHandlers({ spawnSession: async () => { throw new Error('Unexpected spawn'); },
        stopSession: async () => ({ status: 'stopped' }), requestShutdown() {} });
      try {
        const rpcOwner: unknown = Reflect.get(client, 'rpcHandlerManager');
        if (typeof rpcOwner !== 'object' || rpcOwner === null) throw new Error('Missing machine RPC owner');
        const registeredHandlers: unknown = Reflect.get(rpcOwner, 'handlers');
        if (!(registeredHandlers instanceof Map)) throw new Error('Missing registered RPC handlers');
        const installed: RpcHandler<unknown, unknown> | undefined = registeredHandlers.get(`${machineId}:${RPC_METHODS.PROJECTS_OPEN}`);
        if (!installed) throw new Error('Project Open was not installed by the machine composition');
        expect(OpenProjectResultV1Schema.parse(await installed({ ...folder, serverId: profileId }, context))).toMatchObject({ kind: 'opened',
          workspace: { serverId, machineId, rootPath: root } });
      } finally { await registration.dispose(); }
      // Counterfactual wiring: the same exact Home without its Project runtime
      // remains unavailable. The composed opened assertion above detects this omission.
      expect(await register(RPC_METHODS.PROJECTS_OPEN, undefined, target)(folder, context))
        .toEqual({ kind: 'refused', code: 'project_open_unavailable' });
      expect(await handler(folder, context)).toMatchObject({ kind: 'opened', directory: root,
        workspace: { serverId, machineId, rootPath: root } });
      const workspaceRow = rows.find(row => row.key.kind === 'workspace-ref');
      if (!workspaceRow || workspaceRow.key.kind !== 'workspace-ref') throw new Error('Expected accepted checkout row');
      expect(rows.filter(row => row.key.kind === 'workspace-ref')).toHaveLength(1);
      expect(workspaceRow.key.serverId).toBe(serverId);
      const captured = { ...folder, source: { kind: 'source' as const, id: source.id, revision: source.revision,
        selector: source.repository, defaultRef: source.defaultRef, subdir: source.subdir,
        checkout: { serverId, workspaceId: workspaceRow.key.id, machineId, rootPath: root } } };
      expect(await handler(captured, context)).toMatchObject({ kind: 'opened', workspace: { serverId, machineId },
        facts: { source: { sourceId: source.id, revision: 2 } } });
      expect(await openProject(captured, runtime, context)).toMatchObject({ kind: 'opened', workspace: { serverId, machineId } });
      const fields = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
      const copy = { ...captured, materialization: { kind: 'sync' as const, targetPath: root,
        workspaceAction: { kind: 'copy_once' as const, contentPolicy: { ...fields, policyDigest: computeWorkspaceSyncPolicyDigest(fields) } } } };
      const sourceHandler = register(RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN, runtime, target);
      expect(await sourceHandler(copy, context)).toEqual({ kind: 'materialized' });
      expect(await materializeProjectSyncOnSource(copy, runtime, context)).toEqual({ kind: 'materialized' });
      read.mockClear(); post.mockClear();
      for (const wrong of [{ ...folder, serverId: 'srv_other_home' }, { ...folder, machineId: 'other-machine' }]) {
        expect(await handler(wrong, context)).toEqual({ kind: 'refused', code: 'target_mismatch' });
        expect(await openProject(wrong, runtime, context)).toEqual({ kind: 'refused', code: 'target_mismatch' });
      }
      expect(read).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
      expect(await register(RPC_METHODS.PROJECTS_OPEN, runtime, { serverId: profileId, machineId: 'other-machine' })(folder, context))
        .toEqual({ kind: 'refused', code: 'target_mismatch' });
      expect(await handler(folder)).toEqual({ kind: 'refused', code: 'machine_admission_unavailable' });
      expect(await sourceHandler(copy)).toEqual({ kind: 'refused', code: 'machine_admission_unavailable' });
      expect(await handler(folder, { ...context, callerAuthority: 'account_automation' }))
        .toEqual({ kind: 'refused', code: 'requester_authority_unavailable' });
      expect(await sourceHandler(copy, { ...context, callerAuthority: 'account_automation' }))
        .toEqual({ kind: 'refused', code: 'requester_authority_unavailable' });
      expect(read).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
      read.mockResolvedValue({ status: 404, data: { ok: false, error: 'source_unavailable' } });
      const { checkout: _checkout, ...cloneSource } = captured.source;
      expect(await handler({ serverId, machineId, source: cloneSource,
        materialization: { kind: 'clone', destinationParentPath: '/home/ubuntu', destinationDirectoryName: 'q1-round5-hello-world' } }, context))
        .toEqual({ kind: 'refused', code: 'source_unavailable' });
      expect(post).not.toHaveBeenCalled();
      expect(configuration.activeServerId).toBe(profileId);
      const profile = (await readSettings()).servers![profileId]!;
      for (const scenario of ['advisory', 'missing', 'duplicate', 'identity-key-collision'] as const) {
        await updateSettings(settings => {
          const { homeConnectionDescriptor, ...withoutDescriptor } = profile;
          return { ...settings, servers: scenario === 'missing' ? { [profileId]: withoutDescriptor }
            : scenario === 'advisory' ? { [profileId]: { ...profile, homeConnectionDescriptorAuthority: 'advisory' as const } }
            : { [profileId]: { ...profile, homeConnectionDescriptor, homeConnectionDescriptorAuthority: 'exact' as const },
              [scenario === 'duplicate' ? 'second-profile' : serverId]: { ...(scenario === 'duplicate' ? profile : withoutDescriptor),
                id: scenario === 'duplicate' ? 'second-profile' : serverId } } };
        });
        read.mockClear(); post.mockClear();
        expect(await handler(folder, context), scenario).toEqual({ kind: 'refused', code: 'target_mismatch' });
        expect(await openProject(folder, runtime, context), scenario).toEqual({ kind: 'refused', code: 'target_mismatch' });
        expect(await handler({ ...folder, serverId: profileId }, context), scenario).toEqual({ kind: 'refused', code: 'target_mismatch' });
        expect(await sourceHandler(copy, context), scenario).toEqual({ kind: 'refused', code: 'target_mismatch' });
        expect(read).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
      }
    } finally { scope.restore(); reloadConfiguration(); await rm(home, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'linux').each([
    { mode: 'plain', action: 'attach', fault: 'none' }, { mode: 'e2ee', action: 'attach', fault: 'none' },
    { mode: 'plain', action: 'copy_once', fault: 'none' }, { mode: 'plain', action: 'create_relationship', fault: 'none' },
    { mode: 'plain', action: 'create_relationship', fault: 'endpoint_write_failure' },
    { mode: 'plain', action: 'create_relationship', fault: 'enabled_graph_ack' },
    { mode: 'plain', action: 'create_relationship', fault: 'remote_source_ack' },
  ] as const)('keeps a scoped Use requester Source on member execution without custodian credentials ($mode/$action/$fault)', async ({ mode, action, fault }) => {
    const syncing = action !== 'attach';
    socketIo.mockImplementation((await vi.importActual<typeof import('socket.io-client')>('socket.io-client')).io);
    let memberPreparation: ReturnType<typeof createAgentIsolationMemberPreparationBoundary> | undefined;
    const installed = await createInstalledFilesystemMachineFixture({ agentIsolation: {
      managedHappierBinaryPath: '/opt/happier/cli/current/happier',
      read: () => ({ enabled: true, memberProvisioning: 'linuxUsersV1',
        status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: [] }),
      prepareMember: async input => {
        if (!memberPreparation) throw new Error('Member preparation fixture is not ready');
        const result = await memberPreparation.members.prepare(input);
        if (result.kind !== 'ready') throw new Error('Member preparation refused');
        return result;
      },
    } });
    const homeId = installed.homeServerIdentityId;
    const requesterIdentity = { kind: 'isolated' as const, separationRequired: true, homeServerIdentityId: homeId,
      requester: { serverId: homeId, accountId: 'bob', machineId: 'machine', installationId: installed.installation.installationId } };
    const member = deriveAgentIsolationMemberIdentity(requesterIdentity);
    memberPreparation = createAgentIsolationMemberPreparationBoundary({ activeServerDir: configuration.activeServerDir,
      requesterIdentity, custodianAccountId: 'requester', encryptionMode: 'plain', uid: 2401 });
    for (const step of buildAgentIsolationProvisioningSteps({ requesterIdentity, daemonUsername: 'happier', daemonPrimaryGroup: 'happier',
      binaryPath: '/opt/happier/cli/current/happier' })) memberPreparation.installed.add(step.id);
    const backingHome = join(installed.directory, 'native-home');
    const backingWorkspace = join(installed.directory, 'native-workspace');
    await mkdir(backingHome); await mkdir(backingWorkspace);
    nativeBoundary.mounts = [{ path: member.home, backing: backingHome, uid: 2401, gid: 2401, mode: 0o40700 },
      { path: member.workspaceRoot, backing: backingWorkspace, uid: 2401, gid: 1001, mode: 0o42770 }];
    nativeBoundary.accountLookups.set(JSON.stringify(['--service=files', 'passwd', member.username]),
      `${member.username}:x:2401:2401:${member.ownershipMarker}:${member.home}:/usr/sbin/nologin\n`);
    nativeBoundary.accountLookups.set(JSON.stringify(['--service=files', 'group', 'happier']), 'happier:x:1001:\n');
    await writeAgentIsolationMemberBinding(configuration.activeServerDir, { ...member, agentUid: 2401, agentGid: 2401 });
    const root = join(member.workspaceRoot, 'bob-checkout');
    nativeBoundary.launch = async (input, output) => {
      const frame = await readAgentLaunchFrame(input);
      expect(frame.nativeIdentity).toEqual({ username: member.username, agentUid: 2401, agentGid: 2401, home: member.home });
      expect(frame.args).toEqual(['workspace-effect']);
      await runWorkspaceEffectWorker([], { input, output, signal: new AbortController().signal,
        currentDirectory: () => member.workspaceRoot });
    };
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`;
    const material = mode === 'e2ee' ? { type: 'legacy' as const, secret: new Uint8Array(32).fill(8) } : null;
    const cipher = createProjectAccountRowCipherV1({ mode, material, randomBytes: n => new Uint8Array(n) });
    const key = { kind: 'workspace-ref' as const, serverId: homeId, id: 'bob-checkout' };
    const workspace = { id: key.id, serverId: homeId,
      machineId: fault === 'remote_source_ack' ? 'remote-source' : 'machine', rootPath: root, createdAtMs: 1 };
    const rows: ProjectAccountRowV1[] = [{ key, revision: 0, content: cipher.seal({ key, value: workspace }) }];
    const source = { id: 'bob-source', revision: 1, name: 'Bob Source', createdByAccountId: 'bob', audience: [],
      repository: { provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://forge.example' },
        repository: { nameWithOwner: 'group/repo' }, protocol: 'https' } } satisfies ProjectSourceV1;
    let current = true;
    // Private ports represent admitted host custody. Only HTTP/crypto system boundaries are supplied here.
    let authorization: ExternalActionExecutionAuthorizationV1 = { v: 1, token: 'admitted-requester-fixture',
      binding: { accountId: 'bob', machineId: 'machine', custodianAccountId: 'requester',
      installationId: installed.installation.installationId, actionId: 'projects.open', accountEncryptionMode: mode,
      authentication: { kind: 'terminal', tokenEpoch: 0 }, serverIdentityId: homeId,
      ...(syncing ? { workspaceSyncAdmission: { relationshipId: deriveWorkspaceSyncRelationshipId('requester-open'),
        sourceWorkspaceRefId: workspace.id, source: { actorAccountId: 'bob', custodianAccountId: 'requester',
          machineId: workspace.machineId, installationId: installed.installation.installationId,
          role: 'use' as const, encryptionMode: 'plain' as const } } } : {}),
      requestId: 'requester-open', requestEnvelopeDigest: 'A'.repeat(43), target: { kind: 'machine', machineId: 'machine' } },
      requesterAccountProjection: { accountId: 'bob', serverId: homeId, accountEncryptionMode: mode, projectAccountRowCipher: cipher,
        projectTrustRowCipher: createProjectSetupTrustRowCipher({ mode, material }),
        resolveMachineContentEncryptionContext: machine => {
          const context = resolvePublishedMachineEncryptionContext({ credentials: { token, encryption: material }, machineId: machine.id,
            publishedDataEncryptionKey: machine.dataEncryptionKey, access: machine.access,
            expectedAccountMode: machine.access?.resourceMode ?? machine.storageMode ?? mode });
          // The admitted projection declares its mode explicitly; the CLI codec also accepts legacy implicit E2EE contexts.
          return context.encryptionMode === 'plain'
            ? { encryptionMode: 'plain' as const }
            : { encryptionMode: 'e2ee' as const, encryptionKey: context.encryptionKey, encryptionVariant: context.encryptionVariant };
        },
        isCurrent: async () => current, readArtifact: async () => null },
      requesterHttpProjection: { accountId: 'bob', serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl: installed.serverHttpBaseUrl,
        accountEncryptionMode: mode, isCurrent: async () => current,
        createRequestHeaders: async () => current ? { 'x-requester-proof': 'bob' } : null },
    } satisfies ExternalActionExecutionAuthorizationV1;
    const assertBobHeaders = (headers: unknown) => {
      if (syncing) {
        if (headers && typeof headers === 'object' && Reflect.get(headers, 'Authorization') !== undefined)
          expect(headers).toMatchObject({ Authorization: `Bearer ${token}` });
        else expect(headers).toMatchObject({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token });
      }
      else { expect(headers).toMatchObject({ 'x-requester-proof': 'bob' }); expect(headers).not.toHaveProperty('Authorization'); }
    };
    vi.spyOn(axios, 'request').mockImplementation(async request => {
      assertBobHeaders(request.headers);
      return { status: 200, data: { ok: true, source, canManage: false } };
    });
    vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      assertBobHeaders(config?.headers);
      if (syncing && url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (syncing && url.endsWith('/v1/account/encryption')) return { status: 200,
        data: AccountEncryptionModeResponseSchema.parse({ mode: 'plain', updatedAt: 1 }) };
      if (syncing && url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (syncing && url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      const response = await plainMachineRead(url);
      if (!('machine' in response.data)) throw new Error(`Unexpected requester GET ${new URL(url).pathname}`);
      return { ...response, data: { machine: { ...response.data.machine,
        installationId: installed.installation.installationId, storageMode: 'plain',
        access: { custodian: { accountId: 'requester', displayName: 'Custodian' },
          role: 'use', resourceMode: 'plain', accessState: 'ready' } } } };
    });
    const verifyMachineAdmissionRequest = vi.mocked(axios.post).getMockImplementation();
    let endpointWriteFailed = false;
    let graphAcknowledgementLost = false;
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
      if (syncing && url.endsWith('/v1/machines/machine/admission/verify')) {
        expect(config?.headers).toMatchObject({ Authorization: `Bearer ${installed.bootstrap.credentials.token}` });
        if (!verifyMachineAdmissionRequest) throw new Error('Missing installed Machine verification boundary');
        return verifyMachineAdmissionRequest(url, body, config);
      }
      assertBobHeaders(config?.headers);
      if (endpointWriteFailed || graphAcknowledgementLost) throw new Error('Project rows are temporarily unavailable after the committed write');
      if (url.endsWith('/project-trust/read')) return { status: 200, data: { status: 'absent' } };
      if (url.endsWith('/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
      if (url.endsWith('/read')) return projectAccountRowReadResponse(rows, body);
      const request = ProjectAccountRowMutationRequestV1Schema.parse(body);
      const changed = request.mutations.map(mutation => ({ key: mutation.key,
        revision: mutation.expectedRevision === 'absent' ? 0 : mutation.expectedRevision + 1, content: mutation.content }));
      for (const row of changed) { const index = rows.findIndex(existing => JSON.stringify(existing.key) === JSON.stringify(row.key));
        if (index < 0) rows.push(row); else rows[index] = row; }
      if (fault === 'endpoint_write_failure' && request.mutations.some(mutation => mutation.key.kind === 'workspace-ref')) {
        endpointWriteFailed = true;
        throw new Error('The committed endpoint write acknowledgement was lost');
      }
      if (fault === 'enabled_graph_ack' && changed.some(row => {
        if (row.key.kind !== 'relationship-graph' || row.content === null) return false;
        const payload = cipher.open(row.key, row.content);
        return 'relationships' in payload.value && payload.value.relationships.some(relationship => relationship.enabled);
      })) {
        graphAcknowledgementLost = true;
        throw new Error('The enabled relationship acknowledgement was lost');
      }
      return { status: 200, data: { status: 'updated', cursor: 1, rows: changed } };
    });
    const ingress = new AbortController();
    const admissionDiagnostics = syncing ? vi.spyOn(logger, 'warnLocalFile') : undefined;
    const requesterAccount = syncing ? await admitRequesterAccountActionContext({ authorization: {
      v: authorization.v, token: authorization.token, binding: { ...authorization.binding, admittedMachineRole: 'use' } },
      credentials: { token, encryption: null }, serverId: homeId, serverIdentityId: homeId,
      serverHttpBaseUrl: installed.serverHttpBaseUrl, isCurrent: async () => current,
      isCustodyCurrent: async () => current,
      isRetainedCustodyCurrent: async () => installed.isHomeCurrent(), signal: ingress.signal }) : null;
    if (syncing && !requesterAccount) throw new Error(`Canonical requester custody was not admitted: ${JSON.stringify(admissionDiagnostics?.mock.calls)}`);
    if (requesterAccount) {
      onTestFinished(requesterAccount.dispose);
      const projected = await projectExternalActionRequesterHttpAuthorization({ authorization: requesterAccount.authorization,
        serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl: installed.serverHttpBaseUrl,
        target: requesterAccount.authorization.binding.target, installationId: installed.installation.installationId,
        privateKey: decodeBase64(installed.installation.privateKey, 'base64url'), isCurrent: requesterAccount.isCurrent,
        signal: ingress.signal });
      if (!projected) throw new Error('Missing installed requester HTTP projection');
      authorization = projected;
    }
    const context: RpcHandlerContext = { signal: ingress.signal, callerAuthority: 'account_automation',
      callerInputAuthorization: authorization, machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'requester',
        machineId: 'machine', installationId: installed.installation.installationId, role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
    let runtime: ProjectOpenRuntime = { serverId: homeId, serverHttpBaseUrl: installed.serverHttpBaseUrl, machineId: 'machine', accountId: 'requester',
      privateCheckout: { prepareNativeOperation: input => installed.machine.prepareNativeOperation(input) },
      readCredentials: async () => { throw new Error('Bob must not use custodian credentials'); } };
    const targetRoot = syncing ? join(member.workspaceRoot, 'bob-sync') : root;
    nativeBoundary.privateRoot = syncing ? targetRoot : '';
    nativeBoundary.privateRoots = syncing ? [root] : [];
    nativeSyncFiles.source = syncing ? root : '';
    const policyFields = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const contentPolicy = { ...policyFields, policyDigest: computeWorkspaceSyncPolicyDigest(policyFields) };
    const nativeSyncBoundary = createWorkspaceSyncNativeProcessTestBoundary();
    const productionSyncInput = { happyHomeDir: installed.directory,
      activeServerDir: configuration.activeServerDir, activeServerId: installed.serverId,
      homeTarget: await resolveCurrentCliHomeTarget(), localMachineId: 'machine', releaseChannel: 'publicdev',
      privateCheckout: runtime.privateCheckout,
      requesterMachineAdmissionBoundary: { machineId: 'machine', daemonToken: installed.bootstrap.credentials.token,
        isHomeCurrent: installed.isHomeCurrent, getObservedServerIdentityId: () => homeId,
        readInstallation: () => installed.installation },
      credentials: installed.bootstrap.credentials, isCurrent: async () => installed.isHomeCurrent() } satisfies
      Parameters<typeof createProductionDaemonWorkspaceSyncRuntime>[0];
    const productionSync = syncing ? await createProductionDaemonWorkspaceSyncRuntime(productionSyncInput, nativeSyncBoundary.factories) : null;
    let recoveredSync: Awaited<ReturnType<typeof createProductionDaemonWorkspaceSyncRuntime>> | undefined;
    if (productionSync) { runtime = { ...runtime, workspaceSyncAdapter: productionSync.handoffAdapter }; onTestFinished(() => productionSync.stop()); }
    const input = { serverId: homeId, machineId: 'machine', source: { kind: 'source', id: source.id, revision: 1, selector: source.repository,
      checkout: { serverId: homeId, workspaceId: key.id, machineId: workspace.machineId, rootPath: root } }, materialization: action === 'attach'
      ? { kind: 'attach' as const }
      : { kind: 'sync' as const, targetPath: targetRoot, workspaceAction: action === 'copy_once'
        ? { kind: 'copy_once' as const, contentPolicy }
        : { kind: 'create_relationship' as const, mode: 'keep_synced' as const, contentPolicy,
          flushBeforeCommit: true as const } } } satisfies OpenProjectInputV1;
    let remoteTargetPrepared = false;
    if (fault === 'remote_source_ack' && productionSync) {
      const targetHandlers = new Map<string, RpcHandler<unknown, unknown>>();
      const targetRegistrar: RpcHandlerRegistrar = { registerHandler: (method, handler) => {
        targetHandlers.set(method, handler as RpcHandler<unknown, unknown>);
      } };
      registerMachineWorkspaceSyncRpcHandlers({ rpcHandlerManager: targetRegistrar, service: productionSync.workspaceSync });
      runtime = { ...runtime, callWorkspaceSource: async request => {
        expect(request.machineId).toBe('remote-source');
        const capture = productionSync.handoffAdapter.resolvePrivateExecution?.({ operationId: request.operationId });
        if (!capture?.input.sourceWorkspaceRefId || !capture.input.targetWorkspaceRefId || !context.machineAdmission)
          throw new Error('Missing real private TARGET capture');
        const relationshipId = deriveWorkspaceSyncRelationshipId(request.operationId);
        // The remote transport supplies SOURCE's admitted prepare packet. The
        // real TARGET receiver binds custody and runs its native authority.
        const prepare = { v: 1 as const, bootstrapOperationId: relationshipId,
          owner: { kind: 'relationship' as const, relationshipId },
          transientRelationship: { v: 1 as const, relationshipId, controllerMachineId: 'remote-source',
            alphaWorkspaceRefId: capture.input.sourceWorkspaceRefId, betaWorkspaceRefId: capture.input.targetWorkspaceRefId,
            mode: 'keep_synced' as const, contentPolicy, enabled: true, createdAtMs: 1, updatedAtMs: 1 },
          targetWorkspaceRefId: capture.input.targetWorkspaceRefId, endpointRole: 'beta' as const,
          policyDigest: contentPolicy.policyDigest, createIfMissing: true, targetBootstrap: 'use_existing' as const };
        const admitted = resolvePrivateWorkspaceSyncTargetExecution(productionSync.handoffAdapter, {
          context: context.machineAdmission, receivingMachine: { machineId: 'machine', installationId: installed.installation.installationId },
          request: prepare, targetWorkspaceRefId: capture.input.targetWorkspaceRefId,
          routing: { v: 1, phase: 'prepare', operationId: request.operationId, accountServerId: homeId,
            targetMachineId: 'machine', targetRootPath: targetRoot },
        });
        if (admitted.kind !== 'matched') throw new Error(`TARGET admission failed: ${admitted.kind}`);
        const handler = targetHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE);
        if (!handler) throw new Error('TARGET prepare was not registered');
        await handler(prepare, { ...context, workspaceSyncPrivateExecution: admitted.capture });
        remoteTargetPrepared = true;
        return { kind: 'outcomeUnknown' };
      } };
    }
    // Existing-checkout attachment needs the daemon-applied runtime lifetime,
    // but no plugin contributions. Publish it through the real runtime owner.
    const pluginRuntime = await createAdmittedPluginRuntimeFixture({ happyHomeDir: installed.directory,
      controller: pluginReloadController, runtimeOptions: { pluginIds: [], contributes: createResolvedContributionRegistry({}) } });
    onTestFinished(() => pluginRuntime.dispose());
    try {
      await mkdir(join(root, '.happier'), { recursive: true });
      await writeFile(join(root, '.happier/project.json'), JSON.stringify({ version: 1, workspace: { setup: [{ kind: 'command', command: 'touch not-executed' }] } }));
      await writeFile(join(root, 'payload.txt'), 'member seed');
      post.mockClear();
      const foreignHomeAuthorization = { ...authorization,
        binding: { ...authorization.binding, serverIdentityId: 'foreign-home' } };
      // Preserve the real host-only ports while changing only the wire Home binding.
      Object.defineProperties(foreignHomeAuthorization, {
        requesterAccountProjection: { value: authorization.requesterAccountProjection },
        requesterHttpProjection: { value: authorization.requesterHttpProjection },
      });
      expect(await register(RPC_METHODS.PROJECTS_OPEN, runtime)(input, { ...context,
        callerInputAuthorization: foreignHomeAuthorization }))
        .toEqual({ kind: 'refused', code: 'requester_authority_unavailable' });
      expect(post).not.toHaveBeenCalled();
      expect(nativeBoundary.runAsUsers).toEqual([]);
      if (syncing && input.materialization.kind === 'sync') {
        for (const [denied, code] of [[{ ...input, materialization: { ...input.materialization,
          targetPath: join(member.workspaceRoot, '..', 'other-member', 'foreign-checkout') } }, 'workspace_private_checkout_review_required'],
        [{ ...input, source: { kind: 'folder', path: root } }, 'workspace_private_checkout_required']] as const) {
          expect(await register(RPC_METHODS.PROJECTS_OPEN, runtime)(denied, context))
            .toMatchObject({ kind: 'refused', code });
          expect(post.mock.calls.some(([, body]) => ProjectAccountRowMutationRequestV1Schema.safeParse(body).success)).toBe(false);
          expect(nativeBoundary.runAsUsers).toEqual([]);
        }
        const foreign = { ...workspace, id: 'foreign-source', machineId: 'machine',
          rootPath: join(member.workspaceRoot, '..', 'other-member', 'foreign-source') };
        const foreignKey = { ...key, id: foreign.id };
        rows.push({ key: foreignKey, revision: 0, content: cipher.seal({ key: foreignKey, value: foreign }) });
        try {
          expect(await register(RPC_METHODS.PROJECTS_OPEN, runtime)({ ...input,
            source: { ...input.source, checkout: { serverId: homeId, workspaceId: foreign.id,
              machineId: 'machine', rootPath: foreign.rootPath } } }, context))
            .toMatchObject({ kind: 'refused', code: 'workspace_private_checkout_required' });
          expect(post.mock.calls.some(([, body]) => ProjectAccountRowMutationRequestV1Schema.safeParse(body).success)).toBe(false);
          expect(nativeSyncBoundary.commands).toEqual([]);
          await expect(access(targetRoot)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
          rows.splice(rows.findIndex(row => row.key.kind === 'workspace-ref' && row.key.id === foreign.id), 1);
          nativeBoundary.runAsUsers.length = 0;
          nativeBoundary.phases.length = 0;
        }
      }
      // Signed Open reads describe child placement. Retained transfers use
      // Account bearer admission once at their next natural boundary.
      const machineReads = () => vi.mocked(axios.get).mock.calls.filter(([url, config]) => url.endsWith('/v1/machines/machine')
        && config?.headers?.Authorization === `Bearer ${token}`).length;
      const initialMachineReads = machineReads();
      const opened = await register(RPC_METHODS.PROJECTS_OPEN, runtime)(input, context);
      if (fault === 'remote_source_ack') {
        expect(remoteTargetPrepared, JSON.stringify(admissionDiagnostics?.mock.calls)).toBe(true);
        expect(opened).toEqual({ kind: 'outcomeUnknown' });
        const captures = productionSync?.handoffAdapter.listPrivateExecutions?.();
        expect(captures).toHaveLength(1);
        const retained = captures?.[0];
        if (!retained?.relationshipId) throw new Error('The remote SOURCE must bind real TARGET custody');
        expect(retained.relationshipId).toBe(deriveWorkspaceSyncRelationshipId(retained.input.operationId));
        expect(retained.phase).toBe('relationship');
        return;
      }
      if (fault === 'endpoint_write_failure') {
        expect(rows.filter(row => row.key.kind === 'workspace-ref')).toHaveLength(2);
        expect(nativeSyncBoundary.commands).toEqual([]);
        await expect(access(targetRoot)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(opened).toMatchObject({ kind: 'outcomeUnknown' });
        return;
      }
      if (fault === 'enabled_graph_ack') {
        expect(graphAcknowledgementLost, JSON.stringify(admissionDiagnostics?.mock.calls)).toBe(true);
        expect(opened).toEqual({ kind: 'outcomeUnknown' });
      }
      else expect(opened, JSON.stringify({
        outcome: opened,
        requestPaths: post.mock.calls.map(([url]) => new URL(url).pathname),
        settlement: admissionDiagnostics?.mock.calls.filter(([message]) => message === '[Project Open] Settlement failed').map(([, details]) => details),
        nativePhases: nativeBoundary.phases })).toMatchObject({ kind: 'opened', directory: targetRoot, setup: 'approvalRequired',
        workspace: { serverId: homeId, machineId: 'machine', rootPath: targetRoot }, facts: { source: { sourceId: source.id, revision: 1 } } });
      if (syncing) expect(machineReads() - initialMachineReads).toBe(0);
      expect(nativeBoundary.childFailure).toBeUndefined();
      expect(nativeBoundary.runAsUsers[0]).toBe(member.username);
      if (syncing) {
        expect(await nativeBoundary.identity.run('member', () => readFile(join(targetRoot, 'payload.txt'), 'utf8'))).toBe('member seed');
        const captured = productionSync?.handoffAdapter.listPrivateExecutions?.();
        if (fault !== 'enabled_graph_ack') expect(captured?.length ?? 0).toBe(action === 'create_relationship' ? 1 : 0);
        expect(rows.filter(row => row.key.kind === 'workspace-ref')).toHaveLength(2);
        expect(nativeBoundary.runAsUsers).toContain('mutagen-member-source');
        expect(nativeBoundary.runAsUsers).toContain('mutagen-member-target');
        if (action === 'create_relationship') {
          if (!productionSync) throw new Error('Missing private Sync runtime');
          const retained = captured?.[0];
          if (!retained?.relationshipId || retained.execution.executionIdentity?.kind !== 'isolated') throw new Error('Missing bound private relationship');
          const capturedIdentity = retained.execution.executionIdentity;
          expect(capturedIdentity.requester).toEqual(requesterIdentity.requester);
          ingress.abort();
          current = false;
          await requesterAccount?.dispose();
          let relationshipId: string;
          if (fault === 'enabled_graph_ack') {
            expect(graphAcknowledgementLost).toBe(true);
            const graph = rows.find(row => row.key.kind === 'relationship-graph');
            if (!graph?.content) throw new Error('The enabled graph must survive its lost acknowledgement');
            const payload = cipher.open(graph.key, graph.content);
            if (!('relationships' in payload.value)) throw new Error('Expected the relationship graph');
            const relationship = payload.value.relationships.find(value => value.enabled);
            if (!relationship) throw new Error('Expected a durably enabled relationship');
            relationshipId = relationship.relationshipId;
            graphAcknowledgementLost = false;
          } else {
            relationshipId = retained.relationshipId;
          }
          await writeFile(join(root, 'payload.txt'), 'member later transfer');
          const nativeLaunches = nativeBoundary.runAsUsers.length;
          const warmMachineReads = machineReads();
          await productionSync.workspaceSync.controller.flush(relationshipId);
          expect(machineReads() - warmMachineReads).toBe(1);
          expect(nativeBoundary.runAsUsers.slice(nativeLaunches)).toEqual(['mutagen-member-source', 'mutagen-member-target']);
          expect(await nativeBoundary.identity.run('member', () => readFile(join(targetRoot, 'payload.txt'), 'utf8')))
            .toBe('member later transfer');
          expect(await captured?.[0]?.execution.accountRowsCustody.isCurrent()).toBe(true);
          await productionSync.stop();
          const recoveredBoundary = createWorkspaceSyncNativeProcessTestBoundary();
          const recovered = await createProductionDaemonWorkspaceSyncRuntime(productionSyncInput, recoveredBoundary.factories);
          recoveredSync = recovered;
          onTestFinished(() => recovered.stop());
          const recoveredCapture = recovered.handoffAdapter.resolvePrivateExecution?.({ relationshipId });
          expect(recoveredCapture?.execution.executionIdentity).toEqual(capturedIdentity);
          expect(recoveredCapture?.execution.credentials.token).toBe(token);
          await writeFile(join(root, 'payload.txt'), 'member recovered transfer');
          const recoveredLaunches = nativeBoundary.runAsUsers.length;
          await recovered.workspaceSync.controller.flush(relationshipId);
          expect(nativeBoundary.runAsUsers.slice(recoveredLaunches)).toEqual(['mutagen-member-source', 'mutagen-member-target']);
          expect(await nativeBoundary.identity.run('member', () => readFile(join(targetRoot, 'payload.txt'), 'utf8')))
            .toBe('member recovered transfer');
          if (fault === 'none') {
            const graphIndex = rows.findIndex(row => row.key.kind === 'relationship-graph');
            if (graphIndex < 0) throw new Error('The committed graph must be present');
            const flushes = recoveredBoundary.commands.filter(command => command.t === 'flush').length;
            const launches = nativeBoundary.runAsUsers.length;
            rows.splice(graphIndex, 1);
            await expect(recovered.workspaceSync.controller.flush(relationshipId))
              .rejects.toMatchObject({ code: 'relationship_not_ready' });
            expect(recoveredBoundary.commands.filter(command => command.t === 'flush')).toHaveLength(flushes);
            expect(nativeBoundary.runAsUsers).toHaveLength(launches);
          }
        }
      } else expect(nativeBoundary.runAsUsers).toEqual([member.username]);
      // Home binding is proved by the real projection/installed-ingress tests;
      // this consumer receives host-private ports only after that admission.
      current = false;
      post.mockClear();
      expect(await register(RPC_METHODS.PROJECTS_OPEN, runtime)(input, { ...context, signal: new AbortController().signal }))
        .toEqual({ kind: 'refused', code: 'requester_authority_unavailable' });
      expect(post).not.toHaveBeenCalled();
      await expect(access(join(root, 'not-executed'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      endpointWriteFailed = false; graphAcknowledgementLost = false;
      try { await recoveredSync?.stop(); }
      finally {
        try { await productionSync?.stop(); }
        finally { nativeBoundary.completed = true; }
      }
    }
  });

  it('accepts the requested host folder for browsing despite an unenrolled Devcontainer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-child-open-'));
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    const writes: unknown[] = [];
    vi.spyOn(axios, 'get').mockImplementation(plainMachineRead);
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (url.endsWith('/list') && url.includes('/machines/managed/')) return { status: 200, data: { machines: [] } };
      if (url.endsWith('/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows: [] } };
      if (url.endsWith('/read')) return projectAccountRowReadResponse([], body);
      writes.push(body);
      const request = ProjectAccountRowMutationRequestV1Schema.parse(body);
      return { status: 200, data: { status: 'updated', rows: request.mutations.map(mutation => ({ key: mutation.key,
        revision: 0, content: mutation.content })), cursor: 1 } };
    });
    try {
      await mkdir(join(root, '.happier'));
      await writeFile(join(root, '.happier/project.json'), JSON.stringify({ version: 1, devcontainer: {} }));
      const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
        machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: 'machine',
          installationId: 'installation', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
      const result = await register(RPC_METHODS.PROJECTS_OPEN, { serverId: 'srv_test_home', serverHttpBaseUrl: 'https://home.example',
        machineId: 'machine', accountId: 'account', readCredentials: async () => ({ token, encryption: null }) })({
        serverId: 'srv_test_home', machineId: 'machine', source: { kind: 'folder', path: root }, materialization: { kind: 'attach' },
      }, context);
      expect(result).toMatchObject({ kind: 'opened', directory: root,
        workspace: { serverId: 'srv_test_home', machineId: 'machine', rootPath: root } });
      expect(writes).toHaveLength(1);
      expect(ProjectAccountRowMutationRequestV1Schema.parse(writes[0]).mutations).toEqual([
        expect.objectContaining({ key: expect.objectContaining({ kind: 'workspace-ref', serverId: 'srv_test_home' }) }),
        { key: { kind: 'relationship-graph' }, expectedRevision: 'absent',
          content: { t: 'plain', v: { key: { kind: 'relationship-graph' }, value: { relationships: [] } } } },
      ]);
      await access(join(root, '.happier/project.json'));
      expect(vi.mocked(axios.post).mock.calls.some(([url]) => url.includes('/sessions') || url.includes('/machines/managed/'))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('accepts the actual enrolled child root under its existing parent Project without realizing another child', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-admitted-child-open-'));
    const homeId = 'srv_qf4_child_owner';
    await seedTestServerProfile({ id: homeId, homeId, serverUrl: 'https://home.example' });
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    const observation = { nativeResourceId: 'native-child', user: 'coder', workspaceFolder: root,
      storage: { kind: 'bind' as const, hostPath: '/host/project', childPath: root } };
    const projection = { relation: { managedMachineId: 'managed-child', managedMachineKind: 'devcontainer' as const,
      parentMachineId: 'parent' }, observation };
    const machine = { id: 'managed-child', homeId, custodianAccountId: 'account',
      controller: { machineId: 'parent', installationId: 'parent-installation' },
      launch: { provider: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, name: 'Child', choices: {
        workspaceFolder: '/host/project', configPath: '/host/project/.devcontainer/a/devcontainer.json', reviewedEffectDigest: 'a'.repeat(64) } },
      resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, value: {}, devcontainerObservation: observation },
      allocation: 'bound', creationState: 'active', enrolledMachineId: 'machine', desired: 'start', desiredWhen: 'now', intentRevision: 1,
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
    socketIo.mockImplementation(() => createApiSessionSocketStub({ emitWithAck: async (_event, payload) => {
      if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string' || !('params' in payload)) throw new Error('Invalid RPC boundary');
      const content = { mode: 'plain' as const };
      const decoded = await socketRpcCodec.decodeRequestParams(content, payload.params, payload.method);
      return { ok: true, result: await socketRpcCodec.encodeResponse(content,
        { machine: { ...machine, observation: { availability: 'present', observedAt: 1 } } }, decoded.callId) };
    } }));
    const parentKey = { kind: 'workspace-ref' as const, serverId: homeId, id: 'parent-workspace' };
    const rows: ProjectAccountRowV1[] = [{ key: parentKey, revision: 0, content: { t: 'plain', v: { key: parentKey,
      value: { id: 'parent-workspace', serverId: homeId, machineId: 'parent', rootPath: '/host/project', projectKey: 'parent-project', createdAtMs: 1 } } } }];
    let parentOnline = false;
    // Physical bind observation now verifies the Home through its real feature
    // reader. Supply that HTTP boundary, not a mock of the authority owner.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async request => {
      if (String(request) !== 'https://home.example/v1/features') throw new Error('Unexpected Home discovery request');
      return Response.json({ features: {}, capabilities: { serverIdentity: { serverIdentityId: homeId } } });
    });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
      if (url.endsWith('/parent')) {
        if (!parentOnline) throw new Error('Physical controller offline');
        const response = await plainMachineRead(url);
        if ('machine' in response.data && response.data.machine) response.data.machine.installationId = 'parent-installation';
        return response;
      }
      return { status: 200, data: { machine: { id: 'machine', active: true, installationId: 'installation',
        devcontainerChild: projection,
        metadataVersion: 1, daemonStateVersion: 0, daemonState: null, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        metadata: encodePlainMachineStoredContent({ host: 'child', platform: 'linux', homeDir: '/home/coder', username: 'coder',
          happyCliVersion: 'test', happyHomeDir: '/home/coder/.happier', devcontainerChild: projection }) } } };
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (url.endsWith('/machines/managed/actions/list')) return { status: 200, data: { machines: [machine] } };
      if (url.endsWith('/machines/managed/actions/get')) return { status: 200, data: machine };
      if (url.endsWith('/project-trust/read')) return { status: 200, data: { status: 'absent' } };
      if (url.endsWith('/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
      if (url.endsWith('/read')) return projectAccountRowReadResponse(rows, body);
      const request = ProjectAccountRowMutationRequestV1Schema.parse(body);
      const changed = request.mutations.map(mutation => ({ key: mutation.key,
        revision: mutation.expectedRevision === 'absent' ? 0 : mutation.expectedRevision + 1, content: mutation.content }));
      for (const row of changed) { const index = rows.findIndex(existing => JSON.stringify(existing.key) === JSON.stringify(row.key));
        if (index < 0) rows.push(row); else rows[index] = row; }
      return { status: 200, data: { status: 'updated', rows: changed, cursor: 1 } };
    });
    try {
      await mkdir(join(root, '.happier'));
      await mkdir(join(root, '.devcontainer/a'), { recursive: true });
      await mkdir(join(root, '.devcontainer/b'), { recursive: true });
      await writeFile(join(root, '.devcontainer/a/devcontainer.json'), JSON.stringify({ image: 'alpine' }));
      await writeFile(join(root, '.devcontainer/b/devcontainer.json'), JSON.stringify({ image: 'ubuntu' }));
      await writeFile(join(root, '.happier/project.json'), JSON.stringify({ version: 1, devcontainer: { configPath: '.devcontainer/a/devcontainer.json' } }));
      const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
        machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: 'machine',
          installationId: 'installation', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
      const result = await register(RPC_METHODS.PROJECTS_OPEN, { serverId: homeId, serverHttpBaseUrl: 'https://home.example',
        machineId: 'machine', accountId: 'account', readCredentials: async () => ({ token, encryption: null }) })({
        serverId: homeId, machineId: 'machine', source: { kind: 'folder', path: root }, materialization: { kind: 'attach' },
      }, context);
      expect(result).toMatchObject({ kind: 'opened', directory: root, workspace: { serverId: homeId, machineId: 'machine', rootPath: root },
        facts: { projectKey: 'parent-project' } });
      expect(post.mock.calls.some(([url]) => url.includes('/acquire') || url.includes('/admit'))).toBe(false);
      const opened = OpenProjectResultV1Schema.parse(result);
      if (opened.kind !== 'opened') throw new Error('Actual child was not admitted');
      parentOnline = true;
      const fields = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
      const snapshot = await readProjectAccountRows({ serverId: homeId, credentials: { token, encryption: null } });
      const noEffect = async (): Promise<never> => { throw new Error('A bind mapping to the same bytes must not copy or launch a process'); };
      const sync = new WorkspaceSyncController({ localServerId: homeId, localMachineId: 'machine',
        resolveWorkspaceRef: id => { const resolved = resolveWorkspaceRefV1(snapshot.workspaceRefs, { serverId: homeId, id });
          return resolved.kind === 'resolved' ? resolved.ref : null; },
        rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(root, 'locks') }),
        lifecycle: { start: noEffect, stop: noEffect }, adapter: { discoverCopyOnceRecoveries: noEffect, rehydrate: noEffect,
          ensure: noEffect, copyOnce: noEffect, get: noEffect, list: noEffect, flush: noEffect, pause: noEffect,
          resume: noEffect, terminate: noEffect, listConflicts: noEffect, diagnoseSelection: noEffect } });
      const copiedOpen = await register(RPC_METHODS.PROJECTS_OPEN, { serverId: homeId,
        serverHttpBaseUrl: 'https://home.example', machineId: 'machine', accountId: 'account',
        readCredentials: async () => ({ token, encryption: null }),
        workspaceSyncAdapter: createWorkspaceSyncHandoffAdapter({ sync, bootstrap: noEffect }) })({
        serverId: homeId, machineId: 'machine', source: { kind: 'workspace', workspaceId: 'parent-workspace',
          checkout: { serverId: homeId, workspaceId: 'parent-workspace', machineId: 'parent', rootPath: '/host/project' } },
        materialization: { kind: 'sync', targetPath: root, workspaceAction: { kind: 'copy_once',
          contentPolicy: { ...fields, policyDigest: computeWorkspaceSyncPolicyDigest(fields) } } },
      }, context);
      expect(copiedOpen).toMatchObject({ kind: 'opened', directory: root, workspace: opened.workspace,
        facts: { projectKey: 'parent-project' } });
      const copy = await register(RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN, { serverId: homeId,
        serverHttpBaseUrl: 'https://home.example', machineId: 'parent', accountId: 'account',
        readCredentials: async () => ({ token, encryption: null }) })({
        serverId: homeId, machineId: 'parent', source: { kind: 'workspace', workspaceId: opened.workspace.workspaceId,
          checkout: opened.workspace }, materialization: { kind: 'sync', targetPath: '/host/project', workspaceAction: {
            kind: 'copy_once', contentPolicy: { ...fields, policyDigest: computeWorkspaceSyncPolicyDigest(fields) } } },
      }, { ...context, machineAdmission: { ...context.machineAdmission!, machineId: 'parent', installationId: 'parent-installation' } });
      // The admitted child and parent name the same bytes, so no engine or duplicate writer is needed.
      expect(copy).toEqual({ kind: 'materialized' });
      const acceptedRows = structuredClone(rows);
      await writeFile(join(root, '.happier/project.json'), JSON.stringify({ version: 1, devcontainer: { configPath: '.devcontainer/b/devcontainer.json' } }));
      const changedSelection = await register(RPC_METHODS.PROJECTS_OPEN, { serverId: homeId, serverHttpBaseUrl: 'https://home.example',
        machineId: 'machine', accountId: 'account', readCredentials: async () => ({ token, encryption: null }) })({
        serverId: homeId, machineId: 'machine', source: { kind: 'folder', path: root }, materialization: { kind: 'attach' },
      }, context);
      expect(changedSelection).toMatchObject({ kind: 'opened', directory: root,
        workspace: opened.workspace, facts: { projectKey: 'parent-project' } });
      expect(rows).toEqual(acceptedRows);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['metadata', 'override', 'selector', 'revoked'] as const)('admits a captured Source before checkout effects (%s)', async change => {
    const root = await mkdtemp(join(tmpdir(), 'happier-source-open-'));
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    const source: ProjectSourceV1 = { id: 'source', revision: 1, name: 'Original', createdByAccountId: 'account', audience: [],
      repository: { provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://forge.example' },
        repository: { nameWithOwner: 'group/repo', cloneUrl: 'https://forge.example/group/repo.git' }, protocol: 'https' }, subdir: 'packages/app' };
    const current: ProjectSourceV1 = { ...source, revision: 9, name: 'Renamed', attachments: [],
      ...(change === 'override' ? { subdir: 'other' } : {}),
      ...(change === 'selector' ? { repository: { ...source.repository, repository: { nameWithOwner: 'group/other', cloneUrl: 'https://forge.example/group/other.git' } } } : {}) };
    const key = { kind: 'workspace-ref' as const, serverId: 'srv_test_home', id: 'checkout' };
    const rows: ProjectAccountRowV1[] = [{ key, revision: 0, content: { t: 'plain', v: { key,
      value: { id: 'checkout', serverId: 'srv_test_home', machineId: 'machine', rootPath: root, createdAtMs: 1 } } } }];
    const reads: string[] = [];
    vi.spyOn(axios, 'request').mockImplementation(async config => {
      reads.push(config.url ?? '');
      return { status: change === 'revoked' ? 404 : 200, data: change === 'revoked'
        ? { ok: false, error: 'source_unavailable' } : { ok: true, source: current, canManage: true } };
    });
    vi.spyOn(axios, 'get').mockImplementation(plainMachineRead);
    const writes: unknown[] = [];
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (url.endsWith('/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
      if (url.endsWith('/read')) return projectAccountRowReadResponse(rows, body);
      const request = ProjectAccountRowMutationRequestV1Schema.parse(body);
      writes.push(request);
      const changed = request.mutations.map(mutation => ({ key: mutation.key,
        revision: mutation.expectedRevision === 'absent' ? 0 : mutation.expectedRevision + 1, content: mutation.content }));
      for (const row of changed) { const index = rows.findIndex(existing => JSON.stringify(existing.key) === JSON.stringify(row.key));
        if (index < 0) rows.push(row); else rows[index] = row; }
      return { status: 200, data: { status: 'updated', rows: changed, cursor: 1 } };
    });
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
      machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: 'machine',
        installationId: 'installation', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
    try {
      await mkdir(join(root, 'packages/app'), { recursive: true });
      const result = await register(RPC_METHODS.PROJECTS_OPEN, { serverId: 'srv_test_home', serverHttpBaseUrl: 'https://home.example',
        machineId: 'machine', accountId: 'account', readCredentials: async () => ({ token, encryption: null }) })({
        serverId: 'srv_test_home', machineId: 'machine', source: { kind: 'source', id: source.id, revision: source.revision,
          selector: source.repository, subdir: source.subdir, checkout: { serverId: 'srv_test_home', workspaceId: 'checkout', machineId: 'machine', rootPath: root } },
        ...(change === 'override' ? { subdir: 'packages/app' } : {}), materialization: change === 'selector' || change === 'revoked'
          ? { kind: 'clone', destinationParentPath: root, destinationDirectoryName: 'must-not-exist' } : { kind: 'attach' },
      }, context);
      expect(reads).toEqual(['https://home.example/v1/projects/sources/source?serverId=srv_test_home']);
      if (change === 'metadata' || change === 'override') {
        expect(result).toMatchObject({ kind: 'opened', directory: join(root, 'packages/app'), facts: { source: { sourceId: 'source', revision: 9 } } });
        expect(writes.length).toBeGreaterThan(0);
      } else {
        expect(result).toEqual({ kind: 'refused', code: change === 'selector' ? 'source_selection_changed' : 'source_unavailable' });
        expect(writes).toEqual([]);
        await expect(access(join(root, 'must-not-exist'))).rejects.toMatchObject({ code: 'ENOENT' });
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['accepted', 'lost_ack', 'cancelled_ack'] as const)('retains browse bytes through real row acceptance and passive setup (%s)', async outcome => {
    const root = await mkdtemp(join(tmpdir(), 'happier-project-open-'));
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    const rows: ProjectAccountRowV1[] = [];
    const controller = new AbortController();
    vi.spyOn(axios, 'get').mockImplementation(plainMachineRead);
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (url.endsWith('/project-trust/read')) return { status: 200, data: { status: 'absent' } };
      if (url.endsWith('/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
      if (url.endsWith('/read')) return projectAccountRowReadResponse(rows, body);
      const request = ProjectAccountRowMutationRequestV1Schema.parse(body);
      const changed = request.mutations.map(mutation => ({ key: mutation.key,
        revision: mutation.expectedRevision === 'absent' ? 0 : mutation.expectedRevision + 1, content: mutation.content }));
      rows.push(...changed);
      if (outcome === 'lost_ack') throw new Error('Committed acknowledgement was lost');
      if (outcome === 'cancelled_ack') controller.abort();
      return { status: 200, data: { status: 'updated', rows: changed, cursor: 1 } };
    });
    const context: RpcHandlerContext = { signal: controller.signal, callerAuthority: 'present_user',
      machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: 'machine',
        installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => true,
    };
    try {
      await mkdir(join(root, '.happier'));
      await writeFile(join(root, '.happier/project.json'), JSON.stringify({ version: 1,
        workspace: { setup: [{ kind: 'command', command: 'touch should-not-exist' }] } }));
      const runtime: ProjectOpenRuntime = { serverId: 'srv_test_home', serverHttpBaseUrl: 'https://home.example', machineId: 'machine', accountId: 'account',
        readCredentials: async () => ({ token, encryption: null }),
      };
      const result = await register(RPC_METHODS.PROJECTS_OPEN, runtime)({ serverId: 'srv_test_home', machineId: 'machine',
        source: { kind: 'folder', path: root }, materialization: { kind: 'attach' } }, context);
      if (outcome === 'accepted') expect(result).toMatchObject({ kind: 'opened', directory: root, setup: 'approvalRequired',
        workspace: { serverId: 'srv_test_home', machineId: 'machine', rootPath: root } });
      else expect(result).toEqual({ kind: 'outcomeUnknown' });
      expect(rows.some(row => row.key.kind === 'workspace-ref')).toBe(true);
      await expect(access(join(root, 'should-not-exist'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(join(root, '.happier/project.json'))).resolves.toBeUndefined();
      expect(vi.mocked(axios.post).mock.calls.every(([url]) => !url.includes('/account/settings') && !url.endsWith('/project-trust/mutate'))).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('refuses a missing canonical producer before inspecting or materializing a folder', async () => {
    const handler = register();
    expect(await handler({ serverId: 'srv_test_home', machineId: 'machine', source: { kind: 'folder', path: '/not-created' }, materialization: { kind: 'attach' } }))
      .toEqual({ kind: 'refused', code: 'project_open_unavailable' });
  });

  it.each(['foreign', 'restricted'] as const)('keeps %s Source Open refused before reading or materializing', async requester => {
    const request = vi.spyOn(axios, 'request');
    const runtime: ProjectOpenRuntime = { serverId: 'srv_test_home', serverHttpBaseUrl: 'https://home.example', machineId: 'machine', accountId: 'account',
      readCredentials: async () => { throw new Error('Unauthorized caller cannot read stored credentials'); } };
    const context: RpcHandlerContext = { signal: new AbortController().signal,
      callerAuthority: requester === 'restricted' ? 'account_automation' : 'present_user',
      machineAdmission: { actorAccountId: requester === 'foreign' ? 'other' : 'account', custodianAccountId: 'account', machineId: 'machine',
        installationId: 'installation', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
    expect(await register(RPC_METHODS.PROJECTS_OPEN, runtime)({ serverId: 'srv_test_home', machineId: 'machine',
      source: { kind: 'source', id: 'source', revision: 1, selector: {
        provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://forge.example' },
        repository: { nameWithOwner: 'group/repo' }, protocol: 'https' } },
      materialization: { kind: 'clone', destinationParentPath: '/not-created', destinationDirectoryName: 'repo' } }, context))
      .toEqual({ kind: 'refused', code: requester === 'foreign' ? 'requester_account_unavailable' : 'requester_authority_unavailable' });
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects malformed authority and another Home or Machine at the real receiver', async () => {
    const handler = register();
    const input = { serverId: 'srv_test_home', machineId: 'machine', source: { kind: 'folder', path: '/not-created' }, materialization: { kind: 'attach' } };
    expect(await handler({ ...input, actorAccountId: 'other' })).toEqual({ kind: 'refused', code: 'invalid_input' });
    expect(await handler({ ...input, serverId: 'other' })).toEqual({ kind: 'refused', code: 'target_mismatch' });
    expect(await handler({ ...input, machineId: 'other' })).toEqual({ kind: 'refused', code: 'target_mismatch' });
  });

  it('registers the private source route without treating target Home input as source authority', async () => {
    const source = register(RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN);
    const input = { serverId: 'srv_test_home', machineId: 'target', source: { kind: 'folder', path: '/not-created' }, materialization: { kind: 'attach' } };
    expect(await source({ ...input, serverId: 'other' })).toEqual({ kind: 'refused', code: 'target_mismatch' });
    expect(await source({ ...input, custodianAccountId: 'forged' })).toEqual({ kind: 'refused', code: 'invalid_input' });
    expect(await source(input)).toEqual({ kind: 'refused', code: 'project_open_unavailable' });
  });

  it('does not interpret an absent verified source installation as personal owner authority', async () => {
    const runtime: ProjectOpenRuntime = { serverId: 'srv_test_home', serverHttpBaseUrl: 'http://127.0.0.1', machineId: 'machine', accountId: 'account',
      readCredentials: () => readStoredCredentialsForServerId('srv_test_home'),
    };
    const input = { serverId: 'srv_test_home', machineId: 'machine', source: { kind: 'folder', path: '/not-created' }, materialization: { kind: 'attach' } };
    expect(await register(RPC_METHODS.PROJECTS_OPEN, runtime)(input)).toEqual({ kind: 'refused', code: 'machine_admission_unavailable' });
    expect(await register(RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN, runtime)(input)).toEqual({ kind: 'refused', code: 'invalid_materialization' });
  });

  it('binds a private source call to the exact qualified accepted source before Sync effects', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    const value = { id: 'source', serverId: 'srv_test_home', machineId: 'other-source-machine', rootPath: '/source', createdAtMs: 1 };
    const key = { kind: 'workspace-ref' as const, serverId: 'srv_test_home', id: 'source' };
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { status: 'listed', coverage: 'complete',
      rows: [{ key, revision: 0, content: { t: 'plain', v: { key, value } } }] } });
    vi.spyOn(axios, 'get').mockImplementation(plainMachineRead);
    const runtime: ProjectOpenRuntime = { serverId: 'srv_test_home', serverHttpBaseUrl: 'https://home.example', machineId: 'machine', accountId: 'account',
      readCredentials: async () => ({ token, encryption: null }) };
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
      machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: 'machine', installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => true };
    const fields = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const input = { serverId: 'srv_test_home', machineId: 'target', source: { kind: 'workspace', workspaceId: 'source',
      checkout: { serverId: 'srv_test_home', workspaceId: 'source', machineId: 'other-source-machine', rootPath: '/source' } },
      materialization: { kind: 'sync', targetPath: '/target', workspaceAction: { kind: 'copy_once',
        contentPolicy: { ...fields, policyDigest: computeWorkspaceSyncPolicyDigest(fields) } } } };
    const source = register(RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN, runtime);
    expect(await source(input, context)).toEqual({ kind: 'refused', code: 'source_machine_mismatch' });
    expect(await source({ ...input, source: { ...input.source, checkout: { ...input.source.checkout, rootPath: '/invented-source' } } }, context))
      .toEqual({ kind: 'refused', code: 'source_machine_mismatch' });
    expect(post.mock.calls.every(([url]) => url.endsWith('/list'))).toBe(true);
    post.mockClear();
    expect(await source(input, { ...context, callerAuthority: 'account_automation' }))
      .toEqual({ kind: 'refused', code: 'requester_authority_unavailable' });
    expect(post).not.toHaveBeenCalled();
  });

  it('rechecks Source copy authority for a new destination without dereferencing an absent accepted target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-source-copy-open-'));
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    const workspace = { id: 'checkout', serverId: 'srv_test_home', machineId: 'machine', rootPath: root, createdAtMs: 1 };
    const key = { kind: 'workspace-ref' as const, serverId: 'srv_test_home', id: workspace.id };
    const source: ProjectSourceV1 = { id: 'source', revision: 9, name: 'Repository', createdByAccountId: 'account', audience: [],
      repository: { provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://forge.example' },
        repository: { nameWithOwner: 'group/repo' }, protocol: 'https' } };
    let current = true;
    vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: { ok: true, source, canManage: true } });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const response = await plainMachineRead(url);
      if (url.includes('/v1/machines/machine')) current = false;
      return response;
    });
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { status: 'listed', coverage: 'complete',
      rows: [{ key, revision: 0, content: { t: 'plain', v: { key, value: workspace } } }] } });
    // Mutagen/process effects are the external boundary. The Sync controller,
    // handoff adapter and root custody remain real and must never reach it.
    const noEffect = async (): Promise<never> => { throw new Error('Retired copy must not launch a process or mutate bytes'); };
    const sync = new WorkspaceSyncController({ localServerId: 'srv_test_home', localMachineId: 'machine',
      resolveWorkspaceRef: id => { const resolved = resolveWorkspaceRefV1([workspace], { serverId: 'srv_test_home', id });
        return resolved.kind === 'resolved' ? resolved.ref : null; },
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(root, 'locks') }),
      lifecycle: { start: noEffect, stop: noEffect }, adapter: { discoverCopyOnceRecoveries: noEffect, rehydrate: noEffect,
        ensure: noEffect, copyOnce: noEffect, get: noEffect, list: noEffect, flush: noEffect, pause: noEffect,
        resume: noEffect, terminate: noEffect, listConflicts: noEffect, diagnoseSelection: noEffect } });
    const runtime: ProjectOpenRuntime = { serverId: 'srv_test_home', serverHttpBaseUrl: 'https://home.example', machineId: 'machine', accountId: 'account',
      readCredentials: async () => ({ token, encryption: null }), workspaceSyncAdapter: createWorkspaceSyncHandoffAdapter({ sync, bootstrap: noEffect }) };
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
      machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: 'machine', installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => current };
    const fields = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const targetPath = join(root, 'not-created');
    try {
      expect(await register(RPC_METHODS.PROJECTS_OPEN, runtime)({ serverId: 'srv_test_home', machineId: 'machine',
        source: { kind: 'source', id: source.id, revision: 1, selector: source.repository,
          checkout: { serverId: 'srv_test_home', workspaceId: workspace.id, machineId: 'machine', rootPath: root } },
        materialization: { kind: 'sync', targetPath, workspaceAction: { kind: 'copy_once',
          contentPolicy: { ...fields, policyDigest: computeWorkspaceSyncPolicyDigest(fields) } } },
      }, context)).toEqual({ kind: 'refused', code: 'machine_access_denied' });
      expect(post.mock.calls.every(([url]) => url.endsWith('/list'))).toBe(true);
      await expect(access(targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reauthorizes Source selection on the private copy host before Sync effects', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    vi.spyOn(axios, 'request').mockResolvedValue({ status: 404, data: { ok: false, error: 'source_unavailable' } });
    const post = vi.spyOn(axios, 'post');
    const runtime: ProjectOpenRuntime = { serverId: 'srv_test_home', serverHttpBaseUrl: 'https://home.example', machineId: 'machine', accountId: 'account',
      readCredentials: async () => ({ token, encryption: null }) };
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
      machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: 'machine', installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => true };
    const fields = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const result = await register(RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN, runtime)({
      serverId: 'srv_test_home', machineId: 'target', source: { kind: 'source', id: 'source', revision: 1,
        selector: { provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://forge.example' },
          repository: { nameWithOwner: 'group/repo' }, protocol: 'https' },
        checkout: { serverId: 'srv_test_home', workspaceId: 'checkout', machineId: 'machine', rootPath: '/source' } },
      materialization: { kind: 'sync', targetPath: '/target', workspaceAction: { kind: 'copy_once',
        contentPolicy: { ...fields, policyDigest: computeWorkspaceSyncPolicyDigest(fields) } } },
    }, context);
    expect(result).toEqual({ kind: 'refused', code: 'source_unavailable' });
    expect(post).not.toHaveBeenCalled();
  });

  it('reports known cancellation when final Home verification aborts before checkout effects', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    const controller = new AbortController();
    let snapshotRead = false;
    vi.spyOn(axios, 'get').mockImplementation(plainMachineRead);
    const post = vi.spyOn(axios, 'post').mockImplementation(async () => {
      snapshotRead = true;
      return { status: 200, data: { status: 'listed', coverage: 'complete', rows: [] } };
    });
    const runtime: ProjectOpenRuntime = { serverId: 'srv_test_home', serverHttpBaseUrl: 'https://home.example', machineId: 'machine', accountId: 'account',
      readCredentials: async () => ({ token, encryption: null }) };
    const context: RpcHandlerContext = { signal: controller.signal, callerAuthority: 'present_user',
      machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: 'machine', installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => { if (snapshotRead) controller.abort(); return !controller.signal.aborted; } };
    expect(await register(RPC_METHODS.PROJECTS_OPEN, runtime)({ serverId: 'srv_test_home', machineId: 'machine',
      source: { kind: 'folder', path: '/not-created' }, materialization: { kind: 'worktree',
        checkout: { kind: 'git_worktree', displayName: 'feature', baseRef: null } } }, context))
      .toEqual({ kind: 'refused', code: 'cancelled' });
    expect(post.mock.calls.every(([url]) => url.endsWith('/list'))).toBe(true);
  });
});
