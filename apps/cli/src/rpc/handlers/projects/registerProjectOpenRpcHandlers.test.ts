import axios from 'axios';
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectAccountRowMutationRequestV1Schema, type ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
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
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { WorkspaceSyncController } from '@/workspaces/sync/workspaceSyncController';
import { createWorkspaceSyncHandoffAdapter } from '@/workspaces/sync/workspaceSyncHandoffAdapter';
import { createWorkspaceRootOwnershipManager } from '@/workspaces/sync/workspaceSyncRootOwnership';
import { resolveWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { ScmHostingProviderContributionSchema } from '@happier-dev/protocol';
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
import { prepareDaemonHomeIrohTransport } from '@/daemon/peer/iroh/daemonHomeIrohTransport';
import { getServerProfile } from '@/server/serverProfiles';

const socketIo = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({ io: socketIo }));
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
  target = { serverId: runtime?.serverId ?? 'home', machineId: runtime?.machineId ?? 'machine' }) {
  const handlers = new Map<string, RpcHandler<unknown, unknown>>();
  // The RPC transport receives untyped JSON; the real registered owner validates it.
  const registrar: RpcHandlerRegistrar = { registerHandler: (method, handler) => { handlers.set(method, handler as RpcHandler<unknown, unknown>); } };
  registerProjectOpenRpcHandlers(registrar, { ...target, ...(runtime ? { runtime } : {}) });
  const handler = handlers.get(method);
  if (!handler) throw new Error('Open is not registered');
  return handler;
}

