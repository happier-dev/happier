import axios from 'axios';
import { PluginError } from '@happier-dev/plugin-sdk';
import tweetnacl from 'tweetnacl';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { ProjectAccountRowMutationRequestV1Schema, type ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { projectAccountRowReadResponse } from '@/testkit/http/projectAccountRows';
import { createProjectAccountSnapshotMutation, readProjectAccountRows, withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { createProjectAccountRowsHttpBoundary } from '@/workspaces/projectAccountRows.testkit';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { computeWorkspaceSyncPolicyDigest, WorkspaceSyncTargetBootstrapPrepareV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { projectWorkspaceSyncAdmissionInputV1 } from '@happier-dev/protocol/workspaces/workspaceSyncAdmissionV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import type { ProjectOpenRuntime } from '@/workspaces/activation/openProject';
import { readSettings, readStoredCredentials, readStoredCredentialsForServerId, updateSettings } from '@/persistence';
import { registerProjectOpenRpcHandlers } from './registerProjectOpenRpcHandlers';
import { dispatchProjectsDispatch2 } from '../../../../../../packages/protocol/src/actions/executor/projects/dispatch';
import { confirmOwnUiRefusal } from '../../../../../../apps/ui/sources/sync/ops/actions/executeMachineActionAtDaemon';
import { computeActionReviewDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { prepareApprovalRequest } from '../../../../../../packages/protocol/src/actions/executor/approvalPreparation';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { OpenProjectResultV1Schema, ProjectOpenSyncMaterializationResultV1Schema, type OpenProjectInputV1 } from '@happier-dev/protocol/projects/openProjectV1';
import { ApprovalRequestV2Schema, StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { ApprovalRequestPublicReadSchema } from '@happier-dev/protocol/approvals/approvalRequestPublicRead';
import { projectSettledApprovalExecution } from '@happier-dev/protocol/actions/executor/approvalResults';
import { executeActionOperationActionV1 } from '@happier-dev/protocol/actions/executor/actionOperationActions';
import { projectApprovalRequestForPublicRead } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { AccountProfileResponseSchema } from '@happier-dev/protocol/account/profile';
import { AccountEncryptionCurrentnessResponseSchema, AccountEncryptionModeResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { AuthTokenProvenanceSchema } from '@happier-dev/protocol/auth/authToken';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { WorkspaceSyncController } from '@/workspaces/sync/workspaceSyncController';
import { createWorkspaceSyncHandoffAdapter, materializeWorkspaceSyncForOpen } from '@/workspaces/sync/workspaceSyncHandoffAdapter';
import { createWorkspaceRootOwnershipManager } from '@/workspaces/sync/workspaceSyncRootOwnership';
import { createWorkspaceSyncMutagenAdapter } from '@/workspaces/sync/workspaceSyncMutagenAdapter';
import { createWorkspaceSyncRelationshipOwner } from '@/workspaces/sync/workspaceSyncRelationshipOwner';
import { workspaceSyncTargetBootstrap } from '@/workspaces/sync/workspaceSyncTargetBootstrap';
import type { MutagenSessionSummaryV1 } from '@/workspaces/sync/transport/workspaceSyncBrokerProtocol';
import { BrokerProtocolError } from '@/workspaces/sync/transport/workspaceSyncBrokerProtocol';
import { resolveWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { FeaturesResponseSchema, ScmHostingProviderContributionSchema } from '@happier-dev/protocol';
import { PluginConnectedAccountDescriptorContributionV2Schema } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { createProjectSetupTrustRowCipher } from '@/workspaces/projectSetup/projectSetupTrust';
import { configuration, reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { openProject, materializeProjectSyncOnSource } from '@/workspaces/activation/openProject';
import { execFile, spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import { openSessionHolderWorkspaceChannel } from '@/subprocess/supervision/sessionHolder';
import { createHolderWorkspaceSource } from '@/workspaces/source/holderWorkspaceSource';
import { runWithScmAccountScope } from '@/scm/accountScope';
import { scanWorkspaceManifest } from '@/scm/workspace/workspaceExportPackaging/scanWorkspaceManifest';
import { applyManagedWorkspaceReturn, prepareManagedWorkspaceReturnFromStage } from '@/workspaces/sync/managedWorkspaceReturn';
import { runManagedWorkspaceReturnTarget } from '@/workspaces/sync/managedWorkspaceReturnTarget';
import { resolveSessionHolderExecutablePath } from '@happier-dev/iroh-native/node';
import { resolveProcessCustodySupportExecutable } from '@/subprocess/supervision/processCustody';
import { promisify } from 'node:util';
import { createPluginRegistrationScope } from '@/plugins/runtime/api/registrationScope';
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
import { createStartedProductionDaemonWorkspaceSyncRuntime as createProductionDaemonWorkspaceSyncRuntime } from '@/daemon/startup/createProductionDaemonWorkspaceSyncRuntime.testkit';
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
      if ((command === 'git' || command.endsWith('/git')) && workspaceCheckoutNativeBoundary.privateRoot
        && String(options.cwd).startsWith(workspaceCheckoutNativeBoundary.privateRoot)) {
        expect(workspaceCheckoutNativeBoundary.identity.getStore()).toBe('member');
        workspaceCheckoutNativeBoundary.runAsUsers.push('git-member');
        const mount = workspaceCheckoutNativeBoundary.mounts.find(entry => String(options.cwd).startsWith(`${entry.path}/`));
        if (!mount) throw new Error('Missing native Git filesystem boundary');
        return actual.spawn(command, args, { ...options, cwd: `${mount.backing}${String(options.cwd).slice(mount.path.length)}` });
      }
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
      return spawnWorkspaceCheckoutNativeBoundary(actual.spawn, options);
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

  const projectOpenHolder = resolveSessionHolderExecutablePath();
  const projectOpenHelper = resolveProcessCustodySupportExecutable('linux');
  const savedProfileCases = [
    { mode: 'plain', managed: false }, { mode: 'e2ee', managed: false }, { mode: 'plain', managed: true },
  ] as const;
  it.for(savedProfileCases)('opens an admitted Account folder across a saved Home profile (mode=$mode, managed=$managed)', async ({ mode, managed }, { skip }) => {
    if (managed && (process.platform !== 'linux' || !projectOpenHolder || !projectOpenHelper)) skip();
    const root = await mkdtemp(join(tmpdir(), 'happier-open-account-binding-'));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const profileId = 'ordinary-owner-local-profile';
    const homeId = 'srv_ordinary_owner_home';
    await seedTestServerProfile({ id: profileId, homeId, serverUrl: 'https://ordinary-owner.example' });
    const material = mode === 'plain' ? null : { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
    const cipher = createProjectAccountRowCipherV1({ mode, material, randomBytes: n => new Uint8Array(n).fill(3) });
    let current = true;
    const admitted: ExternalActionExecutionAuthorizationV1 = { v: 1, token: 'admitted-account-root', binding: {
      accountId: 'account', custodianAccountId: 'account', serverIdentityId: homeId,
      machineId: 'machine', installationId: 'installation', actionId: 'projects.open', accountEncryptionMode: mode,
      authentication: { kind: 'account', tokenEpoch: 0 }, requestId: 'ordinary-folder-open',
      requestEnvelopeDigest: 'A'.repeat(43), target: { kind: 'machine', machineId: 'machine' },
    }, requesterAccountProjection: {
      accountId: 'account', serverId: homeId, accountEncryptionMode: mode, projectAccountRowCipher: cipher,
      projectTrustRowCipher: createProjectSetupTrustRowCipher({ mode, material }),
      resolveMachineContentEncryptionContext: () => ({ encryptionMode: 'plain' }),
      isCurrent: async () => current, readArtifact: async () => null,
    } };
    Object.defineProperty(admitted, 'requesterAccountProjection', {
      value: admitted.requesterAccountProjection, enumerable: false,
    });
    // Account content and installation are admitted host facets; the real HTTP
    // projection owns signing/currentness. Only authenticated Home I/O is supplied.
    const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: admitted,
      serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl: 'https://ordinary-owner.example',
      target: admitted.binding.target, installationId: 'installation', privateKey: tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(4)).secretKey,
      rootAdmitted: true, isCurrent: async () => current });
    if (!authorization) throw new Error('Canonical Account HTTP projection was not constructed');
    const rows: ProjectAccountRowV1[] = [];
    vi.spyOn(axios, 'get').mockImplementation(plainMachineRead);
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
      expect(config?.headers).toHaveProperty(EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, admitted.token);
      if (url.endsWith('/project-trust/read')) return { status: 200, data: { status: 'absent' } };
      if (url.endsWith('/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
      if (url.endsWith('/read')) return projectAccountRowReadResponse(rows, body);
      const mutation = ProjectAccountRowMutationRequestV1Schema.parse(body);
      const changed = mutation.mutations.map(item => ({ key: item.key, revision: 0, content: item.content }));
      rows.push(...changed);
      return { status: 200, data: { status: 'updated', cursor: 1, rows: changed } };
    });
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
      callerInputAuthorization: authorization, machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account',
        machineId: 'machine', installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => true };
    const destination = { managedId: 'attached-guest', controller: { machineId: 'machine', installationId: 'installation' } };
    const lifetime = new AbortController();
    onTestFinished(() => lifetime.abort());
    const handler = register(RPC_METHODS.PROJECTS_OPEN, { serverId: profileId, serverHttpBaseUrl: 'https://ordinary-owner.example',
      machineId: 'machine', accountId: 'account', readCredentials: async () => { throw new Error('Admitted Open must not borrow login credentials'); },
      ...(managed ? { openManagedProjectWorkspace: async request => {
        expect(request.workspace).toEqual({ ...destination, serverId: homeId, rootPath: root });
        expect(request.requesterAccountId).toBe('account');
        return { lifetime: lifetime.signal, holderPath: projectOpenHolder!, helperPath: projectOpenHelper!,
          openChannel: ([executable, ...args]) => {
            const child = spawn(executable!, args, { stdio: ['pipe', 'pipe', 'ignore'] });
            return Duplex.from({ readable: child.stdout, writable: child.stdin });
          } };
      } } : {}), });
    const input = { serverId: homeId, machineId: 'machine', source: { kind: 'folder', path: root },
      materialization: { kind: 'attach', ...(managed ? { targetManaged: destination } : {}) } };
    const opened = OpenProjectResultV1Schema.parse(await handler(input, context));
    expect(opened, JSON.stringify(opened)).toMatchObject({ kind: 'opened', directory: root, setup: 'notRequired',
      ...(managed ? { workspace: { kind: 'managed', ...destination, serverId: homeId, rootPath: root } } : {}) });
    const accepted = rows.find(row => row.key.kind === 'workspace-ref');
    expect(accepted).toBeDefined();
    if (managed && accepted?.content) {
      const payload = cipher.open(accepted.key, accepted.content);
      expect(payload.value).toMatchObject({ v: 2, kind: 'managed', ...destination, serverId: homeId, rootPath: root });
      expect(payload.value).not.toHaveProperty('machineId');
      if (opened.kind !== 'opened' || opened.workspace.kind !== 'managed') throw new Error('Expected an exact managed checkout');
      const checkout = opened.workspace;
      const retained = { ...input, source: { kind: 'workspace', workspaceId: checkout.workspaceId, checkout },
        materialization: { kind: 'attach' } };
      const wrongInstallation = { ...checkout, controller: { ...checkout.controller, installationId: 'other-installation' } };
      expect(await handler({ ...retained, source: { ...retained.source, checkout: wrongInstallation } }, context))
        .toMatchObject({ kind: 'refused', effectAttempted: false });
      const reopened = await handler(retained, context);
      expect(reopened, JSON.stringify(reopened)).toMatchObject({ kind: 'opened', workspace: checkout, directory: root });
      expect(rows.filter(row => row.key.kind === 'workspace-ref')).toHaveLength(1);
    }
    current = false;
    post.mockClear();
    const diagnostic = vi.spyOn(logger, 'warnLocalFile');
    expect(await handler(input, context)).toMatchObject({ kind: 'refused', code: 'requester_authority_unavailable', effectAttempted: false });
    expect(diagnostic).toHaveBeenCalledWith('[Project Open] Refused', {
      code: 'requester_authority_unavailable', reason: 'requester_projection_not_current', phase: 'requester_projection',
    });
    expect(post).not.toHaveBeenCalled();
  });

  it.each(['plain', 'e2ee'] as const)('lists an opened Project in the requester Account rows for any projects.open caller, keeping its other organization fields (%s)', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'happier-open-lists-project-'));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const homeId = 'srv_listing_home';
    await seedTestServerProfile({ id: homeId, homeId, serverUrl: 'https://listing.example' });
    const material = mode === 'plain' ? null : { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
    const cipher = createProjectAccountRowCipherV1({ mode, material, randomBytes: n => new Uint8Array(n).fill(3) });
    const admitted: ExternalActionExecutionAuthorizationV1 = { v: 1, token: 'agent-open-root', binding: {
      accountId: 'account', custodianAccountId: 'account', serverIdentityId: homeId,
      machineId: 'machine', installationId: 'installation', actionId: 'projects.open', accountEncryptionMode: mode,
      authentication: { kind: 'account', tokenEpoch: 0 }, requestId: 'agent-folder-open',
      requestEnvelopeDigest: 'A'.repeat(43), target: { kind: 'machine', machineId: 'machine' },
    }, requesterAccountProjection: {
      accountId: 'account', serverId: homeId, accountEncryptionMode: mode, projectAccountRowCipher: cipher,
      projectTrustRowCipher: createProjectSetupTrustRowCipher({ mode, material }),
      resolveMachineContentEncryptionContext: () => ({ encryptionMode: 'plain' }),
      isCurrent: async () => true, readArtifact: async () => null,
    } };
    Object.defineProperty(admitted, 'requesterAccountProjection', { value: admitted.requesterAccountProjection, enumerable: false });
    const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: admitted,
      serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl: 'https://listing.example',
      target: admitted.binding.target, installationId: 'installation', privateKey: tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(4)).secretKey,
      rootAdmitted: true, isCurrent: async () => true });
    if (!authorization) throw new Error('Canonical Account HTTP projection was not constructed');
    // The Home row store is the HTTP boundary; the real Open and row owners run above it.
    const rows: ProjectAccountRowV1[] = [];
    vi.spyOn(axios, 'get').mockImplementation(plainMachineRead);
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (url.endsWith('/project-trust/read')) return { status: 200, data: { status: 'absent' } };
      if (url.endsWith('/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
      if (url.endsWith('/read')) return projectAccountRowReadResponse(rows, body);
      const changed = ProjectAccountRowMutationRequestV1Schema.parse(body).mutations
        .map(item => ({ key: item.key, revision: item.expectedRevision === 'absent' ? 0 : item.expectedRevision + 1, content: item.content }));
      for (const row of changed) {
        const index = rows.findIndex(existing => JSON.stringify(existing.key) === JSON.stringify(row.key));
        if (index < 0) rows.push(row); else rows[index] = row;
      }
      return { status: 200, data: { status: 'updated', cursor: 1, rows: changed } };
    });
    const organization = (projectKey: string) => {
      const row = rows.find(candidate => candidate.key.kind === 'project-organization' && candidate.key.projectKey === projectKey);
      return row?.content ? cipher.open(row.key, row.content).value : undefined;
    };
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
      callerInputAuthorization: authorization, machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account',
        machineId: 'machine', installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => true };
    const handler = register(RPC_METHODS.PROJECTS_OPEN, { serverId: homeId, serverHttpBaseUrl: 'https://listing.example',
      machineId: 'machine', accountId: 'account', readCredentials: async () => null });
    const input = { serverId: homeId, machineId: 'machine', source: { kind: 'folder', path: root }, materialization: { kind: 'attach' } };
    const opened = OpenProjectResultV1Schema.parse(await handler(input, context));
    if (opened.kind !== 'opened' || !opened.facts?.projectKey) throw new Error(JSON.stringify(opened));
    const projectKey = opened.facts.projectKey;
    expect(organization(projectKey)).toEqual({ hidden: false });
    // Opening a Project the person hid adds it back without losing its other organization.
    const key = { kind: 'project-organization' as const, serverId: homeId, projectKey };
    rows[rows.findIndex(row => row.key.kind === 'project-organization')] = { key, revision: 1,
      content: cipher.seal({ key, value: { hidden: true, pinned: true } }) };
    expect(await handler(input, context)).toMatchObject({ kind: 'opened' });
    expect(organization(projectKey)).toEqual({ hidden: false, pinned: true });
  });

  it.each(['attach', 'worktree'] as const)('accepts a native Git worktree under its main Project before daemon registration (%s)', async kind => {
    const root = await mkdtemp(join(tmpdir(), 'happier-open-git-family-'));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const main = join(root, 'z-main');
    const linked = join(root, 'a-linked');
    const git = promisify(execFile);
    await git('git', ['init', '-b', 'main', main]);
    await git('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial'], { cwd: main });
    if (kind === 'attach') await git('git', ['worktree', 'add', '-b', 'feature', linked], { cwd: main });
    const rows: ProjectAccountRowV1[] = [];
    const mainRef = { id: 'accepted-main', projectKey: 'hidden-main-project', serverId: 'srv_test_home', machineId: 'machine', rootPath: main, createdAtMs: 1 };
    if (kind === 'worktree') {
      const key = { kind: 'workspace-ref' as const, serverId: mainRef.serverId, id: mainRef.id };
      rows.push({ key, revision: 0, content: { t: 'plain', v: { key, value: mainRef } } });
    }
    vi.spyOn(axios, 'get').mockImplementation(plainMachineRead);
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (url.endsWith('/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
      if (url.endsWith('/read')) return projectAccountRowReadResponse(rows, body);
      const request = ProjectAccountRowMutationRequestV1Schema.parse(body);
      const changed = request.mutations.map(mutation => ({ key: mutation.key, revision: 0, content: mutation.content }));
      for (const row of changed) {
        const index = rows.findIndex(existing => JSON.stringify(existing.key) === JSON.stringify(row.key));
        if (index < 0) rows.push(row); else rows[index] = row;
      }
      return { status: 200, data: { status: 'updated', rows: changed, cursor: 1 } };
    });
    const registration = createGitScmBackendRuntimeRegistration();
    if (!registration.runtime) throw new Error('Git runtime unavailable');
    const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({ definition: { id: 'git', kind: 'git' },
      qualifiedId: 'happier.scm.git/git', executableDefinition: registration.runtime, registration })]);
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    const handler = register(RPC_METHODS.PROJECTS_OPEN, { serverId: 'srv_test_home', machineId: 'machine', registry,
      serverHttpBaseUrl: 'https://home.example', accountId: 'account', readCredentials: async () => ({ token, encryption: null }) });
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
      machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: 'machine',
        installationId: 'installation', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
    const opened = await handler({ serverId: 'srv_test_home', machineId: 'machine',
      source: kind === 'attach' ? { kind: 'folder', path: linked } : { kind: 'workspace', workspaceId: mainRef.id },
      materialization: kind === 'attach' ? { kind: 'attach' } : { kind: 'worktree', targetPath: linked,
        checkout: { kind: 'git_worktree', displayName: 'feature', baseRef: 'main', branchMode: 'new' } } }, context);
    expect(opened).toMatchObject({ kind: 'opened', directory: linked });
    const refs = rows.flatMap(row => row.content?.t === 'plain' && row.content.v.key.kind === 'workspace-ref'
      && 'id' in row.content.v.value ? [row.content.v.value] : []);
    const acceptedMain = refs.find(ref => ref.rootPath === main);
    const acceptedLinked = refs.find(ref => ref.rootPath === linked);
    expect(acceptedMain).toBeDefined();
    expect(acceptedLinked?.projectKey).toBe(acceptedMain?.projectKey);
    if (kind === 'worktree') expect(acceptedLinked?.projectKey).toBe(mainRef.projectKey);
  });

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
        expect(OpenProjectResultV1Schema.parse(result)).toMatchObject({ kind: 'refused', code: 'ref_unavailable', effectAttempted: false });
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

  it.each(['opened', 'refused', 'outcomeUnknown', 'receipt metadata without requester custody', 'owned relay'] as const)('retains the original Open settlement in Action Operations (%s)', async scenario => {
    const receiptOnly = scenario === 'receipt metadata without requester custody';
    const relayed = scenario === 'owned relay';
    const settlement = receiptOnly ? 'refused' : relayed ? 'opened' : scenario;
    const root = await mkdtemp(join(tmpdir(), 'happier-open-operation-'));
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
      transportRequestId: relayed ? 'rpc-fresh-cancellation' : 'original-open-request',
      ...(relayed ? { projectOpenRequestId: 'original-open-request' } : {}),
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
          .toMatchObject({ kind: 'found', operation: { ...(relayed ? {} : { requestId: 'original-open-request' }), state: 'running',
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
        path: scenario === 'refused' ? join(root, 'missing') : root }, materialization: { kind: 'attach' as const } };
      if (relayed) {
        const result = await handler(input, context);
        expect(result, JSON.stringify(result)).toMatchObject({ kind: 'opened' });
        expect((await operations.handlers.listV2({}, context)).items)
          .toMatchObject([{ requestId: 'original-open-request', state: 'succeeded' }]);
        expect(await operations.handlers.getV2({ operationId: 'original-open-operation' }, context))
          .toMatchObject({ kind: 'found', operation: { result } });
        return;
      }
      const pending = receiptOnly ? operations.observeExecution({ actionId: 'projects.open', input,
        actionRequestId: context.transportRequestId, rpcContext: context,
        execute: async owned => {
          expect(owned.operationAcceptance).toMatchObject({ actionId: 'projects.open' });
          return { ok: true, result: await handler(input, { ...context,
          // A real receipt is not requester custody. The receiving handler
          // must refuse this missing projection, never join its own invocation.
          localActionContext: { operationAcceptance: owned.operationAcceptance },
          }) };
        },
      }) : operations.runActionOperation({ actionId: 'projects.open', input,
        context: { actionRequestId: context.transportRequestId, signal: context.signal },
        // Machine relay calls carry authenticated ingress, not the invoking
        // adapter's private local Action context. Installed signed calls are
        // exercised by the composed external Action approval keepers.
        execute: async () => ({ ok: true, result: await handler(input, context) }),
      });
      const observed = await pending;
      expect(observed.ok).toBe(true);
      if (!observed.ok) throw new Error(observed.errorCode);
      const result = observed.result;
      expect(result).toMatchObject({ kind: settlement, ...(settlement === 'outcomeUnknown' ? { operationId: 'original-open-operation' } : {}) });
      if (receiptOnly) {
        expect(result).toMatchObject({ kind: 'refused', code: 'requester_authority_unavailable', effectAttempted: false });
        expect(mutations).toBe(0);
      }
      const found = await operations.handlers.getV2({ operationId: 'original-open-operation' }, context);
      expect(found).toMatchObject({ kind: 'found', operation: { actionId: 'projects.open', scope: { accountId: 'account', machineId: 'machine' },
        result } });
      expect(found).toMatchObject({ operation: settlement === 'outcomeUnknown'
        ? { state: 'running', observation: { kind: 'outcome_uncertain' } }
        : { state: settlement === 'refused' ? 'failed' : 'succeeded' } });
      expect((await operations.handlers.listV2({}, context)).items).toHaveLength(1);
      const beforeCheck = mutations;
      await operations.handlers.getV2({ operationId: 'original-open-operation' }, context);
      expect(mutations).toBe(beforeCheck);
      expect(await operations.handlers.getV2({ operationId: 'original-open-operation' }, { ...context,
        machineAdmission: { ...context.machineAdmission!, actorAccountId: 'other-account' } })).toEqual({ kind: 'not_found' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('finishes an accepted Open after revocation and refuses the next Open before effects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-open-admission-'));
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    let admitted = true;
    let admissionReads = 0;
    const writes: string[][] = [];
    const rows: ProjectAccountRowV1[] = [];
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
      machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: 'machine',
        installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => { admissionReads += 1; return admitted; } };
    vi.spyOn(axios, 'get').mockImplementation(plainMachineRead);
    const post = vi.spyOn(axios, 'post').mockImplementation(createProjectAccountRowsHttpBoundary(rows, {
      beforeMutation: request => {
        const kinds = request.mutations.map(mutation => mutation.key.kind);
        writes.push(kinds);
        // Revocation at checkout acceptance cannot make the admitted Open unknown.
        if (kinds.includes('workspace-ref')) admitted = false;
      },
    }));
    const handler = register(RPC_METHODS.PROJECTS_OPEN, { serverId: 'srv_test_home', machineId: 'machine',
      serverHttpBaseUrl: 'https://home.example', accountId: 'account', readCredentials: async () => ({ token, encryption: null }) });
    const input = { serverId: 'srv_test_home', machineId: 'machine', source: { kind: 'folder', path: root },
      materialization: { kind: 'attach' } };
    try {
      expect(await handler(input, context)).toMatchObject({ kind: 'opened', directory: root });
      expect(admissionReads).toBe(1); // One admission for this finite Open, before effects.
      expect(writes).toEqual([['workspace-ref', 'relationship-graph'], ['project-organization']]);
      post.mockClear();
      expect(await handler(input, context)).toEqual({ kind: 'refused', code: 'machine_access_denied', effectAttempted: false });
      expect(admissionReads).toBe(2);
      expect(post).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('clones with the account selected for this owner Project Open and refuses the same account after removal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-project-open-account-'));
    const git = promisify(execFile);
    const scope = createEnvKeyScope(['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']);
    const seed = join(root, 'seed');
    const remote = join(root, 'remote.git');
    const service = { pluginId: GITHUB_PLUGIN_MANIFEST.id, localId: 'github-account' };
    const account = { service, accountId: 'selected-for-open' };
    const provider = { id: `${GITHUB_PLUGIN_MANIFEST.id}/github`, kind: 'github' as const, displayName: 'GitHub', baseUrl: 'https://github.com' };
    const cloneUrl = 'https://github.com/octocat/selected.git';
    let connected = true;
    const materializedAccounts: string[] = [];
    const bindings = { v: 1 as const, bindings: [] };
    const bindingOwner = createConnectedAccountPurposeBindingOwner({
      store: { read: async () => bindings, update: async () => { throw new Error('Open must not change defaults'); }, subscribe: () => ({ dispose() {} }) },
      selectTarget: async () => { throw new Error('Open must use the explicit selection'); },
      resolveTarget: async target => connected && target.kind === 'account' && target.account.accountId === account.accountId
        ? { displayName: account.accountId, account } : null,
      projectTargetAccounts: async () => ({ status: 'complete', accounts: connected ? [{ account, displayName: account.accountId,
        state: 'connected', connectedAccountOrigins: ['https://github.com'], connectedAccountBases: ['https://github.com'] }] : [] }),
      materializeAccount: async ({ account: selected }) => {
        materializedAccounts.push(selected.accountId);
        return { kind: 'httpHeaders', headers: { Authorization: 'Bearer test-open-selection' } };
      },
      assertTargetAccountMaterializable: async () => undefined,
    });
    const fetch = globalThis.fetch;
    const githubHeaders: Array<string | null> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const request = new Request(url, init);
      if (new URL(request.url).origin !== 'https://api.github.com') return fetch(url, init);
      githubHeaders.push(request.headers.get('authorization'));
      return Response.json({ full_name: 'octocat/selected', html_url: 'https://github.com/octocat/selected',
        clone_url: cloneUrl, visibility: 'private', default_branch: 'main' });
    });
    onTestFinished(async () => { scope.restore(); await rm(root, { recursive: true, force: true }); });
    await mkdir(seed);
    await git('git', ['init', '-b', 'main'], { cwd: seed });
    await writeFile(join(seed, 'README.md'), 'private checkout\n');
    await git('git', ['add', 'README.md'], { cwd: seed });
    await git('git', ['-c', 'user.name=Open test', '-c', 'user.email=open@example.invalid', 'commit', '-m', 'initial'], { cwd: seed });
    await git('git', ['clone', '--bare', seed, remote]);
    scope.patch({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${remote}.insteadOf`, GIT_CONFIG_VALUE_0: cloneUrl });
    const pluginRuntime = await createAdmittedPluginRuntimeFixture({ happyHomeDir: root, controller: pluginReloadController,
      runtimeOptions: { pluginIds: [GIT_PLUGIN.manifest.id, GITHUB_PLUGIN_MANIFEST.id], connectedAccounts: bindingOwner } });
    onTestFinished(pluginRuntime.dispose);

    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    const runtime: ProjectOpenRuntime = { serverId: 'srv_test_home', serverHttpBaseUrl: 'https://home.example', machineId: 'machine',
      accountId: 'account', readCredentials: async () => ({ token, encryption: null }) };
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user', transportRequestId: 'private-owner-open',
      machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: 'machine',
        installationId: 'installation', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
    vi.spyOn(axios, 'get').mockImplementation(plainMachineRead);
    const rows: ProjectAccountRowV1[] = [];
    vi.spyOn(axios, 'post').mockImplementation(createProjectAccountRowsHttpBoundary(rows));
    const open = register(RPC_METHODS.PROJECTS_OPEN, runtime);
    const request = { serverId: runtime.serverId, machineId: runtime.machineId,
      source: { kind: 'repository', selector: { provider, repository: { nameWithOwner: 'octocat/selected' }, protocol: 'https' } },
      materialization: { kind: 'clone', destinationParentPath: root, destinationDirectoryName: 'selected',
        authentication: 'connected_account', gitAccount: account } };
    const opened = await open(request, context);
    expect(opened, JSON.stringify(opened)).toMatchObject({ kind: 'opened' });
    expect(await readFile(join(root, 'selected', 'README.md'), 'utf8')).toBe('private checkout\n');
    expect(githubHeaders).toContain('Bearer test-open-selection');
    expect([...new Set(materializedAccounts)]).toEqual([account.accountId]);

    connected = false;
    expect(await open({ ...request, materialization: { ...request.materialization, destinationDirectoryName: 'removed' } },
      { ...context, transportRequestId: 'private-owner-removed' })).toMatchObject({ kind: 'refused', code: 'REMOTE_AUTH_REQUIRED', effectAttempted: false });
    await expect(access(join(root, 'removed'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('settles a public Source clone for host browsing despite an unenrolled Devcontainer, preserving refusals and uncertainty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-qf4-open-'));
    const git = promisify(execFile);
    const remote = join(root, 'remote.git');
    const seed = join(root, 'seed');
    const scope = createEnvKeyScope(['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']);
    const provider = { id: 'happier.scm.forge.github/github', kind: 'github' as const, displayName: 'GitHub', baseUrl: 'https://github.com' };
    const source = { id: 'cmv06f8oh0002tm6db61h8svg', revision: 2, name: 'Q1 Round 4 Source',
      createdByAccountId: 'account', audience: [], defaultRef: 'master', subdir: '.',
      repository: { provider, repository: { nameWithOwner: 'octocat/Hello-World',
        webUrl: 'https://github.com/octocat/Hello-World', cloneUrl: 'https://github.com/octocat/Hello-World' }, protocol: 'https' } } satisfies ProjectSourceV1;
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
      const repository = { full_name: 'octocat/Hello-World',
        html_url: 'https://github.com/octocat/Hello-World', clone_url: 'https://github.com/octocat/Hello-World.git',
        visibility: 'public', default_branch: 'master' };
      return { ok: true, status: 200, statusText: 'OK', json: async () => repository,
        text: async () => JSON.stringify(repository) };
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
      // A fresh host has the native credential adapter, with no GitHub login.
      materializeNative: async () => { throw new PluginError({ code: 'plugin_connected_account_native_unavailable',
        message: 'Native GitHub login is unavailable' }); },
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
    const publicSettlement = (actionArgs: OpenProjectInputV1, result: unknown) => {
      const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'executing', createdAtMs: 1, updatedAtMs: 2,
        createdBy: { surface: 'cli' }, requestedSurface: 'ui', actionId: 'projects.open', actionArgs,
        summary: 'Open repository', decision: { kind: 'approve', decidedAtMs: 2 },
        executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' },
          serverId: runtime.serverId, accountId: runtime.accountId, machineId: runtime.machineId,
          actionId: 'projects.open', requestId: 'open-repository' } });
      const settled = projectSettledApprovalExecution({ request, actionId: 'projects.open',
        exec: { ok: true, result }, dispatchEffectAttempted: true, executedAtMs: 3 });
      const stored = StoredApprovalRequestSchema.parse(settled.request);
      return ApprovalRequestPublicReadSchema.parse(projectApprovalRequestForPublicRead(stored));
    };
    const observeOpen = async (actionArgs: OpenProjectInputV1, requestId: string) => {
      const operations = createHostActionOperationRuntime({ serverId: runtime.serverId, machineId: runtime.machineId,
        resolveAccountId: async () => runtime.accountId, generateOperationId: () => requestId });
      const execution = await operations.observeExecution({ actionId: 'projects.open', input: actionArgs,
        actionRequestId: requestId, execute: async () => ({ ok: true, result: await handler(actionArgs, context) }) });
      if (!execution.ok) throw new Error('Initial Open execution must return its typed domain result');
      const operation = await executeActionOperationActionV1({ actionId: 'action.operations.get',
        input: { serverId: runtime.serverId, machineId: runtime.machineId, operationId: requestId },
        transport: async ({ payload }) => operations.handlers.getV2(payload) });
      return { result: execution.result, operation };
    };
    const clock = vi.spyOn(Date, 'now');
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
      const fileAsParent = { ...input, materialization: { ...input.materialization, destinationParentPath: join(seed, 'README.md') } };
      expect(await handler(fileAsParent, context)).toMatchObject({ kind: 'refused', code: 'invalid_directory', effectAttempted: false,
        failureCause: { phase: 'projects.open', errorClass: 'Error' } });
      expect(diagnostic.mock.calls.length).toBeGreaterThan(0);
      const noBackend = register(RPC_METHODS.PROJECTS_OPEN, { ...runtime, registry: createScmBackendRegistry([]) });
      expect(await noBackend(input, context)).toMatchObject({ kind: 'refused', code: 'FEATURE_UNSUPPORTED', effectAttempted: false,
        failureCause: { phase: 'projects.open', errorClass: 'Error' } });
      for (const limit of ['timed', 'unhinted'] as const) {
        rateLimited = limit;
        const { result: refusal, operation } = await observeOpen(input, `rate-limit-${limit}`);
        expect.soft(operation).toMatchObject({ kind: 'found', operation: { state: 'failed', error: {
          errorCode: 'REMOTE_RATE_LIMITED',
          failureCause: { phase: 'projects.open', errorClass: 'Error', errorCode: 'REMOTE_RATE_LIMITED', httpStatus: null },
          details: { kind: 'refused', code: 'REMOTE_RATE_LIMITED', effectAttempted: false,
            retryNotBeforeMs: limit === 'timed' ? retryAt : expect.any(Number),
            remediation: { kind: 'retry', action: 'connect_github' } },
        } } });
        expect.soft(publicSettlement(input, refusal)).toMatchObject({ status: 'failed', execution: {
          ok: false, errorCode: 'REMOTE_RATE_LIMITED', effectAttempted: false,
          failureCause: { phase: 'projects.open', errorClass: 'Error', errorCode: 'REMOTE_RATE_LIMITED', httpStatus: null },
          details: { kind: 'refused', code: 'REMOTE_RATE_LIMITED', effectAttempted: false,
            retryNotBeforeMs: limit === 'timed' ? retryAt : expect.any(Number),
            remediation: { kind: 'retry', action: 'connect_github' } },
        } });
        expect.soft(refusal).toEqual({ kind: 'refused', code: 'REMOTE_RATE_LIMITED',
          effectAttempted: false,
          failureCause: { phase: 'projects.open', errorClass: 'Error', errorCode: 'REMOTE_RATE_LIMITED', httpStatus: null },
          retryNotBeforeMs: limit === 'timed' ? retryAt : expect.any(Number),
          remediation: { kind: 'retry', action: 'connect_github' } });
        const parsed = OpenProjectResultV1Schema.parse(refusal);
        expect(parsed).toEqual(refusal);
        await expect(access(join(root, 'checkout'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(rows).toEqual([]);
        // Let the real GitHub owner release its throttle before the next scenario.
        if (parsed.kind === 'refused' && parsed.retryNotBeforeMs !== undefined) clock.mockReturnValue(parsed.retryNotBeforeMs);
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
      const detached = join(root, 'detached');
      expect(await handler({ ...input, source: { kind: 'repository', selector: source.repository }, ref: pin,
        materialization: { ...input.materialization, destinationDirectoryName: 'detached' } }, context))
        .toMatchObject({ kind: 'opened', directory: detached });
      expect((await git('git', ['branch', '--show-current'], { cwd: detached })).stdout.trim()).toBe('');
      expect((await git('git', ['rev-parse', 'HEAD'], { cwd: detached })).stdout.trim()).toBe(pin);
      expect((await git('git', ['rev-parse', 'master'], { cwd: detached })).stdout.trim()).toBe(upstreamHead);
      expect((await git('git', ['rev-parse', 'origin/main'], { cwd: detached })).stdout.trim()).toBe(upstreamHead);
      const acceptedRows = rows.length;
      diagnostic.mockClear();
      const missingRefInput = { ...input, ref: 'missing-ref',
        materialization: { ...input.materialization, destinationDirectoryName: 'missing-ref' } };
      const { result: missingRef, operation: missingRefOperation } = await observeOpen(missingRefInput, 'missing-ref');
      expect(missingRefOperation).toMatchObject({ kind: 'found', operation: { state: 'failed', error: {
        errorCode: 'COMMAND_FAILED', failureCause: { phase: 'project_open.checkout_ref', errorCode: 'COMMAND_FAILED' },
        details: { kind: 'refused', code: 'COMMAND_FAILED', effectAttempted: true },
      } } });
      expect(missingRef).toMatchObject({ kind: 'refused', code: 'COMMAND_FAILED', effectAttempted: true,
          failureCause: { phase: 'project_open.checkout_ref', errorCode: 'COMMAND_FAILED' } });
      expect(publicSettlement(missingRefInput, missingRef)).toMatchObject({ status: 'failed', execution: {
        ok: false, errorCode: 'COMMAND_FAILED', effectAttempted: true,
        failureCause: { phase: 'project_open.checkout_ref', errorCode: 'COMMAND_FAILED' },
        details: { kind: 'refused', code: 'COMMAND_FAILED', effectAttempted: true,
          failureCause: { phase: 'project_open.checkout_ref', errorCode: 'COMMAND_FAILED' } },
      } });
      await access(join(root, 'missing-ref', '.git'));
      expect(rows).toHaveLength(acceptedRows);
      loseAcknowledgement = true;
      expect(await handler({ ...input, materialization: { ...input.materialization, destinationDirectoryName: 'lost-ack' } }, context))
        .toEqual({ kind: 'outcomeUnknown' });
      await access(join(root, 'lost-ack', '.git'));
    } finally { clock.mockRestore(); scope.restore(); await rm(root, { recursive: true, force: true }); }
  });

  it('establishes a credential-seeded profile identity before Project Open while refusing wrong targets', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-open-home-identity-'));
    const root = join(home, 'checkout');
    const scope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID']);
    const profileId = 'stack_agent-qa-l12-a__id_default';
    const serverId = 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN';
    const machineId = '931c4d58-b484-4284-b5b8-f3ef2500d7ec';
    const serverUrl = 'http://happier-agent-qa-l12-a.localhost:3010';
    const provenance = AuthTokenProvenanceSchema.parse({ v: 1, kind: 'terminal', authority: 'account_automation' });
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account', session: 'OPEN-TESTS-terminal', provenance })).toString('base64url')}.signature`;
    const source = { id: 'cmv06f8oh0002tm6db61h8svg', revision: 2,
      name: 'Q1 Round 4 Source', createdByAccountId: 'account', audience: [], defaultRef: 'master', subdir: '.',
      repository: { provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
        repository: { nameWithOwner: 'octocat/Hello-World', cloneUrl: 'https://github.com/octocat/Hello-World', webUrl: 'https://github.com/octocat/Hello-World' }, protocol: 'https' } } satisfies ProjectSourceV1;
    const rows: ProjectAccountRowV1[] = [];
    const read = vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: { ok: true, source, canManage: true } });
    // The installed Machine authenticates its Account through Home, rather
    // than trusting a JWT subject. Keep that HTTP fixture schema-valid too.
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (url.endsWith('/v1/account/profile')) return { status: 200,
        data: AccountProfileResponseSchema.parse({ id: 'account' }) };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200,
        data: AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'plain', version: 1, updatedAt: 0,
          signingKeyFingerprint: null, contentKeyFingerprint: null }) };
      return plainMachineRead(url);
    });
    socketIo.mockImplementation(() => createApiSessionSocketStub());
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
      // Exercise the credential reader the installed CLI also consumes. A
      // retired Account bearer is not a valid terminal-sign-in fixture.
      expect(await readStoredCredentials()).toMatchObject({ token, credentialProvenance: 'stored_session' });
      const runtime: ProjectOpenRuntime = { serverId: profileId, machineId, serverHttpBaseUrl: serverUrl,
        accountId: 'account', readCredentials: async () => ({ token, encryption: null }) };
      const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
        machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId,
          installationId: 'installation', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
      const target = { serverId: profileId, machineId };
      const handler = register(RPC_METHODS.PROJECTS_OPEN, runtime, target);
      const folder = { serverId, machineId, source: { kind: 'folder' as const, path: root }, materialization: { kind: 'attach' as const } };
      expect(await handler(folder, context)).toMatchObject({ kind: 'refused', code: 'target_mismatch' });
      expect(await handler({ ...folder, serverId: profileId }, context)).toMatchObject({ kind: 'refused', code: 'target_mismatch' });
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
        const opened = OpenProjectResultV1Schema.parse(await installed({ ...folder, serverId: profileId }, context));
        expect(opened, JSON.stringify(opened)).toMatchObject({ kind: 'opened',
          workspace: { serverId, machineId, rootPath: root } });
      } finally { await registration.dispose(); await client.shutdown(); }
      // Counterfactual wiring: the same exact Home without its Project runtime
      // remains unavailable. The composed opened assertion above detects this omission.
      expect(await register(RPC_METHODS.PROJECTS_OPEN, undefined, target)(folder, context))
        .toMatchObject({ kind: 'refused', code: 'project_open_unavailable' });
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
        expect(await handler(wrong, context)).toMatchObject({ kind: 'refused', code: 'target_mismatch' });
        expect(await openProject(wrong, runtime, context)).toMatchObject({ kind: 'refused', code: 'target_mismatch' });
      }
      expect(read).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
      expect(await register(RPC_METHODS.PROJECTS_OPEN, runtime, { serverId: profileId, machineId: 'other-machine' })(folder, context))
        .toMatchObject({ kind: 'refused', code: 'target_mismatch' });
      expect(await handler(folder)).toMatchObject({ kind: 'refused', code: 'machine_admission_unavailable', effectAttempted: false });
      expect(await sourceHandler(copy)).toEqual({ kind: 'refused', code: 'machine_admission_unavailable' });
      expect(await handler(folder, { ...context, callerAuthority: 'account_automation' }))
        .toMatchObject({ kind: 'refused', code: 'requester_authority_unavailable' });
      expect(await sourceHandler(copy, { ...context, callerAuthority: 'account_automation' }))
        .toEqual({ kind: 'refused', code: 'requester_authority_unavailable' });
      expect(read).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
      read.mockResolvedValue({ status: 404, data: { ok: false, error: 'source_unavailable' } });
      const { checkout: _checkout, ...cloneSource } = captured.source;
      expect(await handler({ serverId, machineId, source: cloneSource,
        materialization: { kind: 'clone', destinationParentPath: '/home/ubuntu', destinationDirectoryName: 'q1-round5-hello-world' } }, context))
        .toMatchObject({ kind: 'refused', code: 'source_unavailable' });
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
        expect(await handler(folder, context), scenario).toMatchObject({ kind: 'refused', code: 'target_mismatch' });
        expect(await openProject(folder, runtime, context), scenario).toMatchObject({ kind: 'refused', code: 'target_mismatch' });
        expect(await handler({ ...folder, serverId: profileId }, context), scenario).toMatchObject({ kind: 'refused', code: 'target_mismatch' });
        expect(await sourceHandler(copy, context), scenario).toEqual({ kind: 'refused', code: 'target_mismatch' });
        expect(read).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
      }
    } finally { scope.restore(); reloadConfiguration(); await rm(home, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'linux').each([
    { mode: 'plain', action: 'attach', fault: 'none' }, { mode: 'e2ee', action: 'attach', fault: 'none' },
    { mode: 'plain', action: 'attach', fault: 'folder_attach' },
    { mode: 'plain', action: 'attach', fault: 'clone_source' },
    { mode: 'plain', action: 'copy_once', fault: 'none' }, { mode: 'plain', action: 'create_relationship', fault: 'none' },
    { mode: 'plain', action: 'create_relationship', fault: 'endpoint_write_failure' },
    { mode: 'plain', action: 'create_relationship', fault: 'enabled_graph_ack' },
    { mode: 'plain', action: 'create_relationship', fault: 'remote_source_ack' },
    { mode: 'plain', action: 'create_relationship', fault: 'remote_source_refusal' },
    { mode: 'plain', action: 'create_relationship', fault: 'engine_refusal' },
    { mode: 'plain', action: 'create_relationship', fault: 'engine_refusal_cleanup' },
    { mode: 'plain', action: 'create_relationship', fault: 'engine_refusal_cancelled' },
    // Can use Add Machine (owner ruling 2026-11-14): a fresh guest member is
    // provisioned on this deliberate Open; a non-empty own folder still needs Manage.
    { mode: 'plain', action: 'create_relationship', fault: 'cold_member' },
    { mode: 'plain', action: 'create_relationship', fault: 'nonempty_target' },
  ] as const)('keeps a scoped Use requester Source on member execution without custodian credentials ($mode/$action/$fault)', async ({ mode, action, fault }) => {
    const syncing = action !== 'attach';
    const cloneSource = fault === 'clone_source';
    socketIo.mockImplementation((await vi.importActual<typeof import('socket.io-client')>('socket.io-client')).io);
    let memberPreparation: ReturnType<typeof createAgentIsolationMemberPreparationBoundary> | undefined;
    const installed = await createInstalledFilesystemMachineFixture({ agentIsolation: {
      managedHappierBinaryPath: '/opt/happier/cli/current/happier',
      read: () => ({ enabled: true, memberProvisioning: 'linuxUsersV1',
        status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: [] }),
      readMember: async input => {
        if (!memberPreparation) throw new Error('Member preparation fixture is not ready');
        return memberPreparation.members.read(input);
      },
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
    const coldMember = fault === 'cold_member';
    if (!coldMember) for (const step of buildAgentIsolationProvisioningSteps({ requesterIdentity, daemonUsername: 'happier', daemonPrimaryGroup: 'happier',
      binaryPath: '/opt/happier/cli/current/happier' })) memberPreparation.installed.add(step.id);
    const backingHome = join(installed.directory, 'native-home');
    const backingWorkspace = join(installed.directory, 'native-workspace');
    await mkdir(backingHome); await mkdir(backingWorkspace);
    nativeBoundary.mounts = [{ path: member.home, backing: backingHome, uid: 2401, gid: 2401, mode: 0o40700 },
      { path: member.workspaceRoot, backing: backingWorkspace, uid: 2401, gid: 1001, mode: 0o42770 }];
    nativeBoundary.accountLookups.set(JSON.stringify(['--service=files', 'passwd', member.username]),
      `${member.username}:x:2401:2401:${member.ownershipMarker}:${member.home}:/usr/sbin/nologin\n`);
    nativeBoundary.accountLookups.set(JSON.stringify(['--service=files', 'group', 'happier']), 'happier:x:1001:\n');
    if (!coldMember) await writeAgentIsolationMemberBinding(configuration.activeServerDir, { ...member, agentUid: 2401, agentGid: 2401 });
    const root = join(member.workspaceRoot, 'bob-checkout');
    // Test-only sidecar: the member worker's own frames carry the inner refusal that
    // Project Open's settlement diagnostic deliberately withholds.
    const workerFrames: string[] = [];
    nativeBoundary.launch = async (input, output) => {
      const frame = await readAgentLaunchFrame(input);
      expect(frame.nativeIdentity).toEqual({ username: member.username, agentUid: 2401, agentGid: 2401, home: member.home });
      expect(frame.args).toEqual(['workspace-effect']);
      const write = output.write.bind(output) as (...args: unknown[]) => boolean;
      output.write = ((...args: unknown[]) => {
        const text = String(args[0]);
        if (/ENOENT|"ok":false|error/i.test(text)) workerFrames.push(text.slice(0, 600));
        return write(...args);
      }) as typeof output.write;
      await runWorkspaceEffectWorker([], { input, output, signal: new AbortController().signal,
        currentDirectory: () => member.workspaceRoot });
    };
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`;
    const material = mode === 'e2ee' ? { type: 'legacy' as const, secret: new Uint8Array(32).fill(8) } : null;
    const cipher = createProjectAccountRowCipherV1({ mode, material, randomBytes: n => new Uint8Array(n) });
    const key = { kind: 'workspace-ref' as const, serverId: homeId, id: 'bob-checkout' };
    const workspace = { id: key.id, serverId: homeId,
      machineId: fault === 'remote_source_ack' || fault === 'remote_source_refusal' ? 'remote-source' : 'machine', rootPath: root, createdAtMs: 1 };
    const rows: ProjectAccountRowV1[] = fault === 'folder_attach' ? [] : [{ key, revision: 0, content: cipher.seal({ key, value: workspace }) }];
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
    let nativeEngineRefused = false;
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
      if (fault === 'engine_refusal_cleanup' && nativeEngineRefused
        && request.mutations.some(mutation => mutation.key.kind === 'relationship-graph')) {
        throw new Error('Relationship rollback acknowledgement is unavailable');
      }
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
    nativeBoundary.privateRoot = syncing || cloneSource ? targetRoot : '';
    nativeBoundary.privateRoots = syncing ? [root] : [];
    nativeSyncFiles.source = syncing ? root : '';
    const policyFields = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const contentPolicy = { ...policyFields, policyDigest: computeWorkspaceSyncPolicyDigest(policyFields) };
    const nativeSyncBoundary = createWorkspaceSyncNativeProcessTestBoundary({ onCommand: async command => {
      if ((fault === 'engine_refusal' || fault === 'engine_refusal_cleanup' || fault === 'engine_refusal_cancelled')
        && command.t === 'resume') {
        nativeEngineRefused = true;
        if (fault === 'engine_refusal_cancelled') ingress.abort();
        throw new BrokerProtocolError('engine_unavailable', 'External synchronization agent version handshake failed: version mismatch');
      }
    } });
    const productionSyncInput = { happyHomeDir: installed.directory,
      activeServerDir: configuration.activeServerDir, activeServerId: installed.serverId,
      homeTarget: await resolveCurrentCliHomeTarget(), localMachineId: 'machine', releaseChannel: 'publicdev',
      privateCheckout: runtime.privateCheckout,
      requesterMachineAdmissionBoundary: { machineId: 'machine', daemonToken: installed.bootstrap.credentials.token,
        isHomeCurrent: installed.isHomeCurrent, getObservedServerIdentityId: () => homeId,
        readInstallation: () => installed.installation },
      credentials: installed.bootstrap.credentials, isCurrent: async () => installed.isHomeCurrent() } satisfies Parameters<typeof createProductionDaemonWorkspaceSyncRuntime>[0];
    const productionSync = syncing ? await createProductionDaemonWorkspaceSyncRuntime(productionSyncInput, nativeSyncBoundary.factories) : null;
    let recoveredSync: Awaited<ReturnType<typeof createProductionDaemonWorkspaceSyncRuntime>> | undefined;
    if (productionSync) { runtime = { ...runtime, workspaceSyncAdapter: productionSync.handoffAdapter }; onTestFinished(() => productionSync.stop()); }
    const input = { serverId: homeId, machineId: 'machine', ...(cloneSource ? { cloneSource: true as const } : {}), source: fault === 'folder_attach' ? { kind: 'folder' as const, path: root } : { kind: 'source' as const, id: source.id, revision: 1, selector: source.repository,
      checkout: { serverId: homeId, workspaceId: key.id, machineId: workspace.machineId, rootPath: root } }, materialization: action === 'attach'
      ? { kind: 'attach' as const }
      : { kind: 'sync' as const, targetPath: targetRoot, workspaceAction: action === 'copy_once'
        ? { kind: 'copy_once' as const, contentPolicy }
        : { kind: 'create_relationship' as const, mode: 'keep_synced' as const, contentPolicy,
          flushBeforeCommit: true as const } } } satisfies OpenProjectInputV1;
    let remoteTargetPrepared = false;
    let sourceSettlement: 'confirmed' | 'unconfirmed' | undefined;
    if (fault === 'remote_source_ack' && productionSync) {
      const targetHandlers = new Map<string, RpcHandler<unknown, unknown>>();
      const targetRegistrar: RpcHandlerRegistrar = { registerHandler: (method, handler) => {
        targetHandlers.set(method, handler as RpcHandler<unknown, unknown>);
      } };
      registerMachineWorkspaceSyncRpcHandlers({ rpcHandlerManager: targetRegistrar, service: productionSync.workspaceSync });
      const sourceNative = createWorkspaceSyncNativeProcessTestBoundary();
      let sourceOperationId: string | undefined;
      const sourceSync = await createProductionDaemonWorkspaceSyncRuntime({
        ...productionSyncInput, happyHomeDir: join(installed.directory, 'remote-source'),
        activeServerDir: join(installed.directory, 'remote-source', 'server'),
        localMachineId: 'remote-source', credentials: { token, encryption: null },
        privateCheckout: undefined, requesterMachineAdmissionBoundary: undefined,
      }, { ...sourceNative.factories, callMachineRpc: async call => {
        expect(call.machineId).toBe('machine');
        if (remoteTargetPrepared) throw new Error('SOURCE to TARGET transport is unavailable after prepare');
        if (call.method !== RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE || !sourceOperationId)
          throw new Error(`Unexpected SOURCE transport call: ${call.method}`);
        const prepare = WorkspaceSyncTargetBootstrapPrepareV1Schema.parse(call.request);
        if (!context.machineAdmission) throw new Error('Missing TARGET admission');
        const admitted = resolvePrivateWorkspaceSyncTargetExecution(productionSync.handoffAdapter, {
          context: context.machineAdmission, receivingMachine: { machineId: 'machine', installationId: installed.installation.installationId },
          request: prepare, targetWorkspaceRefId: prepare.targetWorkspaceRefId,
          routing: { v: 1, phase: 'prepare', operationId: sourceOperationId, accountServerId: homeId,
            targetMachineId: 'machine', targetRootPath: targetRoot },
        });
        if (admitted.kind !== 'matched') throw new Error(`TARGET admission failed: ${admitted.kind}`);
        // Observe the real SOURCE publication at the transport effect boundary,
        // before TARGET receives its prepare. The fixture supplies no graph row.
        const sourcePublication = await readProjectAccountRows({ credentials: { token, encryption: null }, serverId: installed.serverId,
          selection: { kinds: ['workspace-ref', 'relationship-graph'] } });
        expect(sourcePublication.workspaceRefs).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: key.id, machineId: 'remote-source', rootPath: root }),
          expect.objectContaining({ id: 'bob-sync', machineId: 'machine', rootPath: targetRoot }),
        ]));
        expect(sourcePublication.relationships).toEqual([expect.objectContaining({
          enabled: false, controllerMachineId: 'remote-source', alphaWorkspaceRefId: key.id, betaWorkspaceRefId: 'bob-sync',
        })]);
        const handler = targetHandlers.get(call.method);
        if (!handler) throw new Error('TARGET prepare was not registered');
        await handler(prepare, { ...context, workspaceSyncPrivateExecution: admitted.capture });
        remoteTargetPrepared = true;
        // Only the external transport loses the acknowledgement. Both hosts'
        // production owners have materialized their own endpoints/custody.
        return { errorCode: 'indeterminate', error: 'TARGET prepare acknowledgement was lost' };
      } });
      onTestFinished(() => sourceSync.stop());
      runtime = { ...runtime, callWorkspaceSource: async request => {
        expect(request.machineId).toBe('remote-source');
        sourceOperationId = request.operationId;
        if (request.request.materialization.kind !== 'sync') throw new Error('Missing SOURCE Sync action');
        const action = request.request.materialization.workspaceAction;
        // SOURCE consumes Home rows through its installed Account projection;
        // TARGET's private requester projection is a separate reader lifetime.
        await readProjectAccountRows({ credentials: { token, encryption: null }, serverId: installed.serverId,
          publication: 'installed' });
        try {
          await nativeBoundary.identity.run('member', () => materializeWorkspaceSyncForOpen(sourceSync.handoffAdapter, {
            operationId: request.operationId, accountServerId: homeId,
            sourceMachineId: request.sourceWorkspace.machineId, sourceRootPath: request.sourceWorkspace.rootPath,
            sourceWorkspaceRefId: request.sourceWorkspace.id, targetMachineId: 'machine', targetRootPath: targetRoot,
            action, signal: request.context.signal,
          }));
          sourceSettlement = 'confirmed';
          return { kind: 'materialized' };
        } catch (error) {
          if (!remoteTargetPrepared) throw error;
          sourceSettlement = 'unconfirmed';
          return { kind: 'outcomeUnknown' };
        }
      } };
    }
    // L12 READY218: Home refused the SOURCE's target bootstrap before it ran. The SOURCE's
    // wire settlement carries that owner's typed cause; the opening Machine passes it on.
    const sourceRefusalCause = { phase: 'rpc.admission.machine', errorClass: 'Error' as const, errorCode: 'custodian_only', httpStatus: 403 };
    if (fault === 'remote_source_refusal') {
      runtime = { ...runtime, callWorkspaceSource: async () => ProjectOpenSyncMaterializationResultV1Schema.parse({
        kind: 'refused', code: 'RPC_FORBIDDEN', failureCause: sourceRefusalCause }) };
    }
    // Existing-checkout attachment needs the daemon-applied runtime lifetime,
    // but no plugin contributions. Publish it through the real runtime owner.
    const pluginRuntime = await createAdmittedPluginRuntimeFixture({ happyHomeDir: installed.directory,
      controller: pluginReloadController, runtimeOptions: cloneSource
        ? { pluginIds: ['happier.scm.backend.git', 'happier.scm.forge.github'] }
        : { pluginIds: [], contributes: createResolvedContributionRegistry({}) } });
    onTestFinished(() => pluginRuntime.dispose());
    try {
      await mkdir(join(root, '.happier'), { recursive: true });
      await writeFile(join(root, '.happier/project.json'), JSON.stringify({ version: 1, workspace: { setup: [{ kind: 'command', command: 'touch not-executed' }] } }));
      await writeFile(join(root, 'payload.txt'), 'member seed');
      if (cloneSource) {
        const git = promisify(execFile);
        const cwd = join(backingWorkspace, 'bob-checkout');
        await git('git', ['init', '-b', 'feature/private'], { cwd });
        await git('git', ['-c', 'user.name=Private Source', '-c', 'user.email=source@example.test', 'commit', '--allow-empty', '-m', 'source'], { cwd });
        await git('git', ['remote', 'add', 'origin', 'https://github.com/owner/private-source.git'], { cwd });
      }
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
        .toMatchObject({ kind: 'refused', code: 'requester_authority_unavailable', effectAttempted: false });
      expect(post).not.toHaveBeenCalled();
      expect(nativeBoundary.runAsUsers).toEqual([]);
      if (!syncing && mode === 'plain' && !cloneSource) {
        const sharedSource = { ...source, createdByAccountId: 'requester', audience: [{ principal: { kind: 'team' as const, teamId: 'team-source' }, level: 'view' as const }] };
        vi.mocked(axios.request).mockImplementation(async request => {
          assertBobHeaders(request.headers);
          return { status: 200, data: { ok: true, source: sharedSource, canManage: false } };
        });
        const clone = { ...input, source: { kind: 'source' as const, id: sharedSource.id, revision: sharedSource.revision,
          selector: sharedSource.repository }, materialization: { kind: 'clone' as const,
          destinationParentPath: '/tmp', destinationDirectoryName: 'replay131-g-compose' } };
        expect(await register(RPC_METHODS.PROJECTS_OPEN, runtime)(clone, context)).toMatchObject({
          kind: 'refused', code: 'workspace_private_checkout_review_required', effectAttempted: false,
          destinationReview: { accountId: 'bob', serverId: homeId, machineId: 'machine',
            destinationParentPath: member.workspaceRoot, destinationDirectoryName: 'replay131-g-compose' },
        });
        const press: ActionExecutorContext = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
          serverId: homeId, runtimeAccountId: 'bob', actionRequestId: 'clone-review' };
        const deps = { projectsOpen: async (next: OpenProjectInputV1) =>
          OpenProjectResultV1Schema.parse(await register(RPC_METHODS.PROJECTS_OPEN, runtime)(next, context)) } satisfies ActionExecutorDeps;
        const carried = await dispatchProjectsDispatch2({ actionId: 'projects.open', data: clone, deps, ctx: press });
        expect(carried).toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
        if (!carried || carried.ok) throw new Error('Expected a carried private destination review');
        let confirmedDestination: unknown;
        const confirmed = await confirmOwnUiRefusal('projects.open', clone, press, carried, async request => {
          expect(request.preview).toMatchObject({ actionArgs: { materialization: {
            destinationParentPath: member.workspaceRoot, destinationDirectoryName: 'replay131-g-compose' } } });
          expect(JSON.stringify(request.preview)).toContain(member.workspaceRoot);
          expect(request.preview).toMatchObject({ summary: expect.stringContaining(member.workspaceRoot) });
          return true;
        }, async (next, digest) => {
          confirmedDestination = next;
          const review = await prepareApprovalRequest({ deps, actionId: 'projects.open', input: next, actionArgs: next, context: press });
          if (!review || 'ok' in review) throw new Error('Expected the canonical review');
          expect(digest).toBe(computeActionReviewDigestV1('projects.open', review));
          // The originating UI's next HTTP dispatch is the boundary here. The native
          // destination handback above ran through the installed Open receiver.
          return { ok: true, result: { kind: 'opened' } };
        });
        expect(confirmed.ok).toBe(true);
        expect(confirmedDestination).toMatchObject({ source: clone.source, materialization: {
          kind: 'clone', destinationParentPath: member.workspaceRoot, destinationDirectoryName: 'replay131-g-compose' } });
        expect(await confirmOwnUiRefusal('projects.open', clone, press, carried, async () => false,
          async () => { throw new Error('Cancel must not resubmit'); })).toMatchObject({ ok: false, errorCode: 'approval_canceled' });
        const initialReview = await prepareApprovalRequest({ deps, actionId: 'projects.open', input: clone, actionArgs: clone, context: press });
        if (!initialReview || 'ok' in initialReview) throw new Error('Expected the original Open review');
        const confirmations: unknown[] = [];
        const submissions: unknown[] = [];
        const chained = await confirmOwnUiRefusal('projects.open', clone, press, {
          ok: false, errorCode: 'action_interactive_review_required', error: 'action_interactive_review_required',
          details: { review: initialReview, reviewDigest: computeActionReviewDigestV1('projects.open', initialReview) },
        }, async request => { confirmations.push(request.input); return true; }, async next => {
          submissions.push(next);
          return submissions.length === 1 ? carried : { ok: true, result: { kind: 'opened' } };
        });
        expect(chained.ok).toBe(true);
        expect(confirmations).toEqual([clone, confirmedDestination]);
        expect(submissions).toEqual(confirmations);
        expect(nativeBoundary.runAsUsers).toEqual([]);
      }
      if (syncing && input.materialization.kind === 'sync') {
        const open = register(RPC_METHODS.PROJECTS_OPEN, runtime);
        const foreignTarget = join(member.workspaceRoot, '..', 'other-member', 'foreign-checkout');
        expect(OpenProjectResultV1Schema.parse(await open({
          ...input, materialization: { ...input.materialization, targetPath: foreignTarget },
        }, context))).toMatchObject({
          kind: 'refused', code: 'workspace_private_checkout_review_required', effectAttempted: false,
          destinationReview: { accountId: 'bob', serverId: homeId, machineId: 'machine',
            destinationParentPath: member.workspaceRoot, destinationDirectoryName: 'foreign-checkout' },
        });
        expect(await open({ ...input, source: { kind: 'folder', path: root } }, context))
          .toMatchObject({ kind: 'refused', code: 'workspace_private_checkout_required' });
        expect(post.mock.calls.some(([, body]) => ProjectAccountRowMutationRequestV1Schema.safeParse(body).success)).toBe(false);
        expect(nativeBoundary.runAsUsers).toEqual([]);
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
      if (fault === 'folder_attach') {
        const outside = { ...input, source: { kind: 'folder', path: `${member.workspaceRoot}-outside/bob-checkout` } };
        expect(await register(RPC_METHODS.PROJECTS_OPEN, runtime)(outside, context))
          .toMatchObject({ kind: 'refused', code: 'workspace_private_checkout_required' });
        expect(rows).toEqual([]);
        expect(nativeBoundary.runAsUsers).toEqual([]);
      }
      if (fault === 'nonempty_target') {
        // Replacing a non-empty folder needs Manage; Can use Open has no replacement approval.
        await mkdir(targetRoot, { recursive: true });
        await writeFile(join(targetRoot, 'existing.txt'), 'member bytes');
        const refusedOpen = await register(RPC_METHODS.PROJECTS_OPEN, runtime)(input, context);
        // The target bootstrap owner refuses a non-empty replacement without its approval.
        expect(refusedOpen, JSON.stringify(refusedOpen)).toMatchObject({ kind: 'refused', code: 'approval_stale' });
        expect(await readFile(join(targetRoot, 'existing.txt'), 'utf8')).toBe('member bytes');
        await expect(access(join(targetRoot, 'payload.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
        const graph = rows.find(row => row.key.kind === 'relationship-graph');
        if (graph?.content) expect(cipher.open(graph.key, graph.content).value).toMatchObject({ relationships: [] });
        expect(productionSync?.handoffAdapter.listPrivateExecutions?.()).toEqual([]);
        return;
      }
      // Signed Open reads describe child placement. Retained transfers use
      // Account bearer admission once at their next natural boundary.
      const machineReads = () => vi.mocked(axios.get).mock.calls.filter(([url, config]) => url.endsWith('/v1/machines/machine')
        && config?.headers?.Authorization === `Bearer ${token}`).length;
      const initialMachineReads = machineReads();
      const opened = await register(RPC_METHODS.PROJECTS_OPEN, runtime)(input, context);
      if (fault === 'remote_source_refusal') {
        expect(opened).toMatchObject({ kind: 'refused', code: 'RPC_FORBIDDEN', failureCause: sourceRefusalCause });
        return;
      }
      if (fault === 'engine_refusal_cleanup' || fault === 'engine_refusal_cancelled') {
        expect(nativeEngineRefused).toBe(true);
        expect(opened).toEqual({ kind: 'outcomeUnknown' });
        return;
      }
      if (fault === 'engine_refusal') {
        expect(nativeEngineRefused).toBe(true);
        expect(opened, JSON.stringify(admissionDiagnostics?.mock.calls)).toMatchObject({ kind: 'refused',
          code: 'workspace_sync_unavailable', effectAttempted: true });
        const graph = rows.find(row => row.key.kind === 'relationship-graph');
        if (!graph?.content) throw new Error('Expected the acknowledged rollback graph');
        expect(cipher.open(graph.key, graph.content).value).toMatchObject({ relationships: [] });
        expect(productionSync?.handoffAdapter.listPrivateExecutions?.()).toEqual([]);
        expect(nativeSyncBoundary.commands.some(command => command.t === 'terminate')).toBe(true);
        return;
      }
      if (fault === 'remote_source_ack') {
        expect(remoteTargetPrepared, JSON.stringify({ diagnostics: admissionDiagnostics?.mock.calls, workerFrames: workerFrames.slice(-4) })).toBe(true);
        expect(sourceSettlement).toBe('unconfirmed');
        expect(opened).toEqual({ kind: 'outcomeUnknown' });
        const captures = productionSync?.handoffAdapter.listPrivateExecutions?.();
        expect(captures).toHaveLength(1);
        const retained = captures?.[0];
        if (!retained?.relationshipId) throw new Error('The remote SOURCE must bind real TARGET custody');
        expect(retained.relationshipId).toBe(deriveWorkspaceSyncRelationshipId(retained.input.operationId));
        expect(retained.phase).toBe('relationship');
        // A retry of an unconfirmed Open names the same private root, so it adopts this row.
        expect(retained.input.targetWorkspaceRefId).toBe('bob-sync');
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
        nativePhases: nativeBoundary.phases, workerFrames: workerFrames.slice(-4) })).toMatchObject({ kind: 'opened', directory: targetRoot, setup: 'approvalRequired',
        workspace: { serverId: homeId, machineId: 'machine', rootPath: targetRoot },
        ...(fault === 'folder_attach' ? {} : { facts: { source: { sourceId: source.id, revision: 1 } } }) });
      if (cloneSource) {
        expect(opened).toMatchObject({ kind: 'opened', cloneSource: {
          source: { repository: { nameWithOwner: 'owner/private-source' }, protocol: 'https' }, branch: 'feature/private',
        } });
        expect(nativeBoundary.runAsUsers).toContain('git-member');
        expect(nativeBoundary.phases).not.toContain('daemon_private_readback_denied');
      }
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
          let resolveRecoveredReady: (() => void) | undefined;
          const recoveredReady = new Promise<void>(resolve => { resolveRecoveredReady = resolve; });
          const recovered = await createProductionDaemonWorkspaceSyncRuntime({ ...productionSyncInput,
            onReadinessPublished: readiness => {
              if (readiness.engine.state === 'ready') resolveRecoveredReady?.();
            },
          }, recoveredBoundary.factories);
          recoveredSync = recovered;
          onTestFinished(() => recovered.stop());
          await recoveredReady;
          await writeFile(join(root, 'payload.txt'), 'member recovered transfer');
          const recoveredLaunches = nativeBoundary.runAsUsers.length;
          await recovered.workspaceSync.controller.flush(relationshipId);
          const recoveredCapture = recovered.handoffAdapter.resolvePrivateExecution?.({ relationshipId });
          expect(recoveredCapture?.execution.executionIdentity).toEqual(capturedIdentity);
          expect(recoveredCapture?.execution.credentials.token).toBe(token);
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
      } else expect(cloneSource ? nativeBoundary.runAsUsers.filter(user => user !== 'git-member')
        : nativeBoundary.runAsUsers).toEqual([member.username]);
      // Home binding is proved by the real projection/installed-ingress tests;
      // this consumer receives host-private ports only after that admission.
      current = false;
      post.mockClear();
      expect(await register(RPC_METHODS.PROJECTS_OPEN, runtime)(input, { ...context, signal: new AbortController().signal }))
        .toMatchObject({ kind: 'refused', code: 'requester_authority_unavailable', effectAttempted: false });
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
      expect(writes).toHaveLength(2);
      expect(ProjectAccountRowMutationRequestV1Schema.parse(writes[0]).mutations).toEqual([
        expect.objectContaining({ key: expect.objectContaining({ kind: 'workspace-ref', serverId: 'srv_test_home' }) }),
        { key: { kind: 'relationship-graph' }, expectedRevision: 'absent',
          content: { t: 'plain', v: { key: { kind: 'relationship-graph' }, value: { relationships: [] } } } },
      ]);
      expect(ProjectAccountRowMutationRequestV1Schema.parse(writes[1]).mutations).toEqual([
        expect.objectContaining({
          key: expect.objectContaining({ kind: 'project-organization', serverId: 'srv_test_home' }),
          content: expect.objectContaining({ t: 'plain', v: expect.objectContaining({ value: { hidden: false } }) }),
        }),
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
      storage: { kind: 'child' as const, childPath: root } };
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
    const { materializeWorkspaceRefForMachineRoot } = await import('@/workspaces/workspaceRefsV1');
    const parentRef = { id: 'parent-workspace', serverId: homeId, machineId: 'parent', rootPath: '/host/project',
      projectKey: 'parent-project', createdAtMs: 1 };
    // Project files materialization establishes the association; no host bind alias supplies it at Open.
    const enrolled = materializeWorkspaceRefForMachineRoot([parentRef], {
      serverId: homeId, machineId: 'machine', rootPath: root,
      parentWorkspace: { serverId: homeId, workspaceId: parentRef.id, machineId: 'parent', rootPath: parentRef.rootPath },
      nowMs: 1, createId: () => 'enrolled-child-workspace',
    });
    const rows: ProjectAccountRowV1[] = enrolled.workspaceRefs.map(value => {
      const key = { kind: 'workspace-ref' as const, serverId: homeId, id: value.id };
      return { key, revision: 0, content: { t: 'plain', v: { key, value } } };
    });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
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
      expect(result).toMatchObject({ kind: 'opened', directory: root, workspace: { serverId: homeId, workspaceId: enrolled.workspaceRef.id, machineId: 'machine', rootPath: root },
        facts: { projectKey: 'parent-project' } });
      expect(post.mock.calls.some(([url]) => url.includes('/acquire') || url.includes('/admit'))).toBe(false);
      const opened = OpenProjectResultV1Schema.parse(result);
      if (opened.kind !== 'opened') throw new Error('Actual child was not admitted');
      const separateRoot = join(root, 'separate-guest-project');
      await mkdir(join(separateRoot, '.happier'), { recursive: true });
      await writeFile(join(separateRoot, '.happier/project.json'), JSON.stringify({ version: 1 }));
      const parentIndex = rows.findIndex(row => JSON.stringify(row.key) === JSON.stringify(parentKey));
      const [parentRow] = rows.splice(parentIndex, 1);
      const separate = await register(RPC_METHODS.PROJECTS_OPEN, { serverId: homeId, serverHttpBaseUrl: 'https://home.example',
        machineId: 'machine', accountId: 'account', readCredentials: async () => ({ token, encryption: null }) })({
        serverId: homeId, machineId: 'machine', source: { kind: 'folder', path: separateRoot }, materialization: { kind: 'attach' },
      }, context);
      expect(separate).toMatchObject({ kind: 'opened', directory: separateRoot,
        workspace: { serverId: homeId, machineId: 'machine', rootPath: separateRoot } });
      const separateOpened = OpenProjectResultV1Schema.parse(separate);
      if (separateOpened.kind !== 'opened') throw new Error('Separate guest Project was not opened');
      if (!separateOpened.facts) throw new Error('Separate guest Project facts were not returned');
      expect(separateOpened.facts.projectKey).not.toBe('parent-project');
      rows.push(parentRow!);
      const acceptedRows = structuredClone(rows);
      await writeFile(join(root, '.happier/project.json'), JSON.stringify({ version: 1, devcontainer: { configPath: '.devcontainer/b/devcontainer.json' } }));
      const changedSelection = await register(RPC_METHODS.PROJECTS_OPEN, { serverId: homeId, serverHttpBaseUrl: 'https://home.example',
        machineId: 'machine', accountId: 'account', readCredentials: async () => ({ token, encryption: null }) })({
        serverId: homeId, machineId: 'machine', source: { kind: 'folder', path: root }, materialization: { kind: 'attach' },
      }, context);
      expect(changedSelection).toMatchObject({ kind: 'opened', directory: root,
        workspace: opened.workspace, facts: { projectKey: 'parent-project' } });
      expect(rows).toEqual(acceptedRows);
      // A replaced managed target retires the old enrolled alias, even while its Machine metadata remains published.
      machine.enrolledMachineId = 'replacement-machine';
      const retiredAlias = await register(RPC_METHODS.PROJECTS_OPEN, { serverId: homeId, serverHttpBaseUrl: 'https://home.example',
        machineId: 'machine', accountId: 'account', readCredentials: async () => ({ token, encryption: null }) })({
        serverId: homeId, machineId: 'machine', source: { kind: 'folder', path: root }, materialization: { kind: 'attach' },
      }, context);
      expect(retiredAlias).toMatchObject({ kind: 'refused', code: 'workspace_sync_child_unavailable', effectAttempted: false });
      expect(rows).toEqual(acceptedRows);
      expect(post.mock.calls.some(([url]) => url.includes('/acquire') || url.includes('/admit'))).toBe(false);

    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['metadata', 'override', 'selector', 'revoked', 'repository_removed', 'adopted', 'adopted_revoked'] as const)('admits a captured Source before checkout effects (%s)', async change => {
    const root = await mkdtemp(join(tmpdir(), 'happier-source-open-'));
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    const source = { id: 'source', revision: 1, name: 'Original', createdByAccountId: 'account', audience: [],
      repository: { provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://forge.example' },
        repository: { nameWithOwner: 'group/repo', cloneUrl: 'https://forge.example/group/repo.git' }, protocol: 'https' }, subdir: 'packages/app' } satisfies ProjectSourceV1;
    const { repository: _repository, ...withoutRepository } = source;
    const current: ProjectSourceV1 = change === 'repository_removed' ? withoutRepository : { ...source, revision: 9, name: 'Renamed', attachments: [],
      ...(change === 'override' ? { subdir: 'other' } : {}),
      ...(change === 'selector' ? { repository: { ...source.repository, repository: { nameWithOwner: 'group/other', cloneUrl: 'https://forge.example/group/other.git' } } } : {}) };
    const key = { kind: 'workspace-ref' as const, serverId: 'srv_test_home', id: 'checkout' };
    const adopted = change === 'adopted' || change === 'adopted_revoked';
    const revoked = change === 'revoked' || change === 'adopted_revoked';
    const rows: ProjectAccountRowV1[] = adopted ? [] : [{ key, revision: 0, content: { t: 'plain', v: { key,
      value: { id: 'checkout', serverId: 'srv_test_home', machineId: 'machine', rootPath: root, createdAtMs: 1 } } } }];
    const reads: string[] = [];
    vi.spyOn(axios, 'request').mockImplementation(async config => {
      reads.push(config.url ?? '');
      return { status: revoked ? 404 : 200, data: revoked
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
          selector: source.repository, subdir: source.subdir,
          ...(adopted ? { checkoutPath: root } : { checkout: { serverId: 'srv_test_home', workspaceId: 'checkout', machineId: 'machine', rootPath: root } }) },
        ...(change === 'override' ? { subdir: 'packages/app' } : {}), materialization: change === 'selector' || change === 'revoked' || change === 'repository_removed'
          ? { kind: 'clone', destinationParentPath: root, destinationDirectoryName: 'must-not-exist' } : { kind: 'attach' },
      }, context);
      expect(reads).toEqual(['https://home.example/v1/projects/sources/source?serverId=srv_test_home']);
      if (change === 'metadata' || change === 'override' || change === 'adopted') {
        expect(result).toMatchObject({ kind: 'opened', directory: join(root, 'packages/app'),
          workspace: { machineId: 'machine', rootPath: root }, facts: { source: { sourceId: 'source', revision: 9 } } });
        expect(rows.find(row => row.key.kind === 'workspace-ref')).toMatchObject({ content: { t: 'plain',
          v: { value: { source: { sourceId: 'source', revision: 9 } } } } });
        expect(writes.length).toBeGreaterThan(0);
      } else {
        expect(result).toMatchObject({ kind: 'refused', code: change === 'repository_removed' ? 'needs_repository'
          : change === 'selector' ? 'source_selection_changed' : 'source_unavailable', effectAttempted: false });
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
      .toMatchObject({ kind: 'refused', code: requester === 'foreign' ? 'requester_account_unavailable' : 'requester_authority_unavailable', effectAttempted: false });
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
    expect(await register(RPC_METHODS.PROJECTS_OPEN, runtime)(input)).toEqual({ kind: 'refused', code: 'machine_admission_unavailable', effectAttempted: false });
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

  it('encodes a rolled-back native engine refusal on the SOURCE materialization RPC', async () => {
    socketIo.mockImplementation((await vi.importActual<typeof import('socket.io-client')>('socket.io-client')).io);
    const installed = await createInstalledFilesystemMachineFixture();
    const homeId = installed.homeServerIdentityId;
    const root = join(installed.directory, 'source-checkout');
    const targetPath = join(installed.directory, 'target-checkout');
    await mkdir(root);
    await writeFile(join(root, 'payload.txt'), 'SOURCE preparation bytes');
    const workspace = { id: 'source-checkout', serverId: homeId, machineId: 'machine', rootPath: root, createdAtMs: 1 };
    const key = { kind: 'workspace-ref' as const, serverId: homeId, id: workspace.id };
    const rows: ProjectAccountRowV1[] = [{ key, revision: 0, content: { t: 'plain', v: { key, value: workspace } } }];
    const rowsHttp = createProjectAccountRowsHttpBoundary(rows);
    const admissionHttp = vi.mocked(axios.post).getMockImplementation();
    vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
      if (url.endsWith('/v1/machines/machine/admission/verify')) {
        if (!admissionHttp) throw new Error('Missing installed Machine admission HTTP boundary');
        return admissionHttp(url, body, config);
      }
      return rowsHttp(url, body);
    });
    let nativeRefused = false;
    const native = createWorkspaceSyncNativeProcessTestBoundary({ onCommand: async command => {
      if (command.t === 'resume') {
        nativeRefused = true;
        throw new BrokerProtocolError('engine_unavailable', 'External synchronization agent version handshake failed: version mismatch');
      }
    } });
    await readProjectAccountRows({ credentials: installed.bootstrap.credentials, serverId: installed.serverId, publication: 'installed' });
    const production = await createProductionDaemonWorkspaceSyncRuntime({ happyHomeDir: installed.directory,
      activeServerDir: configuration.activeServerDir, activeServerId: installed.serverId,
      homeTarget: await resolveCurrentCliHomeTarget(), localMachineId: 'machine', releaseChannel: 'publicdev',
      credentials: installed.bootstrap.credentials, isCurrent: async () => installed.isHomeCurrent() }, native.factories);
    onTestFinished(() => production.stop());
    const runtime: ProjectOpenRuntime = { serverId: installed.serverId, serverHttpBaseUrl: installed.serverHttpBaseUrl,
      machineId: 'machine', accountId: 'requester', readCredentials: async () => installed.bootstrap.credentials,
      workspaceSyncAdapter: production.handoffAdapter };
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
      machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'requester', machineId: 'machine',
        installationId: installed.installation.installationId, role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => true };
    const fields = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const input = { serverId: homeId, machineId: 'machine', source: { kind: 'workspace', workspaceId: workspace.id,
      checkout: { serverId: homeId, workspaceId: workspace.id, machineId: 'machine', rootPath: root } },
      materialization: { kind: 'sync', targetPath, workspaceAction: { kind: 'create_relationship', mode: 'keep_synced',
        contentPolicy: { ...fields, policyDigest: computeWorkspaceSyncPolicyDigest(fields) }, flushBeforeCommit: true } } } satisfies OpenProjectInputV1;
    const diagnostic = vi.spyOn(logger, 'warnLocalFile');
    const result = await register(RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN, runtime)(input, context);
    expect(nativeRefused, JSON.stringify(diagnostic.mock.calls)).toBe(true);
    // The existing wire result carries the refusal across Machines without Error identity.
    expect(ProjectOpenSyncMaterializationResultV1Schema.parse(JSON.parse(JSON.stringify(result))))
      .toEqual({ kind: 'refused', code: 'workspace_sync_unavailable' });
    const graph = rows.find(row => row.key.kind === 'relationship-graph');
    expect(graph?.content).toMatchObject({ t: 'plain', v: { value: { relationships: [] } } });
    expect(native.commands.some(command => command.t === 'terminate')).toBe(true);
  });

  it.each(['source-checkout', 'workspace-only', 'managed-workspace'] as const)('finishes an admitted Source copy to a new destination after revocation and refuses the next Open before effects (%s)', async sourceShape => {
    const diagnostic = vi.spyOn(logger, 'warnLocalFile');
    const fixture = await mkdtemp(join(tmpdir(), 'OPEN-TESTS-source-copy-'));
    const root = join(fixture, 'source');
    const targetPath = join(fixture, 'target');
    await mkdir(root);
    await writeFile(join(root, 'content.txt'), 'controller Source bytes');
    const guestDisk = join(fixture, 'guest');
    await mkdir(guestDisk);
    await writeFile(join(guestDisk, 'content.txt'), 'admitted guest bytes');
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    const workspace = { id: 'checkout', serverId: 'srv_test_home', machineId: 'machine', rootPath: root, createdAtMs: 1 };
    const key = { kind: 'workspace-ref' as const, serverId: 'srv_test_home', id: workspace.id };
    const managedAddress = { v: 2 as const, kind: 'managed' as const, serverId: workspace.serverId,
      workspaceId: 'guest-workspace', managedId: 'guest-resource', rootPath: root,
      controller: { machineId: workspace.machineId, installationId: 'installation' } };
    const managedRowKey = { ...key, id: managedAddress.workspaceId };
    const { workspaceId: managedIdInRows, ...managedLocator } = managedAddress;
    const source = { id: 'source', revision: 9, name: 'Repository', createdByAccountId: 'account', audience: [],
      repository: { provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://forge.example' },
        repository: { nameWithOwner: 'group/repo' }, protocol: 'https' } } satisfies ProjectSourceV1;
    let current = true;
    let admissionReads = 0;
    let copies = 0;
    let mutations = 0;
    vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: { ok: true, source, canManage: true } });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const response = await plainMachineRead(url);
      if (url.includes('/v1/machines/machine')) current = false;
      return response;
    });
    const rows: ProjectAccountRowV1[] = [{ key, revision: 0, content: { t: 'plain', v: { key, value: workspace } } }];
    rows.push({ key: managedRowKey, revision: 0, content: { t: 'plain', v: {
      key: managedRowKey, value: { ...managedLocator, id: managedIdInRows, createdAtMs: 1 },
    } } });
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (url.endsWith('/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
      if (url.endsWith('/read')) return projectAccountRowReadResponse(rows, body);
      const request = ProjectAccountRowMutationRequestV1Schema.parse(body);
      const changed = request.mutations.map(mutation => ({ key: mutation.key,
        revision: mutation.expectedRevision === 'absent' ? 0 : mutation.expectedRevision + 1, content: mutation.content }));
      for (const row of changed) {
        const index = rows.findIndex(existing => JSON.stringify(existing.key) === JSON.stringify(row.key));
        if (index < 0) rows.push(row); else rows[index] = row;
      }
      mutations += 1;
      return { status: 200, data: { status: 'updated', rows: changed, cursor: mutations } };
    });
    const credentials = { token, encryption: null };
    const accountRows = { credentials, serverId: 'srv_test_home' };
    const readSnapshot = () => readProjectAccountRows({ ...accountRows,
      selection: { kinds: ['workspace-ref', 'relationship-graph'] } });
    const resolveWorkspaceRef = async (id: string) => {
      const snapshot = await readSnapshot();
      const resolved = resolveWorkspaceRefV1(snapshot.workspaceRefs, { serverId: 'srv_test_home', id });
      return resolved.kind === 'resolved' ? resolved.ref : null;
    };
    const rootOwnershipManager = createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') });
    let native: MutagenSessionSummaryV1 | null = null;
    const guestRoots = createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'guest-locks') });
    let sourceDisk = root;
    // Only the external Mutagen command transport is simulated. The adapter,
    // controller, endpoint writer and physical target bootstrap remain real.
    const adapter = createWorkspaceSyncMutagenAdapter({ resolveWorkspaceRef, send: async command => {
      if (command.t === 'list') return { sessions: native ? [native] : [], nextCursor: null };
      if (command.t === 'create') {
        const state = { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 };
        if (sourceShape === 'managed-workspace') {
          await sync.openExternalStream({ endpointId: new URL(command.session.alpha).hostname });
        }
        native = { identifier: 'OPEN-TESTS-native-copy', name: command.session.name, labels: command.session.labels,
          alpha: { protocol: 'external', host: new URL(command.session.alpha).hostname, path: '', state },
          beta: { protocol: 'external', host: new URL(command.session.beta).hostname, path: '', state },
          mode: command.session.mode, paused: true, status: 'watching', successfulCycles: 0, conflictCount: 0 };
      } else if (command.t === 'resume' && native) native = { ...native, paused: false };
      else if (command.t === 'flush' && native) {
        await copyFile(join(sourceDisk, 'content.txt'), join(targetPath, 'content.txt'));
        copies += 1;
        native = { ...native, successfulCycles: 1 };
      } else if (command.t === 'terminate') { native = null; return null; }
      else throw new Error(`Unexpected native command ${command.t}`);
      return native;
    } });
    const sync = new WorkspaceSyncController({ localServerId: 'srv_test_home', localMachineId: 'machine',
      resolveWorkspaceRef, rootOwnershipManager, adapter,
      borrowLinkedSourceRoot: async (operationId, workspaceRefId) => {
        const source = handoff.resolvePreparedManagedCopySource?.(operationId, workspaceRefId);
        return source ? { handle: source.ownership, release: async () => undefined } : null;
      },
      openManagedWorkspaceAgentStream: async request => {
        const source = handoff.resolvePreparedManagedCopySource?.(request.operationId, request.workspaceRefId);
        if (!source) throw new Error('Guest source is not retained by the copy');
        return await source.openAgent(request);
      },
      lifecycle: { start: async () => undefined, stop: async () => undefined } });
    const unusedRelationshipOperation = async (): Promise<never> => { throw new Error('Copy must not create a relationship'); };
    const relationshipOwner = createWorkspaceSyncRelationshipOwner({ localMachineId: 'machine',
      readProjectSnapshot: readSnapshot, mutateProjectSnapshot: createProjectAccountSnapshotMutation(accountRows),
      // Dynamic fixture resolvers consume acknowledged Home rows directly.
      waitForProjectReconciliation: async () => {
        expect((await readSnapshot()).workspaceRefs).toEqual(expect.arrayContaining([expect.objectContaining({ rootPath: targetPath })]));
      }, ensureRelationship: unusedRelationshipOperation,
      flushRelationship: unusedRelationshipOperation, commitRelationshipTarget: unusedRelationshipOperation,
      terminateRelationshipRuntime: unusedRelationshipOperation });
    const handoff = createWorkspaceSyncHandoffAdapter({ sync, relationshipOwner, bootstrap: async input => {
      if (input.action.kind !== 'copy_once' || !input.targetWorkspaceRefId) throw new Error('Copy endpoint unavailable');
      const target = await workspaceSyncTargetBootstrap({ rootPath: input.targetRootPath, sourceRootPath: input.sourceRootPath,
        relationshipId: input.operationId, endpointRole: 'beta', targetWorkspaceRefId: input.targetWorkspaceRefId,
        policyDigest: input.action.contentPolicy.policyDigest, contentSelection: 'all_files',
        materializationDirectory: join(fixture, 'materialization'), rootOwnershipManager,
        createIfMissing: true, targetBootstrap: 'materialize_from_source_workspace' });
      const workspace = input.managedCopySource;
      const custody = workspace ? await guestRoots.tryAcquire({
        ownerId: input.operationId, canonicalRoot: guestDisk, operation: 'handoff',
      }) : null;
      if (custody && 'kind' in custody) throw new Error('Guest source fixture could not acquire custody');
      return {
        ownershipHandles: target.ownershipHandles,
        ...(workspace && custody ? { managedCopySource: {
          workspace,
          ownership: { ...custody, owner: { ...custody.owner, canonicalRoot: workspace.rootPath } },
          openAgent: async () => {
            sourceDisk = guestDisk;
            const stream = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
            return { stream, stop: async () => { stream.destroy(); } };
          },
        } } : {}),
        release: async reason => {
          try {
            if (reason === 'commit') await target.publishReady();
            await target.release();
          } finally { await custody?.release(); }
        },
      };
    } });
    const runtime: ProjectOpenRuntime = { serverId: 'srv_test_home', serverHttpBaseUrl: 'https://home.example', machineId: 'machine', accountId: 'account',
      readCredentials: async () => credentials, workspaceSyncAdapter: handoff };
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
      machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: 'machine', installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => { admissionReads += 1; return current; } };
    const fields = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const input = { serverId: 'srv_test_home', machineId: 'machine',
      source: sourceShape === 'managed-workspace' ? { kind: 'workspace' as const, workspaceId: managedAddress.workspaceId, checkout: managedAddress }
        : sourceShape === 'workspace-only' ? { kind: 'workspace' as const, workspaceId: workspace.id }
        : { kind: 'source' as const, id: source.id, revision: 9, selector: source.repository,
        checkout: { serverId: 'srv_test_home', workspaceId: workspace.id, machineId: 'machine', rootPath: root } },
      materialization: { kind: 'sync' as const, targetPath, workspaceAction: { kind: 'copy_once' as const,
        contentPolicy: { ...fields, policyDigest: computeWorkspaceSyncPolicyDigest(fields) } } } };
    const handler = register(RPC_METHODS.PROJECTS_OPEN, runtime);
    try {
      expect(projectWorkspaceSyncAdmissionInputV1('projects.open', input)).toEqual({
        sourceMachineId: workspace.machineId,
        sourceWorkspaceRefId: sourceShape === 'managed-workspace' ? managedAddress.workspaceId : workspace.id,
      });
      const opened = await handler(input, context);
      expect(opened, JSON.stringify(diagnostic.mock.calls)).toMatchObject({ kind: 'opened', directory: targetPath,
        workspace: { serverId: 'srv_test_home', machineId: 'machine', rootPath: targetPath } });
      expect(current).toBe(false);
      expect(admissionReads).toBe(1);
      expect(copies).toBe(1);
      expect(await readFile(join(targetPath, 'content.txt'), 'utf8')).toBe(
        sourceShape === 'managed-workspace' ? 'admitted guest bytes' : 'controller Source bytes');
      const writesBeforeRefusal = mutations;
      post.mockClear();
      expect(await handler(input, context)).toEqual({ kind: 'refused', code: 'machine_access_denied', effectAttempted: false });
      expect(admissionReads).toBe(2);
      expect(post).not.toHaveBeenCalled();
      expect(copies).toBe(1);
      expect(mutations).toBe(writesBeforeRefusal);
      if (sourceShape === 'managed-workspace') {
        // On the SSH transport boundary, the holder operates on
        // the guest fixture. The controller has a distinct tree at the selected path.
        const holderPath = resolveSessionHolderExecutablePath();
        const helperPath = resolveProcessCustodySupportExecutable();
        if (!holderPath || !helperPath) throw new Error('Session holder and process custody are required for managed copy and Return');
        const holder = spawn(holderPath, ['workspace', '--root', guestDisk], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, HOME: fixture } });
        const channel = Duplex.from({ readable: holder.stdout, writable: holder.stdin });
        const holderFinished = new Promise<void>(resolve => holder.once('close', () => resolve()));
        const guestSource = createHolderWorkspaceSource({ id: managedAddress.managedId, rootPath: root, guestRootPath: guestDisk,
          holder: openSessionHolderWorkspaceChannel(channel), helperPath });
        const registry = createScmBackendRegistry([]);
        const updated = 'change from the controller Session';
        try {
          const baseline = await scanWorkspaceManifest({ workspaceRoot: targetPath, scmRegistry: registry });
          const stagedPath = join(targetPath, 'content.txt');
          await writeFile(stagedPath, updated);
          const sessionId = 'ssh-copy-return';
          const preview = await runWithScmAccountScope('account', () => prepareManagedWorkspaceReturnFromStage({
            sessionId, hostRoot: root, stageRoot: targetPath, activeServerDir: fixture, baseline, registry,
            original: { workspace: managedAddress, source: guestSource },
          }));
          expect(preview.paths.flatMap(path => path.files)).toContainEqual(expect.objectContaining({ path: 'content.txt', evidence: { state: 'available', unifiedDiff: expect.stringContaining('+change from the controller Session') } }));
          await expect(readFile(join(guestDisk, 'content.txt'), 'utf8')).resolves.toBe('admitted guest bytes');
          await expect(runWithScmAccountScope('account', () => applyManagedWorkspaceReturn({
            sessionId, returnId: preview.returnId, paths: ['content.txt'], activeServerDir: fixture,
            withManagedTarget: async (selected, apply) => {
              expect(selected).toEqual(managedAddress);
              await runManagedWorkspaceReturnTarget({ source: guestSource, rootPath: selected.rootPath,
                signal: context.signal, assertCurrentAuthority: async () => {}, apply });
            },
          }))).resolves.toEqual({ appliedPaths: ['content.txt'], conflicts: [] });
          await expect(readFile(join(guestDisk, 'content.txt'), 'utf8')).resolves.toBe(updated);
          await expect(readFile(join(root, 'content.txt'), 'utf8')).resolves.toBe('controller Source bytes');
        } finally {
          holder.stdin.end();
          await holderFinished;
        }
      }
    } finally { await sync.shutdown(); await rm(fixture, { recursive: true, force: true }); }
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

  it('reports known cancellation when the caller aborts during the Home read before checkout effects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'OPEN-TESTS-cancel-'));
    const targetPath = join(root, 'not-created');
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    const controller = new AbortController();
    vi.spyOn(axios, 'get').mockImplementation(plainMachineRead);
    const post = vi.spyOn(axios, 'post').mockImplementation(async url => {
      if (!url.endsWith('/list')) throw new Error('Cancelled Open must not submit Account rows');
      controller.abort();
      return { status: 200, data: { status: 'listed', coverage: 'complete', rows: [] } };
    });
    const runtime: ProjectOpenRuntime = { serverId: 'srv_test_home', serverHttpBaseUrl: 'https://home.example', machineId: 'machine', accountId: 'account',
      readCredentials: async () => ({ token, encryption: null }) };
    const context: RpcHandlerContext = { signal: controller.signal, callerAuthority: 'present_user',
      machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: 'machine', installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => true };
    try {
      expect(await register(RPC_METHODS.PROJECTS_OPEN, runtime)({ serverId: 'srv_test_home', machineId: 'machine',
        source: { kind: 'folder', path: root }, materialization: { kind: 'worktree', targetPath,
          checkout: { kind: 'git_worktree', displayName: 'feature', baseRef: null } } }, context))
        .toEqual({ kind: 'refused', code: 'cancelled', effectAttempted: false });
      expect(controller.signal.aborted).toBe(true);
      expect(post.mock.calls.every(([url]) => url.endsWith('/list'))).toBe(true);
      expect(post).toHaveBeenCalledOnce();
      await expect(access(targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
