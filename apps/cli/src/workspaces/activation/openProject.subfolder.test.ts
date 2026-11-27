import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import type { ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { WorkspaceSyncSourceExecutionV1Schema, WorkspaceSyncSourceRoutingV1Schema, WorkspaceSyncSourceWriterTargetRoutingV1Schema } from '@happier-dev/protocol/socketRpc';
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk/errors';

import {
  encodePlainMachineStoredContent,
  MACHINE_PLAIN_DATA_KEY_MARKER,
} from '@happier-dev/protocol/machines/machineStoredContent';
import {
  OpenProjectInputV1Schema, OpenProjectResultV1Schema,
  type OpenProjectInputV1,
} from '@happier-dev/protocol/projects/openProjectV1';

import { createGitScmBackendRuntimeRegistration } from '../../../../../packages/plugins/scm-git/src/backend';
import {
  createBareRemoteRepository,
  makeCloneTargetDescription,
  makeProviderRegistry,
  makeRequest,
  runGit,
} from '../../../../../packages/plugins/scm-git/src/operations/repositoryCloneOperations.test-support';
import {
  createScmHostingProviderRuntimeServicesForTest,
  runWithRealGitScmRuntime,
} from '../../../../../packages/plugins/scm-git/src/testkit/scmRuntime.test-support';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createScmBackendRegistry } from '@/scm/registry';
import { resolveWorkspaceReplicationSourceInputsWithScmWorkspace } from '@/scm/workspace/workspaceTransferResolution';
import { seedTestServerProfile } from '@/testkit/serverProfiles';
import { createExternalActionMachineRpcExecution, projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { readProjectAccountRows } from '@/workspaces/projectAccountRows';
import { WorkspaceSyncController } from '@/workspaces/sync/workspaceSyncController';
import { createWorkspaceSyncHandoffAdapter } from '@/workspaces/sync/workspaceSyncHandoffAdapter';
import { createWorkspaceSyncMutagenAdapter } from '@/workspaces/sync/workspaceSyncMutagenAdapter';
import { deriveWorkspaceSyncRelationshipId } from '@/workspaces/sync/workspaceSyncRelationshipIdentity';
import { createWorkspaceRootOwnershipManager } from '@/workspaces/sync/workspaceSyncRootOwnership';
import { resolveWorkspaceSyncSeedTransfer } from '@/workspaces/sync/workspaceSyncSeedTransfer';
import { createWorkspaceSyncTargetAuthority } from '@/workspaces/sync/workspaceSyncTargetAuthority';
import { createPlainProjectAccountRefRow, createProjectAccountRowsHttpBoundary } from '@/workspaces/projectAccountRows.testkit';
import { resolveProjectSetupAcceptedWorkspace } from '@/workspaces/projectSetup/projectSetupAcceptedWorkspace';
import { reviewProjectSetupEffect } from '@/workspaces/projectSetup/projectSetupPreparation';
import { createProjectSetupSuccessStore } from '@/workspaces/projectSetup/projectSetupSuccess';
import { logger } from '@/ui/logger';
import { withSavedSecretMaterializer } from '@/settings/secrets/savedSecretCatalog.testkit';
import type { ProjectRequesterSecretRuntime } from '@/workspaces/projectSetup/projectSetupRequesterInputs';

await import('@/scm/workspace/workspaceCheckoutOperations');
const { openProject } = await import('./openProject');

const temporaryRoots: string[] = [];

async function plainAccountRead(url: string) {
  if (!url.includes('/v1/machines/'))
    return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
  const id = url.slice(url.lastIndexOf('/') + 1);
  return {
    status: 200,
    data: {
      machine: {
        id,
        active: true,
        installationId: 'installation',
        metadataVersion: 1,
        daemonStateVersion: 0,
        daemonState: null,
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        metadata: encodePlainMachineStoredContent({
          host: id,
          platform: 'linux',
          homeDir: '/home/user',
          happyCliVersion: 'test',
          happyHomeDir: '/home/user/.happier',
        }),
      },
    },
  };
}

describe('openProject with a subfolder the repository lacks', () => {
  beforeEach(async () => {
    await seedTestServerProfile({
      id: 'srv_test_home',
      homeId: 'srv_test_home',
      serverUrl: 'https://home.example',
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true })),
    );
  });


  it.each(['copied', 'wrong Machine at preflight', 'wrong Machine at prepare', 'refused with failing cleanup'] as const)(
    'settles an admitted plain-folder Copy to a fresh path (%s)', async outcome => {
      const fixture = await realpath(await mkdtemp(join(tmpdir(), 'happier-remote-open-copy-')));
      temporaryRoots.push(fixture);
      const sourceRoot = join(fixture, 'source');
      const targetRoot = join(fixture, 'target');
      await mkdir(join(sourceRoot, 'secrets'), { recursive: true });
      await writeFile(join(sourceRoot, 'payload.txt'), 'visible bytes');
      await writeFile(join(sourceRoot, 'secrets', 'ignored.txt'), 'ignored fixture');
      const serverId = 'srv_test_home';
      const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`, encryption: null };
      const rows: ProjectAccountRowV1[] = [];
      const http = createProjectAccountRowsHttpBoundary(rows);
      vi.spyOn(axios, 'get').mockImplementation(plainAccountRead);
      // Home refuses every request once the Source has refused, so the new
      // Copy row's cleanup cannot settle.
      let homeRefuses = false;
      vi.spyOn(axios, 'post').mockImplementation(async (...args: Parameters<typeof http>) => {
        if (homeRefuses) throw Object.assign(new Error('Home refused the fixture request'), { response: { status: 403, data: {} } });
        return await http(...args);
      });
      const registry = createScmBackendRegistry([]);
      const accountRows = { credentials, serverId };
      const rootOwnershipManager = createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') });
      const machineAdmission = (machineId: string) => ({
        machineId, installationId: 'installation', actorAccountId: 'account', custodianAccountId: 'account',
        role: 'manage' as const, encryptionMode: 'plain' as const,
      });
      const context = { signal: new AbortController().signal, callerAuthority: 'present_user' as const,
        machineAdmission: machineAdmission('source'), verifyMachineAdmissionCurrent: async () => true };
      const runtime = { serverId, machineId: 'source', serverHttpBaseUrl: 'https://home.example',
        accountId: 'account', registry, readCredentials: async () => credentials };
      const attached = await openProject({ serverId, machineId: 'source', source: { kind: 'folder', path: sourceRoot },
        materialization: { kind: 'attach' } }, runtime, context);
      if (attached.kind !== 'opened') throw new Error(`Plain folder Attach did not open: ${attached.kind}`);
      const checkout = attached.workspace;
      const fields = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: ['secrets/**'], extraIncludePatterns: [] };
      const contentPolicy = { ...fields, policyDigest: computeWorkspaceSyncPolicyDigest(fields) };
      const request = OpenProjectInputV1Schema.parse({ serverId, machineId: 'target',
        source: { kind: 'workspace', workspaceId: checkout.workspaceId, checkout },
        materialization: { kind: 'sync', targetPath: targetRoot, workspaceAction: { kind: 'copy_once', contentPolicy } } });
      const operationId = 'admitted-fresh-copy';
      const envelope = { v: 1 as const, requestId: operationId,
        target: { kind: 'machine' as const, machineId: 'target' }, input: request };
      const admitted = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'verified-test-root', binding: {
        accountId: 'account', authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
        serverIdentityId: serverId, actionId: 'projects.open', machineId: 'target', installationId: 'installation',
        custodianAccountId: 'account', requestId: operationId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        target: envelope.target, workspaceSyncAdmission: { relationshipId: deriveWorkspaceSyncRelationshipId(operationId),
          sourceWorkspaceRefId: checkout.workspaceId, source: machineAdmission('source') },
      } });
      const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: size => new Uint8Array(size) });
      Object.defineProperty(admitted, 'requesterAccountProjection', { value: {
        accountId: 'account', serverId, accountEncryptionMode: 'plain', projectAccountRowCipher: cipher,
        resolveMachineContentEncryptionContext: () => ({ encryptionMode: 'plain' }), isCurrent: async () => true,
      } });
      const keyPair = tweetnacl.sign.keyPair();
      const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: admitted, serverId,
        serverIdentityId: serverId, serverHttpBaseUrl: runtime.serverHttpBaseUrl, target: envelope.target,
        installationId: 'installation', privateKey: keyPair.secretKey, rootAdmitted: true, isCurrent: async () => true });
      if (!authorization) throw new Error('The admitted Copy HTTP projection was unavailable');
      const sourceRouting = WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare', operationId, accountServerId: serverId,
        sourceMachineId: 'source', sourceRootPath: sourceRoot, originalActionEnvelope: envelope,
        sourceContext: { machineAdmission: context.machineAdmission, callerAuthority: 'present_user', workspaceWrites: 'allow' } });
      const method = `source:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN}`;
      const sourceExecution = WorkspaceSyncSourceExecutionV1Schema.parse({ method, requestId: 'admitted-source-call', params: request,
        externalActionExecution: createExternalActionMachineRpcExecution({ context: { externalActionExecutionAuthorization: admitted,
          externalActionTarget: envelope.target }, effectActionId: 'projects.open', installationId: 'installation',
          method, requestId: 'admitted-source-call', params: request, workspaceSyncSourceRouting: sourceRouting, privateKey: keyPair.secretKey }) });
      const targetContext = { ...context, machineAdmission: machineAdmission('target'), callerInputAuthorization: authorization,
        workspaceSyncSourceExecution: sourceExecution };
      const routingFor = (phase: 'preflight' | 'prepare' | 'release') => WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({
        v: 1, sourceWriter: { machineId: 'source', installationId: 'installation' }, source: sourceRouting,
        target: { v: 1, phase, operationId, accountServerId: serverId, targetMachineId: 'target', targetRootPath: targetRoot },
      });
      const existingTarget = { id: 'existing-target', serverId, machineId: 'target', rootPath: targetRoot, createdAtMs: 1 };
      if (outcome === 'wrong Machine at prepare') rows.push(createPlainProjectAccountRefRow(existingTarget));
      const readRows = () => readProjectAccountRows({ ...accountRows, selection: { kinds: ['workspace-ref', 'relationship-graph'] } });
      const initial = await readRows();
      expect(initial.workspaceRefs).toMatchObject([{ id: checkout.workspaceId },
        ...(outcome === 'wrong Machine at prepare' ? [existingTarget] : [])]);
      const wrongMachine = { id: 'other-checkout', serverId, machineId: 'other', rootPath: targetRoot, createdAtMs: 1 };
      const misplacedRefs = initial.workspaceRefs.filter(ref => ref.id !== existingTarget.id).concat(wrongMachine);
      let installed = initial;
      const failingCleanup = outcome === 'refused with failing cleanup';
      let wrongPlacement = outcome === 'wrong Machine at preflight' || failingCleanup;
      const target = createWorkspaceSyncTargetAuthority({
        localServerId: serverId, localMachineId: 'target', localAccountId: 'account',
        getProjectSnapshot: () => installed,
        refreshProjectSnapshot: async () => {
          const snapshot = await readRows();
          installed = wrongPlacement ? { ...snapshot, workspaceRefs: misplacedRefs } : snapshot;
          return installed;
        },
        callMachineRpc: async () => { throw new Error('Unexpected nested Machine RPC'); },
        bootstrap: { rootOwnershipManager, materializationDirectory: join(fixture, 'materialization') },
      });
      onTestFinished(() => target.releaseAllRetainedBootstraps());
      const sync = new WorkspaceSyncController({ localServerId: serverId, localMachineId: 'target', rootOwnershipManager,
        resolveWorkspaceRef: async () => null,
        adapter: createWorkspaceSyncMutagenAdapter({ resolveWorkspaceRef: async () => null,
          send: async () => { throw new Error('A remote finite Copy must not start local Mutagen'); } }),
        lifecycle: { start: async () => undefined, stop: async () => undefined } });
      onTestFinished(() => sync.shutdown());
      let qualifiedId: string | undefined;
      let publishedBeforeDispatch = false;
      const opened = await openProject(request, { ...runtime, machineId: 'target',
        workspaceSyncAdapter: createWorkspaceSyncHandoffAdapter({ sync }),
        callWorkspaceSource: async ({ machineId, operationId: sentOperation, request: sentRequest }) => {
          expect(machineId).toBe('source');
          expect(sentOperation).toBe(operationId);
          publishedBeforeDispatch = (await readRows()).workspaceRefs.some(ref =>
            ref.machineId === 'target' && ref.rootPath === targetRoot);
          try {
            const preflight = await target.preflightHandoffTargetReplacementHere({ v: 1, serverId,
              machineId: 'target', operationId, targetPath: targetRoot, destinationIntent: 'materialize_from_source_workspace',
            }, context.signal, { ...targetContext, workspaceSyncSourceWriterTargetRouting: routingFor('preflight') });
            qualifiedId = preflight.targetWorkspace?.id;
            if (!qualifiedId) throw new Error('The target preflight did not qualify a row');
            if (outcome === 'wrong Machine at prepare') {
              wrongPlacement = true;
              installed = { ...installed, workspaceRefs: misplacedRefs };
            }
            await target.prepareBootstrapHere({ v: 1, bootstrapOperationId: operationId, targetWorkspaceRefId: qualifiedId,
              endpointRole: 'beta', policyDigest: contentPolicy.policyDigest, createIfMissing: true,
              targetBootstrap: 'materialize_from_source_workspace',
              owner: { kind: 'copy_once', operation: { v: 1, operationId, controllerMachineId: 'source',
                alphaWorkspaceRefId: checkout.workspaceId, betaWorkspaceRefId: qualifiedId, contentPolicy } },
            }, context.signal, { ...targetContext, workspaceSyncSourceWriterTargetRouting: routingFor('prepare') });
            // The Source's external transfer process is the boundary in this
            // fixture. Use production plain-folder selection and write the
            // selected bytes into the bootstrapped root without replacing it.
            const sent = sentRequest.materialization;
            if (sent.kind !== 'sync' || sent.workspaceAction.kind !== 'copy_once') throw new Error('Unexpected Source operation');
            const { entries } = await resolveWorkspaceReplicationSourceInputsWithScmWorkspace({
              sourcePath: sourceRoot, workspaceTransfer: resolveWorkspaceSyncSeedTransfer(sent.workspaceAction.contentPolicy), registry,
            });
            for (const entry of entries) {
              const destination = join(targetRoot, entry.relativePath);
              await mkdir(dirname(destination), { recursive: true });
              await copyFile(entry.sourcePath, destination);
            }
            await target.releaseBootstrapHere({ v: 1, bootstrapOperationId: operationId,
              targetWorkspaceRefId: qualifiedId, reason: 'copy_committed',
            }, context.signal, { ...context, workspaceSyncSourceWriterTargetRouting: routingFor('release') });
            return { kind: 'materialized' };
          } catch (error) {
            // This is a finite Source RPC boundary. Carry the actual receiver
            // cause the same way the Source's wire settlement does.
            if (!(error instanceof Error) || !('code' in error)) throw error;
            homeRefuses = failingCleanup;
            return { kind: 'refused', code: error.code, ...('failureCause' in error ? { failureCause: error.failureCause } : {}) };
          }
        },
      }, targetContext);
      homeRefuses = false;
      const final = await readRows();
      if (outcome === 'copied') {
        expect(opened).toMatchObject({ kind: 'opened', workspace: { workspaceId: qualifiedId, machineId: 'target', rootPath: targetRoot } });
        expect(await readFile(join(targetRoot, 'payload.txt'), 'utf8')).toBe('visible bytes');
        await expect(access(join(targetRoot, 'secrets', 'ignored.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(final.workspaceRefs).toMatchObject([{ id: checkout.workspaceId }, { id: qualifiedId, machineId: 'target' }]);
      } else {
        // The Source's typed refusal survives a cleanup that cannot settle.
        expect(opened).toMatchObject({ kind: 'refused', code: 'workspace_sync_child_unavailable', failureCause: {
          phase: outcome === 'wrong Machine at prepare' ? 'workspace_sync.target.prepare.qualification' : 'workspace_sync.target.preflight.qualification',
          errorCode: 'workspace_sync_child_unavailable',
        } });
        if (!failingCleanup) expect(final.workspaceRefs).toMatchObject(initial.workspaceRefs);
        await expect(access(targetRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      }
      expect(publishedBeforeDispatch).toBe(true);
    });

  it.each(['named', 'detached', 'no-remote', 'credentialed'] as const)('projects credential-free clone facts from the admitted source folder: %s', async state => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-open-clone-source-'));
    temporaryRoots.push(directory);
    runGit(directory, ['init', '-b', 'feature/source']);
    runGit(directory, ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'source']);
    if (state !== 'no-remote') runGit(directory, ['remote', 'add', 'origin', state === 'credentialed' ? 'https://x-access-token:secret@github.com/owner/source.git' : 'https://github.com/owner/source.git']);
    if (state === 'detached') runGit(directory, ['checkout', '--detach']);
    const registration = createGitScmBackendRuntimeRegistration();
    if (!registration.runtime) throw new Error('Git SCM test runtime is unavailable');
    const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
      definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.git/git',
      executableDefinition: registration.runtime, registration,
      hostingProviderRuntimeServices: createScmHostingProviderRuntimeServicesForTest(makeProviderRegistry(makeCloneTargetDescription(directory))),
    })]);
    const rows: unknown[] = [];
    vi.spyOn(axios, 'get').mockImplementation(plainAccountRead);
    vi.spyOn(axios, 'post').mockImplementation(createProjectAccountRowsHttpBoundary(rows));
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    const result = await runWithRealGitScmRuntime(() => openProject({
      serverId: 'srv_test_home', machineId: 'machine', source: { kind: 'folder', path: directory },
      materialization: { kind: 'attach' }, cloneSource: true,
    }, { serverId: 'srv_test_home', serverHttpBaseUrl: 'https://home.example', machineId: 'machine', accountId: 'account',
      registry, readCredentials: async () => ({ token, encryption: null }) }, {
      signal: new AbortController().signal, callerAuthority: 'present_user',
      machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: 'machine',
        installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => true,
    }));
    expect(result).toMatchObject({ kind: 'opened', cloneSource: {
      source: state === 'no-remote' || state === 'credentialed' ? null : { repository: { nameWithOwner: 'owner/source' }, protocol: 'https' },
      branch: state === 'detached' ? null : 'feature/source',
    } });
    if (state === 'named') expect(result).toMatchObject({ facts: { repositoryIdentity: {
      kind: 'github', deployment: 'https://github.com', repository: 'owner/source',
    } } });
    expect(JSON.stringify(result)).not.toContain('secret');
    OpenProjectResultV1Schema.parse(result);
  });

  it('retains the preparation owner refusal code when Open accepts a checkout with invalid setup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-open-invalid-setup-'));
    temporaryRoots.push(directory);
    await mkdir(join(directory, '.happier'));
    await writeFile(join(directory, '.happier/project.json'), '{');
    vi.spyOn(axios, 'get').mockImplementation(plainAccountRead);
    vi.spyOn(axios, 'post').mockImplementation(createProjectAccountRowsHttpBoundary([]));
    const warning = vi.spyOn(logger, 'warnLocalFile');
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    const result = await runWithRealGitScmRuntime(() => openProject({
      serverId: 'srv_test_home', machineId: 'machine', source: { kind: 'folder', path: directory },
      materialization: { kind: 'attach' },
    }, { serverId: 'srv_test_home', serverHttpBaseUrl: 'https://home.example', machineId: 'machine',
      accountId: 'account', readCredentials: async () => ({ token, encryption: null }),
    }, { signal: new AbortController().signal, callerAuthority: 'present_user',
      machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: 'machine',
        installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => true,
    }));
    expect(result).toMatchObject({ kind: 'opened', setup: 'failed' });
    expect(warning).toHaveBeenCalledWith('[Project Open] Passive setup failed', {
      kind: 'refused', code: 'invalid_manifest',
    });
  });

  it('projects already completed setup on Open only while its native inputs still match', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-open-completed-setup-'));
    temporaryRoots.push(root);
    const directory = join(root, 'checkout');
    await mkdir(join(directory, '.happier'), { recursive: true });
    const writeSetup = (command: string) => writeFile(join(directory, '.happier/project.json'), JSON.stringify({ version: 1,
      workspace: { setup: [{ kind: 'command', command }] } }));
    await writeSetup('echo first');
    const rows = createProjectAccountRowsHttpBoundary([]);
    vi.spyOn(axios, 'get').mockImplementation(plainAccountRead);
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => url.includes('trust')
      ? { status: 200, data: { status: 'absent' } } : rows(url, body));
    const serverId = 'srv_test_home';
    const machineId = 'machine';
    const serverHttpBaseUrl = 'https://home.example';
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null };
    const preparation = { nativeIo: { resolveTool: async () => null }, platform: { os: 'linux', arch: 'x64' }, successHomeDir: join(root, 'state') };
    const signal = new AbortController().signal;
    const invoke = () => runWithRealGitScmRuntime(() => openProject({ serverId, machineId,
      source: { kind: 'folder', path: directory }, materialization: { kind: 'attach' },
    }, { serverId, serverHttpBaseUrl, machineId, accountId: 'account', setupPreparation: preparation,
      readCredentials: async () => credentials,
    }, { signal, callerAuthority: 'present_user', machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account',
      machineId, installationId: 'installation', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true }));
    const opened = await invoke();
    expect(opened).toMatchObject({ kind: 'opened', setup: 'approvalRequired' });
    if (opened.kind !== 'opened' || !('machineId' in opened.workspace)) throw new Error('Expected a native checkout');
    const association = await resolveProjectSetupAcceptedWorkspace({ address: opened.workspace, serverId, serverHttpBaseUrl, credentials, signal });
    const reviewed = await reviewProjectSetupEffect({ ...preparation, projectAssociation: association, workspace: association.workspace,
      purpose: 'setup', requester: { credentials, serverHttpBaseUrl }, signal });
    if (reviewed.kind !== 'reviewed') throw new Error(reviewed.code);
    const target = { serverId, machineId, workspaceRefId: association.workspace.id };
    await createProjectSetupSuccessStore({ homeDir: preparation.successHomeDir }).recordCompletion(target, {
      v: 1, workspaceRefId: target.workspaceRefId, ...reviewed.plan.successBasis, confirmedCommandCount: 1, completedAtMs: 1,
    });
    expect(await invoke()).toMatchObject({ kind: 'opened', setup: 'notRequired' });
    await writeSetup('echo changed');
    expect(await invoke()).toMatchObject({ kind: 'opened', setup: 'approvalRequired' });
  });

  it('reviews an implicit secret requirement on Open with the requester runtime\'s own saved binding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-open-secret-setup-'));
    temporaryRoots.push(root);
    const directory = join(root, 'checkout');
    await mkdir(join(directory, '.happier'), { recursive: true });
    await writeFile(join(directory, '.happier/project.json'), JSON.stringify({ version: 1,
      environmentVariables: [{ name: 'TOKEN', required: true }],
      workspace: { setup: [{ kind: 'command', command: 'echo setup' }] } }));
    const rows: ProjectAccountRowV1[] = [];
    const accountRows = createProjectAccountRowsHttpBoundary(rows);
    vi.spyOn(axios, 'get').mockImplementation(plainAccountRead);
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => url.includes('trust')
      ? { status: 200, data: { status: 'absent' } } : accountRows(url, body));
    const serverId = 'srv_test_home';
    const machineId = 'machine';
    const serverHttpBaseUrl = 'https://home.example';
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null };
    // The installed Project runtime owner selects whose saved secrets this requester may use.
    const materialized: unknown[] = [];
    const requesterRuntime: ProjectRequesterSecretRuntime = { credentials, resolveSecretEnvironment: async bindings => {
      materialized.push(bindings);
      return withSavedSecretMaterializer({ settingsSecretsReadKeys: [], accountSettings: { secrets: [{ id: 'requester-token',
        name: 'Requester token', encryptedValue: { _isSecretValue: true, value: 'requester-private-value' } }] } });
    } };
    const resolveProjectRuntime = vi.fn(async (_context: RpcHandlerContext) => requesterRuntime);
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
      machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId, installationId: 'installation',
        role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
    const invoke = () => runWithRealGitScmRuntime(() => openProject({ serverId, machineId,
      source: { kind: 'folder', path: directory }, materialization: { kind: 'attach' },
    }, { serverId, serverHttpBaseUrl, machineId, accountId: 'account', resolveProjectRuntime,
      setupPreparation: { nativeIo: { resolveTool: async () => null }, platform: { os: 'linux', arch: 'x64' }, successHomeDir: join(root, 'state') },
      readCredentials: async () => credentials }, context));
    const first = await invoke();
    if (first.kind !== 'opened' || !first.facts?.projectKey) throw new Error('Expected an opened Project');
    // The requester's own Project organization row binds the declared secret to its saved Secret.
    const key = { kind: 'project-organization' as const, serverId, projectKey: first.facts.projectKey };
    const existing = rows.findIndex(row => JSON.stringify(row.key) === JSON.stringify(key));
    const current = existing < 0 ? undefined : rows[existing]!;
    const value = { ...(current?.content?.t === 'plain' ? (current.content.v as { value: object }).value : {}),
      environmentBindings: { v: 1, bindings: { TOKEN: { ref: 'requester-token' } } } };
    const row = { key, revision: (current?.revision ?? 0) + 1, content: { t: 'plain', v: { key, value } } } as ProjectAccountRowV1;
    if (existing < 0) rows.push(row); else rows[existing] = row;
    const opened = await invoke();
    expect(opened).toMatchObject({ kind: 'opened', setup: 'approvalRequired' });
    expect(resolveProjectRuntime).toHaveBeenCalledWith(context);
    // The first Open had no saved binding yet; the second binds only the requester's own reference.
    expect(materialized).toEqual([undefined, { v: 1, bindings: { TOKEN: { ref: 'requester-token' } } }]);
    expect(JSON.stringify(opened)).not.toContain('requester-private-value');
  });

  it.each(['clone-failed', 'native-auth-refused', 'subfolder-missing'] as const)('writes no Project for %s and retains only completed clones', async failure => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-open-subfolder-'));
    temporaryRoots.push(parent);
    const remote = createBareRemoteRepository();
    temporaryRoots.push(join(remote, '..'));
    const registration = createGitScmBackendRuntimeRegistration();
    if (!registration.runtime)
      throw new Error('Git SCM test runtime is unavailable');
    const registry = createScmBackendRegistry([
      createRegisteredScmBackendAdapter({
        definition: { id: 'git', kind: 'git' },
        qualifiedId: 'happier.scm.git/git',
        executableDefinition: registration.runtime,
        registration,
        hostingProviderRuntimeServices:
          createScmHostingProviderRuntimeServicesForTest(
            makeProviderRegistry(makeCloneTargetDescription(failure === 'clone-failed' ? join(remote, 'missing.git') : remote),
              failure === 'native-auth-refused' ? { describeCloneTargets: async () => {
                // The provider is the external boundary; its typed refusal must survive the real SCM and Project owners.
                throw new PluginError({ code: 'plugin_connected_account_native_unavailable',
                  message: 'native output https://secret@example.invalid/private',
                  remediation: { kind: 'selectAccount', service: {
                    pluginId: 'happier.scm.forge.github', localId: 'github',
                  } } });
              } } : undefined),
          ),
      }),
    ]);
    // Account HTTP is the boundary; row admission, materialization and Git stay real.
    const rows: unknown[] = [];
    const accountRows = createProjectAccountRowsHttpBoundary(rows);
    vi.spyOn(axios, 'get').mockImplementation(plainAccountRead);
    vi.spyOn(axios, 'post').mockImplementation(accountRows);
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    const request = makeRequest(parent, remote, 'checkout');
    const input = {
      serverId: 'srv_test_home',
      machineId: 'machine',
      source: {
        kind: 'repository',
        selector: {
          provider: request.provider,
          repository: request.repository,
          protocol: request.protocol,
        },
      },
      subdir: 'not-in-the-repository',
      materialization: {
        kind: 'clone',
        destinationParentPath: parent,
        destinationDirectoryName: 'checkout',
      },
    } as OpenProjectInputV1;
    const context: RpcHandlerContext = {
      signal: new AbortController().signal,
      callerAuthority: 'present_user',
      machineAdmission: {
        actorAccountId: 'account',
        custodianAccountId: 'account',
        machineId: 'machine',
        installationId: 'installation',
        role: 'manage',
        encryptionMode: 'plain',
      },
      verifyMachineAdmissionCurrent: async () => true,
    };

    const result = await runWithRealGitScmRuntime(() =>
      openProject(
        input,
        {
          serverId: 'srv_test_home',
          serverHttpBaseUrl: 'https://home.example',
          machineId: 'machine',
          accountId: 'account',
          registry,
          readCredentials: async () => ({ token, encryption: null }),
        },
        context,
      ),
    );

    if (failure === 'clone-failed' || failure === 'native-auth-refused') {
      expect(result).toMatchObject({ kind: 'refused',
        code: failure === 'clone-failed' ? 'REMOTE_NOT_FOUND' : 'REMOTE_AUTH_REQUIRED', effectAttempted: false });
      if (failure === 'native-auth-refused') {
        expect(result).toMatchObject({ failureCause: { phase: 'scm.hosting_provider',
          errorCode: 'plugin_connected_account_native_unavailable' }, remediation: { kind: 'auth_required' } });
        expect(JSON.stringify(result)).not.toContain('secret@example.invalid');
      }
      await expect(access(join(parent, 'checkout'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(rows).toEqual([]);
      return;
    }
    expect(result).toMatchObject({
      kind: 'refused',
      code: 'repository_subfolder_missing',
      effectAttempted: true,
    });
    expect(OpenProjectResultV1Schema.parse(result)).toEqual(result);
    await access(join(parent, 'checkout', '.git'));
    expect(rows).toEqual([]);
    // A folder already at the clone's destination is never taken over, even a checkout of this same repository
    // (COR4B 11-15: a new deploy adopted another lane's checkout and fetched in it). The refusal names the folder;
    // the person picks another name, or opens that folder as it is. Git's origin is the system fact: the fixture's
    // file:// remote stands in for the hosted URL a real clone records.
    const open = (next: OpenProjectInputV1) => runWithRealGitScmRuntime(() => openProject(next, { serverId: 'srv_test_home',
      serverHttpBaseUrl: 'https://home.example', machineId: 'machine', accountId: 'account', registry,
      readCredentials: async () => ({ token, encryption: null }) }, context));
    const { subdir: _wrong, ...retryInput } = input;
    const checkout = join(parent, 'checkout');
    for (const origin of ['https://github.com/someone-else/another-repository.git', 'https://github.com/happier-dev/happier.git']) {
      runGit(checkout, ['remote', 'set-url', 'origin', origin]);
      expect(await open(retryInput as OpenProjectInputV1)).toMatchObject({ kind: 'refused', code: 'destination_exists',
        effectAttempted: false });
      expect(rows).toEqual([]);
    }
    expect(await open({ ...(retryInput as OpenProjectInputV1), source: { kind: 'folder', path: checkout },
      materialization: { kind: 'attach' } } as OpenProjectInputV1)).toMatchObject({ kind: 'opened', directory: checkout });
    expect(rows.length).toBeGreaterThan(0);
  });

  it('batches workspace-ref and project-organization mutation, falls back on org conflict, deduplicates machine reads, and skips redundant accepted-workspace reads', async () => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'happier-open-rank6-')));
    temporaryRoots.push(fixture);
    const folderA = join(fixture, 'folder-a');
    const folderB = join(fixture, 'folder-b');
    const copyTarget = join(fixture, 'copy-target');
    await mkdir(folderA, { recursive: true });
    await mkdir(folderB, { recursive: true });
    await writeFile(join(folderA, 'hello.txt'), 'hello');
    await writeFile(join(folderB, 'hello.txt'), 'hello-b');
    const serverId = 'srv_test_home';
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`, encryption: null };
    const rows: ProjectAccountRowV1[] = [];
    const http = createProjectAccountRowsHttpBoundary(rows);
    const machineReads: string[] = [];
    const postPaths: string[] = [];
    const readKinds: string[] = [];
    const mutatedKinds: string[] = [];
    let failOrgBatchOnce = false;
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.includes('/v1/machines/')) machineReads.push(url.slice(url.lastIndexOf('/') + 1));
      return await plainAccountRead(url);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url: string, body?: unknown) => {
      const path = new URL(url).pathname;
      postPaths.push(path);
      if (path.endsWith('/project-rows/read') && body && typeof body === 'object') {
        const key = (body as { key?: { kind?: string } }).key;
        if (typeof key?.kind === 'string') readKinds.push(key.kind);
      }
      if (path.endsWith('/project-rows/mutate') && body && typeof body === 'object' && 'mutations' in body
        && Array.isArray((body as { mutations?: unknown[] }).mutations)) {
        for (const m of (body as { mutations: Array<{ key?: { kind?: string } }> }).mutations) {
          if (typeof m.key?.kind === 'string') mutatedKinds.push(m.key.kind);
        }
      }
      const orgMut = failOrgBatchOnce && path.endsWith('/mutate') && body && typeof body === 'object' && 'mutations' in body
        && Array.isArray((body as { mutations?: unknown[] }).mutations)
        ? (body as { mutations: Array<{ key?: { kind?: string } }> }).mutations.find(m => m.key?.kind === 'project-organization')
        : undefined;
      if (orgMut?.key) {
        failOrgBatchOnce = false;
        return { status: 200, data: { status: 'conflict', key: orgMut.key, revision: 0 } };
      }
      return await http(url, body);
    });
    const registry = createScmBackendRegistry([]);
    const machineAdmission = (machineId: string) => ({
      machineId, installationId: 'installation', actorAccountId: 'account', custodianAccountId: 'account',
      role: 'manage' as const, encryptionMode: 'plain' as const,
    });
    const context = { signal: new AbortController().signal, callerAuthority: 'present_user' as const,
      machineAdmission: machineAdmission('source'), verifyMachineAdmissionCurrent: async () => true };
    const runtime = { serverId, machineId: 'source', serverHttpBaseUrl: 'https://home.example',
      accountId: 'account', registry, readCredentials: async () => credentials };

    // Case A: local attach batches workspace-ref + project-organization into 1 /mutate and skips workspace-ref /read.
    const openedA = await openProject({ serverId, machineId: 'source', source: { kind: 'folder', path: folderA },
      materialization: { kind: 'attach' } }, runtime, context);
    expect(openedA).toMatchObject({ kind: 'opened', directory: folderA });
    expect(postPaths.filter(p => p.endsWith('/project-rows/mutate'))).toHaveLength(1);
    expect(readKinds.filter(k => k === 'workspace-ref')).toHaveLength(0);
    expect(readKinds.filter(k => k === 'project-organization')).toHaveLength(1);
    expect(rows.some(r => r.key.kind === 'workspace-ref')).toBe(true);
    expect(rows.some(r => r.key.kind === 'project-organization')).toBe(true);

    // Case B: project-organization conflict during batched /mutate falls back cleanly without failing workspace-ref acceptance.
    postPaths.length = 0;
    readKinds.length = 0;
    failOrgBatchOnce = true;
    const openedB = await openProject({ serverId, machineId: 'source', source: { kind: 'folder', path: folderB },
      materialization: { kind: 'attach' } }, runtime, context);
    expect(openedB).toMatchObject({ kind: 'opened', directory: folderB });
    expect(postPaths.filter(p => p.endsWith('/project-rows/mutate'))).toHaveLength(3); // 1 org-conflicted batch + 1 workspace-ref retry + 1 listOpenedProject fallback
    expect(rows.filter(r => r.key.kind === 'workspace-ref')).toHaveLength(2);
    expect(rows.filter(r => r.key.kind === 'project-organization')).toHaveLength(2);

    // Case C: sync open deduplicates readWorkspaceSyncChildMachineFacts (at most 1 GET /v1/machines/target),
    // deduplicates acceptDestination via publishedPreDispatch (1 /mutate), and skips redundant accepted-workspace /read.
    if (openedA.kind !== 'opened') throw new Error('expected openedA');
    machineReads.length = 0;
    postPaths.length = 0;
    readKinds.length = 0;
    mutatedKinds.length = 0;
    const fields = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const contentPolicy = { ...fields, policyDigest: computeWorkspaceSyncPolicyDigest(fields) };
    const targetRequest = OpenProjectInputV1Schema.parse({ serverId, machineId: 'target',
      source: { kind: 'workspace', workspaceId: openedA.workspace.workspaceId, checkout: openedA.workspace },
      materialization: { kind: 'sync', targetPath: copyTarget, workspaceAction: { kind: 'copy_once', contentPolicy } } });
    const operationId = 'rank6-sync-dedupe';
    const envelope = { v: 1 as const, requestId: operationId, target: { kind: 'machine' as const, machineId: 'target' }, input: targetRequest };
    const admitted = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'verified-test-root', binding: {
      accountId: 'account', authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
      serverIdentityId: serverId, actionId: 'projects.open', machineId: 'target', installationId: 'installation',
      custodianAccountId: 'account', requestId: operationId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      target: envelope.target, workspaceSyncAdmission: { relationshipId: deriveWorkspaceSyncRelationshipId(operationId),
        sourceWorkspaceRefId: openedA.workspace.workspaceId, source: machineAdmission('source') },
    } });
    const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: size => new Uint8Array(size) });
    Object.defineProperty(admitted, 'requesterAccountProjection', { value: {
      accountId: 'account', serverId, accountEncryptionMode: 'plain', projectAccountRowCipher: cipher,
      resolveMachineContentEncryptionContext: () => ({ encryptionMode: 'plain' }), isCurrent: async () => true,
    } });
    const keyPair = tweetnacl.sign.keyPair();
    const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: admitted, serverId,
      serverIdentityId: serverId, serverHttpBaseUrl: 'https://home.example', target: envelope.target,
      installationId: 'installation', privateKey: keyPair.secretKey, rootAdmitted: true, isCurrent: async () => true });
    if (!authorization) throw new Error('expected authorization');
    const sourceRouting = WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare', operationId, accountServerId: serverId,
      sourceMachineId: 'source', sourceRootPath: folderA, originalActionEnvelope: envelope,
      sourceContext: { machineAdmission: machineAdmission('source'), callerAuthority: 'present_user', workspaceWrites: 'allow' } });
    const method = `source:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN}`;
    const sourceExecution = WorkspaceSyncSourceExecutionV1Schema.parse({ method, requestId: 'admitted-rank6-call', params: targetRequest,
      externalActionExecution: createExternalActionMachineRpcExecution({ context: { externalActionExecutionAuthorization: admitted,
        externalActionTarget: envelope.target }, effectActionId: 'projects.open', installationId: 'installation',
        method, requestId: 'admitted-rank6-call', params: targetRequest, workspaceSyncSourceRouting: sourceRouting, privateKey: keyPair.secretKey }) });
    const targetResult = await openProject(targetRequest, {
      serverId, machineId: 'target', serverHttpBaseUrl: 'https://home.example', accountId: 'account', registry,
      readCredentials: async () => credentials,
      workspaceSyncAdapter: {} as never,
      callWorkspaceSource: async () => {
        await mkdir(copyTarget, { recursive: true });
        await writeFile(join(copyTarget, 'hello.txt'), 'hello');
        return { kind: 'materialized' };
      },
    }, {
      signal: new AbortController().signal, callerAuthority: 'present_user',
      machineAdmission: machineAdmission('target'), verifyMachineAdmissionCurrent: async () => true,
      callerInputAuthorization: authorization, workspaceSyncSourceExecution: sourceExecution,
    });
    expect(targetResult).toMatchObject({ kind: 'opened', directory: copyTarget });
    expect(machineReads.filter(id => id === 'target')).toHaveLength(1);
    expect(mutatedKinds.filter(k => k === 'workspace-ref')).toHaveLength(1);
    expect(readKinds.filter(k => k === 'workspace-ref')).toHaveLength(0);
  });
});