describe('Project Open RPC', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); socketIo.mockReset(); withdrawActiveProjectAccountRowsSnapshot(); });

  it.each(['opened', 'refused', 'outcomeUnknown'] as const)('retains the original Open settlement in Action Operations (%s)', async settlement => {
    const root = await mkdtemp(join(tmpdir(), 'happier-open-operation-'));
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
      transportRequestId: 'original-open-request',
      machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: 'machine',
        installationId: 'installation', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
    const operations = createHostActionOperationRuntime({ serverId: 'home', machineId: 'machine',
      resolveAccountId: async () => 'account', generateOperationId: () => 'original-open-operation' });
    const runtime: ProjectOpenRuntime = { serverId: 'home', serverHttpBaseUrl: 'https://home.example', machineId: 'machine',
      accountId: 'account', readCredentials: async () => ({ token, encryption: null }) };
    const rows: ProjectAccountRowV1[] = [];
    let mutations = 0;
    vi.spyOn(axios, 'get').mockImplementation(plainMachineRead);
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (url.endsWith('/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
      mutations += 1;
      const request = ProjectAccountRowMutationRequestV1Schema.parse(body);
      const changed = request.mutations.map(mutation => ({ key: mutation.key, revision: 0, content: mutation.content }));
      rows.push(...changed);
      if (settlement === 'outcomeUnknown') throw new Error('Accepted row acknowledgement lost');
      return { status: 200, data: { status: 'updated', rows: changed, cursor: 1 } };
    });
    const handlers = new Map<string, RpcHandler<unknown, unknown>>();
    const registrar: RpcHandlerRegistrar = { registerHandler: (method, handler) => { handlers.set(method, handler as RpcHandler<unknown, unknown>); } };
    const registration = { serverId: 'home', machineId: 'machine', runtime, observeExecution: operations.observeExecution };
    registerProjectOpenRpcHandlers(registrar, registration);
    try {
      const handler = handlers.get(RPC_METHODS.PROJECTS_OPEN)!;
      const result = await handler({ serverId: 'home', machineId: 'machine', source: { kind: 'folder',
        path: settlement === 'refused' ? join(root, 'missing') : root }, materialization: { kind: 'attach' } }, context);
      expect(result).toMatchObject({ kind: settlement, ...(settlement === 'outcomeUnknown' ? { operationId: 'original-open-operation' } : {}) });
      const found = await operations.handlers.getV2({ operationId: 'original-open-operation' }, context);
      expect(found).toMatchObject({ kind: 'found', operation: { actionId: 'projects.open', scope: { accountId: 'account', machineId: 'machine' },
        result } });
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
    const runtime: ProjectOpenRuntime = { serverId: 'home', serverHttpBaseUrl: 'https://home.example', machineId: 'machine',
      accountId: 'account', registry, readCredentials: async () => ({ token, encryption: null }) };
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
      machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: 'machine',
        installationId: 'installation', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
    const rows: ProjectAccountRowV1[] = [];
    let loseAcknowledgement = false;
    vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: { ok: true, source, canManage: true } });
    vi.spyOn(axios, 'get').mockImplementation(plainMachineRead);
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (url.endsWith('/machines/managed/actions/list')) return { status: 200, data: { machines: [] } };
      if (url.endsWith('/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
      const request = ProjectAccountRowMutationRequestV1Schema.parse(body);
      const changed = request.mutations.map(mutation => ({ key: mutation.key, revision: 0, content: mutation.content }));
      rows.push(...changed);
      if (loseAcknowledgement) throw new Error('Accepted row acknowledgement lost');
      return { status: 200, data: { status: 'updated', rows: changed, cursor: 1 } };
    });
    const diagnostic = vi.spyOn(logger, 'warnLocalFile');
    const handler = register(RPC_METHODS.PROJECTS_OPEN, runtime);
    const input = { serverId: 'home', machineId: 'machine', source: { kind: 'source' as const, id: source.id, revision: 2,
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
        workspace: { serverId: 'home', machineId: 'machine', rootPath: join(root, 'checkout') },
        facts: { source: { sourceId: source.id, revision: 2 } } });
      expect(rows.some(row => row.key.kind === 'workspace-ref')).toBe(true);
      await access(join(root, 'checkout', '.happier/project.json'));
      expect(vi.mocked(axios.post).mock.calls.some(([url]) => url.includes('/sessions') || url.includes('/machines/managed/'))).toBe(false);
      expect((await git('git', ['branch', '--show-current'], { cwd: join(root, 'checkout') })).stdout.trim()).toBe('master');
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
      await updateSettings(settings => ({ ...settings, activeServerId: profileId,
        servers: { [profileId]: { id: profileId, name: 'QA', serverUrl, webappUrl: serverUrl,
          createdAt: 1, updatedAt: 1, lastUsedAt: 1 } } }));
      await mkdir(root);
      const runtime: ProjectOpenRuntime = { serverId: profileId, machineId, serverHttpBaseUrl: serverUrl,
        accountId: 'account', readCredentials: async () => ({ token, encryption: null }) };
      const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
        machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId,
          installationId: 'installation', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
      const target = { serverId: profileId, machineId };
      const handler = register(RPC_METHODS.PROJECTS_OPEN, runtime, target);
      const folder = { serverId, machineId, source: { kind: 'folder' as const, path: root }, materialization: { kind: 'attach' as const } };
      expect(await handler(folder, context)).toEqual({ kind: 'refused', code: 'target_mismatch' });
      // Only the Home HTTP boundary is mocked. Start from the predecessor/Stack
      // URL-only profile and pass the provisioned credential through real startup verification.
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
        expect(String(url)).toBe(`${serverUrl}/v1/features/authenticated`);
        expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
        return Response.json({ features: {}, capabilities: { serverIdentity: { serverIdentityId: serverId } },
          homeConnectionDescriptor: { v: 1, homeServerIdentityId: serverId, canonicalServerUrl: serverUrl,
            revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] } });
      }));
      const transport = await prepareDaemonHomeIrohTransport({ runtime: null, profile: await getServerProfile(profileId),
        applicationCarrierEligibility: 'standard_only' });
      try {
        expect(await transport.verifyAuthenticated(token)).toEqual({ status: 'ready' });
      } finally { await transport.release(); vi.unstubAllGlobals(); }
      expect(await handler(folder, context)).toMatchObject({ kind: 'opened', directory: root,
        workspace: { serverId, machineId, rootPath: root } });
      const workspaceRow = rows.find(row => row.key.kind === 'workspace-ref');
      if (!workspaceRow || workspaceRow.key.kind !== 'workspace-ref') throw new Error('Expected accepted checkout row');
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
        expect(await sourceHandler(copy, context), scenario).toEqual({ kind: 'refused', code: 'target_mismatch' });
        expect(read).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
      }
    } finally { scope.restore(); reloadConfiguration(); await rm(home, { recursive: true, force: true }); }
  });

  it.each(['plain', 'e2ee'] as const)('accepts a scoped requester Source and ref through its admitted private ports without reading custodian credentials (%s)', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'happier-requester-open-'));
    const material = mode === 'e2ee' ? { type: 'legacy' as const, secret: new Uint8Array(32).fill(8) } : null;
    const cipher = createProjectAccountRowCipherV1({ mode, material, randomBytes: n => new Uint8Array(n) });
    const key = { kind: 'workspace-ref' as const, serverId: 'home', id: 'bob-checkout' };
    const workspace = { id: key.id, serverId: 'home', machineId: 'machine', rootPath: root, createdAtMs: 1 };
    const rows: ProjectAccountRowV1[] = [{ key, revision: 0, content: cipher.seal({ key, value: workspace }) }];
    const source: ProjectSourceV1 = { id: 'bob-source', revision: 1, name: 'Bob Source', createdByAccountId: 'bob', audience: [],
      repository: { provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://forge.example' },
        repository: { nameWithOwner: 'group/repo' }, protocol: 'https' } };
    let current = true;
    // Private ports represent admitted host custody. Only HTTP/crypto system boundaries are supplied here.
    const authorization = { v: 1, token: 'admitted-requester-fixture',
      binding: { accountId: 'bob', machineId: 'machine', custodianAccountId: 'alice',
      installationId: 'installation', actionId: 'projects.open', accountEncryptionMode: mode,
      authentication: { kind: 'terminal', tokenEpoch: 0 }, serverIdentityId: 'identity',
      requestId: 'requester-open', requestEnvelopeDigest: 'A'.repeat(43), target: { kind: 'machine', machineId: 'machine' } },
      requesterAccountProjection: { accountId: 'bob', serverId: 'home', accountEncryptionMode: mode, projectAccountRowCipher: cipher,
        projectTrustRowCipher: createProjectSetupTrustRowCipher({ mode, material }),
        isCurrent: async () => current, readArtifact: async () => null },
      requesterHttpProjection: { accountId: 'bob', serverId: 'home', serverIdentityId: 'identity', serverHttpBaseUrl: 'https://home.example',
        accountEncryptionMode: mode, isCurrent: async () => current,
        createRequestHeaders: async () => current ? { 'x-requester-proof': 'bob' } : null },
    } satisfies ExternalActionExecutionAuthorizationV1;
    vi.spyOn(axios, 'request').mockImplementation(async request => {
      expect(request.headers).toMatchObject({ 'x-requester-proof': 'bob' });
      return { status: 200, data: { ok: true, source, canManage: false } };
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
      expect(config?.headers).toMatchObject({ 'x-requester-proof': 'bob' });
      expect(config?.headers).not.toHaveProperty('Authorization');
      if (url.endsWith('/project-trust/read')) return { status: 200, data: { status: 'absent' } };
      if (url.endsWith('/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
      const request = ProjectAccountRowMutationRequestV1Schema.parse(body);
      const changed = request.mutations.map(mutation => ({ key: mutation.key,
        revision: mutation.expectedRevision === 'absent' ? 0 : mutation.expectedRevision + 1, content: mutation.content }));
      for (const row of changed) { const index = rows.findIndex(existing => JSON.stringify(existing.key) === JSON.stringify(row.key));
        if (index < 0) rows.push(row); else rows[index] = row; }
      return { status: 200, data: { status: 'updated', cursor: 1, rows: changed } };
    });
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'account_automation',
      callerInputAuthorization: authorization, machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice',
        machineId: 'machine', installationId: 'installation', role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
    const runtime: ProjectOpenRuntime = { serverId: 'home', serverHttpBaseUrl: 'https://home.example', machineId: 'machine', accountId: 'alice',
      readCredentials: async () => { throw new Error('Bob must not use Alice credentials'); } };
    const input = { serverId: 'home', machineId: 'machine', source: { kind: 'source', id: source.id, revision: 1, selector: source.repository,
      checkout: { serverId: 'home', workspaceId: key.id, machineId: 'machine', rootPath: root } }, materialization: { kind: 'attach' } };
    try {
      await mkdir(join(root, '.happier'));
      await writeFile(join(root, '.happier/project.json'), JSON.stringify({ version: 1, workspace: { setup: [{ kind: 'command', command: 'touch not-executed' }] } }));
      const opened = await register(RPC_METHODS.PROJECTS_OPEN, runtime)(input, context);
      expect(opened, JSON.stringify(post.mock.calls.map(([url]) => url))).toMatchObject({ kind: 'opened', directory: root, setup: 'approvalRequired',
        workspace: { serverId: 'home', machineId: 'machine', rootPath: root }, facts: { source: { sourceId: source.id, revision: 1 } } });
      post.mockClear();
      const wrongHome = { ...authorization, requesterHttpProjection: {
        ...authorization.requesterHttpProjection, serverIdentityId: 'another-home',
      } } satisfies ExternalActionExecutionAuthorizationV1;
      expect(await register(RPC_METHODS.PROJECTS_OPEN, runtime)(input, { ...context,
        callerInputAuthorization: wrongHome })).toEqual({ kind: 'refused', code: 'requester_authority_unavailable' });
      expect(post).not.toHaveBeenCalled();
      current = false;
      post.mockClear();
      expect(await register(RPC_METHODS.PROJECTS_OPEN, runtime)(input, context)).toEqual({ kind: 'refused', code: 'requester_authority_unavailable' });
      expect(post).not.toHaveBeenCalled();
      await expect(access(join(root, 'not-executed'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('accepts the requested host folder for browsing despite an unenrolled Devcontainer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-child-open-'));
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    const writes: unknown[] = [];
    vi.spyOn(axios, 'get').mockImplementation(plainMachineRead);
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (url.endsWith('/list') && url.includes('/machines/managed/')) return { status: 200, data: { machines: [] } };
      if (url.endsWith('/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows: [] } };
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
      const result = await register(RPC_METHODS.PROJECTS_OPEN, { serverId: 'home', serverHttpBaseUrl: 'https://home.example',
        machineId: 'machine', accountId: 'account', readCredentials: async () => ({ token, encryption: null }) })({
        serverId: 'home', machineId: 'machine', source: { kind: 'folder', path: root }, materialization: { kind: 'attach' },
      }, context);
      expect(result).toMatchObject({ kind: 'opened', directory: root,
        workspace: { serverId: 'home', machineId: 'machine', rootPath: root } });
      expect(writes).toHaveLength(1);
      expect(ProjectAccountRowMutationRequestV1Schema.parse(writes[0]).mutations).toEqual([
        expect.objectContaining({ key: expect.objectContaining({ kind: 'workspace-ref', serverId: 'home' }) }),
      ]);
      await access(join(root, '.happier/project.json'));
      expect(vi.mocked(axios.post).mock.calls.some(([url]) => url.includes('/sessions') || url.includes('/machines/managed/'))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('accepts the actual enrolled child root under its existing parent Project without realizing another child', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-admitted-child-open-'));
    const homeId = 'srv_qf4_child_owner';
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
    const key = { kind: 'workspace-ref' as const, serverId: 'home', id: 'checkout' };
    const rows: ProjectAccountRowV1[] = [{ key, revision: 0, content: { t: 'plain', v: { key,
      value: { id: 'checkout', serverId: 'home', machineId: 'machine', rootPath: root, createdAtMs: 1 } } } }];
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
      const result = await register(RPC_METHODS.PROJECTS_OPEN, { serverId: 'home', serverHttpBaseUrl: 'https://home.example',
        machineId: 'machine', accountId: 'account', readCredentials: async () => ({ token, encryption: null }) })({
        serverId: 'home', machineId: 'machine', source: { kind: 'source', id: source.id, revision: source.revision,
          selector: source.repository, subdir: source.subdir, checkout: { serverId: 'home', workspaceId: 'checkout', machineId: 'machine', rootPath: root } },
        ...(change === 'override' ? { subdir: 'packages/app' } : {}), materialization: change === 'selector' || change === 'revoked'
          ? { kind: 'clone', destinationParentPath: root, destinationDirectoryName: 'must-not-exist' } : { kind: 'attach' },
      }, context);
      expect(reads).toEqual(['https://home.example/v1/projects/sources/source?serverId=home']);
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
      const runtime: ProjectOpenRuntime = { serverId: 'home', serverHttpBaseUrl: 'https://home.example', machineId: 'machine', accountId: 'account',
        readCredentials: async () => ({ token, encryption: null }),
      };
      const result = await register(RPC_METHODS.PROJECTS_OPEN, runtime)({ serverId: 'home', machineId: 'machine',
        source: { kind: 'folder', path: root }, materialization: { kind: 'attach' } }, context);
      if (outcome === 'accepted') expect(result).toMatchObject({ kind: 'opened', directory: root, setup: 'approvalRequired',
        workspace: { serverId: 'home', machineId: 'machine', rootPath: root } });
      else expect(result).toEqual({ kind: 'outcomeUnknown' });
      expect(rows.some(row => row.key.kind === 'workspace-ref')).toBe(true);
      await expect(access(join(root, 'should-not-exist'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(join(root, '.happier/project.json'))).resolves.toBeUndefined();
      expect(vi.mocked(axios.post).mock.calls.every(([url]) => !url.includes('/account/settings') && !url.endsWith('/project-trust/mutate'))).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('refuses a missing canonical producer before inspecting or materializing a folder', async () => {
    const handler = register();
    expect(await handler({ serverId: 'home', machineId: 'machine', source: { kind: 'folder', path: '/not-created' }, materialization: { kind: 'attach' } }))
      .toEqual({ kind: 'refused', code: 'project_open_unavailable' });
  });

  it.each(['foreign', 'restricted'] as const)('keeps %s Source Open refused before reading or materializing', async requester => {
    const request = vi.spyOn(axios, 'request');
    const runtime: ProjectOpenRuntime = { serverId: 'home', serverHttpBaseUrl: 'https://home.example', machineId: 'machine', accountId: 'account',
      readCredentials: async () => { throw new Error('Unauthorized caller cannot read stored credentials'); } };
    const context: RpcHandlerContext = { signal: new AbortController().signal,
      callerAuthority: requester === 'restricted' ? 'account_automation' : 'present_user',
      machineAdmission: { actorAccountId: requester === 'foreign' ? 'other' : 'account', custodianAccountId: 'account', machineId: 'machine',
        installationId: 'installation', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
    expect(await register(RPC_METHODS.PROJECTS_OPEN, runtime)({ serverId: 'home', machineId: 'machine',
      source: { kind: 'source', id: 'source', revision: 1, selector: {
        provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://forge.example' },
        repository: { nameWithOwner: 'group/repo' }, protocol: 'https' } },
      materialization: { kind: 'clone', destinationParentPath: '/not-created', destinationDirectoryName: 'repo' } }, context))
      .toEqual({ kind: 'refused', code: requester === 'foreign' ? 'requester_account_unavailable' : 'requester_authority_unavailable' });
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects malformed authority and another Home or Machine at the real receiver', async () => {
    const handler = register();
    const input = { serverId: 'home', machineId: 'machine', source: { kind: 'folder', path: '/not-created' }, materialization: { kind: 'attach' } };
    expect(await handler({ ...input, actorAccountId: 'other' })).toEqual({ kind: 'refused', code: 'invalid_input' });
    expect(await handler({ ...input, serverId: 'other' })).toEqual({ kind: 'refused', code: 'target_mismatch' });
    expect(await handler({ ...input, machineId: 'other' })).toEqual({ kind: 'refused', code: 'target_mismatch' });
  });

  it('registers the private source route without treating target Home input as source authority', async () => {
    const source = register(RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN);
    const input = { serverId: 'home', machineId: 'target', source: { kind: 'folder', path: '/not-created' }, materialization: { kind: 'attach' } };
    expect(await source({ ...input, serverId: 'other' })).toEqual({ kind: 'refused', code: 'target_mismatch' });
    expect(await source({ ...input, custodianAccountId: 'forged' })).toEqual({ kind: 'refused', code: 'invalid_input' });
    expect(await source(input)).toEqual({ kind: 'refused', code: 'project_open_unavailable' });
  });

  it('does not interpret an absent verified source installation as personal owner authority', async () => {
    const runtime: ProjectOpenRuntime = { serverId: 'home', serverHttpBaseUrl: 'http://127.0.0.1', machineId: 'machine', accountId: 'account',
      readCredentials: () => readStoredCredentialsForServerId('home'),
    };
    const input = { serverId: 'home', machineId: 'machine', source: { kind: 'folder', path: '/not-created' }, materialization: { kind: 'attach' } };
    expect(await register(RPC_METHODS.PROJECTS_OPEN, runtime)(input)).toEqual({ kind: 'refused', code: 'machine_admission_unavailable' });
    expect(await register(RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN, runtime)(input)).toEqual({ kind: 'refused', code: 'invalid_materialization' });
  });

  it('binds a private source call to the exact qualified accepted source before Sync effects', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    const value = { id: 'source', serverId: 'home', machineId: 'other-source-machine', rootPath: '/source', createdAtMs: 1 };
    const key = { kind: 'workspace-ref' as const, serverId: 'home', id: 'source' };
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { status: 'listed', coverage: 'complete',
      rows: [{ key, revision: 0, content: { t: 'plain', v: { key, value } } }] } });
    vi.spyOn(axios, 'get').mockImplementation(plainMachineRead);
    const runtime: ProjectOpenRuntime = { serverId: 'home', serverHttpBaseUrl: 'https://home.example', machineId: 'machine', accountId: 'account',
      readCredentials: async () => ({ token, encryption: null }) };
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
      machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: 'machine', installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => true };
    const fields = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const input = { serverId: 'home', machineId: 'target', source: { kind: 'workspace', workspaceId: 'source',
      checkout: { serverId: 'home', workspaceId: 'source', machineId: 'other-source-machine', rootPath: '/source' } },
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
    const workspace = { id: 'checkout', serverId: 'home', machineId: 'machine', rootPath: root, createdAtMs: 1 };
    const key = { kind: 'workspace-ref' as const, serverId: 'home', id: workspace.id };
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
    const sync = new WorkspaceSyncController({ localServerId: 'home', localMachineId: 'machine',
      resolveWorkspaceRef: id => { const resolved = resolveWorkspaceRefV1([workspace], { serverId: 'home', id });
        return resolved.kind === 'resolved' ? resolved.ref : null; },
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(root, 'locks') }),
      lifecycle: { start: noEffect, stop: noEffect }, adapter: { discoverCopyOnceRecoveries: noEffect, rehydrate: noEffect,
        ensure: noEffect, copyOnce: noEffect, get: noEffect, list: noEffect, flush: noEffect, pause: noEffect,
        resume: noEffect, terminate: noEffect, listConflicts: noEffect, diagnoseSelection: noEffect } });
    const runtime: ProjectOpenRuntime = { serverId: 'home', serverHttpBaseUrl: 'https://home.example', machineId: 'machine', accountId: 'account',
      readCredentials: async () => ({ token, encryption: null }), workspaceSyncAdapter: createWorkspaceSyncHandoffAdapter({ sync, bootstrap: noEffect }) };
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
      machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: 'machine', installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => current };
    const fields = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const targetPath = join(root, 'not-created');
    try {
      expect(await register(RPC_METHODS.PROJECTS_OPEN, runtime)({ serverId: 'home', machineId: 'machine',
        source: { kind: 'source', id: source.id, revision: 1, selector: source.repository,
          checkout: { serverId: 'home', workspaceId: workspace.id, machineId: 'machine', rootPath: root } },
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
    const runtime: ProjectOpenRuntime = { serverId: 'home', serverHttpBaseUrl: 'https://home.example', machineId: 'machine', accountId: 'account',
      readCredentials: async () => ({ token, encryption: null }) };
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
      machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: 'machine', installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => true };
    const fields = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const result = await register(RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN, runtime)({
      serverId: 'home', machineId: 'target', source: { kind: 'source', id: 'source', revision: 1,
        selector: { provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://forge.example' },
          repository: { nameWithOwner: 'group/repo' }, protocol: 'https' },
        checkout: { serverId: 'home', workspaceId: 'checkout', machineId: 'machine', rootPath: '/source' } },
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
    const runtime: ProjectOpenRuntime = { serverId: 'home', serverHttpBaseUrl: 'https://home.example', machineId: 'machine', accountId: 'account',
      readCredentials: async () => ({ token, encryption: null }) };
    const context: RpcHandlerContext = { signal: controller.signal, callerAuthority: 'present_user',
      machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: 'machine', installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => { if (snapshotRead) controller.abort(); return !controller.signal.aborted; } };
    expect(await register(RPC_METHODS.PROJECTS_OPEN, runtime)({ serverId: 'home', machineId: 'machine',
      source: { kind: 'folder', path: '/not-created' }, materialization: { kind: 'worktree',
        checkout: { kind: 'git_worktree', displayName: 'feature', baseRef: null } } }, context))
      .toEqual({ kind: 'refused', code: 'cancelled' });
    expect(post.mock.calls.every(([url]) => url.endsWith('/list'))).toBe(true);
  });
});
